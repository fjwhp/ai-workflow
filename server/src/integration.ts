import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getCommitSnapshot, getWorktreeSnapshot, inspectActualWorktreeIdentity } from "./repository.js";
import { buildVerificationPlan, type VerificationCommand } from "./verification-plan.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 16_384;
const MAX_CONFLICT_FILES = 1_024;
const MAX_CONFLICT_FILES_BYTES = 262_144;
const TRUNCATED_OUTPUT_MARKER = "\n[truncated]";

export interface FrozenApplicationInput {
  projectRepoPath: string;
  targetWorktreePath: string;
  targetBranch: string;
  sourceWorktreePath: string;
  sourceBranch: string;
  evidenceHash: string;
  sensitivePatterns: string[];
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
  onSourcePrepared?: (sourceCommit: string) => void | Promise<void>;
};

export type TargetState = {
  identityValid: boolean;
  clean: boolean;
  head: string;
  statusPorcelain: string;
};

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", [
    "-C", cwd,
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "core.fsmonitor=false",
    ...args
  ], { maxBuffer: 10 * 1024 * 1024 });
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

async function inspectRegisteredWorktree(input: FrozenApplicationInput, kind: "target" | "source") {
  const candidatePath = kind === "target" ? input.targetWorktreePath : input.sourceWorktreePath;
  const branch = kind === "target" ? input.targetBranch : input.sourceBranch;
  try {
    const [projectPath, candidate] = await Promise.all([
      realpath(resolve(input.projectRepoPath)), realpath(resolve(candidatePath))
    ]);
    if (kind === "target" && candidate === projectPath) {
      return { valid: false as const, status: "project_root_forbidden", path: candidate };
    }
    const identity = await inspectActualWorktreeIdentity(projectPath, candidate, branch);
    if (!identity.valid) return { valid: false as const, status: identity.status, path: candidate };
    const { stdout } = await git(projectPath, ["worktree", "list", "--porcelain", "-z"]);
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
  } catch {
    return { valid: false as const, status: "not_accessible", path: candidatePath };
  }
}

async function inspectTargetState(input: FrozenApplicationInput): Promise<TargetState> {
  const identity = await inspectRegisteredWorktree(input, "target");
  if (!identity.valid) return { identityValid: false, clean: false, head: "", statusPorcelain: "" };
  try {
    const [{ stdout: head }, { stdout: statusPorcelain }] = await Promise.all([
      git(identity.path, ["rev-parse", "HEAD"]), git(identity.path, ["status", "--porcelain=v1", "--untracked-files=all"])
    ]);
    return { identityValid: true, clean: statusPorcelain.length === 0, head: head.trim(), statusPorcelain };
  } catch {
    return { identityValid: false, clean: false, head: "", statusPorcelain: "" };
  }
}

async function changedTargetFiles(worktreePath: string) {
  const outputs = await Promise.all([
    git(worktreePath, ["diff", "--name-only", "-z"]),
    git(worktreePath, ["diff", "--cached", "--name-only", "-z"]),
    git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
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

export async function preflightLocalIntegration(
  input: FrozenApplicationInput
): Promise<ApplicationPreflight> {
  const checks: ApplicationCheck[] = [];
  let evidenceMode: "worktree" | "commit" | undefined;
  let resolvedSourceCommit: string | undefined;
  const targetIdentity = await inspectRegisteredWorktree(input, "target");
  checks.push({ id: "target_identity", label: "目标工作树身份有效", ok: targetIdentity.valid, detail: targetIdentity.valid ? targetIdentity.path : targetIdentity.status });
  try {
    const branch = (await git(input.targetWorktreePath, ["branch", "--show-current"])).stdout.trim();
    checks.push({ id: "target_branch", label: "目标分支正确", ok: branch === input.targetBranch, detail: branch || "游离 HEAD" });
    const status = (await git(input.targetWorktreePath, ["status", "--porcelain"])).stdout;
    checks.push({
      id: "target_clean",
      label: "目标工作树干净",
      ok: status.length === 0,
      detail: status ? boundedCommandOutput(status) : "没有本地修改"
    });
  } catch { checks.push({ id: "target_branch", label: "目标分支正确", ok: false, detail: "无法读取目标分支" }); }
  const sourceIdentity = await inspectRegisteredWorktree(input, "source");
  checks.push({ id: "source_identity", label: "来源工作树身份有效", ok: sourceIdentity.valid, detail: sourceIdentity.valid ? sourceIdentity.path : sourceIdentity.status });
  try {
    const branch = (await git(input.sourceWorktreePath, ["branch", "--show-current"])).stdout.trim();
    checks.push({ id: "source_branch", label: "AI 分支匹配", ok: branch === input.sourceBranch, detail: branch || "游离 HEAD" });
    if (input.sourceCommit) {
      const commit = (await git(input.sourceWorktreePath, ["rev-parse", "--verify", `${input.sourceCommit}^{commit}`])).stdout.trim();
      await git(input.sourceWorktreePath, ["merge-base", "--is-ancestor", commit, input.sourceBranch]);
      const evidence = await getCommitSnapshot(input.sourceWorktreePath, commit, {
        sensitivePatterns: input.sensitivePatterns
      });
      checks.push({ id: "source_changes", label: "存在待合并变更", ok: evidence.files.length > 0 && evidence.diff.length > 0, detail: `${evidence.files.length} 个文件（已提交）` });
      checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: evidence.evidenceHash === input.evidenceHash, detail: evidence.evidenceHash.slice(0, 12) });
      evidenceMode = "commit";
      resolvedSourceCommit = commit;
    } else {
      const snapshot = await getWorktreeSnapshot(input.sourceWorktreePath, {
        sensitivePatterns: input.sensitivePatterns
      });
      checks.push({ id: "source_changes", label: "存在待合并变更", ok: snapshot.files.length > 0 && snapshot.diff.length > 0, detail: `${snapshot.files.length} 个文件` });
      checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: snapshot.evidenceHash === input.evidenceHash, detail: snapshot.evidenceHash.slice(0, 12) });
      evidenceMode = "worktree";
    }
  } catch { checks.push({ id: "source_branch", label: "AI 分支匹配", ok: false, detail: "AI worktree 不存在或不可访问" }); }
  const plan=input.changedFiles?await buildVerificationPlan({repoPath:input.targetWorktreePath,changedFiles:input.changedFiles,fallbackCommands:input.fallbackCommands||[]}):{changedModules:[],plannedCommands:input.fallbackCommands||[],commandSource:"project_fallback" as const};
  if(input.changedFiles)checks.push({id:"verification_plan",label:"自动测试计划",ok:plan.plannedCommands.length>0,detail:plan.plannedCommands.length?`${plan.plannedCommands.length} 条命令`:"未识别到安全测试命令"});
  let targetHead: string | undefined;
  if (targetIdentity.valid) {
    try { targetHead = (await git(targetIdentity.path, ["rev-parse", "HEAD"])).stdout.trim(); } catch { /* failed checks block application */ }
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
  const preflight = await preflightLocalIntegration({...input,fallbackCommands:input.fallbackCommands||input.commands});
  if (!preflight.allowed) {
    const target = await inspectTargetState(input);
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
  try {
    if (!sourceCommit) {
      await git(input.sourceWorktreePath, ["add", "--all"]);
      await git(input.sourceWorktreePath, ["commit", "-m", input.commitMessage]);
      sourceCommit = (await git(input.sourceWorktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    }
  } catch (error: any) {
    const target = await inspectTargetState(input);
    const safe = target.identityValid && target.clean && target.head === preApplyHead;
    return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
      targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
      error: String(error?.stderr || error?.message || error), commandResults: [] };
  }
  try {
    const sourceIdentityAfterCommit = await inspectRegisteredWorktree(input, "source");
    if (!sourceIdentityAfterCommit.valid) throw new Error("来源工作树身份在提交后失效");
    const evidence = await getCommitSnapshot(input.sourceWorktreePath, sourceCommit!, {
      sensitivePatterns: input.sensitivePatterns
    });
    if (!evidence.diff || evidence.evidenceHash !== input.evidenceHash) throw new Error("提交后的编码证据与原始证据不一致");
    await input.onSourcePrepared?.(sourceCommit!);
    const target = await inspectTargetState(input);
    if (!target.identityValid || !target.clean || target.head !== preApplyHead) {
      return { status: "ambiguous" as const, preflight, sourceCommit, preApplyHead, targetState: "uncertain" as const,
        statusPorcelain: target.statusPorcelain, error: "目标工作树在应用前发生变化", commandResults: [] };
    }
    await git(input.targetWorktreePath, ["cherry-pick", "--no-commit", sourceCommit!]);
  } catch (error: any) {
    const target = await inspectTargetState(input);
    let cherryPickActive = false;
    try { await git(input.targetWorktreePath, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]); cherryPickActive = true; }
    catch { /* No active cherry-pick. */ }
    const unmergedIndex = (await git(input.targetWorktreePath, ["ls-files", "-u", "-z"]).catch(() => ({ stdout: "" }))).stdout;
    if (!cherryPickActive && !unmergedIndex) {
      const safe = target.identityValid && target.clean && target.head === preApplyHead;
      return { status: safe ? "failed" as const : "ambiguous" as const, preflight, sourceCommit, preApplyHead,
        targetState: safe ? "untouched_clean" as const : "uncertain" as const, statusPorcelain: target.statusPorcelain,
        error: String(error?.stderr || error?.message || error), commandResults: [] };
    }
    let conflictFiles: string[] = [];
    try {
      conflictFiles = boundedConflictFiles((await git(input.targetWorktreePath, [
        "diff", "--name-only", "--diff-filter=U", "-z"
      ])).stdout.split("\0").filter(Boolean));
    }
    catch { /* Preserve the original error. */ }
    const evidence = await getCommitSnapshot(input.sourceWorktreePath, sourceCommit!, {
      sensitivePatterns: input.sensitivePatterns
    });
    const changedFiles = await changedTargetFiles(input.targetWorktreePath).catch(() => []);
    let rollbackError = "";
    let rollbackPostcondition: TargetState | undefined;
    if (changedFiles.every((file) => evidence.files.includes(file))) {
      try {
        const existing: string[] = [], added: string[] = [];
        for (const file of evidence.files) {
          try { await git(input.targetWorktreePath, ["cat-file", "-e", `${preApplyHead}:${file}`]); existing.push(file); }
          catch { added.push(file); }
        }
        if (existing.length) {
          await git(input.targetWorktreePath, ["restore", `--source=${preApplyHead}`, "--staged", "--worktree", "--", ...existing]);
        }
        if (added.length) await git(input.targetWorktreePath, ["rm", "-f", "--ignore-unmatch", "--", ...added]);
        await git(input.targetWorktreePath, ["cherry-pick", "--quit"]).catch(() => undefined);
        const restored = await inspectTargetState(input);
        rollbackPostcondition = restored;
        if (restored.identityValid && restored.clean && restored.head === preApplyHead) {
          return { status: "conflict" as const, preflight, sourceCommit, preApplyHead,
            targetState: "rolled_back_clean" as const, statusPorcelain: "", conflictFiles,
            error: String(error?.stderr || error?.message || error), commandResults: [] };
        }
      } catch (rollbackCause: any) {
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
  for (const item of commands) {
    try {
      const result = await execFileAsync(item.command, item.argsPrefix, { cwd: input.targetWorktreePath, maxBuffer: 10 * 1024 * 1024 });
      commandResults.push({
        command: item.command,
        args: item.argsPrefix,
        code: 0,
        stdout: boundedCommandOutput(result.stdout),
        stderr: boundedCommandOutput(result.stderr)
      });
    } catch (error: any) {
      commandResults.push({
        command: item.command,
        args: item.argsPrefix,
        code: Number.isSafeInteger(error?.code) ? error.code : 1,
        stdout: boundedCommandOutput(error?.stdout),
        stderr: boundedCommandOutput(error?.stderr || error?.message)
      });
      const statusPorcelain = (await git(input.targetWorktreePath, ["status", "--porcelain"])).stdout;
      return { status: "test_failed" as const, preflight, sourceCommit, preApplyHead, targetState: "applied_dirty" as const, statusPorcelain, commandResults, error: "本地应用后测试失败" };
    }
  }
  const statusPorcelain = (await git(input.targetWorktreePath, ["status", "--porcelain"])).stdout;
  return { status: "completed" as const, preflight, sourceCommit, preApplyHead, targetState: "applied_dirty" as const, statusPorcelain, commandResults, error: null };
}

export async function rerunIntegrationTests(repoPath: string, commands: { command: string; argsPrefix: string[] }[]) {
  const commandResults: any[] = [];
  for (const item of commands) {
    try { const result = await execFileAsync(item.command, item.argsPrefix, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }); commandResults.push({ command: item.command, args: item.argsPrefix, code: 0, stdout: result.stdout, stderr: result.stderr }); }
    catch (error: any) { commandResults.push({ command: item.command, args: item.argsPrefix, code: error?.code ?? 1, stdout: error?.stdout || "", stderr: error?.stderr || error?.message || "" }); return { status: "test_failed" as const, commandResults }; }
  }
  return { status: "completed" as const, commandResults };
}
