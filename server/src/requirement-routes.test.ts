import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { registerRequirementRoutes } from "./requirement-routes.js";
import { WorkflowStore } from "./store.js";

const directories: string[] = [];
const stores: WorkflowStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function solutionDesignArtifact(backendProjectId: string, frontendProjectId: string) {
  return {
    conclusion: "pass" as const,
    confidence: 0.95,
    summary: "Backend precedes frontend",
    facts: [], assumptions: [], openQuestions: [], risks: [], findings: [],
    deliveryPlan: {
      units: [
        { projectId: backendProjectId, moduleIds: ["api"], acceptanceCriteria: ["API passes"] },
        { projectId: frontendProjectId, moduleIds: ["web"], acceptanceCriteria: ["Web passes"] }
      ],
      dependencies: [{
        upstreamProjectId: backendProjectId,
        downstreamProjectId: frontendProjectId,
        releaseCondition: "automated_testing_passed" as const
      }]
    },
    contracts: [{
      name: "HTTP API", producerProjectId: backendProjectId,
      consumerProjectIds: [frontendProjectId], description: "Versioned API contract"
    }]
  };
}

function createFixture(options: { artifact?: unknown | false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "requirement-routes-"));
  directories.push(directory);
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  stores.push(store);
  const backend = store.createProject({
    name: "Backend", repoPath: join(directory, "backend"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const frontend = store.createProject({
    name: "Frontend", repoPath: join(directory, "frontend"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const backendVersion = store.createProjectVersion({
    projectId: backend.id, name: "v1", branch: "backend-v1", baseBranch: "main",
    worktreePath: join(directory, "backend-v1"), headCommit: "backend-head"
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "v1", branch: "frontend-v1", baseBranch: "main",
    worktreePath: join(directory, "frontend-v1"), headCommit: "frontend-head"
  });
  const requirement = store.createRequirement({
    title: "Cross-project delivery",
    businessProblem: "Two active projects must be delivered in a safe order",
    expectedOutcome: "A frozen delivery graph is created",
    priority: "high",
    primaryProjectId: backend.id,
    primaryProjectVersionId: backendVersion.id
  });
  store.replaceRequirementProjects(requirement.id, [
    {
      projectId: backend.id, projectVersionId: backendVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    },
    {
      projectId: frontend.id, projectVersionId: frontendVersion.id, role: "collaborator", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1
    }
  ]);
  store.updateRequirementState(requirement.id, "solution_design", "awaiting_approval");
  const artifact = options.artifact === undefined
    ? solutionDesignArtifact(backend.id, frontend.id)
    : options.artifact;
  if (artifact !== false) store.addArtifact(requirement.id, "solution_design", "Solution design", artifact);
  return { directory, databasePath, store, requirement, backend, frontend };
}

function queryCount(databasePath: string, table: string, requirementId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const requirementColumn = table === "automation_jobs" ? "owner_id" : "requirement_id";
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${requirementColumn} = ?`)
      .get(requirementId) as { count: number }).count;
  } finally {
    database.close();
  }
}

function expectNoApprovalWrites(fixture: ReturnType<typeof createFixture>) {
  for (const table of [
    "requirement_project_snapshots", "delivery_units", "delivery_unit_snapshots",
    "delivery_dependencies", "approvals", "automation_jobs"
  ]) expect(queryCount(fixture.databasePath, table, fixture.requirement.id)).toBe(0);
}

describe("requirement approval routes", () => {
  it("approves from the latest persisted graph, strips client graph fields, and exposes units in detail", async () => {
    const fixture = createFixture();
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: {
        decision: "approve",
        comment: "Approve persisted design",
        deliveryPlan: {
          units: [{ projectId: fixture.frontend.id, moduleIds: [], acceptanceCriteria: ["tampered"] }],
          dependencies: []
        },
        hiddenGraph: { units: [] }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stage: "implementation", status: "ai_ready" });
    const detail = await app.inject({ method: "GET", url: `/api/requirements/${fixture.requirement.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ stage: "implementation", status: "ai_ready" });
    expect(detail.json().deliveryUnits.map((unit: any) => [unit.projectId, unit.status])).toEqual([
      [fixture.backend.id, "ready"],
      [fixture.frontend.id, "waiting_dependency"]
    ]);
    expect(detail.json().deliveryDependencies).toHaveLength(1);
    expect(queryCount(fixture.databasePath, "requirement_project_snapshots", fixture.requirement.id)).toBe(1);
    expect(queryCount(fixture.databasePath, "delivery_unit_snapshots", fixture.requirement.id)).toBe(2);
    expect(queryCount(fixture.databasePath, "approvals", fixture.requirement.id)).toBe(1);
    expect(queryCount(fixture.databasePath, "automation_jobs", fixture.requirement.id)).toBe(0);
    await app.close();
  });

  it("returns a stable cycle conflict and rolls back every approval write", async () => {
    const fixture = createFixture({ artifact: false });
    const artifact = solutionDesignArtifact(fixture.backend.id, fixture.frontend.id);
    artifact.deliveryPlan.dependencies.push({
      upstreamProjectId: fixture.frontend.id,
      downstreamProjectId: fixture.backend.id,
      releaseCondition: "automated_testing_passed"
    });
    fixture.store.addArtifact(fixture.requirement.id, "solution_design", "Cyclic latest design", artifact);
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST", url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Approve cycle" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "DELIVERY_DEPENDENCY_CYCLE" });
    expect(fixture.store.getRequirement(fixture.requirement.id)).toMatchObject({
      stage: "solution_design", status: "awaiting_approval"
    });
    expectNoApprovalWrites(fixture);
    await app.close();
  });

  it("maps missing, not-ready, missing-artifact, and invalid-latest states to stable responses", async () => {
    const missingArtifact = createFixture({ artifact: false });
    const missingArtifactApp = await buildApp(missingArtifact.store);
    const missing = await missingArtifactApp.inject({
      method: "POST", url: "/api/requirements/missing/approve",
      payload: { decision: "approve", comment: "Missing requirement" }
    });
    expect(missing.statusCode).toBe(404);

    const noArtifact = await missingArtifactApp.inject({
      method: "POST", url: `/api/requirements/${missingArtifact.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Missing artifact" }
    });
    expect(noArtifact.statusCode).toBe(409);
    expect(noArtifact.json()).toEqual({ error: "SOLUTION_DESIGN_ARTIFACT_NOT_FOUND" });
    await missingArtifactApp.close();

    const invalid = createFixture();
    invalid.store.addArtifact(invalid.requirement.id, "solution_design", "Invalid latest", { summary: "invalid" });
    const invalidApp = await buildApp(invalid.store);
    const invalidResponse = await invalidApp.inject({
      method: "POST", url: `/api/requirements/${invalid.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Do not fall back" }
    });
    expect(invalidResponse.statusCode).toBe(409);
    expect(invalidResponse.json()).toEqual({ error: "SOLUTION_DESIGN_ARTIFACT_INVALID" });
    expectNoApprovalWrites(invalid);

    invalid.store.updateRequirementState(invalid.requirement.id, "solution_design", "ai_ready");
    const notReady = await invalidApp.inject({
      method: "POST", url: `/api/requirements/${invalid.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Not ready" }
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toEqual({ error: "REQUIREMENT_APPROVAL_NOT_READY" });
    await invalidApp.close();
  });

  it("rejects a second approval without duplicating the frozen plan or approval", async () => {
    const fixture = createFixture();
    const app = await buildApp(fixture.store);
    const request = () => app.inject({
      method: "POST", url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Approve once" }
    });

    expect((await request()).statusCode).toBe(200);
    const second = await request();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "REQUIREMENT_APPROVAL_NOT_READY" });
    expect(queryCount(fixture.databasePath, "requirement_project_snapshots", fixture.requirement.id)).toBe(1);
    expect(queryCount(fixture.databasePath, "delivery_units", fixture.requirement.id)).toBe(2);
    expect(queryCount(fixture.databasePath, "delivery_dependencies", fixture.requirement.id)).toBe(1);
    expect(queryCount(fixture.databasePath, "approvals", fixture.requirement.id)).toBe(1);
    await app.close();
  });

  it("rolls back snapshot, units, dependencies, approval, and requirement state when approval insertion fails", async () => {
    const fixture = createFixture();
    const externalDatabase = new DatabaseSync(fixture.databasePath);
    externalDatabase.exec(`CREATE TRIGGER fail_solution_design_approval
      BEFORE INSERT ON approvals WHEN NEW.stage = 'solution_design'
      BEGIN SELECT RAISE(ABORT, 'forced approval failure'); END`);
    externalDatabase.close();
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST", url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: { decision: "approve", comment: "Trigger rollback" }
    });

    expect(response.statusCode).toBe(500);
    expect(fixture.store.getRequirement(fixture.requirement.id)).toMatchObject({
      stage: "solution_design", status: "awaiting_approval"
    });
    expectNoApprovalWrites(fixture);
    await app.close();
  });

  it("forces solution-design returns to definition and creates no frozen delivery plan", async () => {
    const fixture = createFixture();
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST", url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: {
        decision: "return", comment: "Clarify the requirement", targetStage: "acceptance_delivery",
        deliveryPlan: { units: [], dependencies: [] }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stage: "definition", status: "returned" });
    expect(fixture.store.listApprovals(fixture.requirement.id)[0]).toMatchObject({
      stage: "solution_design", decision: "return", target_stage: "definition"
    });
    expect(queryCount(fixture.databasePath, "requirement_project_snapshots", fixture.requirement.id)).toBe(0);
    expect(queryCount(fixture.databasePath, "delivery_units", fixture.requirement.id)).toBe(0);
    expect(queryCount(fixture.databasePath, "delivery_dependencies", fixture.requirement.id)).toBe(0);
    expect(queryCount(fixture.databasePath, "approvals", fixture.requirement.id)).toBe(1);
    await app.close();
  });

  it("keeps generic approval behavior for other stages and ignores post-commit callback failures", async () => {
    const fixture = createFixture();
    fixture.store.updateRequirementState(fixture.requirement.id, "definition", "awaiting_approval");
    const app = Fastify();
    await registerRequirementRoutes(app, {
      store: fixture.store,
      onApproved: () => { throw new Error("knowledge refresh failed"); }
    });

    const response = await app.inject({
      method: "POST", url: `/api/requirements/${fixture.requirement.id}/approve`,
      payload: { decision: "conditional", comment: "Proceed conditionally", condition: "Track the risk" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stage: "solution_design", status: "ai_ready" });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toHaveLength(1);
    await app.close();
  });
});
