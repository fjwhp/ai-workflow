import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryExecutionService as RealDeliveryExecutionService,
  createDeliveryAutomationHandlers,
  createDeliveryQualityAutomationHandlers,
  qualityGitEnvironment,
  qualityGate,
  type CodingAgent
} from "./delivery-execution-service.js";
import { WorkflowStore } from "./store.js";
import { evidenceFingerprint, evidenceManifestHash } from "./evidence-tree.js";
import { createAutomationWorker } from "./automation-worker.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];

const testImplementationDependencies = {
  prepare: async (input: any) => ({
    workspace: {
      branch: "HEAD", worktreePath: `${input.version.worktreePath}/.isolated-test-attempt`,
      baseCommit: input.version.headCommit, reused: false as const
    },
    publish: async (result: any) => result,
    rollback: async () => {},
    cleanup: async () => {}
  })
};

class DeliveryExecutionService extends RealDeliveryExecutionService {
  constructor(...args: ConstructorParameters<typeof RealDeliveryExecutionService>) {
    const [persistence, codingAgent, model, qualityPersistence, qualityDependencies, implementationDependencies] = args;
    super(
      persistence, codingAgent, model, qualityPersistence, qualityDependencies,
      implementationDependencies ?? testImplementationDependencies
    );
  }
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  vi.useRealTimers();
});

function createFixture(databasePath = ":memory:", clock: () => Date = () => new Date()) {
  const store = new WorkflowStore(databasePath, clock);
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
  const result = {
    runId: "agent-run-1",
    branch: "ai/REQ-0001",
    worktreePath: "/tmp/.ai-workflow-worktrees/frozen-project-old/requirements/REQ-0001",
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
  const content = Buffer.from("export const ready = true;\n");
  const identity = {
    repositoryPath: "/tmp/frozen-project-old", gitCommonDir: "/tmp/frozen-project-old/.git",
    worktreePath: result.worktreePath, branch: result.branch, headCommit: result.baseCommit
  };
  const manifest = { version: 1 as const, entries: [{
    path: "src/orders/index.ts", type: "file" as const, mode: "100644" as const,
    size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64")
  }] };
  const manifestHash = evidenceManifestHash(manifest);
  return { ...result, evidenceSnapshot: {
    diff: result.diff, files: result.files, additions: result.additions, deletions: result.deletions,
    changedFiles: [{ path: "src/orders/index.ts", status: "modified" as const, kind: "text" as const, content: content.toString("utf8") }],
    identity, manifest, manifestHash, evidenceHash: evidenceFingerprint({
      identity, manifestHash, diff: result.diff,
      changedFiles: [{ path: "src/orders/index.ts", status: "modified", kind: "text", content: content.toString("utf8") }]
    })
  } };
}

function persistenceResult() {
  return {
    branch: "ai/REQ-0001",
    worktreePath: "/tmp/frozen-project-run",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    commands: [] as const,
    diff: "diff --git a/src/orders/index.ts b/src/orders/index.ts\n+export const ready = true;",
    diffHash: "diff-hash",
    changedFiles: [],
    identity: {
      repositoryPath: "/tmp/frozen-project-old", gitCommonDir: "/tmp/frozen-project-old/.git",
      worktreePath: "/tmp/frozen-project-run", branch: "ai/REQ-0001",
      headCommit: "0123456789abcdef0123456789abcdef01234567"
    },
    manifest: { version: 1 as const, entries: [] }, manifestHash: "manifest-hash",
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
  it("fails closed when the coding agent omits its frozen evidence snapshot", async () => {
    const fixture = createFixture();
    const implementation = { ...codingResult(), evidenceSnapshot: undefined } as any;
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation)
    );

    await expect(service.implement(fixture.unit.id)).rejects.toThrow("IMPLEMENTATION_EVIDENCE_REQUIRED");
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });

  it("redacts coding metadata before any execution or evidence persistence", async () => {
    const fixture = createFixture();
    const secret = "persist-me-never";
    const implementation = {
      ...codingResult(),
      diagnostics: [`token=${secret}`],
      events: [{ apiKey: secret, note: `password=${secret}` }],
      summary: `secret=${secret}`
    };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation)
    );

    await service.implement(fixture.unit.id);

    const persisted = JSON.stringify({
      execution: fixture.store.listExecutions(fixture.requirement.id),
      evidence: fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1),
      runs: fixture.store.listStageRuns(fixture.requirement.id)
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
  });

  it("does not persist secrets returned by the code review provider", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const probes = ["provider-basic-probe", "provider-openai-probe", "provider-url-probe"];
    const review = vi.fn().mockResolvedValue({
      conclusion: "pass", confidence: 0.9,
      summary: "Authorization: Basic provider-basic-probe",
      facts: ["OPENAI_API_KEY=sk-proj-provider-openai-probe"],
      assumptions: [], openQuestions: [], risks: ["https://user:provider-url-probe@example.com"], findings: []
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );

    await service.review(fixture.unit.id, 1, "review-provider-redaction");

    const persisted = JSON.stringify(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review"));
    for (const probe of probes) expect(persisted).not.toContain(probe);
    expect(persisted).toContain("[REDACTED]");
  });

  it("persists an identity-bound tree once and never reloads the live source for review", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    const frozenContent = Buffer.from("export const ready = true;\n");
    const identity = {
      repositoryPath: fixture.project.repoPath, gitCommonDir: `${fixture.project.repoPath}/.git`,
      worktreePath: implementation.worktreePath, branch: implementation.branch,
      headCommit: implementation.baseCommit
    };
    const manifest = { version: 1 as const, entries: [{
      path: "src/orders/index.ts", type: "file" as const, mode: "100644" as const,
      size: frozenContent.length, sha256: createHash("sha256").update(frozenContent).digest("hex"),
      contentBase64: frozenContent.toString("base64")
    }] };
    const manifestHash = evidenceManifestHash(manifest);
    const snapshot = {
      diff: implementation.diff, files: implementation.files, additions: 1, deletions: 0,
      changedFiles: [{
        path: "src/orders/index.ts", status: "modified" as const,
        kind: "text" as const, content: frozenContent.toString("utf8")
      }],
      identity, manifest, manifestHash,
      evidenceHash: evidenceFingerprint({ identity, manifestHash, diff: implementation.diff, changedFiles: [{
        path: "src/orders/index.ts", status: "modified", kind: "text", content: frozenContent.toString("utf8")
      }] })
    };
    implementation.evidenceSnapshot = snapshot;
    const review = vi.fn().mockResolvedValue({
      conclusion: "pass", confidence: 0.9, summary: "ok", facts: [], assumptions: [],
      openQuestions: [], risks: [], findings: []
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation), "test-model",
      fixture.store.deliveryQuality, { review }
    );

    await service.implement(fixture.unit.id);

    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toMatchObject({
      diffHash: snapshot.evidenceHash, manifestHash: snapshot.manifestHash,
      sourceHead: implementation.baseCommit, manifest: snapshot.manifest
    });
    snapshot.manifest.entries[0]!.contentBase64 = Buffer.from("mutated live source\n").toString("base64");

    await service.review(fixture.unit.id);

    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      implementation: expect.objectContaining({
        changedFiles: [expect.objectContaining({ content: "export const ready = true;\n" })]
      })
    }), expect.any(AbortSignal));
  });

  it("rejects implementation evidence when worktree HEAD differs from its base commit", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    implementation.evidenceSnapshot = {
      diff: implementation.diff, files: implementation.files, changedFiles: [], additions: 1, deletions: 0,
      identity: {
        repositoryPath: fixture.project.repoPath, gitCommonDir: `${fixture.project.repoPath}/.git`,
        worktreePath: implementation.worktreePath, branch: implementation.branch, headCommit: "different-head"
      },
      manifest: { version: 1, entries: [] }, manifestHash: "manifest", evidenceHash: "evidence"
    };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation), "test-model",
      fixture.store.deliveryQuality
    );

    await expect(service.implement(fixture.unit.id)).rejects.toThrow("IMPLEMENTATION_EVIDENCE_IDENTITY_MISMATCH");
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });

  it("rejects self-consistent evidence outside the deterministic managed requirement worktree", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    implementation.worktreePath = "/tmp/foreign-requirement-worktree";
    implementation.evidenceSnapshot.identity.worktreePath = implementation.worktreePath;
    implementation.evidenceSnapshot.evidenceHash = evidenceFingerprint({
      identity: implementation.evidenceSnapshot.identity,
      manifestHash: implementation.evidenceSnapshot.manifestHash,
      diff: implementation.evidenceSnapshot.diff,
      changedFiles: implementation.evidenceSnapshot.changedFiles
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation)
    );

    await expect(service.implement(fixture.unit.id)).rejects.toThrow("IMPLEMENTATION_EVIDENCE_IDENTITY_MISMATCH");
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });

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

    await vi.waitFor(() => expect(codingAgent).toHaveBeenCalledWith(expect.objectContaining({
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
    }), undefined));
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
    await vi.waitFor(() => expect(codingAgent).toHaveBeenCalledOnce());
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

  it("still cleans the attempt when a post-publish lease failure also makes rollback fail", async () => {
    const fixture = createFixture();
    const leaseFailure = new Error("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    const rollbackFailure = new Error("IMPLEMENTATION_PUBLISH_ROLLBACK_FAILED");
    let fenceCalls = 0;
    const persistence = {
      ...fixture.store.deliveryExecutions,
      assertImplementationLease: vi.fn(() => {
        fenceCalls += 1;
        if (fenceCalls === 2) throw leaseFailure;
      })
    };
    const rollback = vi.fn().mockRejectedValue(rollbackFailure);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const implementationDependencies = {
      prepare: vi.fn().mockResolvedValue({
        workspace: {
          branch: "HEAD", worktreePath: "/tmp/isolated-attempt",
          baseCommit: "0123456789abcdef0123456789abcdef01234567", reused: false as const
        },
        publish: vi.fn().mockResolvedValue(codingResult()),
        rollback,
        cleanup
      })
    };
    const service = new DeliveryExecutionService(
      persistence, vi.fn().mockResolvedValue(codingResult()), "test-model", fixture.store.deliveryQuality,
      {}, implementationDependencies
    );

    await expect(service.implement(fixture.unit.id)).rejects.toBe(rollbackFailure);

    expect(rollback).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(rollbackFailure.cause).toBe(leaseFailure);
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  });

  it("runs review and testing against the same immutable implementation evidence", async () => {
    const fixture = createFixture();
    const definition = fixture.store.addArtifact(
      fixture.requirement.id, "definition", "Approved definition", { summary: "frozen definition" }
    );
    const design = fixture.store.addArtifact(
      fixture.requirement.id, "solution_design", "Approved design", { summary: "frozen design" }
    );
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const codingEvidence = fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1) as {
      id: string; diffHash: string;
    };
    const snapshot = implementation.evidenceSnapshot!;
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
      { review, testing, inspectTarget: vi.fn().mockResolvedValue(targetState) }
    );

    await Promise.all([service.review(fixture.unit.id), service.test(fixture.unit.id)]);

    const reviewEvidence = fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")!;
    const testingEvidence = fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")!;
    expect(reviewEvidence).toMatchObject({ inputEvidenceVersion: 1, result: "passed", content: { summary: "review passed" } });
    expect(testingEvidence, JSON.stringify(testingEvidence)).toMatchObject({
      inputCodingEvidenceId: codingEvidence.id, inputEvidenceVersion: 1,
      inputDiffHash: codingEvidence.diffHash, result: "passed"
    });
    expect(reviewEvidence.inputCodingEvidenceId).toBe(testingEvidence.inputCodingEvidenceId);
    expect(reviewEvidence.inputDiffHash).toBe(testingEvidence.inputDiffHash);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      implementation: { diff: implementation.diff, changedFiles: snapshot.changedFiles }
    }), expect.any(AbortSignal));
    expect(testing).toHaveBeenCalledWith(expect.objectContaining({
      sourceManifest: snapshot.manifest,
      sensitivePatterns: [".env*"],
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }],
      acceptanceCriteria: ["Order contract tests pass"],
      untrustedEvidence: {
        requirement: expect.objectContaining({ id: fixture.requirement.id, title: "Frozen implementation" }),
        approvedArtifacts: [
          expect.objectContaining({
            id: definition.id, stage: "definition", version: 1,
            title: "Approved definition", content: { summary: "frozen definition" }
          }),
          expect.objectContaining({
            id: design.id, stage: "solution_design", version: 1,
            title: "Approved design", content: { summary: "frozen design" }
          })
        ],
        implementation: { diff: implementation.diff, changedFiles: snapshot.changedFiles },
        codingEvidence: {
          id: codingEvidence.id, evidenceVersion: 1, diffHash: codingEvidence.diffHash
        },
        deliverySnapshot: expect.objectContaining({
          repoPath: "/tmp/frozen-project-old", branch: "feature/2.2.1",
          worktreePath: "/tmp/frozen-project-version", headCommit: fixture.version.headCommit,
          moduleIds: ["src/orders"], acceptanceCriteria: ["Order contract tests pass"],
          allowedCommands: [{ command: "npm", argsPrefix: ["test"] }]
        })
      }
    }), undefined);
  });

  it("fails closed before review when the full implementation diff is stale", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const review = vi.fn();
    const claim = fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", "corrupt-review");
    expect(claim.status).toBe("running");
    if (claim.status !== "running") throw new Error("expected running claim");
    const quality = {
      ...fixture.store.deliveryQuality,
      claim: vi.fn(() => ({ ...claim, input: {
        ...claim.input,
        codingEvidence: { ...claim.input.codingEvidence, diff: "different" }
      } }))
    };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", quality, { review }
    );

    await expect(service.review(fixture.unit.id)).resolves.toMatchObject({
      status: "aborted", error: "IMPLEMENTATION_EVIDENCE_STALE"
    });
    expect(review).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
  });

  it("retries provider failures with the same claim token without writing failed evidence", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const review = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        conclusion: "pass", confidence: 0.9, summary: "ok", facts: [], assumptions: [],
        openQuestions: [], risks: [], findings: []
      });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );

    await expect(service.review(fixture.unit.id, 1, "review-job-retry"))
      .rejects.toThrow("DELIVERY_QUALITY_PROVIDER_UNAVAILABLE");
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();

    await expect(service.review(fixture.unit.id, 1, "review-job-retry"))
      .resolves.toMatchObject({ result: "passed" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("propagates worker cancellation to the review provider without writing evidence", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    let providerSignal: AbortSignal | undefined;
    const review = vi.fn(async (_input: unknown, signal: AbortSignal) => {
      providerSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );
    const worker = createAutomationWorker({
      jobs: fixture.store.automationJobs,
      handlers: { ...createDeliveryQualityAutomationHandlers(service), test: async () => {} },
      workerId: "worker-provider-abort"
    });

    let drain = worker.drainOnce();
    await Promise.resolve();
    if (!providerSignal) {
      await drain;
      drain = worker.drainOnce();
      await Promise.resolve();
    }
    expect(providerSignal).toBeDefined();
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(drain).resolves.toBe(true);

    expect(providerSignal?.aborted).toBe(true);
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)).toMatchObject({
      status: "pending", lastError: "DELIVERY_QUALITY_PROVIDER_UNAVAILABLE"
    });
  });

  it("aborts a review provider at the configured deadline without writing evidence", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    let providerSignal: AbortSignal | undefined;
    const review = vi.fn(async (_input: unknown, signal: AbortSignal) => {
      providerSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { review, reviewTimeoutMs: 100 }
    );

    const pending = service.review(fixture.unit.id, 1, "review-deadline");
    const rejection = expect(pending).rejects.toThrow("DELIVERY_QUALITY_PROVIDER_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    expect((providerSignal?.reason as Error).message).toBe("DELIVERY_QUALITY_REVIEW_TIMEOUT");
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not complete review evidence when cancellation arrives with the provider result", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const controller = new AbortController();
    const review = vi.fn(async () => {
      controller.abort();
      return {
        conclusion: "pass" as const, confidence: 0.9, summary: "must not persist",
        facts: [], assumptions: [], openQuestions: [], risks: [], findings: []
      };
    });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );

    await expect(service.review(fixture.unit.id, 1, "review-late-abort", controller.signal))
      .rejects.toThrow("DELIVERY_QUALITY_PROVIDER_UNAVAILABLE");
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
  });

  it("does not complete testing evidence when cancellation arrives with the command result", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const controller = new AbortController();
    const testing = vi.fn(async () => {
      controller.abort();
      return { result: "passed" as const, commandResults: [], acceptanceTrace: [] };
    });
    const targetState = {
      head: fixture.version.headCommit, refsHash: "refs", diffHash: "target-diff", gitCommonDir: "/repo/.git"
    };
    const inspectTarget = vi.fn().mockResolvedValue(targetState);
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { testing, inspectTarget }
    );

    await expect(service.test(fixture.unit.id, 1, "test-late-abort", controller.signal))
      .rejects.toThrow("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE");
    expect(inspectTarget).toHaveBeenCalledOnce();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toBeNull();
  });

  it("atomically aborts a quality claim when its automation job exhausts three attempts", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const reviewJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)!;
    const review = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );
    const handlers = createDeliveryQualityAutomationHandlers(service);
    const worker = createAutomationWorker({
      jobs: fixture.store.automationJobs,
      handlers: { ...handlers, test: async () => {} },
      workerId: "worker-exhaustion"
    });

    for (let drain = 0; drain < 4 && fixture.store.automationJobs.get(reviewJob.id)?.status !== "failed"; drain += 1) {
      await worker.drainOnce();
    }

    expect(fixture.store.automationJobs.get(reviewJob.id)).toMatchObject({ status: "failed", attempt: 3 });
    const attempts = (fixture.store as any).db.prepare(`SELECT claim_token, status, error
      FROM delivery_quality_runs WHERE delivery_unit_id = ? AND kind = 'code_review' ORDER BY rowid`)
      .all(fixture.unit.id);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((attempt: any) => attempt.claim_token)).size).toBe(3);
    expect(attempts.map(({ status, error }: any) => ({ status, error }))).toEqual([
      { status: "aborted", error: "DELIVERY_QUALITY_AUTOMATION_LEASE_STALE" },
      { status: "aborted", error: "DELIVERY_QUALITY_AUTOMATION_LEASE_STALE" },
      { status: "aborted", error: "DELIVERY_QUALITY_AUTOMATION_FAILED" }
    ]);
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
    expect(() => fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", "different-job"))
      .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    expect(fixture.store.automationJobs.enqueue({
      ownerType: "delivery_unit", ownerId: fixture.unit.id, evidenceVersion: 1,
      action: "review", payload: {}, maxAttempts: 3
    }).id).toBe(reviewJob.id);

    (fixture.store as any).db.prepare(
      "UPDATE delivery_units SET status = 'ready', evidence_version = 2 WHERE id = ?"
    ).run(fixture.unit.id);
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const nextJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v2`)!;
    expect(nextJob.id).not.toBe(reviewJob.id);
    expect(fixture.store.deliveryQuality.claim(fixture.unit.id, 2, "code_review", nextJob.id))
      .toMatchObject({ status: "running", evidenceVersion: 2 });
  });

  it("rolls back final job failure when the matching quality abort cannot commit", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const reviewJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)!;
    (fixture.store as any).db.prepare(
      "UPDATE automation_jobs SET status = 'canceled' WHERE dedupe_key = ?"
    ).run(`test:${fixture.unit.id}:v1`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fixture.store.automationJobs.leaseNext(`worker-${attempt}`, new Date(), 30_000);
      expect(fixture.store.automationJobs.fail(reviewJob.id, `worker-${attempt}`, "provider unavailable", true)).toBe(true);
    }
    const finalLease = fixture.store.automationJobs.leaseNext("worker-3", new Date(), 30_000)!;
    fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", finalLease.claimToken);
    (fixture.store as any).db.exec(`CREATE TRIGGER reject_quality_automation_abort
      BEFORE UPDATE OF status ON delivery_quality_runs
      WHEN NEW.status = 'aborted'
      BEGIN SELECT RAISE(ABORT, 'QUALITY_ABORT_WRITE_FAILED'); END;`);

    expect(() => fixture.store.automationJobs.fail(
      reviewJob.id, "worker-3", "provider unavailable", true
    )).toThrow("QUALITY_ABORT_WRITE_FAILED");

    expect(fixture.store.automationJobs.get(reviewJob.id)).toMatchObject({ status: "leased", attempt: 3 });
    expect((fixture.store as any).db.prepare(
      "SELECT status FROM delivery_quality_runs WHERE claim_token = ?"
    ).get(finalLease.claimToken)).toEqual({ status: "running" });
  });

  it("aborts an exhausted leased quality claim during restart recovery", async () => {
    const path = fileBackedDatabase();
    const fixture = createFixture(path);
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const reviewJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)!;
    (fixture.store as any).db.prepare(
      "UPDATE automation_jobs SET status = 'canceled' WHERE dedupe_key = ?"
    ).run(`test:${fixture.unit.id}:v1`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fixture.store.automationJobs.leaseNext(`worker-${attempt}`, new Date(), 30_000);
      fixture.store.automationJobs.fail(reviewJob.id, `worker-${attempt}`, "provider unavailable", true);
    }
    const finalLease = fixture.store.automationJobs.leaseNext("worker-3", new Date(), 30_000)!;
    fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", finalLease.claimToken);
    fixture.store.close();
    stores.splice(stores.indexOf(fixture.store), 1);
    const restarted = new WorkflowStore(path);
    stores.push(restarted);

    restarted.automationJobs.recoverExpired(new Date(Date.now() + 60_000));

    expect(restarted.automationJobs.get(reviewJob.id)).toMatchObject({ status: "failed", attempt: 3 });
    expect((restarted as any).db.prepare(
      "SELECT status, error FROM delivery_quality_runs WHERE claim_token = ?"
    ).get(finalLease.claimToken)).toEqual({ status: "aborted", error: "DELIVERY_QUALITY_AUTOMATION_FAILED" });
  });

  it("repairs a legacy failed-job running-claim orphan during startup recovery", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult())
    ).implement(fixture.unit.id);
    const reviewJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)!;
    fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", reviewJob.id);
    (fixture.store as any).db.prepare(`UPDATE automation_jobs
      SET status = 'failed', attempt = max_attempts, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ?`).run(reviewJob.id);

    fixture.store.automationJobs.recoverExpired(new Date());

    expect((fixture.store as any).db.prepare(
      "SELECT status, error FROM delivery_quality_runs WHERE claim_token = ?"
    ).get(reviewJob.id)).toEqual({ status: "aborted", error: "DELIVERY_QUALITY_AUTOMATION_FAILED" });
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
      { inspectTarget, testing }
    );

    await expect(service.test(fixture.unit.id)).resolves.toMatchObject({
      status: "aborted", error: "AUTOMATED_TEST_TARGET_MUTATED"
    });
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toBeNull();
  });

  it("retries cleanup infrastructure failures with the same claim and no failed evidence", async () => {
    const fixture = createFixture();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const targetState = {
      head: fixture.version.headCommit, refsHash: "refs", diffHash: "clean", gitCommonDir: "/repo/.git"
    };
    const testing = vi.fn()
      .mockRejectedValueOnce(new Error("AUTOMATED_TEST_CLEANUP_FAILED"))
      .mockResolvedValueOnce({ result: "passed", commandResults: [], acceptanceTrace: [] });
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality,
      { inspectTarget: vi.fn().mockResolvedValue(targetState), testing }
    );

    await expect(service.test(fixture.unit.id, 1, "test-job-retry"))
      .rejects.toThrow("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE");
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toBeNull();

    await expect(service.test(fixture.unit.id, 1, "test-job-retry"))
      .resolves.toMatchObject({ result: "passed" });
    expect(testing).toHaveBeenCalledTimes(2);
  });

  it("does not disclose a frozen sensitive path to review", async () => {
    const fixture = createFixture();
    const implementation = codingResult();
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(implementation))
      .implement(fixture.unit.id);
    const review = vi.fn();
    const claim = fixture.store.deliveryQuality.claim(fixture.unit.id, 1, "code_review", "corrupt-sensitive-review");
    expect(claim.status).toBe("running");
    if (claim.status !== "running") throw new Error("expected running claim");
    const quality = {
      ...fixture.store.deliveryQuality,
      claim: vi.fn(() => ({ ...claim, input: {
        ...claim.input,
        codingEvidence: {
          ...claim.input.codingEvidence,
          changedFiles: [{
            path: ".env.local", status: "modified" as const, kind: "text" as const, content: "SECRET=value"
          }]
        }
      } }))
    };
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", quality, { review }
    );

    await expect(service.review(fixture.unit.id)).resolves.toMatchObject({
      status: "aborted", error: "IMPLEMENTATION_EVIDENCE_STALE"
    });
    expect(review).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
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
        inspectTarget: vi.fn().mockResolvedValue({
          head: "advanced-head", refsHash: "refs", diffHash: "clean", gitCommonDir: "/repo/.git"
        }),
        testing
      }
    );

    await expect(service.test(fixture.unit.id)).resolves.toMatchObject({
      status: "aborted", error: "AUTOMATED_TEST_TARGET_HEAD_STALE"
    });
    expect(testing).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "automated_testing")).toBeNull();
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
      { review }
    );

    const first = await service.review(fixture.unit.id, 1, "review-job-1") as any;
    const resumed = await service.review(fixture.unit.id, 1, "review-job-1") as any;

    expect(resumed.id).toBe(first.id);
    expect(review).toHaveBeenCalledOnce();
  });

  it("completes a recovered automation job without rerunning an aborted quality claim", async () => {
    let now = Date.now();
    const clock = () => new Date(now);
    const fixture = createFixture(":memory:", clock);
    await new DeliveryExecutionService(fixture.store.deliveryExecutions, vi.fn().mockResolvedValue(codingResult()))
      .implement(fixture.unit.id);
    const reviewJob = fixture.store.automationJobs.byDedupe(`review:${fixture.unit.id}:v1`)!;
    (fixture.store as any).db.prepare(
      "UPDATE automation_jobs SET status = 'canceled' WHERE dedupe_key = ?"
    ).run(`test:${fixture.unit.id}:v1`);
    const firstLease = fixture.store.automationJobs.leaseNext("worker-before-crash", clock(), 100)!;
    const aborted = fixture.store.deliveryQuality.claim(
      fixture.unit.id, 1, "code_review", firstLease.claimToken
    );
    fixture.store.deliveryQuality.abort(aborted, "IMPLEMENTATION_EVIDENCE_STALE");
    now += 101;
    (fixture.store as any).db.prepare(
      "UPDATE delivery_units SET status = 'returned', evidence_version = 2 WHERE id = ?"
    ).run(fixture.unit.id);
    const review = vi.fn();
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, vi.fn(), "test-model", fixture.store.deliveryQuality, { review }
    );
    const handlers = createDeliveryQualityAutomationHandlers(service);
    const worker = createAutomationWorker({
      jobs: fixture.store.automationJobs,
      handlers: { ...handlers, test: async () => {} },
      workerId: "worker-recovery", clock
    });

    for (let drain = 0; drain < 3; drain += 1) {
      if (fixture.store.automationJobs.get(reviewJob.id)?.status === "completed") break;
      await worker.drainOnce();
    }

    expect(fixture.store.automationJobs.get(reviewJob.id)).toMatchObject({
      status: "completed", attempt: 2, lastError: null
    });
    expect(review).not.toHaveBeenCalled();
    expect(fixture.store.deliveryQuality.latest(fixture.unit.id, "code_review")).toBeNull();
  });

  it("rejects quality jobs with mismatched ownership, action, or version", async () => {
    const fixture = createFixture();
    const service = { review: vi.fn(), test: vi.fn() } as any;
    const handlers = createDeliveryQualityAutomationHandlers(service);
    const baseJob = { claimToken: "quality-claim", ownerType: "delivery_unit",
      ownerId: fixture.unit.id, evidenceVersion: 1 } as any;
    const context = { signal: new AbortController().signal };
    await expect(handlers.review!({ ...baseJob, action: "test" }, context)).rejects
      .toThrow("AUTOMATION_INPUT_INVALID");
    await expect(handlers.test!({ ...baseJob, action: "test", evidenceVersion: 0 }, context)).rejects
      .toThrow("AUTOMATION_INPUT_INVALID");
    await expect(handlers.review!({ ...baseJob, action: "review", claimToken: "" }, context)).rejects
      .toThrow("AUTOMATION_INPUT_INVALID");
    await handlers.review!({ ...baseJob, action: "review" }, context);
    expect(service.review).toHaveBeenCalledWith(fixture.unit.id, 1, "quality-claim", context.signal);
  });

  it("validates and forwards a leased implementation job through the unified handler factory", async () => {
    const fixture = createFixture();
    fixture.store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: fixture.unit.id,
      evidenceVersion: 1, action: "implement", payload: {}, maxAttempts: 3 });
    const job = fixture.store.automationJobs.leaseNext("implementation-handler", new Date(), 30_000)!;
    const implement = vi.fn(async () => {});
    const service = { implement, review: vi.fn(), test: vi.fn() } as any;
    const handlers = createDeliveryAutomationHandlers(service);
    const context = { signal: new AbortController().signal };

    await handlers.implement!(job, context);

    expect(implement).toHaveBeenCalledWith(
      fixture.unit.id, 1, job.claimToken, context.signal
    );
    for (const invalid of [
      { ...job, ownerType: "requirement" },
      { ...job, action: "review" },
      { ...job, evidenceVersion: 0 },
      { ...job, claimToken: job.id },
      { ...job, leaseOwner: "another-worker" }
    ]) {
      await expect(handlers.implement!(invalid as any, context)).rejects
        .toThrow("AUTOMATION_INPUT_INVALID");
    }
    expect(implement).toHaveBeenCalledOnce();

    const coding = vi.fn();
    const realHandlers = createDeliveryAutomationHandlers(new DeliveryExecutionService(
      fixture.store.deliveryExecutions, coding, "test-model", fixture.store.deliveryQuality
    ));
    await expect(realHandlers.implement!({ ...job, evidenceVersion: 2 }, context)).rejects
      .toThrow("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    expect(coding).not.toHaveBeenCalled();
  });

  it("fences implementation evidence after its exact automation lease expires", async () => {
    let now = Date.now();
    const clock = () => new Date(now);
    const path = fileBackedDatabase();
    const fixture = createFixture(path, clock);
    fixture.store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: fixture.unit.id,
      evidenceVersion: 1, action: "implement", payload: {}, maxAttempts: 3 });
    const job = fixture.store.automationJobs.leaseNext("implementation-fence", clock(), 100)!;
    let release!: (value: ReturnType<typeof codingResult>) => void;
    const coding = vi.fn(() => new Promise<ReturnType<typeof codingResult>>((resolve) => { release = resolve; }));
    const service = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, coding, "test-model", fixture.store.deliveryQuality
    );
    const handlers = createDeliveryAutomationHandlers(service);
    const running = handlers.implement!(job, { signal: new AbortController().signal });
    await vi.waitFor(() => expect(coding).toHaveBeenCalledOnce());

    now += 101;
    const recovery = new WorkflowStore(path, clock);
    stores.push(recovery);
    expect(recovery.automationJobs.recoverExpired(clock())).toBe(1);
    release(codingResult());

    await expect(running).rejects.toThrow("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
    expect(fixture.store.deliveryUnits.get(fixture.unit.id)).toMatchObject({ status: "ready" });
    expect(fixture.store.automationJobs.get(job.id)).toMatchObject({ status: "pending", attempt: 1 });
  });

  it("isolates an aborted partial write while a second worker retries the same implementation", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-22T08:00:00.000Z") });
    const path = fileBackedDatabase();
    const fixture = createFixture(path);
    const authoritative = mkdtempSync(join(tmpdir(), "delivery-authoritative-"));
    directories.push(authoritative);
    fixture.store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: fixture.unit.id,
      evidenceVersion: 1, action: "implement", payload: {}, maxAttempts: 3 });
    let releaseOld!: () => void;
    const oldProvider = new Promise<void>((resolve) => { releaseOld = resolve; });
    let calls = 0;
    let oldSignal: AbortSignal | undefined;
    const attemptPaths: string[] = [];
    const coding = vi.fn(async (input: any, signal?: AbortSignal) => {
      calls += 1;
      const attemptPath = input.attemptWorkspace?.worktreePath ?? authoritative;
      attemptPaths.push(attemptPath);
      if (calls === 1) {
        oldSignal = signal;
        writeFileSync(join(attemptPath, "old-partial.txt"), "stale partial");
        await oldProvider;
      } else {
        writeFileSync(join(attemptPath, "new-final.txt"), "retry result");
      }
      return codingResult();
    });
    const implementationDependencies = {
      prepare: vi.fn(async () => {
        const worktreePath = mkdtempSync(join(tmpdir(), "delivery-attempt-"));
        directories.push(worktreePath);
        return {
          workspace: {
            branch: `attempt-${calls + 1}`, worktreePath,
            baseCommit: "0123456789abcdef0123456789abcdef01234567", reused: false as const
          },
          publish: async (result: ReturnType<typeof codingResult>) => {
            if (existsSync(join(worktreePath, "new-final.txt"))) {
              writeFileSync(join(authoritative, "new-final.txt"), "retry result");
            }
            return result;
          },
          cleanup: async () => { rmSync(worktreePath, { recursive: true, force: true }); }
        };
      })
    };
    const firstService = new DeliveryExecutionService(
      fixture.store.deliveryExecutions, coding as any, "test-model", fixture.store.deliveryQuality,
      {}, implementationDependencies
    );
    const first = createAutomationWorker({
      jobs: { ...fixture.store.automationJobs, renew: () => false },
      handlers: createDeliveryAutomationHandlers(firstService),
      workerId: "implementation-worker-old", leaseMs: 300
    });

    const firstDrain = first.drainOnce();
    await vi.waitFor(() => expect(coding).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(100);
    expect(oldSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(200);

    const retryStore = new WorkflowStore(path);
    stores.push(retryStore);
    const retryService = new DeliveryExecutionService(
      retryStore.deliveryExecutions, coding as any, "test-model", retryStore.deliveryQuality,
      {}, implementationDependencies
    );
    const retry = createAutomationWorker({
      jobs: retryStore.automationJobs,
      handlers: createDeliveryAutomationHandlers(retryService),
      workerId: "implementation-worker-retry", leaseMs: 300
    });
    await expect(retry.drainOnce()).resolves.toBe(true);
    expect(coding).toHaveBeenCalledTimes(2);
    expect(new Set(attemptPaths).size).toBe(2);
    expect(attemptPaths).not.toContain(authoritative);

    releaseOld();
    await expect(firstDrain).resolves.toBe(true);
    expect(existsSync(join(authoritative, "old-partial.txt"))).toBe(false);
    expect(existsSync(join(authoritative, "new-final.txt"))).toBe(true);
    expect(retryStore.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toEqual(expect.any(Object));
  });
});
