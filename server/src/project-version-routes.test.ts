import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { registerProjectVersionRoutes } from "./project-version-routes.js";
import { WorkflowStore } from "./store.js";

const exec = promisify(execFile);
const roots: string[] = [];
const stores: WorkflowStore[] = [];
const apps: FastifyInstance[] = [];
const databases: DatabaseSync[] = [];

async function git(path: string, ...args: string[]) {
  return (await exec("git", ["-C", path, ...args])).stdout.trim();
}

async function setupRepository() {
  const root = await mkdtemp(join(tmpdir(), "project-version-routes-"));
  roots.push(root);
  const repoPath = join(root, "project");
  const externalWorktreePath = join(root, "external-occupied");
  await exec("git", ["init", "-b", "prod", repoPath]);
  await git(repoPath, "config", "user.email", "routes@example.com");
  await git(repoPath, "config", "user.name", "Routes Test");
  await writeFile(join(repoPath, "README.md"), "base\n");
  await git(repoPath, "add", "--all");
  await git(repoPath, "commit", "-m", "base");
  await git(repoPath, "branch", "feature/existing");
  await git(repoPath, "branch", "feature/occupied");
  await git(repoPath, "worktree", "add", externalWorktreePath, "feature/occupied");
  return { root, repoPath, externalWorktreePath };
}

function createStore(path = ":memory:") {
  const store = new WorkflowStore(path);
  stores.push(store);
  return store;
}

function createProject(store: WorkflowStore, repoPath: string, name = "Routes") {
  return store.createProject({
    name, repoPath, defaultBranch: "prod", allowedCommands: [], sensitivePatterns: []
  });
}

async function routeApp(store: WorkflowStore) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerProjectVersionRoutes(app, { store });
  return app;
}

async function fullApp(store: WorkflowStore) {
  const app = await buildApp(store);
  apps.push(app);
  return app;
}

async function repositoryState(repoPath: string) {
  return {
    branch: await git(repoPath, "branch", "--show-current"),
    head: await git(repoPath, "rev-parse", "HEAD"),
    status: await git(repoPath, "status", "--porcelain=v1", "--untracked-files=all"),
    branches: await git(repoPath, "branch", "--format=%(refname:short)"),
    worktrees: await git(repoPath, "worktree", "list", "--porcelain")
  };
}

async function pathExists(path: string) {
  try { await lstat(path); return true; } catch { return false; }
}

async function branchExists(repoPath: string, branch: string) {
  try {
    await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch { return false; }
}

async function createVersion(app: FastifyInstance, projectId: string, input: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/versions`, payload: input
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function pendingApplication(store: WorkflowStore, app: FastifyInstance, projectId: string, suffix: string, complete = true) {
  const version = await createVersion(app, projectId, {
    name: `pending-${suffix}`, branch: `feature/pending-${suffix}`, baseBranch: "prod"
  });
  const requirement = store.createRequirement({
    title: `Pending ${suffix}`, businessProblem: "Await local resolution", expectedOutcome: "Resolve lease",
    priority: "medium", primaryProjectId: projectId, primaryProjectVersionId: version.id
  });
  store.updateRequirementState(requirement.id, "acceptance_delivery", "awaiting_merge");
  const runId = `pending-run-${suffix}`;
  store.beginVersionApplication({
    versionId: version.id, requirementId: requirement.id,
    run: {
      id: runId, projectId, executionId: `execution-${suffix}`, evidenceId: `evidence-${suffix}`,
      sourceBranch: `ai/${suffix}`, worktreePath: `/tmp/requirement-${suffix}`,
      targetBranch: version.branch, preflight: { allowed: true }
    }
  });
  if (complete) {
    store.completeVersionApplicationApply({
      runId, sourceCommit: "c".repeat(40), preApplyHead: version.headCommit,
      status: "awaiting_local_resolution"
    });
  }
  return { version, requirement, runId };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project version collection routes", () => {
  it("registers with buildApp and filters active, closed, and all versions", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const active = store.createProjectVersion({
      projectId: project.id, name: "active", branch: "feature/active", baseBranch: "prod",
      worktreePath: join(repoPath, "..", "active-record"), headCommit: "active-head"
    });
    const closed = store.createProjectVersion({
      projectId: project.id, name: "closed", branch: "feature/closed", baseBranch: "prod",
      worktreePath: join(repoPath, "..", "closed-record"), headCommit: "closed-head"
    });
    store.closeProjectVersion(closed.id);
    const app = await fullApp(store);

    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions` })).json())
      .toEqual([active]);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions?status=closed` })).json())
      .toMatchObject([{ id: closed.id, status: "closed" }]);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions?status=all` })).json())
      .toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions?status=invalid` }))).toMatchObject({ statusCode: 400 });
    expect((await app.inject({ method: "GET", url: "/api/projects/missing/versions" })).json())
      .toMatchObject({ error: "PROJECT_NOT_FOUND" });
  });

  it("validates trimmed inputs for all modes without mutating Git or persistence", async () => {
    const { repoPath, externalWorktreePath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const before = await repositoryState(repoPath);

    const cases = [
      {
        payload: { name: " 2.0 ", branch: " feature/new ", baseBranch: " prod " },
        mode: "create_branch", branch: "feature/new", existingWorktreePath: undefined
      },
      {
        payload: { name: " existing ", branch: " feature/existing ", baseBranch: " prod " },
        mode: "attach_branch", branch: "feature/existing", existingWorktreePath: undefined
      },
      {
        payload: { name: " occupied ", branch: " feature/occupied ", baseBranch: " prod " },
        mode: "reuse_worktree", branch: "feature/occupied", existingWorktreePath: await realpath(externalWorktreePath)
      }
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/versions/validate`, payload: entry.payload
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        valid: true, mode: entry.mode, branch: entry.branch, baseBranch: "prod"
      });
      expect(response.json().headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(response.json().existingWorktreePath).toBe(entry.existingWorktreePath);
    }

    expect(store.listProjectVersions(project.id, "all")).toEqual([]);
    expect(await repositoryState(repoPath)).toEqual(before);
  });

  it("creates new and existing branches while preserving the main worktree", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const before = await repositoryState(repoPath);

    const created = await createVersion(app, project.id, {
      name: "new", branch: "feature/new", baseBranch: "prod"
    });
    const attached = await createVersion(app, project.id, {
      name: "existing", branch: "feature/existing", baseBranch: "prod"
    });

    expect(store.getProjectVersion(created.id)).toEqual(created);
    expect(store.getProjectVersion(attached.id)).toEqual(attached);
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("feature/new");
    expect(await git(attached.worktreePath, "branch", "--show-current")).toBe("feature/existing");
    expect(created.headCommit).toBe(await git(created.worktreePath, "rev-parse", "HEAD"));
    expect(attached.headCommit).toBe(await git(attached.worktreePath, "rev-parse", "HEAD"));
    expect(basename(created.worktreePath)).toBe(created.id);
    expect(basename(attached.worktreePath)).toBe(attached.id);
    expect(await repositoryState(repoPath)).toMatchObject({
      branch: before.branch, head: before.head, status: before.status
    });
  });

  it("requires explicit confirmation before reusing an occupied external worktree", async () => {
    const { repoPath, externalWorktreePath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const denied = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "occupied", branch: "feature/occupied", baseBranch: "prod" }
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe("PROJECT_VERSION_REUSE_NOT_CONFIRMED");
    expect(store.listProjectVersions(project.id, "all")).toEqual([]);

    const reused = await createVersion(app, project.id, {
      name: "occupied", branch: "feature/occupied", baseBranch: "prod", reuseExistingWorktree: true
    });
    expect(reused.worktreePath).toBe(await realpath(externalWorktreePath));
    expect(await pathExists(externalWorktreePath)).toBe(true);
  });

  it("returns stable errors for invalid, duplicate, missing, archived, and in-use inputs", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    await createVersion(app, project.id, { name: "one", branch: "feature/one", baseBranch: "prod" });

    const cases = [
      [{ name: " ", branch: "feature/two", baseBranch: "prod" }, 400, "VALIDATION_ERROR"],
      [{ name: "bad-ref", branch: "bad ref", baseBranch: "prod" }, 400, "PROJECT_VERSION_BRANCH_INVALID"],
      [{ name: "bad-base", branch: "feature/two", baseBranch: "missing" }, 400, "PROJECT_VERSION_BASE_BRANCH_NOT_FOUND"],
      [{ name: "one", branch: "feature/two", baseBranch: "prod" }, 409, "PROJECT_VERSION_NAME_EXISTS"],
      [{ name: "two", branch: "feature/one", baseBranch: "prod" }, 409, "PROJECT_VERSION_BRANCH_EXISTS"],
      [{ name: "root", branch: "prod", baseBranch: "prod" }, 409, "PROJECT_VERSION_BRANCH_IN_USE"]
    ] as const;
    for (const [payload, status, error] of cases) {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/versions`, payload
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toBe(error);
    }
    expect((await app.inject({
      method: "POST", url: "/api/projects/missing/versions",
      payload: { name: "x", branch: "feature/x", baseBranch: "prod" }
    })).statusCode).toBe(404);

    store.archiveProject(project.id);
    const archived = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions/validate`,
      payload: { name: "x", branch: "feature/x", baseBranch: "prod" }
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error).toBe("PROJECT_ARCHIVED");
  });

  it("rejects version mutations after the project is archived", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "archived", branch: "feature/archived", baseBranch: "prod"
    });
    store.archiveProject(project.id);

    for (const operation of ["recheck", "close"]) {
      const response = await app.inject({
        method: "POST", url: `/api/project-versions/${version.id}/${operation}`
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("PROJECT_ARCHIVED");
    }
  });
});

class FailingVersionStore extends WorkflowStore {
  override createProjectVersion(_input: Parameters<WorkflowStore["createProjectVersion"]>[0]): never {
    throw new Error("SQLITE_BUSY");
  }
}

class AdvancingFailingVersionStore extends WorkflowStore {
  override createProjectVersion(input: Parameters<WorkflowStore["createProjectVersion"]>[0]): never {
    writeFileSync(join(input.worktreePath, "advanced.txt"), "advanced before persistence\n");
    execFileSync("git", ["-C", input.worktreePath, "add", "--all"]);
    execFileSync("git", ["-C", input.worktreePath, "commit", "-m", "advance before persistence"]);
    throw new Error("SQLITE_BUSY");
  }
}

class DirtyFailingVersionStore extends WorkflowStore {
  createdWorktreePath?: string;

  override createProjectVersion(input: Parameters<WorkflowStore["createProjectVersion"]>[0]): never {
    this.createdWorktreePath = input.worktreePath;
    writeFileSync(join(input.worktreePath, "dirty-recovery.txt"), "preserve this recovery work\n");
    throw new Error("SQLITE_BUSY");
  }
}

class ArchivingVersionStore extends WorkflowStore {
  override createProjectVersion(input: Parameters<WorkflowStore["createProjectVersion"]>[0]) {
    this.archiveProject(input.projectId);
    return super.createProjectVersion(input);
  }
}

class ArchivingReadStore extends WorkflowStore {
  private race = false;
  private reads = 0;

  armArchiveRace() {
    this.race = true;
    this.reads = 0;
  }

  override getProject(id: string) {
    const project = super.getProject(id);
    if (this.race && ++this.reads >= 2 && project) return { ...project, status: "archived" as const };
    return project;
  }
}

class ClosingVersionReadStore extends WorkflowStore {
  private versionId?: string;
  private projectReads = 0;

  armCloseRace(versionId: string) {
    this.versionId = versionId;
    this.projectReads = 0;
  }

  override getProject(id: string) {
    const project = super.getProject(id);
    if (this.versionId && ++this.projectReads === 2) super.closeProjectVersion(this.versionId);
    return project;
  }
}

class ArchivingVersionUpdateStore extends WorkflowStore {
  override updateProjectVersionHead(id: string, headCommit: string) {
    const version = this.getProjectVersion(id)!;
    this.archiveProject(version.projectId);
    return super.updateProjectVersionHead(id, headCommit);
  }
}

describe("project version persistence rollback", () => {
  it("removes only the managed worktree and branch created by the failed request", async () => {
    const { repoPath } = await setupRepository();
    const store = new FailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-new", branch: "feature/rollback-new", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "PROJECT_VERSION_PERSISTENCE_FAILED" });
    expect(JSON.stringify(response.json())).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(response.json())).not.toContain("git -C");
    expect(await branchExists(repoPath, "feature/rollback-new")).toBe(false);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).not.toContain("feature/rollback-new");
  });

  it("preserves a dirty created worktree and branch when persistence fails", async () => {
    const { repoPath } = await setupRepository();
    const store = new DirtyFailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-dirty", branch: "feature/rollback-dirty", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROJECT_VERSION_PERSISTENCE_FAILED");
    expect(store.listProjectVersions(project.id, "all")).toEqual([]);
    expect(await pathExists(store.createdWorktreePath!)).toBe(true);
    expect(await readFile(join(store.createdWorktreePath!, "dirty-recovery.txt"), "utf8"))
      .toBe("preserve this recovery work\n");
    expect(await branchExists(repoPath, "feature/rollback-dirty")).toBe(true);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).toContain("feature/rollback-dirty");
  });

  it("returns the archived-project error and cleans Git when archival races persistence", async () => {
    const { repoPath } = await setupRepository();
    const store = new ArchivingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "archive-race", branch: "feature/archive-race", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROJECT_ARCHIVED");
    expect(await branchExists(repoPath, "feature/archive-race")).toBe(false);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).not.toContain("feature/archive-race");
  });

  it("removes its created worktree but preserves a created branch that advanced before persistence failed", async () => {
    const { repoPath } = await setupRepository();
    const store = new AdvancingFailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-advanced", branch: "feature/rollback-advanced", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROJECT_VERSION_PERSISTENCE_FAILED");
    expect(await branchExists(repoPath, "feature/rollback-advanced")).toBe(true);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).not.toContain("feature/rollback-advanced");
  });

  it("preserves a created branch advanced by a checkout hook before worktree creation returns", async () => {
    const { repoPath } = await setupRepository();
    const baseHead = await git(repoPath, "rev-parse", "prod");
    const hookPath = join(repoPath, ".git", "hooks", "post-checkout");
    await writeFile(hookPath, [
      "#!/bin/sh",
      "printf 'advanced by hook\\n' > hook-advanced.txt",
      "git add hook-advanced.txt",
      "git commit -m 'advance from post-checkout' >/dev/null 2>&1",
      ""
    ].join("\n"));
    await chmod(hookPath, 0o755);
    const store = new FailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-hook", branch: "feature/rollback-hook", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(await branchExists(repoPath, "feature/rollback-hook")).toBe(true);
    expect(await git(repoPath, "rev-parse", "feature/rollback-hook")).not.toBe(baseHead);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).not.toContain("feature/rollback-hook");
  });

  it("removes a request-created attachment but preserves its pre-existing branch", async () => {
    const { repoPath } = await setupRepository();
    const store = new FailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const expectedHead = await git(repoPath, "rev-parse", "feature/existing");

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-existing", branch: "feature/existing", baseBranch: "prod" }
    });

    expect(response.statusCode).toBe(409);
    expect(await branchExists(repoPath, "feature/existing")).toBe(true);
    expect(await git(repoPath, "rev-parse", "feature/existing")).toBe(expectedHead);
    expect((await git(repoPath, "worktree", "list", "--porcelain"))).not.toContain("feature/existing");
  });

  it("never removes a reused external worktree after persistence fails", async () => {
    const { repoPath, externalWorktreePath } = await setupRepository();
    const store = new FailingVersionStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const before = await repositoryState(repoPath);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/versions`,
      payload: { name: "rollback-reuse", branch: "feature/occupied", baseBranch: "prod", reuseExistingWorktree: true }
    });

    expect(response.statusCode).toBe(409);
    expect(await pathExists(externalWorktreePath)).toBe(true);
    expect(await repositoryState(repoPath)).toEqual(before);
  });
});

describe("project version item routes", () => {
  it("gets a version and its requirements and returns 404 for missing versions", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "requirements", branch: "feature/requirements", baseBranch: "prod"
    });
    const requirement = store.createRequirement({
      title: "Version requirement", businessProblem: "Track work", expectedOutcome: "Visible",
      priority: "medium", primaryProjectId: project.id, primaryProjectVersionId: version.id
    });

    expect((await app.inject({ method: "GET", url: `/api/project-versions/${version.id}` })).json()).toEqual(version);
    expect((await app.inject({ method: "GET", url: `/api/project-versions/${version.id}/requirements` })).json())
      .toMatchObject([{ id: requirement.id }]);
    expect((await app.inject({ method: "GET", url: "/api/project-versions/missing" }))).toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: "GET", url: "/api/project-versions/missing/requirements" }))).toMatchObject({ statusCode: 404 });
  });

  it("rechecks the real worktree, reports dirty state, and updates the stored head only while valid", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "recheck", branch: "feature/recheck", baseBranch: "prod"
    });
    await writeFile(join(version.worktreePath, "change.txt"), "committed\n");
    await git(version.worktreePath, "add", "--all");
    await git(version.worktreePath, "commit", "-m", "advance version");
    const actualHead = await git(version.worktreePath, "rev-parse", "HEAD");
    await writeFile(join(version.worktreePath, "dirty.txt"), "pending\n");

    const checked = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/recheck` });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      version: { id: version.id, headCommit: actualHead },
      inspection: { valid: true, clean: false, headCommit: actualHead, status: "dirty" }
    });
    expect(store.getProjectVersion(version.id)?.headCommit).toBe(actualHead);

    await rm(join(version.worktreePath, "dirty.txt"));
    await git(version.worktreePath, "checkout", "--detach");
    const invalid = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/recheck` });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ error: "PROJECT_VERSION_WORKTREE_INVALID", details: { status: "branch_mismatch" } });
    expect(store.getProjectVersion(version.id)?.headCommit).toBe(actualHead);
  });

  it("keeps a dirty pending application leased until a human commits it", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const pending = await pendingApplication(store, app, project.id, "human-commit");
    await writeFile(join(pending.version.worktreePath, "applied.txt"), "pending\n");
    await git(pending.version.worktreePath, "add", "--all");

    const dirty = await app.inject({ method: "POST", url: `/api/project-versions/${pending.version.id}/recheck` });

    expect(dirty.statusCode).toBe(200);
    expect(dirty.json()).toMatchObject({ status: "pending" });
    expect(store.getProjectVersion(pending.version.id)?.pendingIntegrationRunId).toBe(pending.runId);
    expect(store.getRequirement(pending.requirement.id)?.status).toBe("awaiting_local_resolution");

    await git(pending.version.worktreePath, "commit", "-m", "REQ local review");
    const committedHead = await git(pending.version.worktreePath, "rev-parse", "HEAD");
    const committed = await app.inject({ method: "POST", url: `/api/project-versions/${pending.version.id}/recheck` });

    expect(committed.json()).toMatchObject({ status: "committed", commit: committedHead });
    expect(store.getRequirement(pending.requirement.id)?.status).toBe("completed");
    expect(store.getProjectVersion(pending.version.id)).toMatchObject({
      headCommit: committedHead, pendingRequirementId: undefined, pendingIntegrationRunId: undefined
    });
  });

  it("returns a clean manual revert to awaiting application", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const pending = await pendingApplication(store, app, project.id, "human-revert");
    await writeFile(join(pending.version.worktreePath, "applied.txt"), "pending\n");
    await git(pending.version.worktreePath, "add", "--all");
    await git(pending.version.worktreePath, "reset", "--hard", pending.version.headCommit);

    const reverted = await app.inject({ method: "POST", url: `/api/project-versions/${pending.version.id}/recheck` });

    expect(reverted.json()).toMatchObject({ status: "reverted" });
    expect(store.getRequirement(pending.requirement.id)?.status).toBe("awaiting_merge");
    expect(store.getProjectVersion(pending.version.id)?.pendingRequirementId).toBeUndefined();
  });

  it("marks a clean non-descendant head ambiguous and retains the lease", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const pending = await pendingApplication(store, app, project.id, "non-descendant");
    await git(pending.version.worktreePath, "checkout", "--orphan", "divergent");
    await git(pending.version.worktreePath, "rm", "-rf", ".");
    await git(pending.version.worktreePath, "commit", "--allow-empty", "-m", "divergent history");
    await git(pending.version.worktreePath, "branch", "-D", pending.version.branch);
    await git(pending.version.worktreePath, "branch", "-m", pending.version.branch);
    const divergentHead = await git(pending.version.worktreePath, "rev-parse", "HEAD");

    const response = await app.inject({ method: "POST", url: `/api/project-versions/${pending.version.id}/recheck` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ambiguous", currentHead: divergentHead });
    expect(store.getRequirement(pending.requirement.id)?.status).toBe("manual_resolution_required");
    expect(store.getProjectVersion(pending.version.id)?.pendingIntegrationRunId).toBe(pending.runId);

    await git(pending.version.worktreePath, "reset", "--hard", pending.version.headCommit);
    const repaired = await app.inject({
      method: "POST", url: `/api/project-versions/${pending.version.id}/recheck`
    });

    expect(repaired.json()).toMatchObject({ status: "reverted" });
    expect(store.getRequirement(pending.requirement.id)?.status).toBe("awaiting_merge");
    expect(store.getProjectVersion(pending.version.id)?.pendingIntegrationRunId).toBeUndefined();
  });

  it("recovers every pending application on startup without releasing inaccessible ownership", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const setupApp = await routeApp(store);
    const inaccessible = await pendingApplication(store, setupApp, project.id, "startup-missing");
    const wrongBranch = await pendingApplication(store, setupApp, project.id, "startup-wrong-branch");
    const interrupted = await pendingApplication(store, setupApp, project.id, "startup-interrupted", false);
    const committed = await pendingApplication(store, setupApp, project.id, "startup-committed");
    await git(committed.version.worktreePath, "commit", "--allow-empty", "-m", "human commit");
    await git(repoPath, "worktree", "remove", "--force", inaccessible.version.worktreePath);
    await git(wrongBranch.version.worktreePath, "checkout", "--detach");
    await git(repoPath, "worktree", "remove", "--force", interrupted.version.worktreePath);
    await setupApp.close();
    apps.splice(apps.indexOf(setupApp), 1);

    const app = await fullApp(store);

    expect(store.getRequirement(inaccessible.requirement.id)?.status).toBe("manual_resolution_required");
    expect(store.getProjectVersion(inaccessible.version.id)?.pendingIntegrationRunId).toBe(inaccessible.runId);
    expect(store.getRequirement(wrongBranch.requirement.id)?.status).toBe("manual_resolution_required");
    expect(store.getProjectVersion(wrongBranch.version.id)?.pendingIntegrationRunId).toBe(wrongBranch.runId);
    expect(store.getRequirement(interrupted.requirement.id)?.status).toBe("manual_resolution_required");
    expect(store.getProjectVersion(interrupted.version.id)?.pendingIntegrationRunId).toBe(interrupted.runId);
    expect(store.getIntegrationRun(interrupted.runId)).toMatchObject({ status: "failed", resolutionStatus: "ambiguous" });
    expect(store.getRequirement(committed.requirement.id)?.status).toBe("completed");
    expect(store.getProjectVersion(committed.version.id)?.pendingRequirementId).toBeUndefined();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
  });

  it("recovers an integration run already marked failed by startup interruption", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const setupApp = await routeApp(store);
    const interrupted = await pendingApplication(store, setupApp, project.id, "startup-already-failed", false);
    expect(store.interruptActiveIntegrationRuns()).toBe(1);
    await setupApp.close();
    apps.splice(apps.indexOf(setupApp), 1);

    const app = await fullApp(store);

    expect(store.getIntegrationRun(interrupted.runId)).toMatchObject({
      status: "failed", resolutionStatus: "ambiguous"
    });
    expect(store.getRequirement(interrupted.requirement.id)?.status).toBe("manual_resolution_required");
    expect(store.getProjectVersion(interrupted.version.id)?.pendingIntegrationRunId).toBe(interrupted.runId);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
  });

  it("revalidates project activity after Git inspection before recheck or close writes", async () => {
    const { repoPath } = await setupRepository();
    const store = new ArchivingReadStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "archive-race-write", branch: "feature/archive-race-write", baseBranch: "prod"
    });

    for (const operation of ["recheck", "close"]) {
      store.armArchiveRace();
      const response = await app.inject({
        method: "POST", url: `/api/project-versions/${version.id}/${operation}`
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("PROJECT_ARCHIVED");
      expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", headCommit: version.headCommit });
    }
  });

  it("does not update a version closed while recheck inspects its worktree", async () => {
    const { repoPath } = await setupRepository();
    const store = new ClosingVersionReadStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "close-race-recheck", branch: "feature/close-race-recheck", baseBranch: "prod"
    });
    await writeFile(join(version.worktreePath, "advanced.txt"), "advanced\n");
    await git(version.worktreePath, "add", "--all");
    await git(version.worktreePath, "commit", "-m", "advance before close race");
    store.armCloseRace(version.id);

    const response = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/recheck` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROJECT_VERSION_NOT_ACTIVE");
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "closed", headCommit: version.headCommit });
  });

  it("reports an archived project when archival wins the atomic head update", async () => {
    const { repoPath } = await setupRepository();
    const store = new ArchivingVersionUpdateStore(":memory:"); stores.push(store);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "archive-update-race", branch: "feature/archive-update-race", baseBranch: "prod"
    });
    await writeFile(join(version.worktreePath, "advanced.txt"), "advanced\n");
    await git(version.worktreePath, "add", "--all");
    await git(version.worktreePath, "commit", "-m", "advance before archive update race");

    const response = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/recheck` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROJECT_ARCHIVED");
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", headCommit: version.headCommit });
  });

  it("closes a clean valid version idempotently without deleting Git state", async () => {
    const { repoPath } = await setupRepository();
    const store = createStore();
    const project = createProject(store, repoPath);
    const app = await routeApp(store);
    const version = await createVersion(app, project.id, {
      name: "close", branch: "feature/close", baseBranch: "prod"
    });

    const first = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/close` });
    const second = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/close` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: version.id, status: "closed" });
    expect(second.json()).toEqual(first.json());
    expect(await pathExists(version.worktreePath)).toBe(true);
    expect(await branchExists(repoPath, version.branch)).toBe(true);

    const recheck = await app.inject({ method: "POST", url: `/api/project-versions/${version.id}/recheck` });
    expect(recheck.statusCode).toBe(409);
    expect(recheck.json().error).toBe("PROJECT_VERSION_NOT_ACTIVE");
  });

  it("blocks close for dirty, invalid, pending, and nonterminal historical requirements", async () => {
    const { root, repoPath } = await setupRepository();
    const databasePath = join(root, "routes.db");
    const store = createStore(databasePath);
    const database = new DatabaseSync(databasePath); databases.push(database);
    const project = createProject(store, repoPath);
    const app = await routeApp(store);

    const dirty = await createVersion(app, project.id, { name: "dirty", branch: "feature/dirty", baseBranch: "prod" });
    await writeFile(join(dirty.worktreePath, "dirty.txt"), "dirty\n");
    const dirtyResponse = await app.inject({ method: "POST", url: `/api/project-versions/${dirty.id}/close` });
    expect(dirtyResponse.statusCode).toBe(409);
    expect(dirtyResponse.json().error).toBe("PROJECT_VERSION_WORKTREE_DIRTY");

    const missing = await createVersion(app, project.id, { name: "missing", branch: "feature/missing", baseBranch: "prod" });
    await git(repoPath, "worktree", "remove", "--force", missing.worktreePath);
    const missingResponse = await app.inject({ method: "POST", url: `/api/project-versions/${missing.id}/close` });
    expect(missingResponse.statusCode).toBe(409);
    expect(missingResponse.json()).toMatchObject({ error: "PROJECT_VERSION_WORKTREE_INVALID", details: { status: "not_accessible" } });

    const pending = await createVersion(app, project.id, { name: "pending", branch: "feature/pending", baseBranch: "prod" });
    database.prepare("UPDATE project_versions SET pending_requirement_id = ? WHERE id = ?").run("owner", pending.id);
    const pendingResponse = await app.inject({ method: "POST", url: `/api/project-versions/${pending.id}/close` });
    expect(pendingResponse.statusCode).toBe(409);
    expect(pendingResponse.json().error).toBe("PROJECT_VERSION_CLOSE_BLOCKED");

    const historical = await createVersion(app, project.id, { name: "historical", branch: "feature/historical", baseBranch: "prod" });
    const replacement = await createVersion(app, project.id, { name: "replacement", branch: "feature/replacement", baseBranch: "prod" });
    const requirement = store.createRequirement({
      title: "Historical blocker", businessProblem: "Still active", expectedOutcome: "Cannot close",
      priority: "medium", primaryProjectId: project.id, primaryProjectVersionId: historical.id
    });
    store.replaceRequirementProjects(requirement.id, [{
      projectId: project.id, projectVersionId: replacement.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 0
    }]);
    const historicalResponse = await app.inject({ method: "POST", url: `/api/project-versions/${historical.id}/close` });
    expect(historicalResponse.statusCode).toBe(409);
    expect(historicalResponse.json().error).toBe("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
  });
});

describe("project version application queue route", () => {
  it("returns only the exact version queue and reports a missing version", async () => {
    const store = createStore();
    const firstProject = createProject(store, "/tmp/queue-route-first", "Queue first");
    const secondProject = createProject(store, "/tmp/queue-route-second", "Queue second");
    const firstVersion = store.createProjectVersion({
      projectId: firstProject.id, name: "1.0.0", branch: "release/first", baseBranch: "prod",
      worktreePath: "/tmp/queue-route-first-version", headCommit: "a".repeat(40)
    });
    const secondVersion = store.createProjectVersion({
      projectId: secondProject.id, name: "1.0.0", branch: "release/second", baseBranch: "prod",
      worktreePath: "/tmp/queue-route-second-version", headCommit: "b".repeat(40)
    });
    const owner = store.createRequirement({
      title: "Queue owner", businessProblem: "Serialize application", expectedOutcome: "Own first version",
      priority: "high", primaryProjectId: firstProject.id, primaryProjectVersionId: firstVersion.id
    });
    store.updateRequirementState(owner.id, "acceptance_delivery", "awaiting_merge");
    store.beginVersionApplication({
      versionId: firstVersion.id,
      requirementId: owner.id,
      run: {
        id: "queue-route-run", projectId: firstProject.id, executionId: "queue-route-execution",
        evidenceId: "queue-route-evidence", sourceBranch: "ai/queue-owner",
        worktreePath: "/tmp/queue-route-requirement", targetBranch: firstVersion.branch,
        preflight: { allowed: true }
      }
    });
    const app = await routeApp(store);

    const exact = await app.inject({
      method: "GET", url: `/api/project-versions/${firstVersion.id}/application-queue`
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject([{
      requirementId: owner.id, code: owner.code, owner: true, position: 1
    }]);

    const other = await app.inject({
      method: "GET", url: `/api/project-versions/${secondVersion.id}/application-queue`
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual([]);
    expect(store.getProjectVersion(firstVersion.id)).toMatchObject({
      pendingRequirementId: owner.id, pendingIntegrationRunId: "queue-route-run"
    });

    const missing = await app.inject({
      method: "GET", url: "/api/project-versions/missing/application-queue"
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "PROJECT_VERSION_NOT_FOUND" });
  });
});
