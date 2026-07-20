import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryExecutionService, type CodingAgent } from "./delivery-execution-service.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function createFixture(databasePath = ":memory:") {
  const store = new WorkflowStore(databasePath);
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

function fileBackedDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "delivery-execution-service-"));
  directories.push(directory);
  return join(directory, "workflow.db");
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
    commands: [] as const,
    files: ["src/orders/index.ts"],
    additions: 1,
    deletions: 0,
    diagnostics: []
  };
}

function persistenceResult() {
  return {
    branch: "ai/REQ-0001",
    worktreePath: "/tmp/frozen-project-run",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    commands: [] as const,
    diff: "diff --git a/src/orders/index.ts b/src/orders/index.ts\n+export const ready = true;",
    diffHash: "diff-hash",
    originalChars: 82,
    truncated: false,
    files: ["src/orders/index.ts"],
    additions: 1,
    deletions: 0,
    diagnostics: "",
    output: { summary: "implemented" }
  };
}

function claimOnNextTurn(store: WorkflowStore, unitId: string) {
  return new Promise((resolve, reject) => setImmediate(() => {
    try { resolve(store.deliveryExecutions.claimImplementation(unitId, "test-model")); }
    catch (error) { reject(error); }
  }));
}

describe("DeliveryExecutionService", () => {
  it("allows only one claim across two file-backed store connections", async () => {
    const databasePath = fileBackedDatabase();
    const fixture = createFixture(databasePath);
    const secondStore = new WorkflowStore(databasePath);
    stores.push(secondStore);

    const attempts = await Promise.allSettled([
      claimOnNextTurn(fixture.store, fixture.unit.id),
      claimOnNextTurn(secondStore, fixture.unit.id)
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: "DELIVERY_UNIT_RUN_ACTIVE" });
    expect(fixture.store.listStageRuns(fixture.requirement.id)).toHaveLength(1);
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)).toHaveLength(1);
  });

  it.each([
    ["module ids", "module_ids_json", "{}"],
    ["acceptance criteria", "acceptance_criteria_json", "{"],
    ["sensitive patterns", "sensitive_patterns_json", "[1]"],
    ["allowed commands", "allowed_commands_json", "[{\"command\":1}]" ]
  ])("fails closed for malformed snapshot %s", async (_label, column, value) => {
    const fixture = createFixture();
    (fixture.store as any).db.prepare(`UPDATE delivery_unit_snapshots SET ${column} = ? WHERE delivery_unit_id = ?`)
      .run(value, fixture.unit.id);
    const codingAgent: CodingAgent = vi.fn();
    const service = new DeliveryExecutionService(fixture.store.deliveryExecutions, codingAgent);

    await expect(service.implement(fixture.unit.id)).rejects.toThrow("DELIVERY_UNIT_SNAPSHOT_INVALID");

    expect(codingAgent).not.toHaveBeenCalled();
    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({ status: "ready" });
    expect(fixture.store.listStageRuns(fixture.requirement.id)).toEqual([]);
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)).toEqual([]);
  });

  it("rolls back every complete mutation when coding evidence insertion fails", () => {
    const fixture = createFixture();
    const claim = fixture.store.deliveryExecutions.claimImplementation(fixture.unit.id, "test-model");
    (fixture.store as any).db.exec(`CREATE TRIGGER fail_coding_evidence_insert
      BEFORE INSERT ON coding_evidence
      BEGIN SELECT RAISE(ABORT, 'forced evidence failure'); END;`);

    expect(() => fixture.store.deliveryExecutions.completeImplementation(claim, persistenceResult()))
      .toThrow("forced evidence failure");

    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({ status: "running" });
    expect(fixture.store.getStageRun(claim.runId)).toMatchObject({ status: "running", error: null });
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)[0]).toMatchObject({ status: "running", error: null });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
    expect(fixture.store.getStageRun(claim.runId)?.events.map((event: any) => event.type)).toEqual(["run.started"]);
  });

  it("rolls back every failure mutation when the terminal event insertion fails", () => {
    const fixture = createFixture();
    const claim = fixture.store.deliveryExecutions.claimImplementation(fixture.unit.id, "test-model");
    (fixture.store as any).db.exec(`CREATE TRIGGER fail_terminal_event_insert
      BEFORE INSERT ON stage_run_events WHEN NEW.type = 'run.failed'
      BEGIN SELECT RAISE(ABORT, 'forced terminal event failure'); END;`);

    expect(() => fixture.store.deliveryExecutions.failImplementation(claim, "coding failed"))
      .toThrow("forced terminal event failure");

    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({ status: "running" });
    expect(fixture.store.getStageRun(claim.runId)).toMatchObject({ status: "running", error: null });
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)[0]).toMatchObject({ status: "running", error: null });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
    expect(fixture.store.getStageRun(claim.runId)?.events.map((event: any) => event.type)).toEqual(["run.started"]);
  });

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
        acceptanceCriteria: ["Order contract tests pass"],
        allowedCommands: [{ command: "npm", argsPrefix: ["test"] }]
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
        commands: []
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

  it.each([
    ["Error rejection", new Error("coding failed")],
    ["primitive rejection", "coding failed as text"]
  ])("surfaces a stale failure settlement for an %s and preserves the coding failure as cause", async (_name, codingFailure) => {
    const fixture = createFixture();
    const settlementFailure = new Error("DELIVERY_UNIT_RUN_STALE");
    const failImplementation = vi.fn(() => { throw settlementFailure; });
    const persistence = { ...fixture.store.deliveryExecutions, failImplementation };
    const service = new DeliveryExecutionService(
      persistence,
      vi.fn().mockRejectedValue(codingFailure)
    );

    await expect(service.implement(fixture.unit.id)).rejects.toBe(settlementFailure);

    expect(settlementFailure.cause).toBe(codingFailure);
    expect(failImplementation).toHaveBeenCalledOnce();
  });
});
