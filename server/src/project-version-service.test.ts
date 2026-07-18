import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectVersionWorktree,
  inspectProjectVersion,
  inspectVersionWorktree
} from "./project-version-service.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(path: string, ...args: string[]) {
  return (await exec("git", ["-C", path, ...args])).stdout.trim();
}

async function setupRepository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-version-"));
  roots.push(root);
  const repoPath = join(root, "project");
  const externalWorktreePath = join(root, "external-occupied");
  await exec("git", ["init", "-b", "prod", repoPath]);
  await git(repoPath, "config", "user.email", "test@example.com");
  await git(repoPath, "config", "user.name", "Test");
  await writeFile(join(repoPath, "README.md"), "base\n");
  await git(repoPath, "add", "--all");
  await git(repoPath, "commit", "-m", "base");
  await git(repoPath, "branch", "feature/2.2.1");
  await git(repoPath, "branch", "occupied/3.0");
  await git(repoPath, "worktree", "add", externalWorktreePath, "occupied/3.0");
  return { root, repoPath, externalWorktreePath };
}

async function mainState(repoPath: string) {
  return {
    branch: await git(repoPath, "branch", "--show-current"),
    head: await git(repoPath, "rev-parse", "HEAD"),
    status: await git(repoPath, "status", "--porcelain=v1", "--untracked-files=all")
  };
}

async function replaceWithForeignRepository(path: string, branch: string) {
  await rm(path, { recursive: true, force: true });
  await exec("git", ["init", "-b", branch, path]);
  await git(path, "config", "user.email", "foreign@example.com");
  await git(path, "config", "user.name", "Foreign");
  await writeFile(join(path, "FOREIGN.md"), "foreign\n");
  await git(path, "add", "--all");
  await git(path, "commit", "-m", "foreign");
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

async function localBranchExists(repoPath: string, branch: string) {
  try { await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; }
  catch { return false; }
}

async function configureFailingSmudge(repoPath: string) {
  await writeFile(join(repoPath, ".gitattributes"), "failure.txt filter=required-fail\n");
  await writeFile(join(repoPath, "failure.txt"), "checkout must fail\n");
  await git(repoPath, "add", "--all");
  await git(repoPath, "commit", "-m", "add required filter file");
  await git(repoPath, "config", "filter.required-fail.clean", "cat");
  await git(repoPath, "config", "filter.required-fail.smudge", "false");
  await git(repoPath, "config", "filter.required-fail.required", "true");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("project version worktree lifecycle", () => {
  it("creates a missing branch from the base branch in its deterministic worktree", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    const baseHead = await git(repoPath, "rev-parse", "prod");
    const inspected = await inspectProjectVersion({ repoPath, name: "2.3", branch: "feature/2.3", baseBranch: "prod" });
    expect(inspected).toEqual({
      valid: true, branch: "feature/2.3", baseBranch: "prod", mode: "create_branch", headCommit: baseHead
    });

    const created = await createProjectVersionWorktree({
      repoPath, versionId: "version-23", branch: "feature/2.3", baseBranch: "prod", mode: "create_branch"
    });

    expect(created).toEqual({
      worktreePath: resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "version-23"),
      headCommit: baseHead,
      createdBranchHead: baseHead,
      createdBranch: true,
      createdWorktree: true
    });
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("feature/2.3");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("returns the base head resolved inside creation after an earlier inspection becomes stale", async () => {
    const { repoPath } = await setupRepository();
    const inspected = await inspectProjectVersion({
      repoPath, name: "stale-base", branch: "feature/stale-base", baseBranch: "prod"
    });
    await writeFile(join(repoPath, "advanced-base.txt"), "advanced base\n");
    await git(repoPath, "add", "--all");
    await git(repoPath, "commit", "-m", "advance base after inspection");
    const creationBase = await git(repoPath, "rev-parse", "prod");

    const created = await createProjectVersionWorktree({
      repoPath, versionId: "stale-base", branch: "feature/stale-base", baseBranch: "prod", mode: "create_branch"
    });

    expect(inspected.headCommit).not.toBe(creationBase);
    expect(created.createdBranchHead).toBe(creationBase);
    expect(created.headCommit).toBe(creationBase);
  });

  it("keeps the lock-time branch head separate from a checkout hook advanced final head", async () => {
    const { repoPath } = await setupRepository();
    const creationBase = await git(repoPath, "rev-parse", "prod");
    const hookPath = join(repoPath, ".git", "hooks", "post-checkout");
    await writeFile(hookPath, [
      "#!/bin/sh",
      "printf 'hook advance\\n' > hook-advance.txt",
      "git add hook-advance.txt",
      "git commit -m 'hook advance' >/dev/null 2>&1",
      ""
    ].join("\n"));
    await chmod(hookPath, 0o755);

    const created = await createProjectVersionWorktree({
      repoPath, versionId: "hook-head", branch: "feature/hook-head", baseBranch: "prod", mode: "create_branch"
    });

    expect(created.createdBranchHead).toBe(creationBase);
    expect(created.headCommit).not.toBe(creationBase);
    expect(created.headCommit).toBe(await git(created.worktreePath, "rev-parse", "HEAD"));
  });

  it("attaches an existing unmounted branch", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    const branchHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    expect(await inspectProjectVersion({ repoPath, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod" }))
      .toEqual({
        valid: true, branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch", headCommit: branchHead
      });

    const created = await createProjectVersionWorktree({
      repoPath, versionId: "version-221", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    });
    expect(created.createdBranch).toBe(false);
    expect(created.createdWorktree).toBe(true);
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("feature/2.2.1");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("requires explicit confirmation before reusing an occupied external worktree", async () => {
    const { repoPath, externalWorktreePath } = await setupRepository();
    const before = await mainState(repoPath);
    const branchHead = await git(externalWorktreePath, "rev-parse", "HEAD");
    const inspected = await inspectProjectVersion({ repoPath, name: "3.0", branch: "occupied/3.0", baseBranch: "prod" });
    expect(inspected).toEqual({
      valid: true, branch: "occupied/3.0", baseBranch: "prod", mode: "reuse_worktree",
      headCommit: branchHead, existingWorktreePath: await realpath(externalWorktreePath)
    });

    await expect(createProjectVersionWorktree({
      repoPath, versionId: "version-30", branch: "occupied/3.0", baseBranch: "prod",
      mode: "reuse_worktree", existingWorktreePath: externalWorktreePath
    })).rejects.toThrow("PROJECT_VERSION_REUSE_NOT_CONFIRMED");

    const reused = await createProjectVersionWorktree({
      repoPath, versionId: "version-30", branch: "occupied/3.0", baseBranch: "prod",
      mode: "reuse_worktree", existingWorktreePath: externalWorktreePath, reuseExistingWorktree: true
    });
    expect(reused).toEqual({
      worktreePath: await realpath(externalWorktreePath),
      headCommit: await git(externalWorktreePath, "rev-parse", "HEAD"),
      createdBranch: false,
      createdWorktree: false
    });
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("never registers the project root as its own version worktree", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    await expect(inspectProjectVersion({ repoPath, name: "prod", branch: "prod", baseBranch: "prod" }))
      .rejects.toThrow("PROJECT_VERSION_BRANCH_IN_USE");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects invalid refs, missing bases, traversal, occupied targets, and symlink escapes", async () => {
    const invalid = await setupRepository();
    const before = await mainState(invalid.repoPath);
    await expect(inspectProjectVersion({ repoPath: invalid.repoPath, name: "bad", branch: "../bad", baseBranch: "prod" }))
      .rejects.toThrow("PROJECT_VERSION_BRANCH_INVALID");
    await expect(inspectProjectVersion({ repoPath: invalid.repoPath, name: "bad", branch: "feature/new", baseBranch: "missing" }))
      .rejects.toThrow("PROJECT_VERSION_BASE_BRANCH_NOT_FOUND");
    await expect(createProjectVersionWorktree({
      repoPath: invalid.repoPath, versionId: "../escape", branch: "feature/new", baseBranch: "prod", mode: "create_branch"
    })).rejects.toThrow("PROJECT_VERSION_ID_INVALID");
    expect(await mainState(invalid.repoPath)).toEqual(before);

    const occupied = await setupRepository();
    const occupiedBefore = await mainState(occupied.repoPath);
    const target = resolve(occupied.repoPath, "..", ".ai-workflow-worktrees", basename(occupied.repoPath), "versions", "taken");
    await mkdir(resolve(target, ".."), { recursive: true });
    await git(occupied.repoPath, "branch", "other/version");
    await git(occupied.repoPath, "worktree", "add", target, "other/version");
    await expect(createProjectVersionWorktree({
      repoPath: occupied.repoPath, versionId: "taken", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    })).rejects.toThrow("PROJECT_VERSION_PATH_IN_USE");
    expect(await mainState(occupied.repoPath)).toEqual(occupiedBefore);

    const escaped = await setupRepository();
    const escapedBefore = await mainState(escaped.repoPath);
    const managedRoot = resolve(escaped.repoPath, "..", ".ai-workflow-worktrees");
    const outside = join(escaped.root, "outside");
    await mkdir(outside);
    await symlink(outside, managedRoot);
    await expect(createProjectVersionWorktree({
      repoPath: escaped.repoPath, versionId: "safe-id", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    })).rejects.toThrow("PROJECT_VERSION_PATH_ESCAPE");
    expect(await readdir(outside)).toEqual([]);
    expect(await mainState(escaped.repoPath)).toEqual(escapedBefore);
  });

  it("reports registered worktree validity and dirtiness without repairing it", async () => {
    const { repoPath } = await setupRepository();
    expect(await inspectVersionWorktree({ repoPath, worktreePath: repoPath, branch: "prod" }))
      .toMatchObject({ valid: false, status: "project_root_forbidden" });
    const created = await createProjectVersionWorktree({
      repoPath, versionId: "inspect", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    });
    expect(await inspectVersionWorktree({ repoPath, worktreePath: created.worktreePath, branch: "feature/2.2.1" }))
      .toEqual({ valid: true, clean: true, headCommit: created.headCommit, status: "ok" });
    await writeFile(join(created.worktreePath, "dirty.txt"), "dirty\n");
    expect(await inspectVersionWorktree({ repoPath, worktreePath: created.worktreePath, branch: "feature/2.2.1" }))
      .toMatchObject({ valid: true, clean: false, status: "dirty" });
    expect(await inspectVersionWorktree({ repoPath, worktreePath: created.worktreePath, branch: "wrong/branch" }))
      .toEqual({ valid: false, clean: false, headCommit: "", status: "branch_mismatch" });
  });

  it("rejects a foreign repository replacing a stale registered version worktree", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    const created = await createProjectVersionWorktree({
      repoPath, versionId: "stale", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    });
    await replaceWithForeignRepository(created.worktreePath, "feature/2.2.1");

    expect(await inspectVersionWorktree({ repoPath, worktreePath: created.worktreePath, branch: "feature/2.2.1" }))
      .toEqual({ valid: false, clean: false, headCommit: "", status: "repository_mismatch" });
    await expect(inspectProjectVersion({ repoPath, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod" }))
      .rejects.toThrow("PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH");
    await expect(createProjectVersionWorktree({
      repoPath, versionId: "stale", branch: "feature/2.2.1", baseBranch: "prod", mode: "reuse_worktree",
      existingWorktreePath: created.worktreePath, reuseExistingWorktree: true
    })).rejects.toThrow("PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("anchors managed version paths beside the canonical repo when invoked through a symlink", async () => {
    const { root, repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    const aliasParent = join(root, "aliases");
    const aliasPath = join(aliasParent, "alias");
    await mkdir(aliasParent);
    await symlink(repoPath, aliasPath);

    const created = await createProjectVersionWorktree({
      repoPath: aliasPath, versionId: "alias-version", branch: "feature/2.2.1", baseBranch: "prod", mode: "attach_branch"
    });
    expect(created.worktreePath).toBe(resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "alias-version"
    ));
    expect((await readdir(aliasParent)).sort()).toEqual(["alias"]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("serializes concurrent creation attempts for the same version branch", async () => {
    const { repoPath } = await setupRepository();
    await git(repoPath, "branch", "feature/race");
    const before = await mainState(repoPath);
    const canonicalRepo = await realpath(repoPath);
    const paths = ["race-a", "race-b"].map((versionId) => resolve(
      canonicalRepo, "..", ".ai-workflow-worktrees", basename(canonicalRepo), "versions", versionId
    ));

    const results = await Promise.allSettled(["race-a", "race-b"].map((versionId) => createProjectVersionWorktree({
      repoPath, versionId, branch: "feature/race", baseBranch: "prod", mode: "attach_branch"
    })));

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: "PROJECT_VERSION_MODE_MISMATCH" });
    const registered = (await registeredPaths(repoPath, "feature/race")).filter(Boolean);
    expect(registered).toHaveLength(1);
    expect(await Promise.all(paths.filter((path) => !registered.includes(path)).map(pathExists))).toEqual([false]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("preserves one winner when different branches concurrently claim the same version target", async () => {
    const { repoPath } = await setupRepository();
    await git(repoPath, "branch", "feature/a");
    await git(repoPath, "branch", "feature/b");
    const before = await mainState(repoPath);
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "same-target"
    );

    const results = await Promise.allSettled(["feature/a", "feature/b"].map((branch) => createProjectVersionWorktree({
      repoPath, versionId: "same-target", branch, baseBranch: "prod", mode: "attach_branch"
    })));

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: "PROJECT_VERSION_PATH_IN_USE" });
    expect(await pathExists(target)).toBe(true);
    const registrations = [
      ...await registeredPaths(repoPath, "feature/a"),
      ...await registeredPaths(repoPath, "feature/b")
    ].filter((path) => path === target);
    expect(registrations).toEqual([target]);
    expect(["feature/a", "feature/b"]).toContain(await git(target, "branch", "--show-current"));
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rolls back a created version branch and target after checkout failure", async () => {
    const { repoPath } = await setupRepository();
    await configureFailingSmudge(repoPath);
    const before = await mainState(repoPath);
    const target = resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "failure");
    let failure: unknown;
    try {
      await createProjectVersionWorktree({
        repoPath, versionId: "failure", branch: "feature/failure", baseBranch: "prod", mode: "create_branch"
      });
    } catch (error) { failure = error; }

    expect(failure).toMatchObject({ message: "PROJECT_VERSION_WORKTREE_CREATE_FAILED" });
    expect(await localBranchExists(repoPath, "feature/failure")).toBe(false);
    expect(await pathExists(target)).toBe(false);
    expect(await registeredPaths(repoPath, "feature/failure")).toEqual([]);
    expect(await mainState(repoPath)).toEqual(before);
  });
});
