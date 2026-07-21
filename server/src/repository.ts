import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { captureCommitEvidence, captureWorktreeEvidence, type EvidenceOptions } from "./evidence-tree.js";

const execFileAsync = promisify(execFile);
const protectedBranches=new Set(["prod","production","main","master"]);
const CODING_ATTEMPT_OWNER_SUFFIX = ".owner.json";
type GitConfigEntry = readonly [key: string, value: string];

export interface CodingAttemptOwnership {
  version: 1;
  uid: number;
  nonce: string;
  dev: number;
  ino: number;
}

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
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
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

async function ensureRequirementDirectory(parent: string, segments: string[], finalMode?: number) {
  let path = resolve(parent);
  let canonicalPath = await realpath(path);
  for (const [index, segment] of segments.entries()) {
    path = resolve(path, segment);
    canonicalPath = resolve(canonicalPath, segment);
    let entry;
    try { entry = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
      try { await mkdir(path, index === segments.length - 1 && finalMode ? { mode: finalMode } : undefined); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
      }
      try { entry = await lstat(path); }
      catch { throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE"); }
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    if (await realpath(path) !== canonicalPath) throw new Error("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    if (index === segments.length - 1 && finalMode !== undefined) {
      const uid = typeof process.getuid === "function" ? process.getuid() : entry.uid;
      if (entry.uid !== uid || (entry.mode & 0o777) !== finalMode) {
        throw new Error("IMPLEMENTATION_ATTEMPT_ROOT_UNSAFE");
      }
    }
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

export async function createCodingAttemptWorktree(
  repoPath: string,
  baseCommit: string,
  signal?: AbortSignal
) {
  repoPath = await requirementRepoPath(repoPath);
  await validateSnapshotCommit(repoPath, baseCommit);
  const id = randomUUID();
  const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "implementation-attempts");
  const worktreePath = resolve(root, id);
  let attemptIdentity: CodingAttemptOwnership | undefined;
  await ensureRequirementDirectory(resolve(repoPath, ".."), [
    ".ai-workflow-worktrees", basename(repoPath), "implementation-attempts"
  ], 0o700);
  await withRepoWorktreeMutationLock(repoPath, async () => {
    await mkdir(worktreePath, { mode: 0o700 });
    const hooksPath = await mkdtemp(join(tmpdir(), "ai-workflow-empty-hooks-"));
    try {
      const filterOverrides = await codingFilterOverrides(repoPath);
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, baseCommit], {
        env: codingGitEnvironmentWithFsmonitor([["core.hooksPath", hooksPath], ...filterOverrides]), signal
      });
      const status = await lstat(worktreePath);
      const uid = typeof process.getuid === "function" ? process.getuid() : status.uid;
      if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== uid
        || (status.mode & 0o777) !== 0o700) {
        throw new Error("IMPLEMENTATION_ATTEMPT_ROOT_UNSAFE");
      }
      const ownership: CodingAttemptOwnership = {
        version: 1, uid, nonce: randomUUID(), dev: status.dev, ino: status.ino
      };
      attemptIdentity = ownership;
      await writeFile(codingAttemptMarkerPath(root, id), JSON.stringify(ownership), {
        encoding: "utf8", flag: "wx", mode: 0o600
      });
    } catch (error) {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(codingAttemptMarkerPath(root, id), { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(hooksPath, { recursive: true, force: true });
    }
  });
  if (!attemptIdentity) throw new Error("IMPLEMENTATION_ATTEMPT_IDENTITY_MISSING");
  return { branch: "HEAD", worktreePath, baseCommit, reused: false as const, attemptIdentity };
}

export async function cleanupCodingAttemptWorktree(repoPath: string, worktreePath: string) {
  repoPath = await requirementRepoPath(repoPath);
  await withRepoWorktreeMutationLock(repoPath, async () => {
    const owned = await validateCodingAttemptOwnership(repoPath, worktreePath);
    const quarantine = resolve(owned.root, `${owned.id}.quarantine-${owned.ownership.nonce}`);
    try {
      await rename(owned.path, quarantine);
    } catch (error) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED", { cause: error });
    }
    let pruneError: unknown;
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
        env: codingGitEnvironmentWithFsmonitor()
      });
    } catch (error) {
      pruneError = error;
    }
    try {
      await validateCodingAttemptQuarantine(quarantine, owned.ownership, owned.root);
      await rm(quarantine, { recursive: true });
      await rm(owned.markerPath);
    } catch (error) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED", { cause: error });
    }
    if (pruneError) throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED", { cause: pruneError });
  });
}

export async function cleanupJournaledCodingAttemptWorktree(
  repoPath: string,
  worktreePath: string,
  expected: CodingAttemptOwnership
) {
  repoPath = await requirementRepoPath(repoPath);
  if (!validCodingAttemptOwnership(expected)) {
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
  }
  await withRepoWorktreeMutationLock(repoPath, async () => {
    const id = basename(worktreePath);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "implementation-attempts");
    const path = resolve(root, id);
    if (resolve(worktreePath) !== path) throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    const rootStatus = await lstat(root);
    const uid = typeof process.getuid === "function" ? process.getuid() : rootStatus.uid;
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || rootStatus.uid !== uid
      || (rootStatus.mode & 0o777) !== 0o700 || await realpath(root) !== root || expected.uid !== uid) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    const markerPath = codingAttemptMarkerPath(root, id);
    const quarantine = resolve(root, `${id}.quarantine-${expected.nonce}`);
    const pathPresent = await entryExists(path);
    const markerPresent = await entryExists(markerPath);
    const quarantinePresent = await entryExists(quarantine);
    if (pathPresent) {
      const owned = await validateCodingAttemptOwnership(repoPath, path);
      assertCodingAttemptOwnership(owned.ownership, expected);
      if (quarantinePresent) throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
      await rename(path, quarantine).catch((error) => {
        throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED", { cause: error });
      });
    } else if (markerPresent) {
      assertCodingAttemptOwnership(await readCodingAttemptOwnership(markerPath, uid), expected);
    }
    if (pathPresent || quarantinePresent) {
      await validateCodingAttemptQuarantine(quarantine, expected, root);
      await rm(quarantine, { recursive: true });
    }
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
      env: codingGitEnvironmentWithFsmonitor()
    });
    let registrations = await registeredWorktreePaths(repoPath);
    if (registrations.has(path)) {
      await execFileAsync("git", ["-C", repoPath, "worktree", "remove", "--force", path], {
        env: codingGitEnvironmentWithFsmonitor()
      }).catch(() => undefined);
      await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
        env: codingGitEnvironmentWithFsmonitor()
      });
      registrations = await registeredWorktreePaths(repoPath);
    }
    if (registrations.has(path) || await entryExists(path) || await entryExists(quarantine)) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED");
    }
    if (await entryExists(markerPath)) {
      assertCodingAttemptOwnership(await readCodingAttemptOwnership(markerPath, uid), expected);
      await rm(markerPath);
    }
  });
}

async function registeredWorktreePaths(repoPath: string) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain", "-z"], {
    env: codingGitEnvironmentWithFsmonitor()
  });
  return new Set(parseRegisteredWorktrees(stdout).map((item) => resolve(item.path)));
}

async function entryExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertCodingAttemptOwnership(actual: CodingAttemptOwnership, expected: CodingAttemptOwnership) {
  if (actual.uid !== expected.uid || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.nonce !== expected.nonce || actual.version !== expected.version) {
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
  }
}

function codingAttemptMarkerPath(root: string, id: string) {
  return resolve(root, `${id}${CODING_ATTEMPT_OWNER_SUFFIX}`);
}

async function validateCodingAttemptOwnership(repoPath: string, worktreePath: string) {
  const id = basename(worktreePath);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
  }
  const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "implementation-attempts");
  const expectedPath = resolve(root, id);
  if (resolve(worktreePath) !== expectedPath) throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
  try {
    const [rootStatus, canonicalRoot, status, canonicalPath] = await Promise.all([
      lstat(root), realpath(root), lstat(expectedPath), realpath(expectedPath)
    ]);
    const uid = typeof process.getuid === "function" ? process.getuid() : status.uid;
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || rootStatus.uid !== uid
      || (rootStatus.mode & 0o777) !== 0o700 || canonicalRoot !== root
      || !status.isDirectory() || status.isSymbolicLink() || status.uid !== uid
      || (status.mode & 0o777) !== 0o700 || canonicalPath !== expectedPath) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    const markerPath = codingAttemptMarkerPath(root, id);
    const ownership = await readCodingAttemptOwnership(markerPath, uid);
    if (ownership.dev !== status.dev || ownership.ino !== status.ino) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    const candidateCommonDir = await canonicalGitCommonDir(expectedPath);
    if (candidateCommonDir !== await canonicalGitCommonDir(repoPath)) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    return { id, root, path: expectedPath, markerPath, ownership };
  } catch (error) {
    if (error instanceof Error && error.message === "IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID") throw error;
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID", { cause: error });
  }
}

async function validateCodingAttemptQuarantine(
  quarantine: string,
  ownership: CodingAttemptOwnership,
  root: string
) {
  const [status, canonical] = await Promise.all([lstat(quarantine), realpath(quarantine)]);
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== ownership.uid
    || (status.mode & 0o777) !== 0o700 || status.dev !== ownership.dev || status.ino !== ownership.ino
    || canonical !== quarantine || resolve(quarantine, "..") !== root) {
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
  }
}

async function readCodingAttemptOwnership(markerPath: string, uid: number): Promise<CodingAttemptOwnership> {
  let handle;
  try {
    handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const status = await handle.stat();
    if (!status.isFile() || status.uid !== uid || (status.mode & 0o777) !== 0o600 || status.size > 4096) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!validCodingAttemptOwnership(parsed) || parsed.uid !== uid) {
      throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID") throw error;
    throw new Error("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID", { cause: error });
  } finally {
    await handle?.close();
  }
}

function validCodingAttemptOwnership(value: unknown): value is CodingAttemptOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return Object.keys(marker).sort().join(",") === "dev,ino,nonce,uid,version"
    && marker.version === 1
    && [marker.uid, marker.dev, marker.ino].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
    && typeof marker.nonce === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.nonce);
}

export async function publishCodingAttemptDiff(input: {
  repoPath: string;
  authoritativeWorktreePath: string;
  baseCommit: string;
  diff: string;
  signal?: AbortSignal;
}) {
  return withRepoWorktreeMutationLock(input.repoPath, async () => {
    const before = await getWorktreeSnapshot(input.authoritativeWorktreePath);
    if (before.identity.headCommit !== input.baseCommit || before.diff !== "") {
      throw new Error("IMPLEMENTATION_AUTHORITATIVE_WORKTREE_DIRTY");
    }
    if (!input.diff) return { snapshot: before, rollback: async () => {}, discard: async () => {} };
    const patchRoot = await mkdtemp(join(tmpdir(), "ai-workflow-implementation-patch-"));
    const patchPath = join(patchRoot, "attempt.patch");
    await writeFile(patchPath, input.diff, { mode: 0o600 });
    let applied = false;
    try {
      const args = ["-C", input.authoritativeWorktreePath, "apply", "--binary", "--whitespace=nowarn"];
      await execFileAsync("git", [...args, "--check", patchPath], {
        env: codingGitEnvironmentWithFsmonitor(), signal: input.signal
      });
      await execFileAsync("git", [...args, patchPath], {
        env: codingGitEnvironmentWithFsmonitor(), signal: input.signal
      });
      applied = true;
      const snapshot = await getWorktreeSnapshot(input.authoritativeWorktreePath);
      return {
        snapshot,
        rollback: async () => {
          if (!applied) return;
          await withRepoWorktreeMutationLock(input.repoPath, async () => {
            await execFileAsync("git", [...args, "--reverse", patchPath], {
              env: codingGitEnvironmentWithFsmonitor()
            });
            applied = false;
          });
          await rm(patchRoot, { recursive: true, force: true });
        },
        discard: async () => {
          await rm(patchRoot, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (applied) {
        await execFileAsync("git", ["-C", input.authoritativeWorktreePath, "apply", "--binary",
          "--whitespace=nowarn", "--reverse", patchPath], {
          env: codingGitEnvironmentWithFsmonitor()
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!applied) await rm(patchRoot, { recursive: true, force: true });
    }
  });
}

export async function createIsolatedWorktree(repoPath: string, defaultBranch: string, requirementCode: string, _runId: string) {
  return createOrReuseRequirementWorktree(repoPath, defaultBranch, requirementCode);
}

export async function getWorktreeDiff(worktreePath: string) {
  return (await getWorktreeSnapshot(worktreePath)).diff;
}

export async function getWorktreeSnapshot(
  worktreePath: string,
  options: EvidenceOptions = {}
) {
  return captureWorktreeEvidence(worktreePath, codingGitEnvironmentWithFsmonitor(), options);
}

export async function getCommitSnapshot(
  worktreePath: string,
  commit: string,
  options: EvidenceOptions = {}
) {
  return captureCommitEvidence(worktreePath, commit, codingGitEnvironmentWithFsmonitor(), options);
}
