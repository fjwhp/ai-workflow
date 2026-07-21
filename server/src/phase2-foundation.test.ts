import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai.js", () => ({ runAgent: vi.fn() }));
vi.mock("./codex-runner.js", () => ({ runCodexCoding: vi.fn() }));

import { buildApp } from "./app.js";
import { runAgent } from "./ai.js";
import { runCodexCoding } from "./codex-runner.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];
const databasePaths = new WeakMap<WorkflowStore, string>();

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "phase2-foundation-"));
  directories.push(directory);
  const path = join(directory, "workflow.db");
  const store = new WorkflowStore(path);
  databasePaths.set(store, path);
  stores.push(store);
  return store;
}

function createRequirement(store: WorkflowStore) {
  const root = mkdtempSync(join(tmpdir(), "phase2-worktree-"));
  directories.push(root);
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  mkdirSync(repoPath);
  git(repoPath, "init", "--initial-branch", "main");
  git(repoPath, "config", "user.name", "Phase 2 Test");
  git(repoPath, "config", "user.email", "phase2@example.invalid");
  mkdirSync(join(repoPath, "fixtures"));
  writeFileSync(join(repoPath, "fixtures", "marker.txt"), "unchanged\n");
  git(repoPath, "add", "fixtures/marker.txt");
  git(repoPath, "commit", "-m", "fixture");
  git(repoPath, "branch", "feature/v1");
  git(repoPath, "worktree", "add", worktreePath, "feature/v1");
  const headCommit = git(repoPath, "rev-parse", "HEAD").trim();
  const project = store.createProject({
    name: "Foundation",
    repoPath,
    defaultBranch: "main",
    allowedCommands: [],
    sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id,
    name: "v1",
    branch: "feature/v1",
    baseBranch: "main",
    worktreePath,
    headCommit
  });
  const requirement = store.createRequirement({
    title: "Keep downstream stages read-only",
    businessProblem: "Foundation must not execute delivery jobs",
    expectedOutcome: "Only delivery-unit state is displayed",
    priority: "high",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
  return { requirement, version, repoPath, worktreePath };
}

function databaseSnapshot(store: WorkflowStore) {
  const database = new DatabaseSync(databasePaths.get(store)!);
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(tables.map(({ name }) => {
      const quotedName = name.replaceAll('"', '""');
      return [name, database.prepare(`SELECT * FROM "${quotedName}" ORDER BY rowid`).all()];
    }));
  } finally {
    database.close();
  }
}

function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
}

function repositorySnapshot(path: string) {
  return {
    status: git(path, "status", "--porcelain=v1", "--untracked-files=all"),
    head: git(path, "rev-parse", "HEAD").trim(),
    files: recursiveFileHashes(path)
  };
}

function recursiveFileHashes(root: string) {
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({
        path: relative(root, path),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

describe("Phase 2 foundation live surface", () => {
  it.each([
    ["GET", "integration-check"],
    ["POST", "integrate"],
    ["POST", "integration-test"]
  ] as const)("does not expose requirement-level %s /%s", async (method, action) => {
    const store = createStore();
    const { requirement } = createRequirement(store);
    const app = await buildApp(store);

    const response = await app.inject({ method, url: `/api/requirements/${requirement.id}/${action}`, payload: method === "POST" ? {} : undefined });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("does not expose the removed project-version application queue", async () => {
    const store = createStore();
    const { version } = createRequirement(store);
    const app = await buildApp(store);

    const response = await app.inject({ method: "GET", url: `/api/project-versions/${version.id}/application-queue` });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)("rejects requirement-owned %s runs without any mutation", async (stage) => {
    const store = createStore();
    const { requirement, repoPath, worktreePath } = createRequirement(store);
    store.updateRequirementState(requirement.id, stage, "ai_ready");
    const app = await buildApp(store);
    const beforeDatabase = databaseSnapshot(store);
    const beforeRepository = repositorySnapshot(repoPath);
    const beforeWorktree = repositorySnapshot(worktreePath);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/run`, payload: {} });
    const detail = await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "DELIVERY_UNIT_AUTOMATION_OWNS_STAGE", stage });
    expect(runAgent).not.toHaveBeenCalled();
    expect(runCodexCoding).not.toHaveBeenCalled();
    expect(store.listExecutions(requirement.id)).toEqual([]);
    expect(store.listStageRuns(requirement.id)).toEqual([]);
    expect(databaseSnapshot(store)).toEqual(beforeDatabase);
    expect(repositorySnapshot(repoPath)).toEqual(beforeRepository);
    expect(repositorySnapshot(worktreePath)).toEqual(beforeWorktree);
    expect(detail.json()).not.toHaveProperty("integrationRun");
    await app.close();
  });

});
