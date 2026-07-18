import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const protectedBranches=new Set(["prod","production","main","master"]);

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

export async function cleanupFailedManagedWorktreeCreation(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  ownedHead?: string;
  targetReserved: boolean;
  worktreeAddAttempted: boolean;
  worktreeAdded: boolean;
}) {
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

    if (targetRegistration?.branch === `refs/heads/${input.branch}`) {
      const identity = await inspectActualWorktreeIdentity(input.repoPath, input.worktreePath, input.branch);
      if (identity.valid && identity.path === input.worktreePath) {
        await execFileAsync("git", ["-C", input.repoPath, "worktree", "remove", "--force", input.worktreePath]).catch(() => undefined);
        await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (!targetRegistration) {
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

  if (!input.ownedHead) return;
  try {
    const { stdout } = await execFileAsync("git", ["-C", input.repoPath, "worktree", "list", "--porcelain", "-z"]);
    const stillInUse = parseRegisteredWorktrees(stdout).some((item) => item.branch === `refs/heads/${input.branch}`);
    if (!stillInUse) {
      await execFileAsync("git", ["-C", input.repoPath, "update-ref", "-d", `refs/heads/${input.branch}`, input.ownedHead]);
    }
  } catch { /* best-effort rollback without touching pre-existing refs */ }
}

export async function createOrReuseRequirementWorktree(repoPath: string, baseBranch: string, requirementCode: string) {
  if (!/^REQ-[0-9]{4,}$/.test(requirementCode)) throw new Error("REQUIREMENT_CODE_INVALID");
  repoPath = await requirementRepoPath(repoPath);
  const branch = `ai/${requirementCode}`;
  return withRepoWorktreeMutationLock(repoPath, async () => {
    await validateLocalBranch(repoPath, baseBranch, "REQUIREMENT_BASE_BRANCH_INVALID", "REQUIREMENT_BASE_BRANCH_NOT_FOUND");
    const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "requirements");
    const worktreePath = resolve(root, requirementCode);
    const existing = await findRegisteredWorktree(repoPath, branch, root);
    if (existing) return { branch, worktreePath: existing.path, baseCommit: existing.baseCommit, reused: true };

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
    let ownedHead: string | undefined;
    let targetReserved = false;
    let worktreeAddAttempted = false;
    let worktreeAdded = false;
    try {
      if (!branchExists) {
        const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", baseBranch]);
        const baseHead = stdout.trim();
        await execFileAsync("git", ["-C", repoPath, "update-ref", `refs/heads/${branch}`, baseHead, ""]);
        ownedHead = baseHead;
      }
      await mkdir(worktreePath);
      targetReserved = true;
      worktreeAddAttempted = true;
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", worktreePath, branch]);
      worktreeAdded = true;
      const created = await findRegisteredWorktree(repoPath, branch, root);
      if (!created || created.path !== worktreePath) throw new Error("REQUIREMENT_WORKTREE_POSTCONDITION_FAILED");
      return { branch, worktreePath, baseCommit: created.baseCommit, reused: false };
    } catch (cause) {
      await cleanupFailedManagedWorktreeCreation({
        repoPath, worktreePath, branch, ownedHead, targetReserved, worktreeAddAttempted, worktreeAdded
      });
      throw new Error("REQUIREMENT_WORKTREE_CREATE_FAILED", { cause });
    }
  });
}

export async function createIsolatedWorktree(repoPath: string, defaultBranch: string, requirementCode: string, _runId: string) {
  return createOrReuseRequirementWorktree(repoPath, defaultBranch, requirementCode);
}

export async function getWorktreeDiff(worktreePath: string) {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function getWorktreeSnapshot(worktreePath: string) {
  const { stdout: tracked } = await execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { maxBuffer: 10 * 1024 * 1024 });
  const { stdout: status } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain", "-z"], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any });
  const entries = Buffer.from(status as any).toString("utf8").split("\0").filter(Boolean);
  const { stdout: untrackedOutput } = await execFileAsync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any });
  const untracked = Buffer.from(untrackedOutput as any).toString("utf8").split("\0").filter(Boolean);
  const trackedFiles = entries.filter((entry) => !entry.startsWith("?? ")).map((entry) => entry.slice(3)).filter(Boolean);
  const files = [...new Set([...trackedFiles, ...untracked])];
  const patches: string[] = [tracked];
  for (const file of untracked) {
    const content = await readFile(resolve(worktreePath, file), "utf8");
    const lines = content.split("\n");
    patches.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
  }
  const diff = patches.filter(Boolean).join("\n");
  const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return { diff, files, additions, deletions };
}
