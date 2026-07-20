import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function createFixture() {
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
    store, requirement, firstDatabase, secondDatabase,
    first: new AutomationJobRepository(firstDatabase),
    second: new AutomationJobRepository(secondDatabase)
  };
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
      dedupeKey: `implement:${fixture.requirement.id}:v1`, ownerType: "requirement",
      ownerId: fixture.requirement.id, evidenceVersion: 1, action: "implement",
      status: "pending", attempt: 0, maxAttempts: 3, payload: { command: "npm test" }
    });
    expect(fixture.first.listPending()).toEqual([first]);
  });

  it("keeps distinct actions and evidence versions as distinct jobs", () => {
    const fixture = createFixture();

    const implementation = fixture.first.enqueue(job(fixture.requirement.id));
    const review = fixture.first.enqueue(job(fixture.requirement.id, { action: "review" }));
    const nextEvidence = fixture.first.enqueue(job(fixture.requirement.id, { evidenceVersion: 2 }));

    expect(new Set([implementation.id, review.id, nextEvidence.id]).size).toBe(3);
    expect(fixture.first.listPending()).toHaveLength(3);
  });

  it("fails closed when a canonical dedupe row does not match its job identity", () => {
    const fixture = createFixture();
    const queued = fixture.first.enqueue(job(fixture.requirement.id));
    fixture.secondDatabase.prepare("UPDATE automation_jobs SET action = 'review' WHERE id = ?").run(queued.id);

    expect(() => fixture.first.enqueue(job(fixture.requirement.id))).toThrow("AUTOMATION_JOB_DEDUPE_CONFLICT");
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

  it("recovers only expired leases and fails an expired final attempt", () => {
    const fixture = createFixture();
    const first = fixture.first.enqueue(job(fixture.requirement.id, { action: "implement", maxAttempts: 2 }));
    const final = fixture.first.enqueue(job(fixture.requirement.id, { action: "review", maxAttempts: 1 }));
    const setCreatedAt = fixture.secondDatabase.prepare("UPDATE automation_jobs SET created_at = ? WHERE id = ?");
    setCreatedAt.run(now.toISOString(), first.id);
    setCreatedAt.run(addMs(now, 1).toISOString(), final.id);
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
    const setCreatedAt = fixture.secondDatabase.prepare("UPDATE automation_jobs SET created_at = ? WHERE id = ?");
    setCreatedAt.run(addMs(now, 100).toISOString(), pending.id);
    setCreatedAt.run(now.toISOString(), leased.id);
    setCreatedAt.run(addMs(now, 1).toISOString(), completed.id);
    setCreatedAt.run(addMs(now, 200).toISOString(), otherVersion.id);
    fixture.first.leaseNext("worker-a", now, 30_000);
    fixture.first.leaseNext("worker-b", now, 30_000);
    fixture.first.complete(completed.id, "worker-b");

    expect(fixture.second.cancelByOwnerVersion(fixture.requirement.id, 1)).toBe(2);

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
    expect(() => fixture.first.fail(queued.id, "worker-a", "error", "yes" as unknown as boolean))
      .toThrow("AUTOMATION_JOB_RETRYABLE_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion("", 1)).toThrow("AUTOMATION_JOB_OWNER_ID_INVALID");
    expect(() => fixture.first.cancelByOwnerVersion(fixture.requirement.id, 0))
      .toThrow("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
    expect(() => fixture.first.recoverExpired(new Date(Number.NaN))).toThrow("AUTOMATION_JOB_DATE_INVALID");
    expect(fixture.first.get(queued.id)?.status).toBe("leased");
  });
});
