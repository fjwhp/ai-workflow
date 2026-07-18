import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("project version worktree lifecycle", () => {
  it("creates a missing branch from the base branch in its deterministic worktree", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    const inspected = await inspectProjectVersion({ repoPath, name: "2.3", branch: "feature/2.3", baseBranch: "prod" });
    expect(inspected).toMatchObject({ mode: "create_branch" });

    const created = await createProjectVersionWorktree({
      repoPath, versionId: "version-23", branch: "feature/2.3", baseBranch: "prod", mode: "create_branch"
    });

    expect(created).toEqual({
      worktreePath: resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "version-23"),
      headCommit: await git(repoPath, "rev-parse", "prod"),
      createdBranch: true,
      createdWorktree: true
    });
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("feature/2.3");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("attaches an existing unmounted branch", async () => {
    const { repoPath } = await setupRepository();
    const before = await mainState(repoPath);
    expect(await inspectProjectVersion({ repoPath, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod" }))
      .toMatchObject({ mode: "attach_branch" });

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
    const inspected = await inspectProjectVersion({ repoPath, name: "3.0", branch: "occupied/3.0", baseBranch: "prod" });
    expect(inspected).toMatchObject({ mode: "reuse_worktree", existingWorktreePath: await realpath(externalWorktreePath) });

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
      .toMatchObject({ valid: false, clean: false, status: "branch_mismatch" });
  });
});
