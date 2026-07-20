import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { safeReadWorktreeFileBuffer } from "./worktree-file-safety.js";

const execFileAsync = promisify(execFile);
const protectedBranches=new Set(["prod","production","main","master"]);
type GitConfigEntry = readonly [key: string, value: string];

function codingGitEnvironment(config: readonly GitConfigEntry[] = []) {
  const env = { ...process.env };
  const exact = new Set([
    "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
    "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"
  ]);
  for (const key of Object.keys(env)) {
    if (exact.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function codingFilterOverrides(repoPath: string): Promise<GitConfigEntry[]> {
  let stdout = "";
  try {
    stdout = (await execFileAsync("git", ["-C", repoPath, "config", "--name-only", "--get-regexp",
      "^filter\\..*\\.(smudge|process|required)$"], { env: codingGitEnvironment() })).stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const names = new Set<string>();
  for (const key of stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = /^filter\.(.+)\.(smudge|process|required)$/i.exec(key);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].flatMap<GitConfigEntry>((name) => [
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"]
  ]);
}

function codingGitEnvironmentWithFsmonitor(config: readonly GitConfigEntry[] = []) {
  return codingGitEnvironment([["core.fsmonitor", "false"], ...config]);
}

export type ActualWorktreeIdentity =
  | { valid: true; path: string; branch: string; headCommit: string }
  | { valid: false; status: "not_accessible" | "repository_mismatch" | "branch_mismatch" };

export type GitFailureKind = "not_found" | "command_failed" | "unavailable";

export function classifyGitFailure(error: unknown): GitFailureKind {
  const failure = error as { code?: unknown; signal?: unknown };
  if (failure?.signal || typeof failure?.code !== "number") return "unavailable";
  return failure.code === 1 ? "not_found" : "command_failed";
}

export function isProtectedBranch(branch:string){return protectedBranches.has(branch.toLowerCase());}

export async function getLocalBranches(repoPath:string){
  const [{stdout:currentOutput},{stdout:branchesOutput}]=await Promise.all([
    execFileAsync("git",["-C",repoPath,"branch","--show-current"]),
    execFileAsync("git",["-C",repoPath,"branch","--format=%(refname:short)"])
  ]);
  const currentBranch=currentOutput.trim();
  const names=branchesOutput.split("\n").map(item=>item.trim()).filter(Boolean).sort((a,b)=>a.localeCompare(b));
  return {currentBranch,branches:names.map(name=>({name,current:name===currentBranch,protected:isProtectedBranch(name)}))};
}

export async function validateRepository(repoPath: string) {
  try {
    const [actualPath, { stdout }] = await Promise.all([
      realpath(resolve(repoPath)),
      execFileAsync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"])
    ]);
    return await realpath(stdout.trim()) === actualPath;
  } catch {
    return false;
  }
}

async function canonicalGitCommonDir(repoOrWorktreePath: string) {
  const { stdout } = await execFileAsync("git", ["-C", repoOrWorktreePath, "rev-parse", "--git-common-dir"]);
  return realpath(resolve(repoOrWorktreePath, stdout.trim()));
}

const worktreeMutationLocks = new Map<string, Promise<void>>();

export async function withRepoWorktreeMutationLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
  const key = await canonicalGitCommonDir(repoPath);
  const predecessor = worktreeMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = predecessor.then(() => gate);
  worktreeMutationLocks.set(key, tail);
  await predecessor;
  try { return await operation(); }
  finally {
    release();
    if (worktreeMutationLocks.get(key) === tail) worktreeMutationLocks.delete(key);
  }
}

export async function inspectActualWorktreeIdentity(
  repoPath: string,
  candidatePath: string,
  expectedBranch: string
): Promise<ActualWorktreeIdentity> {
  let canonicalCandidate: string;
  try { canonicalCandidate = await realpath(resolve(candidatePath)); }
  catch { return { valid: false, status: "not_accessible" }; }
  try {
    const [{ stdout: topLevel }, repoCommonDir, candidateCommonDir] = await Promise.all([
      execFileAsync("git", ["-C", canonicalCandidate, "rev-parse", "--show-toplevel"]),
      canonicalGitCommonDir(repoPath),
      canonicalGitCommonDir(canonicalCandidate)
    ]);
    if (await realpath(resolve(canonicalCandidate, topLevel.trim())) !== canonicalCandidate) {
      return { valid: false, status: "repository_mismatch" };
    }
    if (candidateCommonDir !== repoCommonDir) return { valid: false, status: "repository_mismatch" };
    const [{ stdout: branch }, { stdout: head }] = await Promise.all([
      execFileAsync("git", ["-C", canonicalCandidate, "symbolic-ref", "--quiet", "HEAD"]),
      execFileAsync("git", ["-C", canonicalCandidate, "rev-parse", "HEAD"])
    ]);
    const actualBranch = branch.trim();
    if (actualBranch !== `refs/heads/${expectedBranch}`) return { valid: false, status: "branch_mismatch" };
    return { valid: true, path: canonicalCandidate, branch: actualBranch, headCommit: head.trim() };
  } catch {
    return { valid: false, status: "not_accessible" };
  }
}

interface RegisteredWorktree { path: string; branch?: string; baseCommit: string }

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
  const result: RegisteredWorktree[] = [];
  let current: Partial<RegisteredWorktree> = {};
  const finish = () => {
    if (current.path && current.baseCommit) result.push(current as RegisteredWorktree);
    current = {};
  };
  for (const field of output.split("\0")) {
    if (!field) { finish(); continue; }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.baseCommit = value;
    if (key === "branch") current.branch = value;
  }
  finish();
  return result;
}

async function requirementRepoPath(repoPath: string) {
  const requested = resolve(repoPath);
  let canonical: string;
  try {
    canonical = await realpath(requested);
    const { stdout } = await execFileAsync("git", ["-C", canonical, "rev-parse", "--show-toplevel"]);
    if (await realpath(stdout.trim()) !== canonical) throw new Error("REPOSITORY_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "REPOSITORY_INVALID") throw error;
    throw new Error("REPOSITORY_INVALID");
  }
  return canonical;
}

async function validateLocalBranch(repoPath: string, branch: string, invalidCode: string, missingCode: string) {
  try { await execFileAsync("git", ["check-ref-format", "--branch", branch]); }
  catch (error) {
    if (classifyGitFailure(error) === "unavailable") throw new Error("REQUIREMENT_GIT_UNAVAILABLE", { cause: error });
    throw new Error(invalidCode);
  }
  try { await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); }
  catch (error) {
    if (classifyGitFailure(error) === "not_found") throw new Error(missingCode);
    throw new Error("REQUIREMENT_GIT_UNAVAILABLE", { cause: error });
  }
}

async function localBranchExists(repoPath: string, branch: string) {
  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (classifyGitFailure(error) === "not_found") return false;
    throw new Error("REQUIREMENT_GIT_UNAVAILABLE", { cause: error });
  }
}

function isInside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

async function ensureRequirementDirectory(parent: string, segments: string[]) {
  let path = resolve(parent);
  let canonicalPath = await realpath(path);
  for (const segment of segments) {
    path = resolve(path, segment);
    canonicalPath = resolve(canonicalPath, segment);
    let entry;
    try { entry = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
      try { await mkdir(path); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
      }
      try { entry = await lstat(path); }
      catch { throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE"); }
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    if (await realpath(path) !== canonicalPath) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
  }
  return { path, canonicalPath };
}

async function findRegisteredWorktree(repoPath: string, branch: string, managedRoot: string) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain", "-z"]);
  const matches = parseRegisteredWorktrees(stdout).filter((item) => item.branch === `refs/heads/${branch}`);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error("REQUIREMENT_WORKTREE_AMBIGUOUS");
  let canonicalPath: string;
  try { canonicalPath = await realpath(matches[0]!.path); }
  catch { throw new Error("REQUIREMENT_WORKTREE_INVALID"); }
  const canonicalParent = await realpath(resolve(repoPath, ".."));
  const expectedCanonicalRoot = resolve(canonicalParent, ".ai-workflow-worktrees", basename(repoPath), "requirements");
  let canonicalRoot = expectedCanonicalRoot;
  try {
    canonicalRoot = await realpath(managedRoot);
    if (canonicalRoot !== expectedCanonicalRoot) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
  } catch (error) {
    if (error instanceof Error && error.message === "REQUIREMENT_WORKTREE_PATH_ESCAPE") throw error;
  }
  if (!isInside(canonicalRoot, canonicalPath)) throw new Error("REQUIREMENT_WORKTREE_OUTSIDE_MANAGED_ROOT");
  const identity = await inspectActualWorktreeIdentity(repoPath, canonicalPath, branch);
  if (!identity.valid) throw new Error("REQUIREMENT_WORKTREE_IDENTITY_MISMATCH");
  const deterministicPath = resolve(canonicalRoot, branch.slice("ai/".length));
  if (canonicalPath !== deterministicPath) throw new Error("REQUIREMENT_WORKTREE_PATH_MISMATCH");
  return { ...matches[0]!, path: deterministicPath, baseCommit: identity.headCommit };
}

async function requirementBaseMetadataPath(worktreePath:string){
  const {stdout}=await execFileAsync("git",["-C",worktreePath,"rev-parse","--git-path","ai-workflow-base-commit"]);
  return resolve(worktreePath,stdout.trim());
}

async function validateRequirementBaseCommit(repoPath:string,branch:string,baseCommit:string){
  if(!/^[0-9a-f]{40,64}$/i.test(baseCommit))throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE");
  try{
    await execFileAsync("git",["-C",repoPath,"cat-file","-e",`${baseCommit}^{commit}`]);
    await execFileAsync("git",["-C",repoPath,"merge-base","--is-ancestor",baseCommit,branch]);
  }catch{throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE");}
  return baseCommit;
}

async function validateSnapshotCommit(repoPath:string,baseCommit:string){
  if(!/^[0-9a-f]{40,64}$/i.test(baseCommit))throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE");
  try{await execFileAsync("git",["-C",repoPath,"cat-file","-e",`${baseCommit}^{commit}`]);}
  catch{throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE");}
  return baseCommit;
}

async function recoverRequirementBaseCommit(repoPath:string,branch:string){
  try{
    const {stdout}=await execFileAsync("git",["-C",repoPath,"reflog","show","--format=%H",`refs/heads/${branch}`]);
    const baseCommit=stdout.split("\n").map((item)=>item.trim()).filter(Boolean).at(-1);
    if(!baseCommit)throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE");
    return validateRequirementBaseCommit(repoPath,branch,baseCommit);
  }catch(error){if(error instanceof Error&&error.message==="REQUIREMENT_BASE_COMMIT_UNAVAILABLE")throw error;throw new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE",{cause:error});}
}

async function writeRequirementBaseCommit(worktreePath:string,baseCommit:string){
  await writeFile(await requirementBaseMetadataPath(worktreePath),`${baseCommit}\n`,"utf8");
}

async function readOrRecoverRequirementBaseCommit(repoPath:string,worktreePath:string,branch:string){
  const metadataPath=await requirementBaseMetadataPath(worktreePath);
  try{return await validateRequirementBaseCommit(repoPath,branch,(await readFile(metadataPath,"utf8")).trim());}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error instanceof Error&&error.message==="REQUIREMENT_BASE_COMMIT_UNAVAILABLE"?error:new Error("REQUIREMENT_BASE_COMMIT_UNAVAILABLE",{cause:error});
    const recovered=await recoverRequirementBaseCommit(repoPath,branch);await writeRequirementBaseCommit(worktreePath,recovered);return recovered;
  }
}

export async function cleanupFailedManagedWorktreeCreation(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  ownedHead?: string;
  targetReserved: boolean;
  worktreeAddAttempted: boolean;
  worktreeAdded: boolean;
  requireClean?: boolean;
}) {
  let removed = false;
  const mayOwnTarget = input.targetReserved && (input.worktreeAddAttempted || input.worktreeAdded);
  if (mayOwnTarget) {
    let targetRegistration: RegisteredWorktree | undefined;
    try {
      const { stdout } = await execFileAsync("git", ["-C", input.repoPath, "worktree", "list", "--porcelain", "-z"]);
      for (const item of parseRegisteredWorktrees(stdout)) {
        let registeredPath = resolve(item.path);
        try { registeredPath = await realpath(item.path); } catch { /* keep registered lexical path */ }
        if (registeredPath === input.worktreePath) { targetRegistration = item; break; }
      }
    } catch { /* do not touch an unverified target */ }

    if (input.requireClean && targetRegistration && targetRegistration.branch !== `refs/heads/${input.branch}`) return false;
    if (targetRegistration?.branch === `refs/heads/${input.branch}`) {
      const identity = await inspectActualWorktreeIdentity(input.repoPath, input.worktreePath, input.branch);
      if (identity.valid && identity.path === input.worktreePath) {
        if (input.requireClean) {
          try {
            await execFileAsync("git", ["-C", input.repoPath, "worktree", "remove", input.worktreePath]);
            removed = true;
          } catch { return false; }
        } else {
          await execFileAsync("git", ["-C", input.repoPath, "worktree", "remove", "--force", input.worktreePath]).catch(() => undefined);
          await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
          removed = true;
        }
      }
    } else if (!targetRegistration) {
      if (input.requireClean) return false;
      let safeToRemove = false;
      try {
        safeToRemove = (await readdir(input.worktreePath)).length === 0;
        if (!safeToRemove) {
          const identity = await inspectActualWorktreeIdentity(input.repoPath, input.worktreePath, input.branch);
          safeToRemove = identity.valid && identity.path === input.worktreePath;
        }
      } catch { /* missing or unverifiable targets need no cleanup */ }
      if (safeToRemove) await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (!input.ownedHead) return removed;
  try {
    const { stdout } = await execFileAsync("git", ["-C", input.repoPath, "worktree", "list", "--porcelain", "-z"]);
    const stillInUse = parseRegisteredWorktrees(stdout).some((item) => item.branch === `refs/heads/${input.branch}`);
    if (!stillInUse) {
      await execFileAsync("git", ["-C", input.repoPath, "update-ref", "-d", `refs/heads/${input.branch}`, input.ownedHead]);
    }
  } catch { /* best-effort rollback without touching pre-existing refs */ }
  return removed;
}

export async function createOrReuseRequirementWorktree(
  repoPath: string,
  baseBranch: string,
  requirementCode: string,
  expectedBaseCommit?: string
) {
  if (!/^REQ-[0-9]{4,}$/.test(requirementCode)) throw new Error("REQUIREMENT_CODE_INVALID");
  repoPath = await requirementRepoPath(repoPath);
  const branch = `ai/${requirementCode}`;
  return withRepoWorktreeMutationLock(repoPath, async () => {
    await validateLocalBranch(repoPath, baseBranch, "REQUIREMENT_BASE_BRANCH_INVALID", "REQUIREMENT_BASE_BRANCH_NOT_FOUND");
    if (expectedBaseCommit) await validateSnapshotCommit(repoPath, expectedBaseCommit);
    const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "requirements");
    const worktreePath = resolve(root, requirementCode);
    const existing = await findRegisteredWorktree(repoPath, branch, root);
    if (existing) {
      const baseCommit = await readOrRecoverRequirementBaseCommit(repoPath, existing.path, branch);
      if (expectedBaseCommit && (baseCommit !== expectedBaseCommit || existing.baseCommit !== expectedBaseCommit)) {
        throw new Error("DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH");
      }
      return { branch, worktreePath: existing.path, baseCommit, reused: true };
    }

    await ensureRequirementDirectory(resolve(repoPath, ".."), [
      ".ai-workflow-worktrees", basename(repoPath), "requirements"
    ]);
    if (!isInside(root, worktreePath)) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    try {
      await lstat(worktreePath);
      throw new Error("REQUIREMENT_WORKTREE_PATH_IN_USE");
    } catch (error) {
      if (error instanceof Error && error.message === "REQUIREMENT_WORKTREE_PATH_IN_USE") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("REQUIREMENT_WORKTREE_PATH_IN_USE");
    }

    const branchExists = await localBranchExists(repoPath, branch);
    if (expectedBaseCommit && branchExists) {
      const branchHead = (await execFileAsync("git", ["-C", repoPath, "rev-parse", `refs/heads/${branch}`])).stdout.trim();
      if (branchHead !== expectedBaseCommit) throw new Error("DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH");
    }
    let ownedHead: string | undefined;
    let targetReserved = false;
    let worktreeAddAttempted = false;
    let worktreeAdded = false;
    try {
      if (!branchExists) {
        const baseHead = expectedBaseCommit ?? (await execFileAsync("git", ["-C", repoPath, "rev-parse", baseBranch])).stdout.trim();
        await execFileAsync("git", ["-C", repoPath, "update-ref", `refs/heads/${branch}`, baseHead, ""]);
        ownedHead = baseHead;
      }
      await mkdir(worktreePath);
      targetReserved = true;
      worktreeAddAttempted = true;
      const hooksPath = await mkdtemp(join(tmpdir(), "ai-workflow-empty-hooks-"));
      try {
        const filterOverrides = await codingFilterOverrides(repoPath);
        await execFileAsync("git", [
          "-C", repoPath, "worktree", "add", worktreePath, branch
        ], { env: codingGitEnvironmentWithFsmonitor([
          ["core.hooksPath", hooksPath],
          ...filterOverrides
        ]) });
      } finally {
        await rm(hooksPath, { recursive: true, force: true });
      }
      worktreeAdded = true;
      const created = await findRegisteredWorktree(repoPath, branch, root);
      if (!created || created.path !== worktreePath) throw new Error("REQUIREMENT_WORKTREE_POSTCONDITION_FAILED");
      const baseCommit=ownedHead??await recoverRequirementBaseCommit(repoPath,branch);
      if (expectedBaseCommit && (baseCommit !== expectedBaseCommit || created.baseCommit !== expectedBaseCommit)) {
        throw new Error("DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH");
      }
      await writeRequirementBaseCommit(worktreePath,baseCommit);
      return { branch, worktreePath, baseCommit, reused: false };
    } catch (cause) {
      await cleanupFailedManagedWorktreeCreation({
        repoPath, worktreePath, branch, ownedHead, targetReserved, worktreeAddAttempted, worktreeAdded
      });
      if(cause instanceof Error&&(cause.message==="REQUIREMENT_BASE_COMMIT_UNAVAILABLE"||cause.message==="DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH"))throw cause;
      throw new Error("REQUIREMENT_WORKTREE_CREATE_FAILED", { cause });
    }
  });
}

export async function createIsolatedWorktree(repoPath: string, defaultBranch: string, requirementCode: string, _runId: string) {
  return createOrReuseRequirementWorktree(repoPath, defaultBranch, requirementCode);
}

export async function getWorktreeDiff(worktreePath: string) {
  const { stdout } = await execFileAsync("git", [
    "-C", worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--", "."
  ], { maxBuffer: 10 * 1024 * 1024, env: codingGitEnvironmentWithFsmonitor() });
  return stdout;
}

export async function getWorktreeSnapshot(worktreePath: string) {
  const env = codingGitEnvironmentWithFsmonitor();
  const tracked = await getCompleteTrackedDiff(worktreePath, env);
  const { stdout: status } = await execFileAsync("git", [
    "-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"
  ], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any, env });
  const entries = Buffer.from(status as any).toString("utf8").split("\0").filter(Boolean);
  const { stdout: untrackedOutput } = await execFileAsync("git", [
    "-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"
  ], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any, env });
  const untracked = Buffer.from(untrackedOutput as any).toString("utf8").split("\0").filter(Boolean);
  const trackedFiles = entries.filter((entry) => !entry.startsWith("?? ")).map((entry) => entry.slice(3)).filter(Boolean);
  const files = [...new Set([...trackedFiles, ...untracked])];
  const statuses = new Map(entries.map((entry) => [entry.slice(3), entry.slice(0, 2)]));
  const patches: string[] = [tracked];
  for (const file of untracked) {
    const content = await safeReadWorktreeFileBuffer(worktreePath, file);
    let text: string | undefined;
    if (!content.includes(0)) {
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
      catch { /* binary content */ }
    }
    if (text === undefined) {
      const digest = createHash("sha256").update(content).digest("hex");
      patches.push(`diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\nbinary-size: ${content.length}\nbinary-sha256: ${digest}\n`);
    } else {
      const lines = text.split("\n");
      patches.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
    }
  }
  const diff = patches.filter(Boolean).join("\n");
  const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const changedFiles = await Promise.all(files.map(async (file) => {
    const statusCode = statuses.get(file) ?? "??";
    if (statusCode.includes("D")) return { path: file, status: "deleted" as const };
    const content = await safeReadWorktreeFileBuffer(worktreePath, file);
    const status = statusCode === "??" || statusCode.includes("A") ? "added" as const : "modified" as const;
    let text: string | undefined;
    if (!content.includes(0)) {
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); } catch {}
    }
    if (text !== undefined) return { path: file, status, kind: "text" as const, content: text };
    return {
      path: file, status, kind: "binary" as const, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    };
  }));
  return { diff, files, changedFiles, additions, deletions };
}

async function getCompleteTrackedDiff(worktreePath: string, env: NodeJS.ProcessEnv) {
  const options = { maxBuffer: 10 * 1024 * 1024, env };
  const args = ["--binary", "--full-index", "--no-ext-diff", "--no-textconv"];
  let hasHead = true;
  try {
    await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--verify", "--quiet", "HEAD"], options);
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown };
    if (failure.code !== 1 || failure.signal) throw error;
    hasHead = false;
  }
  if (hasHead) {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "diff", ...args, "HEAD", "--", "."], options);
    return stdout;
  }
  const [{ stdout: staged }, { stdout: unstaged }] = await Promise.all([
    execFileAsync("git", ["-C", worktreePath, "diff", ...args, "--cached", "--", "."], options),
    execFileAsync("git", ["-C", worktreePath, "diff", ...args, "--", "."], options)
  ]);
  return [staged, unstaged].filter(Boolean).join("\n");
}
