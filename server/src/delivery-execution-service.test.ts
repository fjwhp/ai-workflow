import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryExecutionService,
  createDeliveryQualityAutomationHandlers,
  qualityGitEnvironment,
  qualityGate,
  type CodingAgent
} from "./delivery-execution-service.js";
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
  it("sanitizes inherited Git controls for target identity probes", () => {
    const env = qualityGitEnvironment({
      PATH: "/usr/bin", GIT_DIR: "/attacker", GIT_WORK_TREE: "/attacker-tree",
      GIT_CONFIG_GLOBAL: "/attacker-config", GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "alias.rev-parse", GIT_CONFIG_VALUE_0: "!evil",
      SSH_AUTH_SOCK: "secret", GITHUB_TOKEN: "secret", HTTPS_PROXY: "http://proxy"
    });
    expect(env).toEqual({
      PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_TERMINAL_PROMPT: "0"
    });
  });

  it("does not pass quality when only testing passes", () => {
    expect(qualityGate({ review: "running", testing: "passed" })).toEqual({ status: "running" });
    expect(qualityGate({ review: "passed", testing: "passed" })).toEqual({ status: "passed" });
    expect(qualityGate({ review: "failed", testing: "passed" })).toEqual({ status: "failed" });
  });

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

  it("rolls back implementation and the first quality job when the second enqueue fails", () => {
    const fixture = createFixture();
    const claim = fixture.store.deliveryExecutions.claimImplementation(fixture.unit.id, "test-model");
    (fixture.store as any).db.exec(`CREATE TRIGGER fail_testing_enqueue
      BEFORE INSERT ON automation_jobs WHEN NEW.action = 'test'
      BEGIN SELECT RAISE(ABORT, 'forced testing enqueue failure'); END;`);

    expect(() => fixture.store.deliveryExecutions.completeImplementation(claim, persistenceResult()))
      .toThrow("forced testing enqueue failure");

    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)[0]).toMatchObject({ status: "running" });
    expect(fixture.store.getStageRun(claim.runId)).toMatchObject({ status: "running" });
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id)[0]).toMatchObject({ status: "running" });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`test:${fixture.unit.id}:v1`)).toBeNull();
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
    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)).toMatchObject({
      ownerType: "delivery_unit", ownerId: fixture.unit.id, evidenceVersion: 1, action: "review"
    });
    expect(fixture.store.automationJobs.byDedupe(`test:${fixture.unit.id}:v1`)).toMatchObject({
      ownerType: "delivery_unit", ownerId: fixture.unit.id, evidenceVersion: 1, action: "test"
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

  it("runs review and testing against the same immutable implementation evidence", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const snapshot = {
      diff: implementation.diff, files: implementation.files, additions: 1, deletions: 0,
      changedFiles: [{ path: "src/orders/index.ts", status: "modified" as const, kind: "text" as const, content: "export const ready = true;" }]
    };
    const review = vi.fn().mockResolvedValue({
      conclusion: "pass", confidence: 0.9, summary: "review passed", facts: [], assumptions: [],
      openQuestions: [], risks: [], findings: []
    });
    const testing = vi.fn().mockResolvedValue({
      result: "passed", commandResults: [{ id: "verify-1", exitCode: 0 }],
      acceptanceTrace: [{ criterion: "Order contract tests pass", commandIds: ["verify-1"], passed: true }]
    });
    const targetState = { head: fixture.version.headCommit, refsHash: "refs", diffHash: "target-diff", gitCommonDir: "/repo/.git" };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { getSnapshot: vi.fn().mockResolvedValue(snapshot), review, testing, inspectTarget: vi.fn().mockResolvedValue(targetState) }
    );

    await Promise.all([service.review(fixture.unit.id), service.test(fixture.unit.id)]);

    const reviewEvidence = fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")!;
    const testingEvidence = fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")!;
    expect(reviewEvidence).toMatchObject({ inputEvidenceVersion: 1, result: "passed", content: { summary: "review passed" } });
    expect(testingEvidence).toMatchObject({ inputEvidenceVersion: 1, result: "passed" });
    expect(reviewEvidence.inputCodingEvidenceId).toBe(testingEvidence.inputCodingEvidenceId);
    expect(reviewEvidence.inputDiffHash).toBe(testingEvidence.inputDiffHash);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      implementation: { diff: implementation.diff, changedFiles: snapshot.changedFiles }
    }));
    expect(testing).toHaveBeenCalledWith(expect.objectContaining({
      sourceWorktree: "/tmp/frozen-project-run",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }],
      acceptanceCriteria: ["Order contract tests pass"]
    }));
  });

  it("fails closed before review when the full implementation diff is stale", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const review = vi.fn();
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { getSnapshot: vi.fn().mockResolvedValue({ diff: "different", files: [], changedFiles: [], additions: 0, deletions: 0 }), review }
    );

    await expect(service.review(fixture.unit.id)).resolves.toMatchObject({ result: "failed" });
    expect(review).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toMatchObject({
      result: "failed", content: { error: "IMPLEMENTATION_EVIDENCE_STALE" }
    });
  });

  it("fails testing when the real target changes during disposable verification", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const snapshot = {
      diff: implementation.diff, files: implementation.files, additions: 1, deletions: 0,
      changedFiles: [{ path: "src/orders/index.ts", status: "modified" as const, kind: "text" as const, content: "ready" }]
    };
    const inspectTarget = vi.fn()
      .mockResolvedValueOnce({ head: fixture.version.headCommit, refsHash: "before", diffHash: "clean", gitCommonDir: "/repo/.git" })
      .mockResolvedValueOnce({ head: fixture.version.headCommit, refsHash: "after", diffHash: "clean", gitCommonDir: "/repo/.git" });
    const testing = vi.fn().mockResolvedValue({ result: "passed", commandResults: [], acceptanceTrace: [] });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { getSnapshot: vi.fn().mockResolvedValue(snapshot), inspectTarget, testing }
    );

    await expect(service.test(fixture.unit.id)).resolves.toMatchObject({ result: "failed" });
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toMatchObject({
      result: "failed", content: { error: "AUTOMATED_TEST_TARGET_MUTATED" }
    });
  });

  it("does not disclose a frozen sensitive path to review", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const review = vi.fn();
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { getSnapshot: vi.fn().mockResolvedValue({
        diff: implementation.diff, files: [".env.local"], additions: 1, deletions: 0,
        changedFiles: [{ path: ".env.local", status: "modified", kind: "text", content: "SECRET=value" }]
      }), review }
    );

    await expect(service.review(fixture.unit.id)).resolves.toMatchObject({ result: "failed" });
    expect(review).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toMatchObject({
      content: { error: "IMPLEMENTATION_EVIDENCE_SENSITIVE_PATH" }
    });
  });

  it("does not start testing when the target HEAD differs from the frozen snapshot", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const testing = vi.fn();
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      {
        getSnapshot: vi.fn().mockResolvedValue({
          diff: implementation.diff, files: implementation.files, changedFiles: [], additions: 1, deletions: 0
        }),
        inspectTarget: vi.fn().mockResolvedValue({
          head: "advanced-head", refsHash: "refs", diffHash: "clean", gitCommonDir: "/repo/.git"
        }),
        testing
      }
    );

    await expect(service.test(fixture.unit.id)).resolves.toMatchObject({ result: "failed" });
    expect(testing).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toMatchObject({
      content: { error: "AUTOMATED_TEST_TARGET_HEAD_STALE" }
    });
  });

  it("does not retry a failed evidence settlement as a second completion", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const settlementError = new Error("database unavailable");
    const complete = vi.fn(() => { throw settlementError; });
    const quality = { ...fixture.store.deliveryQuality, complete };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", quality,
      {
        getSnapshot: vi.fn().mockResolvedValue({
          diff: implementation.diff, files: implementation.files, changedFiles: [], additions: 1, deletions: 0
        }),
        review: vi.fn().mockResolvedValue({
          conclusion: "pass", confidence: 0.9, summary: "ok", facts: [], assumptions: [],
          openQuestions: [], risks: [], findings: []
        })
      }
    );

    await expect(service.review(fixture.unit.id)).rejects.toBe(settlementError);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("returns terminal evidence without rerunning review for the same automation job", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const review = vi.fn().mockResolvedValue({
      conclusion: "pass", confidence: 0.9, summary: "ok", facts: [], assumptions: [],
      openQuestions: [], risks: [], findings: []
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { getSnapshot: vi.fn().mockResolvedValue({
        diff: implementation.diff, files: implementation.files, changedFiles: [], additions: 1, deletions: 0
      }), review }
    );

    const first = await service.review(fixture.unit.id, 1, "review-job-1");
    const resumed = await service.review(fixture.unit.id, 1, "review-job-1");

    expect(resumed.id).toBe(first.id);
    expect(review).toHaveBeenCalledOnce();
  });

  it("rejects quality jobs with mismatched ownership, action, or version", async () => {
    const fixture = createFixture();
    const service = { review: vi.fn(), test: vi.fn() } as any;
    const handlers = createDeliveryQualityAutomationHandlers(service);
    const baseJob = { ownerType: "delivery_unit", ownerId: fixture.unit.id, evidenceVersion: 1 } as any;
    await expect(handlers.review!({ ...baseJob, action: "test" })).rejects.toThrow("AUTOMATION_INPUT_INVALID");
    await expect(handlers.test!({ ...baseJob, action: "test", evidenceVersion: 0 })).rejects.toThrow("AUTOMATION_INPUT_INVALID");
    await handlers.review!({ ...baseJob, action: "review" });
    expect(service.review).toHaveBeenCalledWith(fixture.unit.id, 1, undefined);
  });
});
