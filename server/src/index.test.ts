import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./index.js";
import { WorkflowStore } from "./store.js";
import { DeliveryExecutionService } from "./delivery-execution-service.js";
import type { CodingAgentInput } from "./coding-agent.js";
import { evidenceFingerprint, evidenceManifestHash } from "./evidence-tree.js";

const directories: string[] = [];
const controlledImplementationDependencies = {
  prepare: async (input: CodingAgentInput) => ({
    workspace: {
      branch: "HEAD", worktreePath: `${input.version.worktreePath}/.isolated-test-attempt`,
      baseCommit: input.version.headCommit!, reused: false as const
    },
    publish: async (result: any) => result,
    rollback: async () => {},
    cleanup: async () => {}
  })
};

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  vi.useRealTimers();
});

describe("server entry point", () => {
  it("exports a testable startup function and only self-starts when executed directly", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("export interface StartupOptions");
    expect(source).toContain("export async function startServer");
    expect(source).toContain("isDirectExecution");
  });

  it("recovers expired jobs after existing recovery and starts only when explicitly enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-"));
    directories.push(directory);
    const { jobId } = await seedExpiredJob(directory);
    const events: string[] = [];
    let recoveredStatus: string | undefined;
    const cleanupVerification = vi.fn(async (options: { maxEntries?: number; maxScannedEntries?: number }) => {
      events.push("cleanup:verification");
      expect(options).toEqual({ maxEntries: 4, maxScannedEntries: 4096 });
      return {
        scanned: 5, scanTruncated: true, attempted: 4, removed: 3, failed: 1, remaining: 2,
        failures: [{ path: "/tmp/quarantine", error: "AUTOMATED_TEST_CLEANUP_FAILED" }]
      };
    });
    const cleanupReports: unknown[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false),
      start: vi.fn(() => { events.push("worker:start"); }),
      stop: vi.fn(async () => { events.push("worker:stop"); })
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0", AUTOMATION_WORKER_ENABLED: "true" },
      createStore: (databasePath) => observedStore(databasePath, events),
      cleanupVerificationQuarantines: cleanupVerification as any,
      reportVerificationCleanup: (result: unknown) => { cleanupReports.push(result); },
      createWorker: (input) => {
        events.push("worker:create");
        recoveredStatus = input.jobs.get(jobId)?.status;
        return worker;
      },
      buildApplication: async () => fakeApp(events),
      writeListening: () => {}
    });

    expect(recoveredStatus).toBe("pending");
    expect(events).toEqual([
      "recover:publication", "recover:stage", "recover:knowledge", "recover:requirements", "recover:jobs",
      "cleanup:verification", "worker:create", "app:build", "app:onClose", "worker:start", "app:listen"
    ]);
    expect(cleanupVerification).toHaveBeenCalledOnce();
    expect(cleanupReports).toEqual([
      {
        scanned: 5, scanTruncated: true, attempted: 4, removed: 3, failed: 1, remaining: 2,
        failures: [{ path: "/tmp/quarantine", error: "AUTOMATED_TEST_CLEANUP_FAILED" }]
      }
    ]);
    await runtime.close();
    expect(events.slice(-3)).toEqual(["app:close", "worker:stop", "store:close"]);
  });

  it("atomically settles an expired implementation claim before making its job retryable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "implementation-startup-recovery-"));
    directories.push(directory);
    const startedAt = new Date(Date.now() + 1_000);
    const seeded = seedLeasedImplementation(directory, startedAt, 100);

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      clock: () => new Date(startedAt.getTime() + 101),
      buildApplication: async () => fakeApp([]),
      writeListening: () => {}
    });

    expect(runtime.store.automationJobs.get(seeded.jobId)).toMatchObject({ status: "pending", attempt: 1 });
    expect(runtime.store.getStageRun(seeded.runId)).toMatchObject({
      status: "interrupted", error: "服务进程已重启，运行被中断"
    });
    expect(runtime.store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "failed", error: "服务进程已重启，运行被中断" })
    );
    expect(runtime.store.deliveryUnits.get(seeded.unitId)).toMatchObject({ phase: "implementation", status: "ready" });
    await runtime.close();
  });

  it("rolls back expired implementation recovery when one execution settlement fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "implementation-recovery-rollback-"));
    directories.push(directory);
    const startedAt = new Date(Date.now() + 1_000);
    const seeded = seedLeasedImplementation(directory, startedAt, 100);
    const store = new WorkflowStore(join(directory, "workflow.db"));
    const database = (store as any).db;
    database.exec(`CREATE TRIGGER reject_recovered_execution BEFORE UPDATE OF status ON executions
      WHEN OLD.id = '${seeded.executionId}' BEGIN SELECT RAISE(ABORT, 'RECOVERY_EXECUTION_WRITE_FAILED'); END;`);

    expect(() => store.automationJobs.recoverExpired(new Date(startedAt.getTime() + 101)))
      .toThrow("RECOVERY_EXECUTION_WRITE_FAILED");

    expect(store.automationJobs.get(seeded.jobId)).toMatchObject({ status: "leased", attempt: 1 });
    expect(store.getStageRun(seeded.runId)).toMatchObject({ status: "running", error: null });
    expect(store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "running", error: null })
    );
    expect(store.deliveryUnits.get(seeded.unitId)).toMatchObject({ status: "running" });
    store.close();
  });

  it("recovers an ownerless implementation claim during startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "implementation-ownerless-recovery-"));
    directories.push(directory);
    const startedAt = new Date(Date.now() + 1_000);
    const seeded = seedLeasedImplementation(directory, startedAt, 1_000);
    const abandoned = new WorkflowStore(join(directory, "workflow.db"));
    (abandoned as any).db.prepare(`UPDATE automation_jobs SET status = 'canceled',
      lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`).run(seeded.jobId);
    abandoned.close();

    const runtime = await startServer({ env: { DATA_DIR: directory, PORT: "0" },
      clock: () => new Date(startedAt.getTime() + 100),
      buildApplication: async () => fakeApp([]), writeListening: () => {} });

    expect(runtime.store.getStageRun(seeded.runId)).toMatchObject({ status: "interrupted" });
    expect(runtime.store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "failed" })
    );
    expect(runtime.store.deliveryUnits.get(seeded.unitId)).toMatchObject({ status: "ready" });
    expect(runtime.store.automationJobs.get(seeded.jobId)).toMatchObject({ status: "pending" });
    await runtime.close();
  });

  it.each([
    ["completed", "ready", "pending"],
    ["failed", "failed", "failed"],
    ["missing", "ready", "pending"]
  ] as const)("settles an ownerless implementation backed by a %s job", async (jobState, unitStatus, jobStatus) => {
    const directory = mkdtempSync(join(tmpdir(), `implementation-${jobState}-recovery-`));
    directories.push(directory);
    const startedAt = new Date(Date.now() + 1_000);
    const seeded = seedLeasedImplementation(directory, startedAt, 1_000);
    const abandoned = new WorkflowStore(join(directory, "workflow.db"));
    if (jobState === "missing") {
      (abandoned as any).db.prepare("DELETE FROM automation_jobs WHERE id = ?").run(seeded.jobId);
    } else {
      (abandoned as any).db.prepare(`UPDATE automation_jobs SET status = ?,
        lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`).run(jobState, seeded.jobId);
    }
    abandoned.close();

    const runtime = await startServer({ env: { DATA_DIR: directory, PORT: "0" },
      clock: () => new Date(startedAt.getTime() + 100),
      buildApplication: async () => fakeApp([]), writeListening: () => {} });

    expect(runtime.store.getStageRun(seeded.runId)).toMatchObject({ status: "interrupted" });
    expect(runtime.store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "failed" })
    );
    expect(runtime.store.deliveryUnits.get(seeded.unitId)).toMatchObject({ status: unitStatus });
    expect(runtime.store.automationJobs.byDedupe(`implement:${seeded.unitId}:v1`)).toMatchObject({ status: jobStatus });
    await runtime.close();
  });

  it("periodically recovers a lease that expires after startup and claims implementation exactly once", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "implementation-periodic-recovery-"));
    directories.push(directory);
    const startedAt = new Date(Date.now() + 1_000);
    const seeded = seedLeasedImplementation(directory, startedAt, 100);
    let now = startedAt.getTime() + 50;
    let runtimeStore: WorkflowStore | undefined;
    const claimed: string[] = [];

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0", AUTOMATION_WORKER_ENABLED: "true",
        AUTOMATION_WORKER_LEASE_MS: "100", AUTOMATION_WORKER_POLL_MS: "10" },
      clock: () => new Date(now),
      createStore: (databasePath) => {
        runtimeStore = new WorkflowStore(databasePath);
        return runtimeStore;
      },
      automationHandlers: {
        implement: async (job) => {
          const claim = runtimeStore!.deliveryExecutions.claimImplementation(job.ownerId, "recovery-model");
          claimed.push(claim.runId);
          runtimeStore!.deliveryExecutions.failImplementation(claim, "test settlement");
        }
      },
      buildApplication: async () => fakeApp([]),
      writeListening: () => {}
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(claimed).toEqual([]);
    expect(runtime.store.automationJobs.get(seeded.jobId)).toMatchObject({ status: "leased", attempt: 1 });
    expect(runtime.store.getStageRun(seeded.runId)).toMatchObject({ status: "running" });
    expect(runtime.store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "running" })
    );
    expect(runtime.store.deliveryUnits.get(seeded.unitId)).toMatchObject({ status: "running" });

    now = startedAt.getTime() + 101;
    await vi.advanceTimersByTimeAsync(20);

    expect(claimed).toHaveLength(1);
    expect(runtime.store.automationJobs.get(seeded.jobId)).toMatchObject({ status: "completed", attempt: 2 });
    expect(runtime.store.getStageRun(seeded.runId)).toMatchObject({ status: "interrupted" });
    expect(runtime.store.deliveryExecutions.listExecutions(seeded.unitId, 1)).toContainEqual(
      expect.objectContaining({ id: seeded.executionId, status: "failed" })
    );
    await runtime.close();
  });

  it("runs a root implementation through the production handler factory exactly once", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "production-implementation-handler-"));
    directories.push(directory);
    let seeded!: ReturnType<typeof seedRootPlan>;
    const coding = vi.fn(async (input: CodingAgentInput) => controlledCodingResult(input));

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0", AUTOMATION_WORKER_ENABLED: "true",
        AUTOMATION_WORKER_POLL_MS: "10", AUTOMATION_WORKER_LEASE_MS: "30000" },
      createStore: (databasePath, clock) => {
        const store = new WorkflowStore(databasePath, clock);
        seeded = seedRootPlan(store, directory);
        return store;
      },
      createDeliveryService: (store) => new DeliveryExecutionService(
        store.deliveryExecutions, coding, "production-test-model", store.deliveryQuality,
        {}, controlledImplementationDependencies
      ),
      buildApplication: async () => fakeApp([]),
      writeListening: () => {}
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(coding).toHaveBeenCalledOnce();
    expect(runtime.store.automationJobs.byDedupe(`implement:${seeded.unitId}:v1`)).toMatchObject({
      status: "completed", attempt: 1, ownerType: "delivery_unit", action: "implement", evidenceVersion: 1,
      lastError: null
    });
    expect(runtime.store.deliveryExecutions.getCodingEvidence(seeded.unitId, 1)).toEqual(expect.any(Object));
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM coding_evidence
      WHERE delivery_unit_id = ? AND evidence_version = 1`).get(seeded.unitId)).toEqual({ count: 1 });
    expect(runtime.store.automationJobs.byDedupe(`review:${seeded.unitId}:v1`)).toMatchObject({ status: "pending" });
    expect(runtime.store.automationJobs.byDedupe(`test:${seeded.unitId}:v1`)).toMatchObject({ status: "pending" });
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE dedupe_key = ? AND status = 'pending' AND evidence_version = 1`).get(
      `review:${seeded.unitId}:v1`
    )).toEqual({ count: 1 });
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE dedupe_key = ? AND status = 'pending' AND evidence_version = 1`).get(
      `test:${seeded.unitId}:v1`
    )).toEqual({ count: 1 });
    await runtime.close();
  });

  it("recovers an expired root lease and runs production implementation only once", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "production-implementation-restart-"));
    directories.push(directory);
    const startedAt = new Date("2026-07-22T00:00:00.000Z");
    const seedStore = new WorkflowStore(join(directory, "workflow.db"), () => startedAt);
    const seeded = seedRootPlan(seedStore, directory);
    expect(seedStore.automationJobs.leaseNext("crashed-worker", startedAt, 100)).toMatchObject({ attempt: 1 });
    seedStore.close();
    writeFileSync(join(directory, "workflow.db.schema-version"), "phase-2-quality-attempt-v14");
    const recoveredAt = new Date(startedAt.getTime() + 101);
    const coding = vi.fn(async (input: CodingAgentInput) => controlledCodingResult(input));

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0", AUTOMATION_WORKER_ENABLED: "true",
        AUTOMATION_WORKER_POLL_MS: "10", AUTOMATION_WORKER_LEASE_MS: "30000" },
      clock: () => recoveredAt,
      createDeliveryService: (store) => new DeliveryExecutionService(
        store.deliveryExecutions, coding, "production-recovery-model", store.deliveryQuality,
        {}, controlledImplementationDependencies
      ),
      buildApplication: async () => fakeApp([]), writeListening: () => {}
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(coding).toHaveBeenCalledOnce();
    expect(runtime.store.automationJobs.byDedupe(`implement:${seeded.unitId}:v1`)).toMatchObject({
      status: "completed", attempt: 2, lastError: null
    });
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM coding_evidence
      WHERE delivery_unit_id = ? AND evidence_version = 1`).get(seeded.unitId)).toEqual({ count: 1 });
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE dedupe_key = ? AND status = 'pending' AND evidence_version = 1`).get(
      `review:${seeded.unitId}:v1`
    )).toEqual({ count: 1 });
    expect((runtime.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE dedupe_key = ? AND status = 'pending' AND evidence_version = 1`).get(
      `test:${seeded.unitId}:v1`
    )).toEqual({ count: 1 });
    await runtime.close();
  });

  it("builds but does not start the worker when enablement is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-disabled-"));
    directories.push(directory);
    const events: string[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(), stop: vi.fn(async () => {})
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" }, createWorker: () => worker,
      buildApplication: async () => fakeApp(events), writeListening: () => {}
    });

    expect(worker.start).not.toHaveBeenCalled();
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  it("keeps SQLite open after stop timeout and lets a later close retry the same worker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-stop-timeout-"));
    directories.push(directory);
    const events: string[] = [];
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(),
      stop: vi.fn()
        .mockRejectedValueOnce(new Error("AUTOMATION_WORKER_STOP_TIMEOUT"))
        .mockImplementationOnce(() => stopped)
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createStore: (databasePath) => observedStore(databasePath, events),
      createWorker: () => worker,
      buildApplication: async () => fakeApp(events),
      writeListening: () => {}
    });

    await expect(runtime.close()).rejects.toThrow("AUTOMATION_WORKER_STOP_TIMEOUT");
    expect(events).not.toContain("store:close");
    expect(() => runtime.store.listProjects()).not.toThrow();

    const retry = runtime.close();
    finishStop();
    await expect(retry).resolves.toBeUndefined();
    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === "store:close")).toHaveLength(1);
  });

  it("registers Store-backed quality handlers and preserves explicit handler overrides", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-handlers-"));
    directories.push(directory);
    const implement = vi.fn(async () => ({} as any));
    const review = vi.fn(async () => ({} as any));
    const test = vi.fn(async () => ({} as any));
    const overrideTest = vi.fn(async () => {});
    let workerOptions: any;
    let serviceStore: WorkflowStore | undefined;
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(), stop: vi.fn(async () => {})
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createDeliveryService: (store) => { serviceStore = store; return { implement, review, test }; },
      automationHandlers: { test: overrideTest },
      createWorker: (options) => { workerOptions = options; return worker; },
      buildApplication: async () => fakeApp([]),
      writeListening: () => {}
    });
    const reviewJob = {
      id: "review-job", claimToken: "review-job", ownerType: "delivery_unit", ownerId: "unit-1",
      evidenceVersion: 3, action: "review"
    } as any;

    expect(serviceStore).toBe(runtime.store);
    await workerOptions.handlers.review(reviewJob);
    await workerOptions.handlers.test({ ...reviewJob, id: "test-job", action: "test" });
    expect(review).toHaveBeenCalledWith("unit-1", 3, "review-job", undefined);
    expect(test).not.toHaveBeenCalled();
    expect(overrideTest).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("closes the worker and store when hook registration and app close both fail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-failure-"));
    directories.push(directory);
    const events: string[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false),
      start: vi.fn(),
      stop: vi.fn(async () => { events.push("worker:stop"); })
    };

    await expect(startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createStore: (databasePath) => observedStore(databasePath, events),
      createWorker: () => worker,
      buildApplication: async () => ({
        addHook() { throw new Error("hook registration failed"); },
        async listen() { return "http://127.0.0.1:12345"; },
        async close() { events.push("app:close"); throw new Error("app close failed"); }
      }),
      writeListening: () => {}
    })).rejects.toThrow("hook registration failed");

    expect(events.slice(-3)).toEqual(["app:close", "worker:stop", "store:close"]);
  });
});

async function seedExpiredJob(directory: string) {
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  const project = store.createProject({
    name: "Startup", repoPath: join(directory, "repo"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: join(directory, "worktree"), headCommit: "abc123"
  });
  const requirement = store.createRequirement({
    title: "Recover worker", businessProblem: "A process stopped during automation",
    expectedOutcome: "Startup recovers the lease", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  const queued = store.automationJobs.enqueue({
    ownerType: "requirement", ownerId: requirement.id, evidenceVersion: 1,
    action: "implement", payload: {}, maxAttempts: 3
  });
  store.automationJobs.leaseNext("old-worker", new Date(), 1);
  store.close();
  writeFileSync(`${databasePath}.schema-version`, "phase-2-quality-attempt-v14");
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { jobId: queued.id };
}

function seedLeasedImplementation(directory: string, now: Date, leaseMs: number) {
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  const project = store.createProject({ name: "Implementation restart", repoPath: join(directory, "repo"),
    defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
  const version = store.createProjectVersion({ projectId: project.id, name: "v1", branch: "feature/v1",
    baseBranch: "main", worktreePath: join(directory, "worktree"), headCommit: "abc123" });
  const requirement = store.createRequirement({ title: "Recover implementation",
    businessProblem: "A process stopped while implementing", expectedOutcome: "Retry from a consistent state",
    priority: "high", primaryProjectId: project.id, primaryProjectVersionId: version.id });
  store.replaceRequirementProjects(requirement.id, [{ projectId: project.id, projectVersionId: version.id,
    role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 }]);
  const plan = store.deliveryUnits.createPlan({ requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["done"] }], dependencies: [] } });
  const unit = plan.units[0]!;
  const job = store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id,
    evidenceVersion: 1, action: "implement", payload: {}, maxAttempts: 3 });
  store.automationJobs.leaseNext("old-worker", now, leaseMs);
  const claim = store.deliveryExecutions.claimImplementation(unit.id, "old-model");
  store.close();
  writeFileSync(`${databasePath}.schema-version`, "phase-2-quality-attempt-v14");
  return { jobId: job.id, unitId: unit.id, runId: claim.runId, executionId: claim.executionId };
}

function observedStore(databasePath: string, events: string[]) {
  const store = new WorkflowStore(databasePath);
  const reconcilePublications = store.reconcileImplementationPublications.bind(store);
  vi.spyOn(store, "reconcileImplementationPublications").mockImplementation(async () => {
    events.push("recover:publication");
    return reconcilePublications();
  });
  for (const [method, event] of [
    ["interruptActiveStageRuns", "recover:stage"],
    ["interruptActiveProjectKnowledge", "recover:knowledge"],
    ["recoverInterruptedRequirements", "recover:requirements"]
  ] as const) {
    const original = store[method].bind(store);
    vi.spyOn(store, method).mockImplementation(() => { events.push(event); return original(); });
  }
  const recoverExpired = store.automationJobs.recoverExpired;
  vi.spyOn(store.automationJobs, "recoverExpired").mockImplementation((now) => {
    events.push("recover:jobs");
    return recoverExpired(now);
  });
  const close = store.close.bind(store);
  vi.spyOn(store, "close").mockImplementation(() => { events.push("store:close"); close(); });
  return store;
}

function fakeApp(events: string[]) {
  events.push("app:build");
  let onClose: (() => Promise<void> | void) | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    addHook(name: string, hook: () => Promise<void> | void) {
      expect(name).toBe("onClose");
      events.push("app:onClose");
      onClose = hook;
    },
    async listen() {
      events.push("app:listen");
      return "http://127.0.0.1:12345";
    },
    close() {
      if (!closePromise) {
        events.push("app:close");
        closePromise = Promise.resolve(onClose?.()).then(() => undefined);
      }
      return closePromise;
    }
  };
}

function seedRootPlan(store: WorkflowStore, directory: string) {
  const project = store.createProject({
    name: "Production handler", repoPath: join(directory, "repo"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: join(directory, "worktree"), headCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  const requirement = store.createRequirement({
    title: "Production implementation", businessProblem: "Root delivery needs a production handler",
    expectedOutcome: "Implementation runs once", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  store.replaceRequirementProjects(requirement.id, [{
    projectId: project.id, projectVersionId: version.id, role: "primary", usage: "delivery",
    deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
  }]);
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id, snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["implemented"] }], dependencies: [] }
  });
  const unitId = plan.units[0]!.id;
  store.automationJobs.enqueue({
    ownerType: "delivery_unit", ownerId: unitId, evidenceVersion: 1,
    action: "implement", payload: {}, maxAttempts: 3
  });
  return { requirementId: requirement.id, unitId };
}

function controlledCodingResult(input: CodingAgentInput) {
  const content = Buffer.from("export const implemented = true;\n");
  const diff = "diff --git a/index.ts b/index.ts\n+export const implemented = true;";
  const identity = {
    repositoryPath: input.project.repoPath,
    gitCommonDir: join(input.project.repoPath, ".git"),
    worktreePath: resolve(input.project.repoPath, "..", ".ai-workflow-worktrees",
      basename(input.project.repoPath), "requirements", input.requirement.code),
    branch: `ai/${input.requirement.code}`,
    headCommit: input.version.headCommit!
  };
  const changedFiles = [{
    path: "index.ts", status: "modified" as const, kind: "text" as const, content: content.toString("utf8")
  }];
  const manifest = { version: 1 as const, entries: [{
    path: "index.ts", type: "file" as const, mode: "100644" as const,
    size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64")
  }] };
  const manifestHash = evidenceManifestHash(manifest);
  return {
    runId: "controlled-production-run", branch: identity.branch, worktreePath: identity.worktreePath,
    baseCommit: identity.headCommit, reused: false, summary: "implemented", diff,
    commands: [] as const, files: ["index.ts"], additions: 1, deletions: 0, diagnostics: [],
    evidenceSnapshot: {
      diff, files: ["index.ts"], additions: 1, deletions: 0, changedFiles,
      identity, manifest, manifestHash,
      evidenceHash: evidenceFingerprint({ identity, manifestHash, diff, changedFiles })
    }
  };
}
