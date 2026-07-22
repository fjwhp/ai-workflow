import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runIsolatedVerification } from "./automated-testing.js";
import {
  codingFilterOverrides,
  codingGitEnvironmentWithFsmonitor,
  getCommitSnapshot,
  getWorktreeSnapshot,
  inspectActualWorktreeIdentity
} from "./repository.js";
import { buildVerificationPlan, type VerificationCommand } from "./verification-plan.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 16_384;
const MAX_CONFLICT_FILES = 1_024;
const MAX_CONFLICT_FILES_BYTES = 262_144;
const TRUNCATED_OUTPUT_MARKER = "\n[truncated]";
const APPLICATION_TIMEOUT_MS = 300_000;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_CLEANUP_TIMEOUT_MS = 30_000;
const RECOVERED_SOURCE_TREE_ARGV_BUDGET_BYTES = 16 * 1024;

interface GitExecutionContext {
  signal?: AbortSignal;
  deadlineAt: number;
}

interface GitExecutionFence {
  before?: () => void | Promise<void>;
  after?: () => void | Promise<void>;
}

interface PreparedGitEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface FrozenApplicationInput {
  projectRepoPath: string;
  targetWorktreePath: string;
  targetBranch: string;
  sourceWorktreePath: string;
  sourceBranch: string;
  evidenceHash: string;
  sensitivePatterns: string[];
  expectedSourceHead?: string;
  expectedTargetHead?: string;
  sourceCommit?: string;
  changedFiles?: string[];
  fallbackCommands?: VerificationCommand[];
}

export interface ApplicationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ApplicationPreflight {
  allowed: boolean;
  checks: ApplicationCheck[];
  changedModules: string[];
  plannedCommands: VerificationCommand[];
  commandSource: "module_inference" | "project_fallback" | "unavailable";
  evidenceMode?: "worktree" | "commit";
  sourceCommit?: string;
  sourceBranch: string;
  targetBranch: string;
  sourceWorktreePath: string;
  targetWorktreePath: string;
  targetHead?: string;
}

export interface ApplicationCommandResult {
  command: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export type ApplicationResult = {
  status: "completed" | "failed" | "ambiguous" | "conflict" | "test_failed";
  preflight: ApplicationPreflight;
  sourceCommit?: string;
  preApplyHead?: string;
  targetState: "untouched_clean" | "rolled_back_clean" | "applied_dirty" | "uncertain";
  statusPorcelain: string;
  commandResults: ApplicationCommandResult[];
  error: string | null;
  conflictFiles?: string[];
  rollbackError?: string;
  rollbackPostcondition?: TargetState;
};

export type LocalIntegrationExecutionInput = FrozenApplicationInput & {
  commitMessage: string;
  commands: VerificationCommand[];
  signal?: AbortSignal;
  onSourceFrozen?: () => void | Promise<void>;
  onSourcePrepared?: (sourceCommit: string) => void | Promise<void>;
  assertSourceOwnership?: () => void | Promise<void>;
  onBeforeTargetMutation?: () => void | Promise<void>;
  onTargetMutated?: () => void | Promise<void>;
  assertTargetOwnership?: () => void | Promise<void>;
};

export type TargetState = {
  identityValid: boolean;
  clean: boolean;
  head: string;
  statusPorcelain: string;
};

function gitExecutionContext(signal?: AbortSignal, timeoutMs = APPLICATION_TIMEOUT_MS): GitExecutionContext {
  return { signal, deadlineAt: Date.now() + timeoutMs };
}

function gitRemaining(context: GitExecutionContext) {
  const remaining = context.deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("DELIVERY_APPLICATION_DEADLINE_EXCEEDED");
  return Math.min(remaining, GIT_COMMAND_TIMEOUT_MS);
}

async function git(
  cwd: string,
  args: string[],
  context: GitExecutionContext,
  indexPath?: string,
  fence?: GitExecutionFence
) {
  const prepared = await prepareGitEnvironment(cwd, context);
  return runPreparedGit(
    indexPath ? preparedGitWithIndex(prepared, indexPath) : prepared,
    args,
    context,
    fence
  );
}

async function prepareGitEnvironment(cwd: string, context: GitExecutionContext) {
  throwIfApplicationAborted(context.signal);
  const filterTimeout = gitRemaining(context);
  const overrides = await codingFilterOverrides(cwd, {
    signal: context.signal,
    timeout: filterTimeout
  });
  throwIfApplicationAborted(context.signal);
  gitRemaining(context);
  return {
    cwd,
    env: codingGitEnvironmentWithFsmonitor([
      ["core.hooksPath", "/dev/null"],
      ["commit.gpgSign", "false"],
      ...overrides
    ])
  } satisfies PreparedGitEnvironment;
}

function preparedGitWithIndex(prepared: PreparedGitEnvironment, indexPath: string) {
  return {
    cwd: prepared.cwd,
    env: { ...prepared.env, GIT_INDEX_FILE: indexPath }
  } satisfies PreparedGitEnvironment;
}

async function runPreparedGit(
  prepared: PreparedGitEnvironment,
  args: string[],
  context: GitExecutionContext,
  fence?: GitExecutionFence
) {
  await fence?.before?.();
  throwIfApplicationAborted(context.signal);
  const timeout = gitRemaining(context);
  let result: { stdout: string; stderr: string } | undefined;
  let commandError: unknown;
  try {
    result = await execFileAsync("git", ["-C", prepared.cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      env: prepared.env,
      signal: context.signal,
      timeout,
      encoding: "utf8"
    });
  } catch (error) {
    commandError = error;
  }
  await fence?.after?.();
  throwIfApplicationAborted(context.signal);
  gitRemaining(context);
  if (commandError) throw commandError;
  return result!;
}

type FrozenSourceIndexEntry = { mode: string; objectId: string } | undefined;

async function buildFrozenSourceObjects(
  input: LocalIntegrationExecutionInput,
  snapshot: Awaited<ReturnType<typeof getWorktreeSnapshot>>,
  execution: GitExecutionContext,
  preparedSourceGit: PreparedGitEnvironment
) {
  const baseCommit = snapshot.identity.headCommit;
  if (!baseCommit || snapshot.files.length === 0) throw new Error("SOURCE_EVIDENCE_EMPTY");
  throwIfApplicationAborted(input.signal);
  const root = await mkdtemp(join(tmpdir(), "ai-workflow-source-commit-"));
  const indexPath = join(root, "index");
  const entries = new Map(snapshot.manifest.entries.map((entry) => [entry.path, entry]));
  const frozenEntries = new Map<string, FrozenSourceIndexEntry>();
  const isolatedGit = preparedGitWithIndex(preparedSourceGit, indexPath);
  const updateIsolatedIndex = async (file: string) => {
    const entry = entries.get(file);
    if (!entry) {
      frozenEntries.set(file, undefined);
      await runPreparedGit(isolatedGit, ["update-index", "--force-remove", "--", file], execution);
      return;
    }
    const content = entry.type === "symlink"
      ? Buffer.from(entry.target)
      : Buffer.from(entry.contentBase64, "base64");
    const blobPath = join(root, `blob-${snapshot.files.indexOf(file)}`);
    await writeFile(blobPath, content, { mode: 0o600 });
    const objectId = (await runPreparedGit(isolatedGit, [
      "hash-object", "-w", "--no-filters", blobPath
    ], execution)).stdout.trim();
    frozenEntries.set(file, { mode: entry.mode, objectId });
    await runPreparedGit(isolatedGit, [
      "update-index", "--add", "--cacheinfo", entry.mode, objectId, file
    ], execution);
  };
  try {
    await runPreparedGit(isolatedGit, ["read-tree", baseCommit], execution);
    for (const file of snapshot.files) await updateIsolatedIndex(file);
    const tree = (await runPreparedGit(isolatedGit, ["write-tree"], execution)).stdout.trim();
    const changed = (await runPreparedGit(isolatedGit, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", baseCommit, tree
    ], execution)).stdout.split("\0").filter(Boolean).sort();
    const frozen = [...snapshot.files].sort();
    if (JSON.stringify(changed) !== JSON.stringify(frozen)) {
      throw new Error("SOURCE_COMMIT_PATH_SET_MISMATCH");
    }
    const sourceCommit = (await runPreparedGit(isolatedGit, [
      "commit-tree", tree, "-p", baseCommit, "-m", input.commitMessage
    ], execution)).stdout.trim();
    return { baseCommit, sourceCommit, frozenEntries };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function synchronizeFrozenSourceIndex(
  files: readonly string[],
  preparedSourceGit: PreparedGitEnvironment,
  frozenEntries: Map<string, FrozenSourceIndexEntry>,
  execution: GitExecutionContext,
  fence: GitExecutionFence
) {
  for (const file of files) {
    const entry = frozenEntries.get(file);
    if (!entry) {
      await runPreparedGit(
        preparedSourceGit,
        ["update-index", "--force-remove", "--", file],
        execution,
        fence
      );
      continue;
    }
    await runPreparedGit(
      preparedSourceGit,
      ["update-index", "--add", "--cacheinfo", entry.mode, entry.objectId, file],
      execution,
      fence
    );
  }
}

async function frozenSourceEntriesFromCommit(
  files: readonly string[],
  sourceCommit: string,
  preparedSourceGit: PreparedGitEnvironment,
  execution: GitExecutionContext
) {
  const fixedArgv = [
    "git", "-C", preparedSourceGit.cwd,
    "--literal-pathspecs", "ls-tree", "-z", sourceCommit, "--"
  ];
  const fixedBytes = gitArgvBytes(fixedArgv);
  if (fixedBytes > RECOVERED_SOURCE_TREE_ARGV_BUDGET_BYTES) {
    throw new Error("SOURCE_COMMIT_PATH_QUERY_ARGV_BUDGET_EXCEEDED");
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = fixedBytes;
  for (const file of files) {
    const fileBytes = gitArgvBytes([file]);
    if (fixedBytes + fileBytes > RECOVERED_SOURCE_TREE_ARGV_BUDGET_BYTES) {
      throw new Error("SOURCE_COMMIT_PATH_QUERY_ARGV_BUDGET_EXCEEDED");
    }
    if (batch.length > 0 && batchBytes + fileBytes > RECOVERED_SOURCE_TREE_ARGV_BUDGET_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = fixedBytes;
    }
    batch.push(file);
    batchBytes += fileBytes;
  }
  if (batch.length > 0) batches.push(batch);

  const entries = new Map<string, GitIndexEntry>();
  const returnedPaths = new Set<string>();
  for (const paths of batches) {
    const parsed = parseTreeEntries((await runPreparedGit(preparedSourceGit, [
      "--literal-pathspecs", "ls-tree", "-z", sourceCommit, "--", ...paths
    ], execution)).stdout);
    const requested = new Set(paths);
    if (!parsed) throw new Error("SOURCE_COMMIT_TREE_INVALID");
    for (const [path, entry] of parsed) {
      if (!requested.has(path) || returnedPaths.has(path)) {
        throw new Error("SOURCE_COMMIT_TREE_INVALID");
      }
      returnedPaths.add(path);
      if (entry.objectType === "tree" && entry.mode === "040000") continue;
      if (entry.objectType !== "blob"
        || (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000")) {
        throw new Error("SOURCE_COMMIT_TREE_ENTRY_UNSUPPORTED");
      }
      entries.set(path, entry);
    }
  }
  return new Map<string, FrozenSourceIndexEntry>(
    files.map((file) => [file, entries.get(file)])
  );
}

function gitArgvBytes(argv: readonly string[]) {
  return argv.reduce((bytes, argument) => bytes + Buffer.byteLength(argument, "utf8") + 1, 0);
}

function parseRegisteredWorktrees(output: string) {
  const result: Array<{ path: string; branch?: string }> = [];
  let current: { path?: string; branch?: string } = {};
  const finish = () => {
    if (current.path) result.push({ path: current.path, branch: current.branch });
    current = {};
  };
  for (const field of output.split("\0")) {
    if (!field) { finish(); continue; }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = value;
    if (key === "branch") current.branch = value;
  }
  finish();
  return result;
}

async function inspectRegisteredWorktree(
  input: FrozenApplicationInput,
  kind: "target" | "source",
  execution: GitExecutionContext
) {
  const candidatePath = kind === "target" ? input.targetWorktreePath : input.sourceWorktreePath;
  const branch = kind === "target" ? input.targetBranch : input.sourceBranch;
  try {
    const [projectPath, candidate] = await Promise.all([
      realpath(resolve(input.projectRepoPath)), realpath(resolve(candidatePath))
    ]);
    if (kind === "target" && candidate === projectPath) {
      return { valid: false as const, status: "project_root_forbidden", path: candidate };
    }
    const identity = await inspectActualWorktreeIdentity(projectPath, candidate, branch, {
      signal: execution.signal, deadlineAt: execution.deadlineAt
    });
    if (!identity.valid) return { valid: false as const, status: identity.status, path: candidate };
    const { stdout } = await git(projectPath, ["worktree", "list", "--porcelain", "-z"], execution);
    const registered = await Promise.all(parseRegisteredWorktrees(stdout).map(async (entry) => {
      try { return { ...entry, path: await realpath(resolve(entry.path)) }; }
      catch { return { ...entry, path: resolve(entry.path) }; }
    }));
    if (!registered.some((entry) => entry.path === candidate && entry.branch === `refs/heads/${branch}`)) {
      return { valid: false as const, status: "not_registered", path: candidate };
    }
    if (kind === "source") {
      const match = /^ai\/(REQ-[0-9]{4,})$/.exec(branch);
      const requirementCode = match?.[1];
      const expected = requirementCode
        ? resolve(projectPath, "..", ".ai-workflow-worktrees", basename(projectPath), "requirements", requirementCode)
        : "";
      if (!requirementCode || candidate !== expected) {
        return { valid: false as const, status: "managed_path_mismatch", path: candidate };
      }
    }
    return { valid: true as const, path: candidate, headCommit: identity.headCommit };
  } catch (error) {
    throwIfApplicationAborted(execution.signal);
    return { valid: false as const, status: "not_accessible", path: candidatePath };
  }
}

async function inspectTargetState(
  input: FrozenApplicationInput,
  execution: GitExecutionContext
): Promise<TargetState> {
  const identity = await inspectRegisteredWorktree(input, "target", execution);
  if (!identity.valid) return { identityValid: false, clean: false, head: "", statusPorcelain: "" };
  try {
    const [{ stdout: head }, { stdout: statusPorcelain }] = await Promise.all([
      git(identity.path, ["rev-parse", "HEAD"], execution),
      git(identity.path, ["status", "--porcelain=v1", "--untracked-files=all"], execution)
    ]);
    return { identityValid: true, clean: statusPorcelain.length === 0, head: head.trim(), statusPorcelain };
  } catch (error) {
    throwIfApplicationAborted(execution.signal);
    return { identityValid: false, clean: false, head: "", statusPorcelain: "" };
  }
}

async function changedTargetFiles(worktreePath: string, execution: GitExecutionContext) {
  const outputs = await Promise.all([
    git(worktreePath, ["diff", "--name-only", "-z"], execution),
    git(worktreePath, ["diff", "--cached", "--name-only", "-z"], execution),
    git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], execution)
  ]);
  return [...new Set(outputs.flatMap(({ stdout }) => stdout.split("\0").filter(Boolean)))];
}

function boundedCommandOutput(value: unknown) {
  const output = String(value ?? "");
  if (Buffer.byteLength(output) <= MAX_COMMAND_OUTPUT_BYTES) return output;
  const prefix = Buffer.from(output).subarray(
    0,
    MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(TRUNCATED_OUTPUT_MARKER) - 4
  ).toString("utf8");
  return `${prefix}${TRUNCATED_OUTPUT_MARKER}`;
}

function boundedConflictFiles(files: string[]) {
  const result: string[] = [];
  let bytes = 2;
  for (const file of files.slice(0, MAX_CONFLICT_FILES)) {
    const nextBytes = Buffer.byteLength(JSON.stringify(file)) + (result.length ? 1 : 0);
    if (bytes + nextBytes > MAX_CONFLICT_FILES_BYTES) break;
    result.push(file);
    bytes += nextBytes;
  }
  return result;
}

function literalPathspec(path: string) {
  return `:(literal)${path}`;
}

type GitIndexEntry = { mode: string; objectId: string };
type GitTreeEntry = GitIndexEntry & { objectType: string };

function sameGitEntry(left: GitIndexEntry | undefined, right: GitIndexEntry | undefined) {
  return left?.mode === right?.mode && left?.objectId === right?.objectId;
}

function parseUnmergedIndex(output: string) {
  const entries = new Map<string, Map<number, GitIndexEntry>>();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(record);
    if (!match) return undefined;
    const mode = match[1]!;
    const objectId = match[2]!;
    const stageValue = match[3]!;
    const path = match[4]!;
    const stages = entries.get(path) ?? new Map<number, GitIndexEntry>();
    stages.set(Number(stageValue), { mode, objectId });
    entries.set(path, stages);
  }
  return entries;
}

function parseTreeEntries(output: string) {
  const entries = new Map<string, GitTreeEntry>();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) return undefined;
    const mode = match[1]!;
    const objectType = match[2]!;
    const objectId = match[3]!;
    const path = match[4]!;
    if (entries.has(path)) return undefined;
    entries.set(path, { mode, objectType, objectId });
  }
  return entries;
}

async function ownsFailedCherryPickState(
  worktreePath: string,
  sourceCommit: string,
  preApplyHead: string,
  cherryPickHead: string,
  execution: GitExecutionContext
) {
  if (cherryPickHead && cherryPickHead !== sourceCommit) return false;
  const unmerged = parseUnmergedIndex((await git(worktreePath, [
    "ls-files", "-u", "-z"
  ], execution)).stdout);
  if (!unmerged || unmerged.size === 0) return false;
  const sourceParent = (await git(worktreePath, [
    "rev-parse", "--verify", `${sourceCommit}^`
  ], execution)).stdout.trim();
  const sourcePaths = (await git(worktreePath, [
    "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sourceParent, sourceCommit
  ], execution)).stdout.split("\0").filter(Boolean);
  const sourcePathSet = new Set(sourcePaths);
  if ([...unmerged.keys()].some((path) => !sourcePathSet.has(path))) return false;
  const paths = [...new Set([...sourcePaths, ...unmerged.keys()])];
  const readTree = async (commit: string) => parseTreeEntries((await git(worktreePath, [
    "ls-tree", "-z", commit, "--", ...paths.map(literalPathspec)
  ], execution)).stdout);
  const [baseEntries, targetEntries, sourceEntries] = await Promise.all([
    readTree(sourceParent), readTree(preApplyHead), readTree(sourceCommit)
  ]);
  if (!baseEntries || !targetEntries || !sourceEntries) return false;
  const expectedStages = [baseEntries, targetEntries, sourceEntries] as const;
  for (const path of sourcePaths) {
    const base = baseEntries.get(path);
    const target = targetEntries.get(path);
    const source = sourceEntries.get(path);
    const potentiallyConflicting = !sameGitEntry(base, target) && !sameGitEntry(target, source);
    if (potentiallyConflicting && !unmerged.has(path)) return false;
  }
  for (const [path, actualStages] of unmerged) {
    for (let stage = 1; stage <= 3; stage += 1) {
      const actual = actualStages.get(stage);
      const expected = expectedStages[stage - 1]!.get(path);
      if (!sameGitEntry(actual, expected)) return false;
    }
  }
  return true;
}

export async function preflightLocalIntegration(
  input: FrozenApplicationInput,
  options: { signal?: AbortSignal } = {}
): Promise<ApplicationPreflight> {
  return preflightLocalIntegrationWithExecution(input, gitExecutionContext(options.signal));
}

async function preflightLocalIntegrationWithExecution(
  input: FrozenApplicationInput,
  execution: GitExecutionContext
): Promise<ApplicationPreflight> {
  const checks: ApplicationCheck[] = [];
  let evidenceMode: "worktree" | "commit" | undefined;
  let resolvedSourceCommit: string | undefined;
  const targetIdentity = await inspectRegisteredWorktree(input, "target", execution);
  checks.push({ id: "target_identity", label: "目标工作树身份有效", ok: targetIdentity.valid, detail: targetIdentity.valid ? targetIdentity.path : targetIdentity.status });
  try {
    const branch = (await git(input.targetWorktreePath, ["branch", "--show-current"], execution)).stdout.trim();
    checks.push({ id: "target_branch", label: "目标分支正确", ok: branch === input.targetBranch, detail: branch || "游离 HEAD" });
    const status = (await git(input.targetWorktreePath, ["status", "--porcelain"], execution)).stdout;
    checks.push({
      id: "target_clean",
      label: "目标工作树干净",
      ok: status.length === 0,
      detail: status ? boundedCommandOutput(status) : "没有本地修改"
    });
  } catch {
    throwIfApplicationAborted(execution.signal);
    checks.push({ id: "target_branch", label: "目标分支正确", ok: false, detail: "无法读取目标分支" });
  }
  const sourceIdentity = await inspectRegisteredWorktree(input, "source", execution);
  checks.push({ id: "source_identity", label: "来源工作树身份有效", ok: sourceIdentity.valid, detail: sourceIdentity.valid ? sourceIdentity.path : sourceIdentity.status });
  try {
    const branch = (await git(input.sourceWorktreePath, ["branch", "--show-current"], execution)).stdout.trim();
    checks.push({ id: "source_branch", label: "AI 分支匹配", ok: branch === input.sourceBranch, detail: branch || "游离 HEAD" });
    if (input.sourceCommit) {
      const commit = (await git(input.sourceWorktreePath, ["rev-parse", "--verify", `${input.sourceCommit}^{commit}`], execution)).stdout.trim();
      await git(input.sourceWorktreePath, ["merge-base", "--is-ancestor", commit, input.sourceBranch], execution);
      const evidence = await getCommitSnapshot(input.sourceWorktreePath, commit, {
        sensitivePatterns: input.sensitivePatterns,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt
      });
      checks.push({ id: "source_changes", label: "存在待合并变更", ok: evidence.files.length > 0 && evidence.diff.length > 0, detail: `${evidence.files.length} 个文件（已提交）` });
      checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: evidence.evidenceHash === input.evidenceHash, detail: evidence.evidenceHash.slice(0, 12) });
      evidenceMode = "commit";
      resolvedSourceCommit = commit;
    } else {
      const snapshot = await getWorktreeSnapshot(input.sourceWorktreePath, {
        sensitivePatterns: input.sensitivePatterns,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt
      });
      if (input.expectedSourceHead && snapshot.identity.headCommit !== input.expectedSourceHead) {
        const commit = snapshot.identity.headCommit;
        const evidence = await getCommitSnapshot(input.sourceWorktreePath, commit, {
          sensitivePatterns: input.sensitivePatterns,
          signal: execution.signal,
          deadlineAt: execution.deadlineAt
        });
        const exactFiles = !input.changedFiles
          || JSON.stringify([...evidence.files].sort()) === JSON.stringify([...input.changedFiles].sort());
        const valid = evidence.identity.headCommit === input.expectedSourceHead
          && evidence.files.length > 0 && evidence.diff.length > 0
          && evidence.evidenceHash === input.evidenceHash && exactFiles;
        checks.push({ id: "source_changes", label: "存在待合并变更", ok: evidence.files.length > 0 && evidence.diff.length > 0, detail: `${evidence.files.length} 个文件（恢复提交）` });
        checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: valid, detail: evidence.evidenceHash.slice(0, 12) });
        evidenceMode = "commit";
        if (valid) resolvedSourceCommit = commit;
      } else {
        checks.push({ id: "source_changes", label: "存在待合并变更", ok: snapshot.files.length > 0 && snapshot.diff.length > 0, detail: `${snapshot.files.length} 个文件` });
        checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: snapshot.evidenceHash === input.evidenceHash, detail: snapshot.evidenceHash.slice(0, 12) });
        evidenceMode = "worktree";
      }
    }
  } catch {
    throwIfApplicationAborted(execution.signal);
    checks.push({ id: "source_branch", label: "AI 分支匹配", ok: false, detail: "AI worktree 不存在或不可访问" });
  }
  const plan=input.changedFiles?await buildVerificationPlan({repoPath:input.targetWorktreePath,changedFiles:input.changedFiles,fallbackCommands:input.fallbackCommands||[]}):{changedModules:[],plannedCommands:input.fallbackCommands||[],commandSource:"project_fallback" as const};
  if(input.changedFiles)checks.push({id:"verification_plan",label:"自动测试计划",ok:plan.plannedCommands.length>0,detail:plan.plannedCommands.length?`${plan.plannedCommands.length} 条命令`:"未识别到安全测试命令"});
  let targetHead: string | undefined;
  if (targetIdentity.valid) {
    try { targetHead = (await git(targetIdentity.path, ["rev-parse", "HEAD"], execution)).stdout.trim(); }
    catch { throwIfApplicationAborted(execution.signal); /* failed checks block application */ }
  }
  return {
    allowed: checks.length >= 7 && checks.every((entry) => entry.ok) && Boolean(targetHead),
    checks,
    ...plan,
    ...(evidenceMode ? { evidenceMode } : {}),
    ...(resolvedSourceCommit ? { sourceCommit: resolvedSourceCommit } : {}),
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    sourceWorktreePath: input.sourceWorktreePath,
    targetWorktreePath: input.targetWorktreePath,
    ...(targetHead ? { targetHead } : {})
  };
}

export async function executeLocalIntegration(
  input: LocalIntegrationExecutionInput
): Promise<ApplicationResult> {
  const execution = gitExecutionContext(input.signal);
  throwIfApplicationAborted(input.signal);
  const preflight = await preflightLocalIntegrationWithExecution(
    {...input,fallbackCommands:input.fallbackCommands||input.commands}, execution
  );
  throwIfApplicationAborted(input.signal);
  if (!preflight.allowed) {
    const target = await inspectTargetState(input, execution);
    const safe = target.identityValid && target.clean &&
      (!input.expectedTargetHead || target.head === input.expectedTargetHead);
    return { status: safe ? "failed" as const : "ambiguous" as const, preflight,
      preApplyHead: input.expectedTargetHead, targetState: safe ? "untouched_clean" as const : "uncertain" as const,
      statusPorcelain: target.statusPorcelain, error: "应用预检未通过", commandResults: [] };
  }
  let sourceCommit: string | undefined = preflight.sourceCommit;
  const preApplyHead = input.expectedTargetHead ?? preflight.targetHead!;
  if (preflight.targetHead !== preApplyHead) {
    return { status: "ambiguous" as const, preflight, sourceCommit, preApplyHead,
      targetState: "uncertain" as const, statusPorcelain: "", error: "目标工作树 HEAD 在租约获取后发生变化", commandResults: [] };
  }
  let sourceOwnershipError: unknown;
  let sourceOwnershipFailed = false;
  const fenceSourceMutation = async () => {
    try {
      await assertSourceOwnership(input);
    } catch (error) {
      sourceOwnershipFailed = true;
      sourceOwnershipError = error;
      throw error;
    }
  };
  if (!sourceCommit) {
    let snapshot: Awaited<ReturnType<typeof getWorktreeSnapshot>>;
    let preparedSourceGit!: PreparedGitEnvironment;
    try {
      snapshot = await getWorktreeSnapshot(input.sourceWorktreePath, {
        sensitivePatterns: input.sensitivePatterns,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt
      });
      if (!snapshot.diff || snapshot.evidenceHash !== input.evidenceHash) {
        throw new Error("SOURCE_EVIDENCE_CHANGED");
      }
      preparedSourceGit = await prepareGitEnvironment(input.sourceWorktreePath, execution);
    } catch (error: any) {
      throwIfApplicationAborted(input.signal);
      const target = await inspectTargetState(input, execution);
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
    await input.onSourceFrozen?.();
    await assertSourceOwnership(input);
    let preparedSource: Awaited<ReturnType<typeof buildFrozenSourceObjects>>;
    try {
      preparedSource = await buildFrozenSourceObjects(input, snapshot, execution, preparedSourceGit);
    } catch (error: any) {
      throwIfApplicationAborted(input.signal);
      const target = await inspectTargetState(input, execution);
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
    try {
      await runPreparedGit(preparedSourceGit, [
        "update-ref", `refs/heads/${input.sourceBranch}`,
        preparedSource.sourceCommit, preparedSource.baseCommit
      ], execution, { before: fenceSourceMutation, after: fenceSourceMutation });
    } catch (error: any) {
      if (sourceOwnershipFailed) throw sourceOwnershipError;
      throwIfApplicationAborted(input.signal);
      const target = await inspectTargetState(input, execution);
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
    sourceCommit = preparedSource.sourceCommit;
    await input.onSourcePrepared?.(preparedSource.sourceCommit);
    await assertSourceOwnership(input);
    sourceOwnershipFailed = false;
    sourceOwnershipError = undefined;
    try {
      await synchronizeFrozenSourceIndex(
        snapshot.files,
        preparedSourceGit,
        preparedSource.frozenEntries,
        execution,
        { before: fenceSourceMutation, after: fenceSourceMutation }
      );
    } catch (error: any) {
      if (sourceOwnershipFailed) throw sourceOwnershipError;
      throwIfApplicationAborted(input.signal);
      const target = await inspectTargetState(input, execution);
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
  } else {
    try {
      const evidence = await getCommitSnapshot(input.sourceWorktreePath, sourceCommit, {
        sensitivePatterns: input.sensitivePatterns,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt
      });
      if (!evidence.diff || evidence.evidenceHash !== input.evidenceHash) {
        throw new Error("SOURCE_EVIDENCE_CHANGED");
      }
      const preparedSourceGit = await prepareGitEnvironment(input.sourceWorktreePath, execution);
      const frozenEntries = await frozenSourceEntriesFromCommit(
        evidence.files, sourceCommit, preparedSourceGit, execution
      );
      await synchronizeFrozenSourceIndex(
        evidence.files,
        preparedSourceGit,
        frozenEntries,
        execution,
        { before: fenceSourceMutation, after: fenceSourceMutation }
      );
    } catch (error: any) {
      if (sourceOwnershipFailed) throw sourceOwnershipError;
      throwIfApplicationAborted(input.signal);
      const target = await inspectTargetState(input, execution);
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
  }
  try {
    const sourceIdentityAfterCommit = await inspectRegisteredWorktree(input, "source", execution);
    if (!sourceIdentityAfterCommit.valid) throw new Error("来源工作树身份在提交后失效");
    const evidence = await getCommitSnapshot(input.sourceWorktreePath, sourceCommit!, {
      sensitivePatterns: input.sensitivePatterns,
      signal: execution.signal,
      deadlineAt: execution.deadlineAt
    });
    if (!evidence.diff || evidence.evidenceHash !== input.evidenceHash) throw new Error("提交后的编码证据与原始证据不一致");
  } catch (error: any) {
    throwIfApplicationAborted(input.signal);
    const target = await inspectTargetState(input, execution);
    const safe = target.identityValid && target.clean && target.head === preApplyHead;
    return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
      targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
      error: String(error?.stderr || error?.message || error), commandResults: [] };
  }
  throwIfApplicationAborted(input.signal);
  const target = await inspectTargetState(input, execution);
  if (!target.identityValid || !target.clean || target.head !== preApplyHead) {
    return { status: "ambiguous" as const, preflight, sourceCommit, preApplyHead, targetState: "uncertain" as const,
      statusPorcelain: target.statusPorcelain, error: "目标工作树在应用前发生变化", commandResults: [] };
  }
  await input.onBeforeTargetMutation?.();
  throwIfApplicationAborted(input.signal);
  let cherryPickCompleted = false;
  let primaryOwnershipError: unknown;
  const fencePrimaryMutation = async () => {
    try {
      await assertTargetOwnership(input);
    } catch (error) {
      primaryOwnershipError = error;
      throw error;
    }
  };
  try {
    await git(input.targetWorktreePath, ["cherry-pick", "--no-commit", sourceCommit!], execution, undefined, {
      before: fencePrimaryMutation,
      after: fencePrimaryMutation
    });
    cherryPickCompleted = true;
    await input.onTargetMutated?.();
    throwIfApplicationAborted(input.signal);
  } catch (error: any) {
    throwIfApplicationAborted(input.signal);
    if (primaryOwnershipError) throw primaryOwnershipError;
    await assertTargetOwnership(input);
    const cleanupExecution = gitExecutionContext(input.signal, GIT_CLEANUP_TIMEOUT_MS);
    const target = await inspectTargetState(input, cleanupExecution);
    let cherryPickHead = "";
    try {
      cherryPickHead = (await git(input.targetWorktreePath, [
        "rev-parse", "--verify", "CHERRY_PICK_HEAD"
      ], cleanupExecution)).stdout.trim();
    }
    catch { throwIfApplicationAborted(input.signal); /* No active cherry-pick. */ }
    const ownsFailedCherryPick = !cherryPickCompleted && await ownsFailedCherryPickState(
      input.targetWorktreePath, sourceCommit!, preApplyHead, cherryPickHead, cleanupExecution
    );
    if (!ownsFailedCherryPick) {
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
    let conflictFiles: string[] = [];
    try {
      conflictFiles = boundedConflictFiles((await git(input.targetWorktreePath, [
        "diff", "--name-only", "--diff-filter=U", "-z"
      ], cleanupExecution)).stdout.split("\0").filter(Boolean));
    }
    catch { throwIfApplicationAborted(input.signal); /* Preserve the original error. */ }
    const evidence = await getCommitSnapshot(input.sourceWorktreePath, sourceCommit!, {
      sensitivePatterns: input.sensitivePatterns,
      signal: cleanupExecution.signal,
      deadlineAt: cleanupExecution.deadlineAt
    });
    let changedFiles: string[] = [];
    try { changedFiles = await changedTargetFiles(input.targetWorktreePath, cleanupExecution); }
    catch { throwIfApplicationAborted(input.signal); }
    let rollbackError = "";
    let rollbackPostcondition: TargetState | undefined;
    if (changedFiles.every((file) => evidence.files.includes(file))) {
      let cleanupOwnershipError: unknown;
      const fenceCleanupMutation = async () => {
        try {
          await assertTargetOwnership(input);
        } catch (error) {
          cleanupOwnershipError = error;
          throw error;
        }
      };
      try {
        const existing: string[] = [], added: string[] = [];
        const preApplyFiles = new Set((await git(input.targetWorktreePath, [
          "ls-tree", "-r", "--name-only", "-z", preApplyHead
        ], cleanupExecution)).stdout.split("\0").filter(Boolean));
        for (const file of evidence.files) {
          if (preApplyFiles.has(file)) existing.push(file);
          else added.push(file);
        }
        if (existing.length) {
          await git(input.targetWorktreePath, [
            "restore", `--source=${preApplyHead}`, "--staged", "--worktree", "--",
            ...existing.map(literalPathspec)
          ], cleanupExecution, undefined, {
            before: fenceCleanupMutation,
            after: fenceCleanupMutation
          });
        }
        if (added.length) {
          await git(input.targetWorktreePath, [
            "rm", "-f", "--ignore-unmatch", "--", ...added.map(literalPathspec)
          ], cleanupExecution, undefined, {
            before: fenceCleanupMutation,
            after: fenceCleanupMutation
          });
        }
        try {
          await git(input.targetWorktreePath, ["cherry-pick", "--quit"], cleanupExecution, undefined, {
            before: fenceCleanupMutation,
            after: fenceCleanupMutation
          });
        } catch {
          if (cleanupOwnershipError) throw cleanupOwnershipError;
          throwIfApplicationAborted(input.signal);
        }
        const restored = await inspectTargetState(input, cleanupExecution);
        rollbackPostcondition = restored;
        if (restored.identityValid && restored.clean && restored.head === preApplyHead) {
          return { status: "conflict" as const, preflight, sourceCommit, preApplyHead,
            targetState: "rolled_back_clean" as const, statusPorcelain: "", conflictFiles,
            error: String(error?.stderr || error?.message || error), commandResults: [] };
        }
      } catch (rollbackCause: any) {
        if (cleanupOwnershipError) throw cleanupOwnershipError;
        throwIfApplicationAborted(input.signal);
        rollbackError = String(rollbackCause?.stderr || rollbackCause?.message || rollbackCause);
      }
    }
    return { status: "ambiguous" as const, preflight, sourceCommit, preApplyHead, targetState: "uncertain" as const,
      statusPorcelain: target.statusPorcelain, conflictFiles, rollbackError,
      rollbackPostcondition,
      error: String(error?.stderr || error?.message || error), commandResults: [] };
  }
  const commandResults: ApplicationCommandResult[] = [];
  const commands=input.changedFiles?preflight.plannedCommands:input.commands;
  const isolatedCommands = commands.filter((item) => !isTrustedIndexCheck(item));
  let trustedCheckFailed = false;
  for (const item of commands.filter(isTrustedIndexCheck)) {
    let result: Awaited<ReturnType<typeof git>> | undefined;
    let commandError: any;
    let ownershipError: unknown;
    const fenceTrustedCommand = async () => {
      try {
        await assertTargetOwnership(input);
      } catch (error) {
        ownershipError = error;
        throw error;
      }
    };
    try {
      result = await git(input.targetWorktreePath, item.argsPrefix, execution, undefined, {
        before: fenceTrustedCommand,
        after: fenceTrustedCommand
      });
    } catch (error: any) {
      if (ownershipError) throw ownershipError;
      commandError = error;
    }
    if (!commandError) {
      commandResults.push({
        command: item.command, args: item.argsPrefix, code: 0,
        stdout: boundedCommandOutput(result?.stdout), stderr: boundedCommandOutput(result?.stderr)
      });
    } else {
      trustedCheckFailed = true;
      commandResults.push({
        command: item.command, args: item.argsPrefix,
        code: Number.isSafeInteger(commandError?.code) ? commandError.code : 1,
        stdout: boundedCommandOutput(commandError?.stdout),
        stderr: boundedCommandOutput(commandError?.stderr || commandError?.message)
      });
    }
  }
  if (!trustedCheckFailed && isolatedCommands.length > 0) {
    const verificationSnapshot = await getWorktreeSnapshot(input.targetWorktreePath, {
      sensitivePatterns: input.sensitivePatterns,
      signal: execution.signal,
      deadlineAt: execution.deadlineAt
    });
    const verification = await runIsolatedVerification({
      sourceManifest: verificationSnapshot.manifest,
      sensitivePatterns: input.sensitivePatterns,
      targetWorktree: input.targetWorktreePath,
      gitCommonDir: verificationSnapshot.identity.gitCommonDir,
      allowedCommands: isolatedCommands.map((item) => ({
        command: item.command, argsPrefix: item.argsPrefix
      })),
      acceptanceCriteria: ["post-application verification passes"]
    }, {}, input.signal, {
      assertCurrent: () => assertTargetOwnership(input),
      deadlineAt: execution.deadlineAt
    });
    commandResults.push(...verification.commandResults.map((result) => ({
      command: result.command,
      args: result.args,
      code: result.exitCode,
      stdout: boundedCommandOutput(result.stdout),
      stderr: boundedCommandOutput(result.stderr || result.error)
    })));
    trustedCheckFailed = verification.result !== "passed";
  }
  if (trustedCheckFailed) {
    const statusPorcelain = (await git(input.targetWorktreePath, ["status", "--porcelain"], execution)).stdout;
    return { status: "test_failed" as const, preflight, sourceCommit, preApplyHead,
      targetState: "applied_dirty" as const, statusPorcelain, commandResults,
      error: "本地应用后测试失败" };
  }
  const statusPorcelain = (await git(input.targetWorktreePath, ["status", "--porcelain"], execution)).stdout;
  throwIfApplicationAborted(input.signal);
  return { status: "completed" as const, preflight, sourceCommit, preApplyHead, targetState: "applied_dirty" as const, statusPorcelain, commandResults, error: null };
}

function throwIfApplicationAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("DELIVERY_APPLICATION_ABORTED", { cause: signal.reason });
}

async function assertSourceOwnership(input: LocalIntegrationExecutionInput) {
  throwIfApplicationAborted(input.signal);
  await input.assertSourceOwnership?.();
  throwIfApplicationAborted(input.signal);
}

async function assertTargetOwnership(input: LocalIntegrationExecutionInput) {
  throwIfApplicationAborted(input.signal);
  await input.assertTargetOwnership?.();
  throwIfApplicationAborted(input.signal);
}

function isTrustedIndexCheck(command: VerificationCommand) {
  return command.command === "git"
    && command.argsPrefix.length === 3
    && command.argsPrefix[0] === "diff"
    && command.argsPrefix[1] === "--cached"
    && command.argsPrefix[2] === "--check";
}

export async function rerunIntegrationTests(repoPath: string, commands: { command: string; argsPrefix: string[] }[]) {
  const commandResults: any[] = [];
  for (const item of commands) {
    try { const result = await execFileAsync(item.command, item.argsPrefix, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }); commandResults.push({ command: item.command, args: item.argsPrefix, code: 0, stdout: result.stdout, stderr: result.stderr }); }
    catch (error: any) { commandResults.push({ command: item.command, args: item.argsPrefix, code: error?.code ?? 1, stdout: error?.stdout || "", stderr: error?.stderr || error?.message || "" }); return { status: "test_failed" as const, commandResults }; }
  }
  return { status: "completed" as const, commandResults };
}
