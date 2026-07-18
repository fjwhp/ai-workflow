import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProjectVersionValidation } from "@ai-workflow/shared";
import {
  classifyGitFailure,
  cleanupFailedManagedWorktreeCreation,
  inspectActualWorktreeIdentity,
  withRepoWorktreeMutationLock
} from "./repository.js";

const execFileAsync = promisify(execFile);

interface RegisteredWorktree {
  path: string;
  headCommit: string;
  branch?: string;
}

function fail(code: string): never {
  throw new Error(code);
}

async function git(repoPath: string, args: string[]) {
  return execFileAsync("git", ["-C", repoPath, ...args], { maxBuffer: 4 * 1024 * 1024 });
}

function parseWorktrees(output: string): RegisteredWorktree[] {
  const result: RegisteredWorktree[] = [];
  let current: Partial<RegisteredWorktree> = {};
  const finish = () => {
    if (current.path && current.headCommit) result.push(current as RegisteredWorktree);
    current = {};
  };
  for (const field of output.split("\0")) {
    if (!field) { finish(); continue; }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.headCommit = value;
    if (key === "branch") current.branch = value;
  }
  finish();
  return result;
}

async function registeredWorktrees(repoPath: string) {
  const { stdout } = await git(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  return parseWorktrees(stdout);
}

async function validateRepo(repoPath: string) {
  const requested = resolve(repoPath);
  let canonical: string;
  try {
    canonical = await realpath(requested);
    const { stdout } = await git(canonical, ["rev-parse", "--show-toplevel"]);
    if (await realpath(stdout.trim()) !== canonical) fail("PROJECT_VERSION_REPOSITORY_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECT_VERSION_REPOSITORY_INVALID") throw error;
    fail("PROJECT_VERSION_REPOSITORY_INVALID");
  }
  return canonical;
}

async function validateBranch(repoPath: string, branch: string, code: string) {
  if (!branch || branch.includes("\0")) fail(code);
  try { await execFileAsync("git", ["check-ref-format", "--branch", branch]); }
  catch (error) {
    if (classifyGitFailure(error) === "unavailable") throw new Error("PROJECT_VERSION_GIT_UNAVAILABLE", { cause: error });
    fail(code);
  }
}

async function localBranchExists(repoPath: string, branch: string) {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (classifyGitFailure(error) === "not_found") return false;
    throw new Error("PROJECT_VERSION_GIT_UNAVAILABLE", { cause: error });
  }
}

async function canonicalWorktree(worktree: RegisteredWorktree) {
  try { return { ...worktree, path: await realpath(worktree.path) }; }
  catch { return worktree; }
}

async function ensureManagedDirectory(parent: string, segments: string[]) {
  let path = resolve(parent);
  let canonicalPath = await realpath(path);
  for (const segment of segments) {
    path = resolve(path, segment);
    canonicalPath = resolve(canonicalPath, segment);
    let entry;
    try { entry = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("PROJECT_VERSION_PATH_ESCAPE");
      try { await mkdir(path); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") fail("PROJECT_VERSION_PATH_ESCAPE");
      }
      try { entry = await lstat(path); }
      catch { fail("PROJECT_VERSION_PATH_ESCAPE"); }
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("PROJECT_VERSION_PATH_ESCAPE");
    if (await realpath(path) !== canonicalPath) fail("PROJECT_VERSION_PATH_ESCAPE");
  }
  return { path, canonicalPath };
}

async function inspectCanonical(repoPath: string, branch: string, baseBranch: string): Promise<ProjectVersionValidation> {
  await validateBranch(repoPath, branch, "PROJECT_VERSION_BRANCH_INVALID");
  await validateBranch(repoPath, baseBranch, "PROJECT_VERSION_BASE_BRANCH_INVALID");
  if (!await localBranchExists(repoPath, baseBranch)) fail("PROJECT_VERSION_BASE_BRANCH_NOT_FOUND");

  const branchExists = await localBranchExists(repoPath, branch);
  if (!branchExists) {
    const { stdout } = await git(repoPath, ["rev-parse", baseBranch]);
    return { valid: true, branch, baseBranch, mode: "create_branch", headCommit: stdout.trim() };
  }
  const wantedRef = `refs/heads/${branch}`;
  const occupied = await Promise.all((await registeredWorktrees(repoPath)).filter((item) => item.branch === wantedRef).map(canonicalWorktree));
  if (!occupied.length) {
    const { stdout } = await git(repoPath, ["rev-parse", branch]);
    return { valid: true, branch, baseBranch, mode: "attach_branch", headCommit: stdout.trim() };
  }
  const projectRoot = await realpath(repoPath);
  if (occupied.some((item) => item.path === projectRoot)) fail("PROJECT_VERSION_BRANCH_IN_USE");
  if (occupied.length !== 1) fail("PROJECT_VERSION_BRANCH_IN_USE");
  const identity = await inspectActualWorktreeIdentity(repoPath, occupied[0]!.path, branch);
  if (!identity.valid) fail("PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH");
  return {
    valid: true, branch, baseBranch, mode: "reuse_worktree",
    headCommit: identity.headCommit, existingWorktreePath: identity.path
  };
}

export async function inspectProjectVersion(input: {
  repoPath: string; name: string; branch: string; baseBranch: string;
}): Promise<ProjectVersionValidation> {
  const repoPath = await validateRepo(input.repoPath);
  return inspectCanonical(repoPath, input.branch, input.baseBranch);
}

function validVersionId(versionId: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(versionId) && versionId !== "." && versionId !== "..";
}

async function prepareManagedTarget(repoPath: string, versionId: string, worktrees: RegisteredWorktree[]) {
  if (!validVersionId(versionId)) fail("PROJECT_VERSION_ID_INVALID");
  const versionsRoot = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "versions");
  const worktreePath = resolve(versionsRoot, versionId);
  if (relative(versionsRoot, worktreePath).startsWith(`..${sep}`)) fail("PROJECT_VERSION_PATH_ESCAPE");
  const { canonicalPath: canonicalRoot } = await ensureManagedDirectory(resolve(repoPath, ".."), [
    ".ai-workflow-worktrees", basename(repoPath), "versions"
  ]);
  const canonicalTarget = resolve(canonicalRoot, versionId);

  for (const item of worktrees) {
    let itemPath = item.path;
    try { itemPath = await realpath(item.path); } catch { /* stale registrations are not reusable */ }
    if (itemPath === canonicalTarget) fail("PROJECT_VERSION_PATH_IN_USE");
  }
  try {
    await lstat(worktreePath);
    fail("PROJECT_VERSION_PATH_IN_USE");
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECT_VERSION_PATH_IN_USE") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("PROJECT_VERSION_PATH_IN_USE");
  }
  return worktreePath;
}

async function inspectCreatedVersionWorktree(repoPath: string, branch: string, expectedPath: string) {
  const matches = (await registeredWorktrees(repoPath)).filter((item) => item.branch === `refs/heads/${branch}`);
  if (matches.length !== 1) throw new Error("PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED");
  let registeredPath: string;
  try { registeredPath = await realpath(matches[0]!.path); }
  catch { throw new Error("PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED"); }
  if (registeredPath !== expectedPath) throw new Error("PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED");
  const identity = await inspectActualWorktreeIdentity(repoPath, expectedPath, branch);
  if (!identity.valid) throw new Error("PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED");
  return identity;
}

export async function createProjectVersionWorktree(input: {
  repoPath: string; versionId: string; branch: string; baseBranch: string;
  mode: "create_branch" | "attach_branch" | "reuse_worktree";
  existingWorktreePath?: string; reuseExistingWorktree?: boolean;
}): Promise<{ worktreePath: string; headCommit: string; createdBranch: boolean; createdWorktree: boolean }> {
  const repoPath = await validateRepo(input.repoPath);
  if (!validVersionId(input.versionId)) fail("PROJECT_VERSION_ID_INVALID");
  return withRepoWorktreeMutationLock(repoPath, async () => {
    const inspected = await inspectCanonical(repoPath, input.branch, input.baseBranch);
    if (inspected.mode !== input.mode) fail("PROJECT_VERSION_MODE_MISMATCH");

    if (input.mode === "reuse_worktree") {
      if (!input.reuseExistingWorktree) fail("PROJECT_VERSION_REUSE_NOT_CONFIRMED");
      if (!input.existingWorktreePath || !inspected.existingWorktreePath) fail("PROJECT_VERSION_WORKTREE_MISMATCH");
      let requested: string;
      try { requested = await realpath(input.existingWorktreePath); }
      catch { fail("PROJECT_VERSION_WORKTREE_MISMATCH"); }
      if (requested !== inspected.existingWorktreePath) fail("PROJECT_VERSION_WORKTREE_MISMATCH");
      const identity = await inspectActualWorktreeIdentity(repoPath, requested, input.branch);
      if (!identity.valid) fail("PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH");
      const live = await inspectCreatedVersionWorktree(repoPath, input.branch, requested)
        .catch(() => fail("PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH"));
      return { worktreePath: requested, headCommit: live.headCommit, createdBranch: false, createdWorktree: false };
    }

    const worktreePath = await prepareManagedTarget(repoPath, input.versionId, await registeredWorktrees(repoPath));
    let ownedHead: string | undefined;
    let targetReserved = false;
    let worktreeAddAttempted = false;
    let worktreeAdded = false;
    try {
      if (input.mode === "create_branch") {
        const { stdout } = await git(repoPath, ["rev-parse", input.baseBranch]);
        const baseHead = stdout.trim();
        await git(repoPath, ["update-ref", `refs/heads/${input.branch}`, baseHead, ""]);
        ownedHead = baseHead;
      }
      await mkdir(worktreePath);
      targetReserved = true;
      worktreeAddAttempted = true;
      await git(repoPath, ["worktree", "add", worktreePath, input.branch]);
      worktreeAdded = true;
      const identity = await inspectCreatedVersionWorktree(repoPath, input.branch, worktreePath);
      return {
        worktreePath,
        headCommit: identity.headCommit,
        createdBranch: input.mode === "create_branch",
        createdWorktree: true
      };
    } catch (cause) {
      await cleanupFailedManagedWorktreeCreation({
        repoPath, worktreePath, branch: input.branch, ownedHead, targetReserved, worktreeAddAttempted, worktreeAdded
      });
      throw new Error("PROJECT_VERSION_WORKTREE_CREATE_FAILED", { cause });
    }
  });
}

export async function inspectVersionWorktree(input: {
  repoPath: string; worktreePath: string; branch: string;
}): Promise<{ valid: boolean; clean: boolean; headCommit: string; status: string }> {
  let repoPath: string;
  let worktreePath: string;
  try {
    repoPath = await validateRepo(input.repoPath);
    worktreePath = await realpath(resolve(input.worktreePath));
  } catch {
    return { valid: false, clean: false, headCommit: "", status: "not_accessible" };
  }
  if (worktreePath === await realpath(repoPath)) return { valid: false, clean: false, headCommit: "", status: "project_root_forbidden" };
  const registered = await Promise.all((await registeredWorktrees(repoPath)).map(canonicalWorktree));
  const found = registered.find((item) => item.path === worktreePath);
  if (!found) return { valid: false, clean: false, headCommit: "", status: "not_registered" };
  if (found.branch !== `refs/heads/${input.branch}`) {
    return { valid: false, clean: false, headCommit: "", status: "branch_mismatch" };
  }
  const identity = await inspectActualWorktreeIdentity(repoPath, worktreePath, input.branch);
  if (identity.valid === false) {
    return { valid: false, clean: false, headCommit: "", status: identity.status };
  }
  try {
    const { stdout: status } = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const clean = status.length === 0;
    return { valid: true, clean, headCommit: identity.headCommit, status: clean ? "ok" : "dirty" };
  } catch {
    return { valid: false, clean: false, headCommit: "", status: "not_accessible" };
  }
}
