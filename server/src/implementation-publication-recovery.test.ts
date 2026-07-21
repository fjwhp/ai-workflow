import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";
import {
  applyImplementationPatchSync,
  captureImplementationPatchSync
} from "./implementation-publication.js";
import {
  cleanupCodingAttemptWorktree, createCodingAttemptWorktree, getWorktreeSnapshot
} from "./repository.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("implementation publication startup recovery", () => {
  it.each(["clean", "exact-patch"] as const)("cancels a prepared %s journal and makes the job retryable", async (state) => {
    const fixture = await preparedFixture();
    if (state === "exact-patch") applyImplementationPatchSync(fixture.repo, fixture.patch);

    await fixture.store.reconcileImplementationPublications();
    fixture.store.recoverAbandonedDeliveryExecutions(new Date());

    expect(captureImplementationPatchSync(fixture.repo)).toHaveLength(0);
    expect(fixture.store.automationJobs.get(fixture.job.id)).toMatchObject({ status: "pending", attempt: 1 });
    expect(fixture.store.deliveryUnits.get(fixture.unit.id)).toMatchObject({ status: "ready" });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
    expect(existsSync(fixture.attempt.worktreePath)).toBe(false);
  });

  it("finishes cleanup after canceled status committed before cleanup began", async () => {
    const fixture = await preparedFixture();
    fixture.db.prepare(`UPDATE implementation_publication_journals
      SET status = 'canceled' WHERE delivery_unit_id = ?`).run(fixture.unit.id);

    await fixture.store.reconcileImplementationPublications();

    expect(existsSync(fixture.attempt.worktreePath)).toBe(false);
    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
  });

  it("settles cleanup when filesystem removal completed before status write", async () => {
    const fixture = await preparedFixture();
    fixture.db.prepare(`UPDATE implementation_publication_journals
      SET status = 'canceled' WHERE delivery_unit_id = ?`).run(fixture.unit.id);
    await cleanupCodingAttemptWorktree(fixture.repo, fixture.attempt.worktreePath);

    await fixture.store.reconcileImplementationPublications();

    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
  });

  it("recovers after a child is SIGKILLed after canceled commit and before cleanup", async () => {
    const fixture = await preparedFixture();
    const barrier = join(fixture.root, "canceled-before-cleanup.marker");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      import { writeFileSync } from "node:fs";
      const db = new DatabaseSync(process.env.PUBLICATION_DATABASE);
      db.prepare("UPDATE implementation_publication_journals SET status = 'canceled' WHERE status = 'prepared'").run();
      db.close();
      writeFileSync(process.env.PUBLICATION_BARRIER, "canceled", { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `], {
      env: { ...process.env, PUBLICATION_DATABASE: fixture.databasePath, PUBLICATION_BARRIER: barrier },
      stdio: ["ignore", "ignore", "pipe"]
    });

    await killChildAtBarrier(child, barrier);
    await fixture.store.reconcileImplementationPublications();

    expect(existsSync(fixture.attempt.worktreePath)).toBe(false);
    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
  }, 15_000);

  it("recovers after a child is SIGKILLed after filesystem cleanup and before status write", async () => {
    const fixture = await preparedFixture();
    fixture.db.prepare(`UPDATE implementation_publication_journals
      SET status = 'canceled' WHERE delivery_unit_id = ?`).run(fixture.unit.id);
    const barrier = join(fixture.root, "filesystem-before-status.marker");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      const { cleanupJournaledCodingAttemptWorktree } = await import(process.env.PUBLICATION_REPOSITORY_MODULE);
      await cleanupJournaledCodingAttemptWorktree(process.env.PUBLICATION_REPO, process.env.PUBLICATION_ATTEMPT, {
        version: 1,
        uid: Number(process.env.PUBLICATION_UID),
        dev: Number(process.env.PUBLICATION_DEV),
        ino: Number(process.env.PUBLICATION_INO),
        nonce: process.env.PUBLICATION_NONCE
      });
      writeFileSync(process.env.PUBLICATION_BARRIER, "clean", { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `], {
      env: {
        ...process.env,
        PUBLICATION_REPOSITORY_MODULE: new URL("./repository.ts", import.meta.url).href,
        PUBLICATION_REPO: fixture.repo,
        PUBLICATION_ATTEMPT: fixture.attempt.worktreePath,
        PUBLICATION_UID: String(fixture.attempt.attemptIdentity.uid),
        PUBLICATION_DEV: String(fixture.attempt.attemptIdentity.dev),
        PUBLICATION_INO: String(fixture.attempt.attemptIdentity.ino),
        PUBLICATION_NONCE: fixture.attempt.attemptIdentity.nonce,
        PUBLICATION_BARRIER: barrier
      },
      stdio: ["ignore", "ignore", "pipe"]
    });

    await killChildAtBarrier(child, barrier);
    await fixture.store.reconcileImplementationPublications();

    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
  }, 15_000);

  it.each([
    ["identity", "UPDATE implementation_publication_journals SET patch_sha256 = lower(hex(randomblob(32))) WHERE delivery_unit_id = ?"],
    ["delete", "DELETE FROM implementation_publication_journals WHERE delivery_unit_id = ?"]
  ])("rejects direct SQL %s mutation", async (_kind, sql) => {
    const fixture = await preparedFixture();

    expect(() => fixture.db.prepare(sql).run(fixture.unit.id))
      .toThrow("IMPLEMENTATION_PUBLICATION_JOURNAL_IMMUTABLE");
  });

  it("rejects terminal status reversal and completed cleanup downgrade", async () => {
    const fixture = await preparedFixture();
    fixture.db.prepare(`UPDATE implementation_publication_journals
      SET status = 'canceled' WHERE delivery_unit_id = ?`).run(fixture.unit.id);
    expect(() => fixture.db.prepare(`UPDATE implementation_publication_journals
      SET status = 'prepared' WHERE delivery_unit_id = ?`).run(fixture.unit.id))
      .toThrow("IMPLEMENTATION_PUBLICATION_STATUS_IMMUTABLE");
    fixture.db.prepare(`UPDATE implementation_publication_journals SET
      cleanup_status = 'completed', cleanup_completed_at = updated_at WHERE delivery_unit_id = ?`)
      .run(fixture.unit.id);

    expect(() => fixture.db.prepare(`UPDATE implementation_publication_journals SET
      cleanup_status = 'failed', cleanup_completed_at = NULL WHERE delivery_unit_id = ?`).run(fixture.unit.id))
      .toThrow("IMPLEMENTATION_PUBLICATION_CLEANUP_IMMUTABLE");
  });

  it("fails closed without reversing an ambiguous dirty authoritative worktree", async () => {
    const fixture = await preparedFixture();
    applyImplementationPatchSync(fixture.repo, fixture.patch);
    writeFileSync(join(fixture.repo, "unrelated.txt"), "manual edit\n");

    await expect(fixture.store.reconcileImplementationPublications())
      .rejects.toThrow("IMPLEMENTATION_PUBLICATION_MANUAL_RECOVERY_REQUIRED");

    expect(existsSync(join(fixture.repo, "published.txt"))).toBe(true);
    expect(existsSync(join(fixture.repo, "unrelated.txt"))).toBe(true);
    expect(fixture.db.prepare("SELECT status FROM implementation_publication_journals WHERE delivery_unit_id = ?")
      .get(fixture.unit.id)).toEqual({ status: "manual" });
  });

  it("never reverses a committed publication and retries only attempt cleanup", async () => {
    const fixture = await preparedFixture();
    fixture.store.deliveryExecutions.publishPreparedImplementation(fixture.claim, fixture.result);

    await fixture.store.reconcileImplementationPublications();

    expect(captureImplementationPatchSync(fixture.repo).equals(fixture.patch)).toBe(true);
    expect(fixture.store.automationJobs.get(fixture.job.id)).toMatchObject({ status: "completed" });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toEqual(expect.any(Object));
    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "committed", cleanup_status: "completed"
    });
    expect(existsSync(fixture.attempt.worktreePath)).toBe(false);
  });

  it("preserves the canceled journal and inserts an immutable row for the reassigned lease", async () => {
    const fixture = await preparedFixture();
    await fixture.store.reconcileImplementationPublications();
    fixture.store.recoverAbandonedDeliveryExecutions(new Date());
    const nextJob = fixture.store.automationJobs.leaseNext("replacement-worker", new Date(), 30_000)!;
    const nextClaim = fixture.store.deliveryExecutions.claimImplementation(
      fixture.unit.id, "test-model", { evidenceVersion: 1, claimToken: nextJob.claimToken }
    );
    const nextAttempt = await createCodingAttemptWorktree(fixture.repo, fixture.claim.version.headCommit);
    writeFileSync(join(nextAttempt.worktreePath, "replacement.txt"), "replacement\n");
    const nextPatch = captureImplementationPatchSync(nextAttempt.worktreePath);

    const rebound = fixture.store.deliveryExecutions.prepareImplementationPublication(nextClaim, {
      repoPath: fixture.repo,
      authoritativeWorktreePath: fixture.repo,
      attemptPath: nextAttempt.worktreePath,
      attemptDev: nextAttempt.attemptIdentity.dev,
      attemptIno: nextAttempt.attemptIdentity.ino,
      attemptUid: nextAttempt.attemptIdentity.uid,
      attemptNonce: nextAttempt.attemptIdentity.nonce,
      patch: nextPatch
    });

    expect(rebound.status).toBe("prepared");
    const journals = fixture.db.prepare(`SELECT id, job_id, claim_token, worker_id, status
      FROM implementation_publication_journals WHERE delivery_unit_id = ?`).all(fixture.unit.id) as any[];
    expect(journals).toHaveLength(2);
    expect(journals).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim_token: fixture.job.claimToken, status: "canceled" }),
      expect.objectContaining({
        job_id: nextJob.id, claim_token: nextJob.claimToken,
        worker_id: "replacement-worker", status: "prepared"
      })
    ]));
    expect(rebound.id).not.toBe(journals.find((row) => row.status === "canceled")?.id);
  });

  it("recovers after a real child is SIGKILLed after apply and before database commit", async () => {
    const fixture = await preparedFixture();
    const barrier = join(fixture.root, "applied.marker");
    let stderr = "";
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      import { writeFileSync } from "node:fs";
      const { applyImplementationPatchSync } = await import(process.env.PUBLICATION_MODULE);
      const db = new DatabaseSync(process.env.PUBLICATION_DATABASE);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
      const row = db.prepare("SELECT authoritative_worktree_path, patch_blob FROM implementation_publication_journals WHERE status = 'prepared'").get();
      applyImplementationPatchSync(row.authoritative_worktree_path, Buffer.from(row.patch_blob));
      writeFileSync(process.env.PUBLICATION_BARRIER, "applied", { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `], {
      env: {
        ...process.env,
        PUBLICATION_MODULE: new URL("./implementation-publication.ts", import.meta.url).href,
        PUBLICATION_DATABASE: fixture.databasePath,
        PUBLICATION_BARRIER: barrier
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    for (let attempt = 0; attempt < 500 && !existsSync(barrier); attempt += 1) await delay(10);
    expect(existsSync(barrier), stderr).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
    expect(captureImplementationPatchSync(fixture.repo).equals(fixture.patch)).toBe(true);
    expect(fixture.db.prepare("SELECT status FROM implementation_publication_journals WHERE delivery_unit_id = ?")
      .get(fixture.unit.id)).toEqual({ status: "prepared" });

    await fixture.store.reconcileImplementationPublications();
    fixture.store.recoverAbandonedDeliveryExecutions(new Date());

    expect(captureImplementationPatchSync(fixture.repo)).toHaveLength(0);
    expect(existsSync(fixture.attempt.worktreePath)).toBe(false);
    expect(existsSync(`${fixture.attempt.worktreePath}.owner.json`)).toBe(false);
    expect(execFileSync("git", ["-C", fixture.repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }))
      .not.toContain(fixture.attempt.worktreePath);
    expect(fixture.store.automationJobs.get(fixture.job.id)).toMatchObject({ status: "pending" });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.unit.id, 1)).toBeNull();
  }, 15_000);

  it("reserves the lease and immediately reverses an apply that crosses the final expiry fence", async () => {
    let now = new Date("2026-07-22T00:00:00.000Z");
    const fixture = await preparedFixture({
      clock: () => now,
      afterApply: () => { now = new Date(now.getTime() + 61_000); }
    });
    const lease = fixture.db.prepare("SELECT lease_expires_at FROM automation_jobs WHERE id = ?")
      .get(fixture.job.id) as { lease_expires_at: string };
    expect(new Date(lease.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-07-22T00:01:00.000Z").getTime()
    );

    await expect(Promise.resolve().then(() =>
      fixture.store.deliveryExecutions.publishPreparedImplementation(fixture.claim, fixture.result)
    )).rejects.toThrow("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    expect(captureImplementationPatchSync(fixture.repo).equals(fixture.patch)).toBe(true);

    await fixture.store.deliveryExecutions.reconcilePreparedImplementation(fixture.claim);

    expect(captureImplementationPatchSync(fixture.repo)).toHaveLength(0);
    expect(fixture.store.automationJobs.get(fixture.job.id)).toMatchObject({ status: "pending" });
    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "canceled", cleanup_status: "completed"
    });
  });

  it("rolls back every runtime settlement write when bound run settlement fails", async () => {
    let inject = true;
    const fixture = await preparedFixture({
      beforeRecoverySettlement: () => {
        if (inject) throw new Error("INJECTED_RECOVERY_SETTLEMENT_FAILURE");
      }
    });
    applyImplementationPatchSync(fixture.repo, fixture.patch);

    await expect(fixture.store.deliveryExecutions.reconcilePreparedImplementation(fixture.claim))
      .rejects.toThrow("INJECTED_RECOVERY_SETTLEMENT_FAILURE");

    expect(fixture.db.prepare(`SELECT status, cleanup_status FROM implementation_publication_journals
      WHERE delivery_unit_id = ?`).get(fixture.unit.id)).toEqual({
      status: "prepared", cleanup_status: "pending"
    });
    expect(fixture.store.automationJobs.get(fixture.job.id)).toMatchObject({ status: "leased" });
    expect(fixture.store.deliveryUnits.get(fixture.unit.id)).toMatchObject({ status: "running" });
    expect(fixture.store.deliveryExecutions.listExecutions(fixture.unit.id, 1)[0])
      .toMatchObject({ status: "running" });
    expect(fixture.store.getStageRun(fixture.claim.runId)).toMatchObject({ status: "running" });

    inject = false;
    await fixture.store.deliveryExecutions.reconcilePreparedImplementation(fixture.claim);
    expect(fixture.store.deliveryUnits.get(fixture.unit.id)).toMatchObject({ status: "ready" });
    expect(fixture.store.getStageRun(fixture.claim.runId)).toMatchObject({ status: "interrupted" });
  });

  it("fences a stale child so the replacement child is the only publisher", async () => {
    const fixture = await preparedFixture();
    await fixture.store.reconcileImplementationPublications();
    fixture.store.recoverAbandonedDeliveryExecutions(new Date());
    const nextJob = fixture.store.automationJobs.leaseNext("winner-worker", new Date(), 30_000)!;
    const nextClaim = fixture.store.deliveryExecutions.claimImplementation(
      fixture.unit.id, "test-model", { evidenceVersion: 1, claimToken: nextJob.claimToken }
    );
    const nextAttempt = await createCodingAttemptWorktree(fixture.repo, fixture.claim.version.headCommit);
    writeFileSync(join(nextAttempt.worktreePath, "winner.txt"), "winner\n");
    const nextSnapshot = await getWorktreeSnapshot(nextAttempt.worktreePath);
    const nextPatch = captureImplementationPatchSync(nextAttempt.worktreePath);
    fixture.store.deliveryExecutions.prepareImplementationPublication(nextClaim, {
      repoPath: fixture.repo,
      authoritativeWorktreePath: fixture.repo,
      attemptPath: nextAttempt.worktreePath,
      attemptDev: nextAttempt.attemptIdentity.dev,
      attemptIno: nextAttempt.attemptIdentity.ino,
      attemptUid: nextAttempt.attemptIdentity.uid,
      attemptNonce: nextAttempt.attemptIdentity.nonce,
      patch: nextPatch
    });
    const nextIdentity = {
      ...nextSnapshot.identity, repositoryPath: fixture.repo, gitCommonDir: join(fixture.repo, ".git"),
      worktreePath: fixture.repo, branch: "main", headCommit: fixture.claim.version.headCommit
    };
    const nextResult = {
      branch: "main", worktreePath: fixture.repo, baseCommit: fixture.claim.version.headCommit,
      commands: [] as const, diff: nextSnapshot.diff,
      diffHash: createHash("sha256").update(nextSnapshot.diff).digest("hex"),
      changedFiles: nextSnapshot.changedFiles, identity: nextIdentity,
      manifest: nextSnapshot.manifest, manifestHash: nextSnapshot.manifestHash,
      originalChars: nextSnapshot.diff.length, truncated: false,
      files: nextSnapshot.files, additions: nextSnapshot.additions, deletions: nextSnapshot.deletions,
      diagnostics: "", output: { runId: "winner-run", summary: "winner" }
    };
    const go = join(fixture.root, "publish.go");
    const stale = startPublisherChild(fixture, "stale", fixture.claim, fixture.result, go);
    const winner = startPublisherChild(fixture, "winner", nextClaim, nextResult, go);
    for (let attempt = 0; attempt < 500
      && (!existsSync(stale.ready) || !existsSync(winner.ready)); attempt += 1) await delay(10);
    expect(existsSync(stale.ready)).toBe(true);
    expect(existsSync(winner.ready)).toBe(true);
    writeFileSync(go, "go", { flag: "wx" });

    const [staleResult, winnerResult] = await Promise.all([stale.result, winner.result]);

    expect(staleResult).toEqual({ status: "error", error: "IMPLEMENTATION_PUBLICATION_JOURNAL_STALE" });
    expect(winnerResult).toEqual({ status: "completed", unitId: fixture.unit.id });
    expect(captureImplementationPatchSync(fixture.repo).equals(nextPatch)).toBe(true);
    expect(existsSync(join(fixture.repo, "published.txt"))).toBe(false);
    expect(existsSync(join(fixture.repo, "winner.txt"))).toBe(true);
    expect(fixture.db.prepare("SELECT count(*) AS count FROM coding_evidence WHERE delivery_unit_id = ?")
      .get(fixture.unit.id)).toEqual({ count: 1 });
    expect(fixture.db.prepare(`SELECT action, count(*) AS count FROM automation_jobs
      WHERE owner_id = ? GROUP BY action ORDER BY action`).all(fixture.unit.id)).toEqual([
      { action: "implement", count: 1 }, { action: "review", count: 1 }, { action: "test", count: 1 }
    ]);
    expect(fixture.store.automationJobs.get(nextJob.id)).toMatchObject({
      status: "completed", claimToken: nextJob.claimToken
    });
    await fixture.store.reconcileImplementationPublications();
  }, 15_000);
});

function startPublisherChild(
  fixture: Awaited<ReturnType<typeof preparedFixture>>,
  name: string,
  claim: unknown,
  result: unknown,
  go: string
) {
  const inputPath = join(fixture.root, `${name}.json`);
  const ready = join(fixture.root, `${name}.ready`);
  writeFileSync(inputPath, JSON.stringify({ claim, result }), { flag: "wx" });
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { WorkflowStore } = await import(process.env.PUBLICATION_STORE_MODULE);
    const input = JSON.parse(readFileSync(process.env.PUBLICATION_INPUT, "utf8"));
    writeFileSync(process.env.PUBLICATION_READY, "ready", { flag: "wx" });
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(process.env.PUBLICATION_GO)) Atomics.wait(wait, 0, 0, 10);
    const store = new WorkflowStore(process.env.PUBLICATION_DATABASE);
    try {
      const unit = store.deliveryExecutions.publishPreparedImplementation(input.claim, input.result);
      process.stdout.write(JSON.stringify({ status: "completed", unitId: unit.id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }));
    } finally {
      store.close();
    }
  `], {
    env: {
      ...process.env,
      PUBLICATION_STORE_MODULE: new URL("./store.ts", import.meta.url).href,
      PUBLICATION_DATABASE: fixture.databasePath,
      PUBLICATION_INPUT: inputPath,
      PUBLICATION_READY: ready,
      PUBLICATION_GO: go
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const resultPromise = once(child, "exit").then(([code, signal]) => {
    if (code !== 0) throw new Error(`PUBLISHER_CHILD_FAILED:${name}:${String(code)}:${String(signal)}:${stderr}`);
    return JSON.parse(stdout) as { status: string; error?: string; unitId?: string };
  });
  return { ready, result: resultPromise };
}

async function killChildAtBarrier(child: ReturnType<typeof spawn>, barrier: string) {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 500 && !existsSync(barrier); attempt += 1) await delay(10);
  expect(existsSync(barrier), stderr).toBe(true);
  expect(child.kill("SIGKILL")).toBe(true);
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
}

async function preparedFixture(options: {
  clock?: () => Date;
  afterApply?: () => void;
  beforeRecoverySettlement?: () => void;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "implementation-publication-recovery-")));
  directories.push(root);
  const repo = join(root, "repo");
  const databasePath = join(root, "workflow.db");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "--all"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const store = new WorkflowStore(databasePath, options.clock, {
    afterApply: options.afterApply,
    beforeRecoverySettlement: options.beforeRecoverySettlement
  });
  stores.push(store);
  const project = store.createProject({
    name: "Recovery", repoPath: repo, defaultBranch: "main", allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "main", baseBranch: "main",
    worktreePath: repo, headCommit: head
  });
  const requirement = store.createRequirement({
    title: "Recover publication", businessProblem: "A publisher can crash",
    expectedOutcome: "Publication recovers", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["published"] }], dependencies: [] }
  });
  const unit = plan.units[0]!;
  const queued = store.automationJobs.enqueue({
    ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: 1,
    action: "implement", payload: {}, maxAttempts: 3
  });
  const job = store.automationJobs.leaseNext("recovery-worker", options.clock?.() ?? new Date(), 30_000)!;
  expect(job.id).toBe(queued.id);
  const claim = store.deliveryExecutions.claimImplementation(
    unit.id, "test-model", { evidenceVersion: 1, claimToken: job.claimToken }
  );
  const attempt = await createCodingAttemptWorktree(repo, head);
  writeFileSync(join(attempt.worktreePath, "published.txt"), "published\n");
  const snapshot = await getWorktreeSnapshot(attempt.worktreePath);
  const patch = captureImplementationPatchSync(attempt.worktreePath);
  store.deliveryExecutions.prepareImplementationPublication(claim, {
    repoPath: repo,
    authoritativeWorktreePath: repo,
    attemptPath: attempt.worktreePath,
    attemptDev: attempt.attemptIdentity.dev,
    attemptIno: attempt.attemptIdentity.ino,
    attemptUid: attempt.attemptIdentity.uid,
    attemptNonce: attempt.attemptIdentity.nonce,
    patch
  });
  const identity = {
    ...snapshot.identity, repositoryPath: repo, gitCommonDir: join(repo, ".git"),
    worktreePath: repo, branch: "main", headCommit: head
  };
  const result = {
    branch: "main", worktreePath: repo, baseCommit: head, commands: [] as const,
    diff: snapshot.diff,
    diffHash: createHash("sha256").update(snapshot.diff).digest("hex"),
    changedFiles: snapshot.changedFiles,
    identity,
    manifest: snapshot.manifest,
    manifestHash: snapshot.manifestHash,
    originalChars: snapshot.diff.length,
    truncated: false,
    files: snapshot.files,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    diagnostics: "",
    output: { runId: "recovery-run", summary: "published" }
  };
  return { root, repo, databasePath, store, db: (store as any).db, project, version, requirement, unit, job, claim, attempt, patch, result };
}
