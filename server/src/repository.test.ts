import { lstat, mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyGitFailure,
  cleanupFailedManagedWorktreeCreation,
  createOrReuseRequirementWorktree,
  getLocalBranches,
  getWorktreeSnapshot,
  isProtectedBranch
} from "./repository.js";

const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});

describe("getWorktreeSnapshot",()=>{
  it("includes files nested inside an untracked directory",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-git-"));dirs.push(dir);
    await exec("git",["init",dir]);
    await mkdir(join(dir,"src","test"),{recursive:true});
    await writeFile(join(dir,"src","test","new.txt"),"hello\n");
    const snapshot=await getWorktreeSnapshot(dir);
    expect(snapshot.files).toContain("src/test/new.txt");
    expect(snapshot.diff).toContain("+hello");
  });
});

describe("local integration branches",()=>{
  it("lists local branches and marks the current and protected branches",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-branches-"));dirs.push(dir);
    await exec("git",["init","-b","main",dir]);
    await exec("git",["-C",dir,"config","user.email","test@example.com"]);await exec("git",["-C",dir,"config","user.name","Test"]);
    await writeFile(join(dir,"README.md"),"base\n");await exec("git",["-C",dir,"add","--all"]);await exec("git",["-C",dir,"commit","-m","base"]);
    await exec("git",["-C",dir,"branch","feature/0710-test"]);await exec("git",["-C",dir,"switch","feature/0710-test"]);
    const result=await getLocalBranches(dir);
    expect(result.currentBranch).toBe("feature/0710-test");
    expect(result.branches).toEqual([
      {name:"feature/0710-test",current:true,protected:false},
      {name:"main",current:false,protected:true}
    ]);
    expect(isProtectedBranch("prod")).toBe(true);expect(isProtectedBranch("feature/prod-fix")).toBe(false);
  });
});

async function git(path: string, ...args: string[]) { return (await exec("git", ["-C", path, ...args])).stdout.trim(); }

async function replaceWithForeignRepository(path: string, branch: string) {
  await rm(path, { recursive: true, force: true });
  await exec("git", ["init", "-b", branch, path]);
  await git(path, "config", "user.email", "foreign@example.com"); await git(path, "config", "user.name", "Foreign");
  await writeFile(join(path, "FOREIGN.md"), "foreign\n"); await git(path, "add", "--all"); await git(path, "commit", "-m", "foreign");
}

async function registeredPaths(repoPath: string, branch: string) {
  const output = (await exec("git", ["-C", repoPath, "worktree", "list", "--porcelain"])).stdout;
  return output.trim().split("\n\n").map((record) => ({
    path: record.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length),
    branch: record.split("\n").find((line) => line.startsWith("branch "))?.slice("branch ".length)
  })).filter((item) => item.branch === `refs/heads/${branch}`).map((item) => item.path);
}

async function pathExists(path: string) {
  try { await lstat(path); return true; } catch { return false; }
}

async function localBranchExistsForTest(repoPath: string, branch: string) {
  try { await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; }
  catch { return false; }
}

async function configureFailingSmudge(repoPath: string) {
  await writeFile(join(repoPath, ".gitattributes"), "failure.txt filter=required-fail\n");
  await writeFile(join(repoPath, "failure.txt"), "checkout must fail\n");
  await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add required filter file");
  await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
  await git(repoPath, "config", "filter.required-fail.clean", "cat");
  await git(repoPath, "config", "filter.required-fail.smudge", "false");
  await git(repoPath, "config", "filter.required-fail.required", "true");
}

async function setupVersionRepository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-requirements-")); dirs.push(root);
  const repoPath = join(root, "project");
  await exec("git", ["init", "-b", "prod", repoPath]);
  await git(repoPath, "config", "user.email", "test@example.com"); await git(repoPath, "config", "user.name", "Test");
  await writeFile(join(repoPath, "README.md"), "base\n"); await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "base");
  await git(repoPath, "branch", "feature/2.2.1");
  return { root, repoPath };
}

async function mainState(repoPath: string) {
  return {
    branch: await git(repoPath, "branch", "--show-current"),
    head: await git(repoPath, "rev-parse", "HEAD"),
    status: await git(repoPath, "status", "--porcelain=v1", "--untracked-files=all")
  };
}

describe("requirement worktree lifecycle", () => {
  it("creates independent deterministic worktrees from a version branch current HEAD", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const versionHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const first = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0001");
    expect(first).toEqual({
      branch: "ai/REQ-0001",
      worktreePath: resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-0001"),
      baseCommit: versionHead,
      reused: false
    });

    const versionTree = await git(repoPath, "rev-parse", "feature/2.2.1^{tree}");
    const advancedHead = await git(repoPath, "commit-tree", versionTree, "-p", versionHead, "-m", "advance version");
    await git(repoPath, "update-ref", "refs/heads/feature/2.2.1", advancedHead, versionHead);
    const second = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0002");
    expect(second.branch).toBe("ai/REQ-0002");
    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(second.baseCommit).toBe(await git(repoPath, "rev-parse", "feature/2.2.1"));
    expect(await git(first.worktreePath, "rev-parse", "HEAD")).toBe(versionHead);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("reuses the same managed worktree and preserves uncommitted changes", async () => {
    const { repoPath } = await setupVersionRepository();
    const first = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0001");
    await writeFile(join(first.worktreePath, "unfinished.txt"), "keep me\n");
    const second = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0001");
    expect(second).toEqual({ ...first, reused: true });
    expect(await git(first.worktreePath, "status", "--porcelain")).toContain("?? unfinished.txt");
  });

  it("attaches an existing unmounted requirement branch at the deterministic path", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    await git(repoPath, "branch", "ai/REQ-0004", "feature/2.2.1");
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0004");
    expect(created).toMatchObject({ branch: "ai/REQ-0004", reused: false, baseCommit: await git(repoPath, "rev-parse", "feature/2.2.1") });
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("ai/REQ-0004");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects unsafe requirement codes and a matching branch mounted outside the managed root", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "../escape"))
      .rejects.toThrow("REQUIREMENT_CODE_INVALID");
    await git(repoPath, "branch", "ai/REQ-0003", "feature/2.2.1");
    await git(repoPath, "worktree", "add", join(root, "user-worktree"), "ai/REQ-0003");
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0003"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_OUTSIDE_MANAGED_ROOT");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects a symlinked managed requirements root that escapes its canonical location", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const managedRoot = resolve(repoPath, "..", ".ai-workflow-worktrees");
    const outside = join(root, "outside-requirements");
    await mkdir(outside);
    await symlink(outside, managedRoot);
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0005"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a foreign repository replacing a stale registered requirement worktree", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0006");
    await replaceWithForeignRepository(created.worktreePath, "ai/REQ-0006");

    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0006"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_IDENTITY_MISMATCH");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("anchors managed requirement paths beside the canonical repo when invoked through a symlink", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const aliasParent = join(root, "aliases");
    const aliasPath = join(aliasParent, "alias");
    await mkdir(aliasParent);
    await symlink(repoPath, aliasPath);

    const created = await createOrReuseRequirementWorktree(aliasPath, "feature/2.2.1", "REQ-0007");
    expect(created.worktreePath).toBe(resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-0007"
    ));
    expect((await readdir(aliasParent)).sort()).toEqual(["alias"]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("serializes concurrent create-or-reuse calls for the same requirement", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const results = await Promise.all([
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0008"),
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0008")
    ]);
    expect(results.map((item) => item.reused).sort()).toEqual([false, true]);
    expect(new Set(results.map((item) => item.worktreePath)).size).toBe(1);
    expect(await registeredPaths(repoPath, "ai/REQ-0008")).toHaveLength(1);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects a requirement branch mounted at a non-deterministic managed path", async () => {
    const { repoPath } = await setupVersionRepository();
    const root = resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements");
    const wrongPath = resolve(root, "not-the-deterministic-code");
    await mkdir(root, { recursive: true });
    await git(repoPath, "branch", "ai/REQ-9000", "feature/2.2.1");
    await git(repoPath, "worktree", "add", wrongPath, "ai/REQ-9000");
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-9000"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_PATH_MISMATCH");
  });

  it("rolls back a created requirement branch and target after checkout failure", async () => {
    const { repoPath } = await setupVersionRepository();
    await configureFailingSmudge(repoPath);
    const before = await mainState(repoPath);
    const target = resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9001");
    let failure: unknown;
    try { await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-9001"); }
    catch (error) { failure = error; }

    expect(failure).toMatchObject({ message: "REQUIREMENT_WORKTREE_CREATE_FAILED" });
    expect(await localBranchExistsForTest(repoPath, "ai/REQ-9001")).toBe(false);
    expect(await pathExists(target)).toBe(false);
    expect(await registeredPaths(repoPath, "ai/REQ-9001")).toEqual([]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("classifies only exit code 1 without a signal as a missing Git ref", () => {
    expect(classifyGitFailure({ code: 1, signal: null })).toBe("not_found");
    expect(classifyGitFailure({ code: 128, signal: null })).toBe("command_failed");
    expect(classifyGitFailure({ code: "ENOENT", signal: null })).toBe("unavailable");
    expect(classifyGitFailure({ code: 1, signal: "SIGTERM" })).toBe("unavailable");
  });

  it("does not clean an external winner when worktree add was attempted without target ownership", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "ai/REQ-9011";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9011"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    await git(repoPath, "branch", branch, "feature/2.2.1");
    await git(repoPath, "worktree", "add", target, branch);
    const head = await git(repoPath, "rev-parse", branch);

    await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch,
      targetReserved: false, worktreeAddAttempted: true, worktreeAdded: false
    });

    expect(await git(repoPath, "rev-parse", branch)).toBe(head);
    expect(await git(target, "branch", "--show-current")).toBe(branch);
    expect(await registeredPaths(repoPath, branch)).toEqual([target]);
  });

  it("does not clean an unregistered foreign repository at a reserved target", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "ai/REQ-9012";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9012"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    await exec("git", ["init", "-b", branch, target]);
    await git(target, "config", "user.email", "foreign@example.com"); await git(target, "config", "user.name", "Foreign");
    await writeFile(join(target, "FOREIGN.md"), "foreign\n"); await git(target, "add", "--all"); await git(target, "commit", "-m", "foreign");

    await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: false
    });

    expect(await git(target, "branch", "--show-current")).toBe(branch);
    expect(await git(target, "show", "HEAD:FOREIGN.md")).toBe("foreign");
  });

  it("refuses to remove a dirty owned worktree when clean rollback is required", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "feature/dirty-cleanup";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "dirty-cleanup"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    const ownedHead = await git(repoPath, "rev-parse", "prod");
    await git(repoPath, "branch", branch, ownedHead);
    await git(repoPath, "worktree", "add", target, branch);
    await writeFile(join(target, "recovery.txt"), "keep this work\n");

    const removed = await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch, ownedHead,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: true, requireClean: true
    });

    expect(removed).toBe(false);
    expect(await pathExists(target)).toBe(true);
    expect(await git(target, "status", "--porcelain")).toContain("?? recovery.txt");
    expect(await localBranchExistsForTest(repoPath, branch)).toBe(true);
    expect(await registeredPaths(repoPath, branch)).toEqual([target]);
  });

  it("preserves both refs when a clean rollback target belongs to another branch", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "feature/expected-owner";
    const winner = "feature/external-winner";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "external-winner"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    const ownedHead = await git(repoPath, "rev-parse", "prod");
    await git(repoPath, "branch", branch, ownedHead);
    await git(repoPath, "branch", winner, ownedHead);
    await git(repoPath, "worktree", "add", target, winner);

    const removed = await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch, ownedHead,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: true, requireClean: true
    });

    expect(removed).toBe(false);
    expect(await localBranchExistsForTest(repoPath, branch)).toBe(true);
    expect(await localBranchExistsForTest(repoPath, winner)).toBe(true);
    expect(await git(target, "branch", "--show-current")).toBe(winner);
  });
});
