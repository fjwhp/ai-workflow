import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  mkdirSync(worktreePath);
  writeFileSync(join(worktreePath, "marker.txt"), "unchanged\n");
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
    headCommit: "abc123"
  });
  const requirement = store.createRequirement({
    title: "Keep downstream stages read-only",
    businessProblem: "Foundation must not execute delivery jobs",
    expectedOutcome: "Only delivery-unit state is displayed",
    priority: "high",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
  return { requirement, version, worktreePath };
}

const mutationTables = [
  "requirements", "requirement_revisions", "requirement_projects", "requirement_project_snapshots",
  "project_versions", "stage_runs", "executions", "automation_jobs", "delivery_units",
  "delivery_unit_snapshots", "delivery_dependencies", "approvals", "artifacts"
] as const;

function databaseSnapshot(store: WorkflowStore) {
  const database = new DatabaseSync(databasePaths.get(store)!);
  try {
    return Object.fromEntries(mutationTables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally {
    database.close();
  }
}

function worktreeSnapshot(path: string) {
  return { entries: readdirSync(path).sort(), marker: readFileSync(join(path, "marker.txt"), "utf8") };
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

  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)("keeps %s runs read-only without any mutation", async (stage) => {
    const store = createStore();
    const { requirement, worktreePath } = createRequirement(store);
    store.updateRequirementState(requirement.id, stage, "ai_ready");
    const app = await buildApp(store);
    const beforeDatabase = databaseSnapshot(store);
    const beforeWorktree = worktreeSnapshot(worktreePath);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/run`, payload: {} });
    const detail = await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requirement: { id: requirement.id, stage }, stage, automationPending: true });
    expect(response.json()).toHaveProperty("deliveryUnits");
    expect(response.json()).toHaveProperty("deliveryDependencies");
    expect(runAgent).not.toHaveBeenCalled();
    expect(runCodexCoding).not.toHaveBeenCalled();
    expect(store.listExecutions(requirement.id)).toEqual([]);
    expect(store.listStageRuns(requirement.id)).toEqual([]);
    expect(databaseSnapshot(store)).toEqual(beforeDatabase);
    expect(worktreeSnapshot(worktreePath)).toEqual(beforeWorktree);
    expect(detail.json()).not.toHaveProperty("integrationRun");
    await app.close();
  });

});
