import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryExecutionService, type CodingAgent } from "./delivery-execution-service.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function createFixture() {
  const store = new WorkflowStore(":memory:");
  stores.push(store);
  const project = store.createProject({
    name: "Frozen project",
    repoPath: "/tmp/frozen-project-old",
    defaultBranch: "main",
    allowedCommands: [{ command: "npm", argsPrefix: ["test"] }],
    sensitivePatterns: [".env*"]
  });
  const version = store.createProjectVersion({
    projectId: project.id,
    name: "2.2.1",
    branch: "feature/2.2.1",
    baseBranch: "main",
    worktreePath: "/tmp/frozen-project-version",
    headCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  const requirement = store.createRequirement({
    title: "Frozen implementation",
    businessProblem: "Live project edits must not change an approved run",
    expectedOutcome: "The approved delivery unit is implemented",
    priority: "high",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
  store.replaceRequirementProjects(requirement.id, [{
    projectId: project.id,
    projectVersionId: version.id,
    role: "primary",
    usage: "delivery",
    deliveryRequired: true,
    moduleMode: "all",
    moduleIds: [],
    position: 0
  }]);
  const snapshot = store.createRequirementProjectSnapshot(requirement.id);
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot,
    plan: {
      units: [{
        projectId: project.id,
        moduleIds: ["src/orders"],
        acceptanceCriteria: ["Order contract tests pass"]
      }],
      dependencies: []
    }
  });
  return { store, project, version, requirement, unit: plan.units[0]! };
}

function codingResult() {
  return {
    runId: "agent-run-1",
    branch: "ai/REQ-0001",
    worktreePath: "/tmp/frozen-project-run",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    reused: false,
    summary: "implemented",
    diff: "diff --git a/src/orders/index.ts b/src/orders/index.ts\n+export const ready = true;",
    commands: [{ command: "npm", args: ["test"], exitCode: 0 }],
    files: ["src/orders/index.ts"],
    additions: 1,
    deletions: 0,
    diagnostics: []
  };
}

describe("DeliveryExecutionService", () => {
  it("uses the unit snapshot even when the live project changes and rejects a concurrent claim", async () => {
    const fixture = createFixture();
    fixture.store.updateProject(fixture.project.id, {
      repoPath: "/tmp/frozen-project-new",
      allowedCommands: [{ command: "pnpm", argsPrefix: ["test"] }]
    });
    let finish!: (value: ReturnType<typeof codingResult>) => void;
    const codingAgent = vi.fn(() => new Promise<ReturnType<typeof codingResult>>((resolve) => { finish = resolve; }));
    const service = new DeliveryExecutionService(fixture.store.deliveryExecutions, codingAgent);

    const first = service.implement(fixture.unit.id);

    expect(codingAgent).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({
        id: fixture.project.id,
        repoPath: "/tmp/frozen-project-old",
        allowedCommands: [{ command: "npm", argsPrefix: ["test"] }]
      }),
      version: expect.objectContaining({
        id: fixture.version.id,
        branch: "feature/2.2.1",
        headCommit: "0123456789abcdef0123456789abcdef01234567"
      }),
      deliveryContext: expect.objectContaining({
        deliveryUnitId: fixture.unit.id,
        evidenceVersion: 1,
        moduleIds: ["src/orders"],
        acceptanceCriteria: ["Order contract tests pass"]
      })
    }));
    await expect(service.implement(fixture.unit.id)).rejects.toThrow("DELIVERY_UNIT_RUN_ACTIVE");

    (fixture.store as any).db.prepare("DELETE FROM requirement_projects WHERE requirement_id = ?")
      .run(fixture.requirement.id);

    finish(codingResult());
    await expect(first).resolves.toMatchObject({ status: "awaiting_gate", evidenceVersion: 1 });
    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({
      id: fixture.unit.id,
      status: "awaiting_gate",
      evidenceVersion: 1
    });
    expect(fixture.store.listStageRuns(fixture.requirement.id)).toEqual([
      expect.objectContaining({
        ownerType: "delivery_unit",
        ownerId: fixture.unit.id,
        evidenceVersion: 1,
        status: "completed"
      })
    ]);
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id, 1)).toEqual([
      expect.objectContaining({
        deliveryUnitId: fixture.unit.id,
        evidenceVersion: 1,
        status: "completed",
        commands: codingResult().commands
      })
    ]);
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toMatchObject({
      deliveryUnitId: fixture.unit.id,
      evidenceVersion: 1,
      files: ["src/orders/index.ts"],
      additions: 1,
      deletions: 0
    });
  });

  it("fails only the claimed unit and rethrows the original coding error", async () => {
    const fixture = createFixture();
    const failure = new Error("coding failed with details");
    const codingAgent: CodingAgent = vi.fn().mockRejectedValue(failure);
    const service = new DeliveryExecutionService(fixture.store.deliveryExecutions, codingAgent);
    const before = fixture.store.getRequirement(fixture.requirement.id);

    await expect(service.implement(fixture.unit.id)).rejects.toBe(failure);

    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({
      status: "failed",
      evidenceVersion: 1
    });
    expect(fixture.store.getRequirement(fixture.requirement.id)).toMatchObject({
      stage: before!.stage,
      status: before!.status,
      version: before!.version
    });
    expect(fixture.store.listStageRuns(fixture.requirement.id)[0]).toMatchObject({
      ownerType: "delivery_unit",
      ownerId: fixture.unit.id,
      evidenceVersion: 1,
      status: "failed",
      error: "coding failed with details"
    });
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id, 1)[0]).toMatchObject({
      status: "failed",
      error: "coding failed with details"
    });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });

  it("rolls back the unit claim when execution creation fails", async () => {
    const fixture = createFixture();
    const codingAgent: CodingAgent = vi.fn();
    const service = new DeliveryExecutionService(fixture.store.deliveryExecutions, codingAgent);
    (fixture.store as any).db.exec(`CREATE TRIGGER fail_execution_claim
      BEFORE INSERT ON executions
      BEGIN SELECT RAISE(ABORT, 'forced execution failure'); END;`);

    await expect(service.implement(fixture.unit.id)).rejects.toThrow("forced execution failure");

    expect(codingAgent).not.toHaveBeenCalled();
    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({ status: "ready" });
    expect(fixture.store.listStageRuns(fixture.requirement.id)).toEqual([]);
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)).toEqual([]);
  });

  it("does not let a late success overwrite a newer unit evidence version", async () => {
    const fixture = createFixture();
    let finish!: (value: ReturnType<typeof codingResult>) => void;
    const codingAgent = vi.fn(() => new Promise<ReturnType<typeof codingResult>>((resolve) => { finish = resolve; }));
    const service = new DeliveryExecutionService(fixture.store.deliveryExecutions, codingAgent);
    const implementation = service.implement(fixture.unit.id);
    (fixture.store as any).db.prepare(`UPDATE delivery_units
      SET status = 'returned', evidence_version = 2 WHERE id = ?`).run(fixture.unit.id);

    finish(codingResult());
    await expect(implementation).rejects.toThrow("DELIVERY_UNIT_RUN_STALE");

    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({
      status: "returned",
      evidenceVersion: 2
    });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });
});
