import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function createStore() {
  const store = new WorkflowStore(join(mkdtempSync(join(tmpdir(), "phase2-foundation-")), "workflow.db"));
  stores.push(store);
  return store;
}

function createRequirement(store: WorkflowStore) {
  const project = store.createProject({
    name: "Foundation",
    repoPath: `/tmp/foundation-${Date.now()}-${Math.random()}`,
    defaultBranch: "main",
    allowedCommands: [],
    sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id,
    name: "v1",
    branch: "feature/v1",
    baseBranch: "main",
    worktreePath: `/tmp/foundation-worktree-${Date.now()}-${Math.random()}`,
    headCommit: "abc123"
  });
  return store.createRequirement({
    title: "Keep downstream stages read-only",
    businessProblem: "Foundation must not execute delivery jobs",
    expectedOutcome: "Only delivery-unit state is displayed",
    priority: "high",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
}

describe("Phase 2 foundation live surface", () => {
  it.each([
    ["GET", "integration-check"],
    ["POST", "integrate"],
    ["POST", "integration-test"]
  ] as const)("does not expose requirement-level %s /%s", async (method, action) => {
    const store = createStore();
    const requirement = createRequirement(store);
    const app = await buildApp(store);

    const response = await app.inject({ method, url: `/api/requirements/${requirement.id}/${action}`, payload: method === "POST" ? {} : undefined });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("keeps downstream runs read-only and omits legacy application state", async () => {
    const store = createStore();
    const requirement = createRequirement(store);
    store.updateRequirementState(requirement.id, "implementation", "ai_ready");
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/run`, payload: {} });
    const detail = await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stage: "implementation", automationPending: true });
    expect(store.listExecutions(requirement.id)).toEqual([]);
    expect(store.listStageRuns(requirement.id)).toEqual([]);
    expect(detail.json()).not.toHaveProperty("integrationRun");
    await app.close();
  });

});
