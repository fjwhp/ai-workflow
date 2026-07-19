import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementWorkflowService } from "./requirement-workflow-service.js";
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
    confidence: 0.96,
    summary: "Deliver the API before the web integration",
    facts: ["Both projects use active versions"],
    assumptions: [],
    openQuestions: [],
    risks: [],
    findings: [],
    deliveryPlan: {
      units: [
        { projectId: backendProjectId, moduleIds: ["src/api"], acceptanceCriteria: ["API contract tests pass"] },
        { projectId: frontendProjectId, moduleIds: ["src/web"], acceptanceCriteria: ["Web integration tests pass"] }
      ],
      dependencies: [{
        upstreamProjectId: backendProjectId,
        downstreamProjectId: frontendProjectId,
        releaseCondition: "automated_testing_passed" as const
      }]
    },
    contracts: [{
      name: "Orders HTTP API",
      producerProjectId: backendProjectId,
      consumerProjectIds: [frontendProjectId],
      description: "The web application consumes the versioned orders endpoint"
    }]
  };
}

function createFixture(options: { artifact?: boolean } = { artifact: true }) {
  const directory = mkdtempSync(join(tmpdir(), "requirement-workflow-service-"));
  directories.push(directory);
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  stores.push(store);
  const backend = store.createProject({
    name: "Backend", repoPath: join(directory, "backend"), defaultBranch: "main",
    allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
  });
  const frontend = store.createProject({
    name: "Frontend", repoPath: join(directory, "frontend"), defaultBranch: "main",
    allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
  });
  const backendVersion = store.createProjectVersion({
    projectId: backend.id, name: "backend-v1", branch: "feature/backend", baseBranch: "main",
    worktreePath: join(directory, "backend-v1"), headCommit: "backend-head"
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "frontend-v1", branch: "feature/frontend", baseBranch: "main",
    worktreePath: join(directory, "frontend-v1"), headCommit: "frontend-head"
  });
  const requirement = store.createRequirement({
    title: "Coordinated delivery",
    businessProblem: "The API and web application need a coordinated change",
    expectedOutcome: "Both projects ship in dependency order",
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
  if (options.artifact !== false) {
    store.addArtifact(requirement.id, "solution_design", "Solution design", solutionDesignArtifact(backend.id, frontend.id));
  }
  const service = new RequirementWorkflowService(store, () => new Date("2026-07-20T08:00:00.000Z"));
  return { directory, databasePath, store, service, requirement, backend, frontend, backendVersion, frontendVersion };
}

function count(databasePath: string, table: string, requirementId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const requirementColumn = table === "automation_jobs" ? "owner_id" : "requirement_id";
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${requirementColumn} = ?`)
      .get(requirementId) as { count: number }).count;
  } finally {
    database.close();
  }
}

describe("RequirementWorkflowService", () => {
  it("approves persisted solution design and creates the frozen delivery plan atomically", () => {
    const fixture = createFixture();

    const result = fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "approve", comment: "Design approved" }
    });

    expect(result.requirement).toMatchObject({ stage: "implementation", status: "ai_ready" });
    expect(result.snapshot).toMatchObject({ requirementId: fixture.requirement.id, version: 1, status: "active" });
    expect(result.deliveryUnits.map((unit) => [unit.projectId, unit.status])).toEqual([
      [fixture.backend.id, "ready"],
      [fixture.frontend.id, "waiting_dependency"]
    ]);
    expect(result.deliveryDependencies).toHaveLength(1);
    expect(result.approval).toMatchObject({
      requirement_id: fixture.requirement.id,
      stage: "solution_design",
      decision: "approve",
      comment: "Design approved"
    });
    expect(count(fixture.databasePath, "requirement_project_snapshots", fixture.requirement.id)).toBe(1);
    expect(count(fixture.databasePath, "delivery_units", fixture.requirement.id)).toBe(2);
    expect(count(fixture.databasePath, "delivery_unit_snapshots", fixture.requirement.id)).toBe(2);
    expect(count(fixture.databasePath, "delivery_dependencies", fixture.requirement.id)).toBe(1);
    expect(count(fixture.databasePath, "approvals", fixture.requirement.id)).toBe(1);
    expect(count(fixture.databasePath, "automation_jobs", fixture.requirement.id)).toBe(0);
  });

  it("uses only the latest artifact and preserves all state when its delivery graph is cyclic", () => {
    const fixture = createFixture();
    const cyclic = solutionDesignArtifact(fixture.backend.id, fixture.frontend.id);
    cyclic.deliveryPlan.dependencies.push({
      upstreamProjectId: fixture.frontend.id,
      downstreamProjectId: fixture.backend.id,
      releaseCondition: "automated_testing_passed"
    });
    fixture.store.addArtifact(fixture.requirement.id, "solution_design", "Latest cyclic design", cyclic);

    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "approve", comment: "Do not approve the old graph" }
    })).toThrow("DELIVERY_DEPENDENCY_CYCLE");

    expect(fixture.store.getRequirement(fixture.requirement.id)).toMatchObject({
      stage: "solution_design", status: "awaiting_approval"
    });
    for (const table of [
      "requirement_project_snapshots", "delivery_units", "delivery_unit_snapshots",
      "delivery_dependencies", "approvals", "automation_jobs"
    ]) expect(count(fixture.databasePath, table, fixture.requirement.id)).toBe(0);
  });

  it("returns stable errors for missing requirements, invalid state, missing artifacts, and invalid latest artifacts", () => {
    const fixture = createFixture({ artifact: false });
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: "missing",
      approval: { decision: "approve", comment: "Approve missing" }
    })).toThrow("REQUIREMENT_NOT_FOUND");
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "approve", comment: "No artifact" }
    })).toThrow("SOLUTION_DESIGN_ARTIFACT_NOT_FOUND");

    fixture.store.addArtifact(fixture.requirement.id, "solution_design", "Invalid latest artifact", { summary: "incomplete" });
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "conditional", comment: "Invalid artifact", condition: "Fix it" }
    })).toThrow("SOLUTION_DESIGN_ARTIFACT_INVALID");

    fixture.store.updateRequirementState(fixture.requirement.id, "definition", "awaiting_approval");
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "approve", comment: "Wrong stage" }
    })).toThrow("REQUIREMENT_APPROVAL_STATE_CHANGED");
    fixture.store.updateRequirementState(fixture.requirement.id, "solution_design", "ai_ready");
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "approve", comment: "Wrong status" }
    })).toThrow("REQUIREMENT_APPROVAL_NOT_READY");
  });

  it("rejects return decisions because they belong to the generic approval flow", () => {
    const fixture = createFixture();
    expect(() => fixture.service.approveSolutionDesign({
      requirementId: fixture.requirement.id,
      approval: { decision: "return", comment: "Return it" }
    })).toThrow("SOLUTION_DESIGN_APPROVAL_DECISION_INVALID");
    expect(count(fixture.databasePath, "approvals", fixture.requirement.id)).toBe(0);
  });
});
