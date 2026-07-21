import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_AUTOMATION_EVIDENCE_VERSION } from "@ai-workflow/shared";
import { AutomationJobRepository, type AutomationJobInput } from "./automation-job-repository.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function createFixture(clock: () => Date = () => now) {
  const directory = mkdtempSync(join(tmpdir(), "automation-jobs-"));
  directories.push(directory);
  const path = join(directory, "workflow.db");
  const store = new WorkflowStore(path);
  stores.push(store);
  const project = store.createProject({
    name: "Queue", repoPath: join(directory, "repo"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: join(directory, "worktree"), headCommit: "abc123"
  });
  const requirement = store.createRequirement({
    title: "Persistent jobs", businessProblem: "Automation needs durable scheduling",
    expectedOutcome: "Jobs survive process restarts", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  const firstDatabase = new DatabaseSync(path);
  const secondDatabase = new DatabaseSync(path);
  databases.push(firstDatabase, secondDatabase);
  for (const database of [firstDatabase, secondDatabase]) {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  }
  return {
    store, project, version, requirement, firstDatabase, secondDatabase,
    first: new AutomationJobRepository(firstDatabase, clock),
    second: new AutomationJobRepository(secondDatabase, clock)
  };
}

function insertCollidingDeliveryOwner(fixture: ReturnType<typeof createFixture>) {
  const snapshot = fixture.store.createRequirementProjectSnapshot(fixture.requirement.id);
  const timestamp = now.toISOString();
  fixture.secondDatabase.prepare(`INSERT INTO delivery_units
    (id, requirement_id, association_snapshot_id, project_id, project_version_id, required, position,
      phase, status, evidence_version, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, 'implementation', 'ready', 1, ?, ?, NULL)`)
    .run(
      fixture.requirement.id, fixture.requirement.id, snapshot.id, fixture.project.id,
      fixture.version.id, timestamp, timestamp
    );
  return fixture.requirement.id;
}

function insertRequirementOwner(fixture: ReturnType<typeof createFixture>, ownerId: string) {
  const timestamp = now.toISOString();
  fixture.secondDatabase.prepare(`INSERT INTO requirements
    (id, code, title, business_problem, expected_outcome, priority, stage, status, created_at, updated_at)
    VALUES (?, ?, 'Queue owner', 'Queue owner must be valid', 'Queue owner is persisted', 'medium',
      'implementation', 'ai_ready', ?, ?)`)
    .run(ownerId, `REQ-OWNER-${ownerId}`, timestamp, timestamp);
}

function job(ownerId: string, overrides: Partial<AutomationJobInput> = {}): AutomationJobInput {
  return {
    ownerType: "requirement", ownerId, evidenceVersion: 1, action: "implement",
    payload: { command: "npm test" }, maxAttempts: 3, ...overrides
  };
}

const now = new Date("2026-07-20T00:00:00.000Z");

function addMs(date: Date, milliseconds: number) {
  return new Date(date.getTime() + milliseconds);
}

function concurrentEnqueueWorker(input: AutomationJobInput, databasePath: string) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    try {
      const { AutomationJobRepository } = require(workerData.repositoryPath);
      const database = new DatabaseSync(workerData.databasePath);
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      const repository = new AutomationJobRepository(database, () => new Date(workerData.now));
      parentPort.postMessage({ type: "ready" });
      parentPort.once("message", (message) => {
        if (message?.type !== "go") throw new Error("INVALID_BARRIER_MESSAGE");
        try {
          parentPort.postMessage({ type: "result", job: repository.enqueue(workerData.input) });
        } catch (error) {
          parentPort.postMessage({
            type: "error", message: error instanceof Error ? error.message : String(error),
            code: error && typeof error === "object" && "code" in error ? error.code : undefined
          });
        } finally {
          database.close();
        }
      });
    } catch (error) {
      parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  `, {
    eval: true,
    execArgv: ["--require", "tsx/cjs"],
    workerData: {
      databasePath,
      repositoryPath: fileURLToPath(new URL("./automation-job-repository.ts", import.meta.url)),
      input,
      now: now.toISOString()
    }
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let resultReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<ReturnType<AutomationJobRepository["enqueue"]>>((resolve, reject) => {
    resultReject = reject;
    worker.on("message", (message: { type?: string; job?: ReturnType<AutomationJobRepository["enqueue"]>; message?: string; code?: string }) => {
      if (message.type === "ready") readyResolve();
      if (message.type === "result" && message.job) resolve(message.job);
      if (message.type === "error") {
        const error = Object.assign(new Error(message.message ?? "WORKER_FAILED"), { code: message.code });
        readyReject(error);
        reject(error);
      }
    });
    worker.on("error", (error) => {
      readyReject(error);
      reject(error);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`ENQUEUE_WORKER_EXIT_${code}`);
        readyReject(error);
        resultReject(error);
      }
    });
  });
  return { worker, ready, result };
}

function concurrentLeaseWorker(databasePath: string, workerId: string) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    let database;
    try {
      const { AutomationJobRepository } = require(workerData.repositoryPath);
      database = new DatabaseSync(workerData.databasePath);
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      const repository = new AutomationJobRepository(database, () => new Date(workerData.now));
      parentPort.postMessage({ type: "ready" });
      parentPort.once("message", (message) => {
        try {
          if (message?.type !== "go") throw new Error("INVALID_BARRIER_MESSAGE");
          parentPort.postMessage({
            type: "result",
            job: repository.leaseNext(workerData.workerId, new Date(workerData.now), workerData.leaseMs)
          });
        } catch (error) {
          parentPort.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            code: error && typeof error === "object" && "code" in error ? error.code : undefined
          });
        } finally {
          database.close();
          parentPort.close();
        }
      });
    } catch (error) {
      if (database) database.close();
      parentPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? error.code : undefined
      });
      parentPort.close();
    }
  `, {
    eval: true,
    execArgv: ["--require", "tsx/cjs"],
    workerData: {
      databasePath,
      repositoryPath: fileURLToPath(new URL("./automation-job-repository.ts", import.meta.url)),
      workerId,
      leaseMs: 30_000,
      now: now.toISOString()
    }
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let resultResolve!: (job: ReturnType<AutomationJobRepository["leaseNext"]>) => void;
  let resultReject!: (error: Error) => void;
  let exitResolve!: (code: number) => void;
  let readySeen = false;
  let resultSeen = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<ReturnType<AutomationJobRepository["leaseNext"]>>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });
  void ready.catch(() => {});
  void result.catch(() => {});
  worker.on("message", (message: {
    type?: string;
    job?: ReturnType<AutomationJobRepository["leaseNext"]>;
    message?: string;
    code?: string;
  }) => {
    if (message.type === "ready") {
      readySeen = true;
      readyResolve();
    }
    if (message.type === "result") {
      resultSeen = true;
      resultResolve(message.job ?? null);
    }
    if (message.type === "error") {
      const error = Object.assign(new Error(message.message ?? "LEASE_WORKER_FAILED"), { code: message.code });
      readyReject(error);
      resultReject(error);
    }
  });
  worker.on("error", (error) => {
    readyReject(error);
    resultReject(error);
  });
  worker.on("exit", (code) => {
    exitResolve(code);
    if (!readySeen || !resultSeen) {
      const error = new Error(`LEASE_WORKER_EXIT_${code}`);
      readyReject(error);
      resultReject(error);
    }
  });
  return { worker, ready, result, exited };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("AutomationJobRepository", () => {
  it("exports the persistent queue repository", () => {
    expect(AutomationJobRepository).toBeTypeOf("function");
  });

  it("deduplicates one action and owner evidence version across real connections", () => {
    const fixture = createFixture();

    const first = fixture.first.enqueue(job(fixture.requirement.id));
    const duplicate = fixture.second.enqueue(job(fixture.requirement.id, { payload: { ignored: true } }));

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      dedupeKey: `implement:requirement:${fixture.requirement.id}:v1`, ownerType: "requirement",
      ownerId: fixture.requirement.id, evidenceVersion: 1, action: "implement",
      status: "pending", attempt: 0, maxAttempts: 3, payload: { command: "npm test" }
    });
    expect(fixture.first.listPending()).toEqual([first]);
  });

  it("revives a failed job only when explicitly requested and rotates its quality claim token", () => {
    const fixture = createFixture();
    const input = job(fixture.requirement.id, { action: "review" });
    const queued = fixture.first.enqueue(input);
    const leased = fixture.first.leaseNext("worker-a", now, 30_000)!;
    fixture.first.fail(queued.id, "worker-a", "provider unavailable", false);

    const duplicate = fixture.first.enqueue(input);
    const revived = fixture.first.enqueue(input, { reviveTerminal: true });

    expect(duplicate).toMatchObject({ id: queued.id, status: "failed", claimToken: leased.claimToken });
    expect(revived).toMatchObject({ id: queued.id, status: "pending", attempt: 0, lastError: null });
    expect(revived.claimToken).not.toBe(leased.claimToken);
    expect(fixture.first.byDedupe(queued.dedupeKey)).toEqual(revived);
  });

  it("atomically deduplicates simultaneous enqueue from independent repository workers", { timeout: 15_000 }, async () => {
    const fixture = createFixture();
    const databasePath = fixture.firstDatabase.prepare("PRAGMA database_list").get() as { file: string };
    const input = job(fixture.requirement.id);
    const first = concurrentEnqueueWorker(input, databasePath.file);
    const second = concurrentEnqueueWorker(input, databasePath.file);
    try {
      await Promise.all([first.ready, second.ready]);
      first.worker.postMessage({ type: "go" });
      second.worker.postMessage({ type: "go" });
      const [firstJob, secondJob] = await Promise.all([first.result, second.result]);

      expect(secondJob.id).toBe(firstJob.id);
      expect(fixture.first.listPending()).toEqual([firstJob]);
    } finally {
      await Promise.all([first.worker.terminate(), second.worker.terminate()]);
    }
  });

  it("leases one pending job exactly once across simultaneous repository workers", { timeout: 15_000 }, async () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    const databasePath = fixture.firstDatabase.prepare("PRAGMA database_list").get() as { file: string };
    const first = concurrentLeaseWorker(databasePath.file, "worker-a");
    const second = concurrentLeaseWorker(databasePath.file, "worker-b");

    try {
      await withTimeout(Promise.all([first.ready, second.ready]), 5_000, "lease workers ready");
      first.worker.postMessage({ type: "go" });
      second.worker.postMessage({ type: "go" });
      const results = await withTimeout(
        Promise.all([first.result, second.result]), 5_000, "lease workers result"
      );

      expect(results.filter((result) => result?.id === queued.id)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      await expect(withTimeout(
        Promise.all([first.exited, second.exited]), 5_000, "lease workers exit"
      )).resolves.toEqual([0, 0]);
    } finally {
      await Promise.all([first.worker.terminate(), second.worker.terminate()]);
    }
  });

  it("keeps distinct actions and evidence versions as distinct jobs", () => {
    const fixture = createFixture();

    const implementation = fixture.first.enqueue(job(fixture.requirement.id));
    const review = fixture.first.enqueue(job(fixture.requirement.id, { action: "review" }));
    const nextEvidence = fixture.first.enqueue(job(fixture.requirement.id, { evidenceVersion: 2 }));

    expect(new Set([implementation.id, review.id, nextEvidence.id]).size).toBe(3);
    expect(fixture.first.listPending()).toHaveLength(3);
  });

  it("accepts the evidence version maximum and rejects overflow consistently", () => {
    const fixture = createFixture();
    const maximum = fixture.first.enqueue(job(fixture.requirement.id, {
      evidenceVersion: MAX_AUTOMATION_EVIDENCE_VERSION
    }));

    expect(maximum.evidenceVersion).toBe(MAX_AUTOMATION_EVIDENCE_VERSION);
    expect(fixture.first.cancelByOwnerVersion(
      fixture.requirement.id,
      MAX_AUTOMATION_EVIDENCE_VERSION,
      "requirement"
    )).toBe(1);
    expect(() => fixture.first.enqueue(job(fixture.requirement.id, {
      evidenceVersion: MAX_AUTOMATION_EVIDENCE_VERSION + 1
    }))).toThrow("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion(
      fixture.requirement.id,
      MAX_AUTOMATION_EVIDENCE_VERSION + 1,
      "requirement"
    )).toThrow("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
  });

  it("scopes canonical dedupe keys by polymorphic owner and reads them directly", () => {
    const fixture = createFixture();
    const ownerId = insertCollidingDeliveryOwner(fixture);

    const requirementJob = fixture.first.enqueue(job(ownerId));
    const deliveryJob = fixture.second.enqueue(job(ownerId, { ownerType: "delivery_unit" }));

    expect(requirementJob.dedupeKey).toBe(`implement:requirement:${ownerId}:v1`);
    expect(deliveryJob.dedupeKey).toBe(`implement:${ownerId}:v1`);
    expect(deliveryJob.id).not.toBe(requirementJob.id);
    expect(fixture.first.byDedupe(requirementJob.dedupeKey)).toEqual(requirementJob);
    expect(fixture.second.byDedupe(deliveryJob.dedupeKey)).toEqual(deliveryJob);
    expect(fixture.store.automationJobs.byDedupe(deliveryJob.dedupeKey)).toEqual(deliveryJob);
  });

  it("rejects separator-bearing owners before they can collide with canonical prefixes", () => {
    const fixture = createFixture();
    insertRequirementOwner(fixture, "abc");

    const requirementJob = fixture.first.enqueue(job("abc"));

    expect(requirementJob.dedupeKey).toBe("implement:requirement:abc:v1");
    expect(() => fixture.first.enqueue(job("requirement:abc", { ownerType: "delivery_unit" })))
      .toThrow("AUTOMATION_JOB_OWNER_INVALID");
    expect(() => fixture.first.enqueue(job("unit%3Aabc", { ownerType: "delivery_unit" })))
      .toThrow("AUTOMATION_JOB_OWNER_INVALID");
    expect(fixture.first.listPending()).toEqual([requirementJob]);
  });

  it("defaults cancellation to delivery units and can explicitly cancel requirements", () => {
    const fixture = createFixture();
    const ownerId = insertCollidingDeliveryOwner(fixture);
    const requirementJob = fixture.first.enqueue(job(ownerId, { action: "review" }));
    const deliveryJob = fixture.first.enqueue(job(ownerId, { ownerType: "delivery_unit", action: "implement" }));

    expect(fixture.first.cancelByOwnerVersion(ownerId, 1)).toBe(1);
    expect(fixture.first.get(deliveryJob.id)?.status).toBe("canceled");
    expect(fixture.first.get(requirementJob.id)?.status).toBe("pending");
    expect(fixture.first.cancelByOwnerVersion(ownerId, 1, "requirement")).toBe(1);
    expect(fixture.first.get(requirementJob.id)?.status).toBe("canceled");
  });

  it("uses the injected clock when canceling a delivery job", () => {
    const future = new Date("2099-01-01T00:00:00.000Z");
    const fixture = createFixture(() => future);
    const ownerId = insertCollidingDeliveryOwner(fixture);
    const queued = fixture.first.enqueue(job(ownerId, { ownerType: "delivery_unit" }));

    expect(fixture.first.cancelByOwnerVersion(ownerId, 1)).toBe(1);
    expect(fixture.first.get(queued.id)).toMatchObject({ status: "canceled", updatedAt: future.toISOString() });
  });

  it("rejects direct corruption of a canonical job identity", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));

    expect(() => fixture.secondDatabase.prepare("UPDATE automation_jobs SET action = 'review' WHERE id = ?").run(queued.id))
      .toThrow(/CHECK constraint failed/);
    expect(fixture.first.enqueue(job(fixture.requirement.id))).toEqual(queued);
    expect(fixture.first.listPending()).toHaveLength(1);
  });

  it("rejects an owner that does not exist", () => {
    const fixture = createFixture();
    expect(() => fixture.first.enqueue(job("missing-owner"))).toThrow("OWNER_NOT_FOUND");
    expect(fixture.first.listPending()).toEqual([]);
  });

  it("is wired through WorkflowStore without moving queue behavior into the store", () => {
    const fixture = createFixture();
    const queued = fixture.store.automationJobs.enqueue(job(fixture.requirement.id));

    expect(fixture.store.automationJobs.get(queued.id)).toEqual(queued);
  });

  it.each([
    ["empty owner", { ownerId: "" }],
    ["long owner", { ownerId: "x".repeat(257) }],
    ["invalid owner type", { ownerType: "project" }],
    ["invalid evidence", { evidenceVersion: 0 }],
    ["fractional evidence", { evidenceVersion: 1.5 }],
    ["unknown action", { action: "invented" }],
    ["invalid max attempts", { maxAttempts: 0 }],
    ["excessive max attempts", { maxAttempts: 101 }],
    ["undefined payload", { payload: undefined }],
    ["non-JSON payload", { payload: { run: () => undefined } }],
    ["oversized payload", { payload: { value: "x".repeat(65_537) } }]
  ])("rejects %s", (_label, invalid) => {
    const fixture = createFixture();
    expect(() => fixture.first.enqueue(job(fixture.requirement.id, invalid as Partial<AutomationJobInput>)))
      .toThrow(/AUTOMATION_JOB_/);
    expect(fixture.first.listPending()).toEqual([]);
  });

  it.each([
    ["root", "1e999"],
    ["nested", "{\"nested\":[1e999]}"],
  ])("rejects stored %s non-finite JSON numbers", (_label, payloadJson) => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET payload_json = ? WHERE id = ?")
      .run(payloadJson, queued.id);

    expect(() => fixture.first.get(queued.id)).toThrow("AUTOMATION_JOB_ROW_INVALID");
  });

  it.each([
    ["id runtime type", "id = x'616263'", "byDedupe"],
    ["empty id", "id = ''", "byDedupe"],
    ["dedupe runtime type", "dedupe_key = x'616263'", "get"],
    ["noncanonical dedupe key", "dedupe_key = 'forged'", "get"],
    ["owner type", "owner_type = 'invented'", "get"],
    ["evidence runtime type", "evidence_version = x'31'", "get"],
    ["evidence range", "evidence_version = 0", "get"],
    ["action", "action = 'invented'", "get"],
    ["status", "status = 'invented'", "get"],
    ["attempt runtime type", "attempt = x'31'", "get"],
    ["maximum attempts runtime type", "max_attempts = x'33'", "get"],
    ["maximum attempts range", "max_attempts = 101", "get"],
    ["exhausted pending attempt", "attempt = max_attempts", "get"],
    [
      "zero leased attempt",
      "status = 'leased', attempt = 0, lease_owner = 'worker', lease_expires_at = '2026-07-20T00:05:00.000Z'",
      "get"
    ],
    ["missing leased fields", "status = 'leased', attempt = 1", "get"],
    [
      "unexpected pending lease fields",
      "lease_owner = 'worker', lease_expires_at = '2026-07-20T00:05:00.000Z'",
      "get"
    ],
    [
      "lease owner runtime type",
      "status = 'leased', attempt = 1, lease_owner = x'77', lease_expires_at = '2026-07-20T00:05:00.000Z'",
      "get"
    ],
    [
      "lease owner policy",
      "status = 'leased', attempt = 1, lease_owner = 'worker:unsafe', lease_expires_at = '2026-07-20T00:05:00.000Z'",
      "get"
    ],
    [
      "lease timestamp format",
      "status = 'leased', attempt = 1, lease_owner = 'worker', lease_expires_at = '2026-07-20T00:05:00Z'",
      "get"
    ],
    ["payload runtime type", "payload_json = x'7B7D'", "get"],
    ["malformed payload", "payload_json = '{'", "get"],
    ["non-finite payload", "payload_json = '1e999'", "get"],
    ["last error runtime type", "last_error = x'65'", "get"],
    ["last error length", `last_error = '${"x".repeat(4097)}'`, "get"],
    ["created timestamp", "created_at = '2026-07-20 00:00:00'", "get"],
    ["updated timestamp", "updated_at = '2026-07-20T00:00:00Z'", "get"],
    [
      "timestamp order",
      "created_at = '2026-07-20T00:00:01.000Z', updated_at = '2026-07-20T00:00:00.000Z'",
      "get"
    ]
  ] as const)("rejects a stored row with invalid %s", (_label, assignment, readPath) => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.exec("PRAGMA ignore_check_constraints = ON");
    fixture.secondDatabase.prepare(`UPDATE automation_jobs SET ${assignment} WHERE id = ?`).run(queued.id);

    const read = readPath === "byDedupe"
      ? () => fixture.first.byDedupe(queued.dedupeKey)
      : () => fixture.first.get(queued.id);
    expect(read).toThrow("AUTOMATION_JOB_ROW_INVALID");
  });

  it("rejects a stored row with an unsafe owner", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    insertRequirementOwner(fixture, "unsafe:owner");
    fixture.secondDatabase.exec("PRAGMA ignore_check_constraints = ON");
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET owner_id = 'unsafe:owner' WHERE id = ?")
      .run(queued.id);

    expect(() => fixture.first.get(queued.id)).toThrow("AUTOMATION_JOB_ROW_INVALID");
  });

  it("decodes duplicate enqueue, direct lookup, and pending list through the same row validator", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.exec("PRAGMA ignore_check_constraints = ON");

    fixture.secondDatabase.prepare("UPDATE automation_jobs SET status = 'invented' WHERE id = ?").run(queued.id);
    expect(() => fixture.first.enqueue(job(fixture.requirement.id))).toThrow("AUTOMATION_JOB_ROW_INVALID");
    expect(() => fixture.first.byDedupe(queued.dedupeKey)).toThrow("AUTOMATION_JOB_ROW_INVALID");

    fixture.secondDatabase.prepare(
      "UPDATE automation_jobs SET status = 'pending', created_at = 'not-a-date' WHERE id = ?"
    ).run(queued.id);
    expect(() => fixture.first.listPending()).toThrow("AUTOMATION_JOB_ROW_INVALID");
  });

  it("lists only lease-eligible pending jobs through the pending partial index", () => {
    const fixture = createFixture();
    const exhausted = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.exec("PRAGMA ignore_check_constraints = ON");
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET attempt = max_attempts WHERE id = ?")
      .run(exhausted.id);

    expect(fixture.first.listPending()).toEqual([]);
    const queryPlan = fixture.firstDatabase.prepare(`EXPLAIN QUERY PLAN SELECT * FROM automation_jobs
      WHERE status = 'pending' AND attempt < max_attempts ORDER BY created_at, id`).all() as Array<{ detail: string }>;
    expect(queryPlan.some(({ detail }) => detail.includes("idx_automation_jobs_pending_lease"))).toBe(true);
  });

  it("preserves normal Unicode in queue payload and failure text", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id, {
      payload: { message: "构建完成 😀" }
    }));

    expect(fixture.first.leaseNext("worker-unicode-error", now, 30_000)).toMatchObject({
      id: queued.id, leaseOwner: "worker-unicode-error", payload: { message: "构建完成 😀" }
    });
    expect(fixture.first.fail(queued.id, "worker-unicode-error", "临时错误 😀", false)).toBe(true);
    expect(fixture.first.get(queued.id)?.lastError).toBe("临时错误 😀");
  });

  it("accepts 128 ASCII worker characters and rejects 129 before mutation", () => {
    const fixture = createFixture();
    const accepted = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement" }));
    const pending = fixture.first.enqueue(job(fixture.requirement.id, { action: "review" }));
    const maximumWorker = "w".repeat(128);
    const leaseCandidate = accepted.id < pending.id ? accepted : pending;
    const stillPending = leaseCandidate.id === accepted.id ? pending : accepted;

    expect(fixture.first.leaseNext(maximumWorker, now, 30_000)).toMatchObject({
      id: leaseCandidate.id, leaseOwner: maximumWorker
    });
    expect(fixture.first.get(leaseCandidate.id)?.leaseOwner).toBe(maximumWorker);
    expect(() => fixture.first.leaseNext("w".repeat(129), now, 30_000))
      .toThrow("AUTOMATION_JOB_WORKER_ID_INVALID");
    expect(fixture.first.get(stillPending.id)).toMatchObject({ status: "pending", attempt: 0 });
  });

  it.each([
    ["emoji", "worker😀"],
    ["colon", "worker:unsafe"],
    ["leading space", " worker"],
    ["trailing space", "worker "],
    ["tab", "worker\tid"]
  ])("rejects an unsafe %s worker before mutation", (_label, workerId) => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));

    expect(() => fixture.first.leaseNext(workerId, now, 30_000))
      .toThrow("AUTOMATION_JOB_WORKER_ID_INVALID");
    expect(fixture.first.get(queued.id)).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("leases pending jobs in stable created-at and id order", () => {
    const fixture = createFixture();
    const jobs = [
      fixture.first.enqueue(job(fixture.requirement.id, { action: "implement" })),
      fixture.first.enqueue(job(fixture.requirement.id, { action: "review" })),
      fixture.first.enqueue(job(fixture.requirement.id, { action: "test" }))
    ];
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET created_at = ?").run(now.toISOString());
    const expected = jobs.map(({ id }) => id).sort();

    const leased = expected.map(() => fixture.first.leaseNext("worker-a", now, 30_000));

    expect(leased.map((item) => item?.id)).toEqual(expected);
    expect(leased.every((item) => item?.status === "leased" && item.attempt === 1)).toBe(true);
    expect(fixture.first.leaseNext("worker-a", now, 30_000)).toBeNull();
  });

  it("does not let another worker steal an active lease", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));

    const leased = fixture.first.leaseNext("worker-a", now, 30_000);

    expect(leased).toMatchObject({ id: queued.id, leaseOwner: "worker-a", attempt: 1 });
    expect(leased?.leaseExpiresAt).toBe(addMs(now, 30_000).toISOString());
    expect(fixture.second.leaseNext("worker-b", now, 30_000)).toBeNull();
  });

  it("renews only the owning worker's unexpired lease", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.second.renew(queued.id, "worker-b", addMs(now, 1_000), 60_000)).toBe(false);
    expect(fixture.first.renew(queued.id, "worker-a", addMs(now, 1_000), 60_000)).toBe(true);
    expect(fixture.first.get(queued.id)?.leaseExpiresAt).toBe(addMs(now, 61_000).toISOString());
    expect(fixture.first.renew(queued.id, "worker-a", addMs(now, 61_000), 60_000)).toBe(false);
  });

  it("rejects renew, complete, and fail after expiry even before recovery", () => {
    let clock = now;
    const fixture = createFixture(() => clock);
    const renewJob = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement" }));
    const completeJob = fixture.first.enqueue(job(fixture.requirement.id, { action: "review" }));
    const failJob = fixture.first.enqueue(job(fixture.requirement.id, { action: "test" }));
    for (let index = 0; index < 3; index += 1) fixture.first.leaseNext("worker-a", now, 10);
    clock = addMs(now, 10);

    expect(fixture.first.renew(renewJob.id, "worker-a", clock, 10)).toBe(false);
    expect(fixture.first.complete(completeJob.id, "worker-a")).toBe(false);
    expect(fixture.first.fail(failJob.id, "worker-a", "late failure", true)).toBe(false);
    for (const queued of [renewJob, completeJob, failJob]) {
      expect(fixture.first.get(queued.id)).toMatchObject({ status: "leased", leaseOwner: "worker-a", attempt: 1 });
    }
  });

  it("blocks late settlement after an expired lease is reassigned", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 10);
    expect(fixture.second.recoverExpired(addMs(now, 10))).toBe(1);
    expect(fixture.second.leaseNext("worker-b", addMs(now, 10), 10)).toMatchObject({ id: queued.id, attempt: 2 });

    expect(fixture.first.complete(queued.id, "worker-a")).toBe(false);
    expect(fixture.second.complete(queued.id, "worker-b")).toBe(true);
    expect(fixture.first.get(queued.id)).toMatchObject({
      status: "completed", attempt: 2, leaseOwner: null, leaseExpiresAt: null
    });
    expect(fixture.second.complete(queued.id, "worker-b")).toBe(false);
  });

  it("rolls back a failed lease transaction observed by another connection", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.exec(`CREATE TRIGGER reject_test_lease BEFORE UPDATE OF status ON automation_jobs
      WHEN NEW.status = 'leased' BEGIN SELECT RAISE(ABORT, 'forced lease failure'); END;`);

    expect(() => fixture.first.leaseNext("worker-a", now, 30_000)).toThrow("forced lease failure");

    expect(fixture.second.get(queued.id)).toMatchObject({
      status: "pending", attempt: 0, leaseOwner: null, leaseExpiresAt: null
    });
  });

  it("rolls back a lease when the stored row cannot be decoded", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET payload_json = '1e999' WHERE id = ?")
      .run(queued.id);

    expect(() => fixture.first.leaseNext("worker-a", now, 30_000))
      .toThrow("AUTOMATION_JOB_ROW_INVALID");

    expect(fixture.secondDatabase.prepare(
      "SELECT status, attempt, lease_owner, lease_expires_at FROM automation_jobs WHERE id = ?"
    ).get(queued.id)).toEqual({
      status: "pending", attempt: 0, lease_owner: null, lease_expires_at: null
    });
  });

  it("preserves the original error when SQLite already rolled back the lease transaction", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.exec(`CREATE TRIGGER rollback_test_lease BEFORE UPDATE OF status ON automation_jobs
      WHEN NEW.status = 'leased' BEGIN SELECT RAISE(ROLLBACK, 'forced lease rollback'); END;`);

    expect(() => fixture.first.leaseNext("worker-a", now, 30_000)).toThrow("forced lease rollback");

    expect(fixture.secondDatabase.prepare(
      "SELECT status, attempt, lease_owner, lease_expires_at FROM automation_jobs WHERE id = ?"
    ).get(queued.id)).toEqual({
      status: "pending", attempt: 0, lease_owner: null, lease_expires_at: null
    });
  });

  it.each([
    ["empty worker", "", now, 1],
    ["long worker", "w".repeat(129), now, 1],
    ["invalid date", "worker-a", new Date(Number.NaN), 1],
    ["zero lease", "worker-a", now, 0],
    ["fractional lease", "worker-a", now, 1.5],
    ["excessive lease", "worker-a", now, 86_400_001]
  ])("rejects %s lease input", (_label, workerId, leaseNow, leaseMs) => {
    const fixture = createFixture();
    fixture.first.enqueue(job(fixture.requirement.id));
    expect(() => fixture.first.leaseNext(workerId, leaseNow, leaseMs)).toThrow(/AUTOMATION_JOB_/);
    expect(fixture.first.listPending()).toHaveLength(1);
  });

  it("rejects a NUL worker before starting a lease transaction", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));

    expect(() => fixture.first.leaseNext("worker\0id", now, 30_000))
      .toThrow("AUTOMATION_JOB_WORKER_ID_INVALID");

    expect(fixture.secondDatabase.prepare(
      "SELECT status, attempt, lease_owner, lease_expires_at FROM automation_jobs WHERE id = ?"
    ).get(queued.id)).toEqual({
      status: "pending", attempt: 0, lease_owner: null, lease_expires_at: null
    });
  });

  it("sanitizes a NUL failure before returning a retryable lease to pending", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-a", "temporary😀\0outage", true)).toBe(true);

    expect(fixture.second.get(queued.id)).toMatchObject({
      status: "pending", attempt: 1, lastError: "temporary😀\\0outage",
      leaseOwner: null, leaseExpiresAt: null
    });
  });

  it("sanitizes an Error object before making a lease terminal", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(
      queued.id, "worker-a", new Error("fatal\0failure"), false
    )).toBe(true);

    expect(fixture.second.get(queued.id)).toMatchObject({
      status: "failed", attempt: 1, lastError: "fatal\\0failure",
      leaseOwner: null, leaseExpiresAt: null
    });
  });

  it("rejects a whitespace-only Error message before settling a lease", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(() => fixture.first.fail(queued.id, "worker-a", new Error("   "), true))
      .toThrow("AUTOMATION_JOB_ERROR_INVALID");
    expect(fixture.first.get(queued.id)?.status).toBe("leased");
  });

  it("returns a retryable first failure to pending with attempt one", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-a", "temporary outage", true)).toBe(true);
    expect(fixture.second.get(queued.id)).toMatchObject({
      status: "pending", attempt: 1, lastError: "temporary outage",
      leaseOwner: null, leaseExpiresAt: null
    });
  });

  it("stops retrying when the lease attempt reaches its cap", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id, { maxAttempts: 2 }));

    fixture.first.leaseNext("worker-a", now, 30_000);
    expect(fixture.first.fail(queued.id, "worker-a", "first", true)).toBe(true);
    fixture.first.leaseNext("worker-b", addMs(now, 1), 30_000);
    expect(fixture.first.fail(queued.id, "worker-b", "second", true)).toBe(true);

    expect(fixture.first.get(queued.id)).toMatchObject({ status: "failed", attempt: 2, lastError: "second" });
    expect(fixture.first.leaseNext("worker-c", addMs(now, 2), 30_000)).toBeNull();
  });

  it("makes a non-retryable failure terminal on its first attempt", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-a", "invalid evidence", false)).toBe(true);

    expect(fixture.first.get(queued.id)).toMatchObject({ status: "failed", attempt: 1, lastError: "invalid evidence" });
  });

  it("bounds persisted failure text", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-a", "x".repeat(10_000), false)).toBe(true);

    expect(fixture.first.get(queued.id)?.lastError).toBe("x".repeat(4096));
  });

  it("truncates persisted failure text without splitting a Unicode code point", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-a", `${"x".repeat(4095)}😀tail`, false)).toBe(true);

    const persisted = fixture.first.get(queued.id)?.lastError;
    expect(persisted).toBe(`${"x".repeat(4095)}😀`);
    expect(persisted).not.toContain("�");
    expect(Array.from(persisted ?? "")).toHaveLength(4096);
  });

  it("recovers only expired leases and fails an expired final attempt", () => {
    const fixture = createFixture();
    const first = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement", maxAttempts: 2 }));
    const final = fixture.first.enqueue(job(fixture.requirement.id, { action: "review", maxAttempts: 1 }));
    const setCreatedAt = fixture.secondDatabase.prepare(
      "UPDATE automation_jobs SET created_at = ?, updated_at = ? WHERE id = ?"
    );
    setCreatedAt.run(addMs(now, -1).toISOString(), addMs(now, -1).toISOString(), first.id);
    setCreatedAt.run(now.toISOString(), now.toISOString(), final.id);
    fixture.first.leaseNext("worker-a", now, 20);
    fixture.first.leaseNext("worker-b", now, 10);

    expect(fixture.second.recoverExpired(addMs(now, 9))).toBe(0);
    expect(fixture.second.recoverExpired(addMs(now, 10))).toBe(1);
    expect(fixture.second.get(final.id)).toMatchObject({ status: "failed", attempt: 1, leaseOwner: null });
    expect(fixture.second.get(first.id)).toMatchObject({ status: "leased", attempt: 1, leaseOwner: "worker-a" });
    expect(fixture.second.recoverExpired(addMs(now, 20))).toBe(1);
    expect(fixture.second.get(first.id)).toMatchObject({ status: "pending", attempt: 1, leaseOwner: null });
  });

  it("cancels only pending and leased jobs for one owner evidence version", () => {
    const fixture = createFixture();
    const pending = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement" }));
    const leased = fixture.first.enqueue(job(fixture.requirement.id, { action: "review" }));
    const completed = fixture.first.enqueue(job(fixture.requirement.id, { action: "test" }));
    const otherVersion = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement", evidenceVersion: 2 }));
    const setCreatedAt = fixture.secondDatabase.prepare(
      "UPDATE automation_jobs SET created_at = ?, updated_at = ? WHERE id = ?"
    );
    setCreatedAt.run(addMs(now, -1).toISOString(), addMs(now, -1).toISOString(), pending.id);
    setCreatedAt.run(addMs(now, -3).toISOString(), addMs(now, -3).toISOString(), leased.id);
    setCreatedAt.run(addMs(now, -2).toISOString(), addMs(now, -2).toISOString(), completed.id);
    setCreatedAt.run(now.toISOString(), now.toISOString(), otherVersion.id);
    fixture.first.leaseNext("worker-a", now, 30_000);
    fixture.first.leaseNext("worker-b", now, 30_000);
    fixture.first.complete(completed.id, "worker-b");

    expect(fixture.second.cancelByOwnerVersion(fixture.requirement.id, 1, "requirement")).toBe(2);

    expect(fixture.first.get(pending.id)?.status).toBe("canceled");
    expect(fixture.first.get(leased.id)).toMatchObject({ status: "canceled", leaseOwner: null, leaseExpiresAt: null });
    expect(fixture.first.get(completed.id)?.status).toBe("completed");
    expect(fixture.first.get(otherVersion.id)?.status).toBe("pending");
    expect(fixture.first.complete(leased.id, "worker-a")).toBe(false);
  });

  it("does not settle a lease for the wrong worker or invalid failure input", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.first.leaseNext("worker-a", now, 30_000);

    expect(fixture.first.fail(queued.id, "worker-b", "late", true)).toBe(false);
    expect(() => fixture.first.fail(queued.id, "worker-a", "", true)).toThrow("AUTOMATION_JOB_ERROR_INVALID");
    expect(() => fixture.first.fail(queued.id, "worker-a", "   ", true))
      .toThrow("AUTOMATION_JOB_ERROR_INVALID");
    expect(() => fixture.first.fail(queued.id, "worker-a", "error", "yes" as unknown as boolean))
      .toThrow("AUTOMATION_JOB_RETRYABLE_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion("", 1)).toThrow("AUTOMATION_JOB_OWNER_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion("unsafe:owner", 1)).toThrow("AUTOMATION_JOB_OWNER_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion(fixture.requirement.id, 0))
      .toThrow("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
    expect(() => fixture.first.recoverExpired(new Date(Number.NaN))).toThrow("AUTOMATION_JOB_DATE_INVALID");
    expect(fixture.first.get(queued.id)?.status).toBe("leased");
  });
});
