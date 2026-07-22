import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationJob } from "./automation-job-repository.js";
import { WorkflowStore } from "./store.js";

const CLOCK_ISO = "2026-07-22T01:02:03.000Z";
const CLOCK = new Date(CLOCK_ISO);
const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function openStore(path: string) {
  const store = new WorkflowStore(path, () => new Date(CLOCK));
  stores.push(store);
  return store;
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "delivery-application-repository-"));
  directories.push(directory);
  const path = join(directory, "workflow.db");
  const store = openStore(path);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  databases.push(database);

  const backend = store.createProject({
    name: "Backend", repoPath: join(directory, "backend"), defaultBranch: "main",
    allowedCommands: ["npm test"], sensitivePatterns: ["CUSTOM_SECRET"]
  });
  const frontend = store.createProject({
    name: "Frontend", repoPath: join(directory, "frontend"), defaultBranch: "main",
    allowedCommands: ["npm test"], sensitivePatterns: []
  });
  const backendVersion = store.createProjectVersion({
    projectId: backend.id, name: "backend-v1", branch: "feature/backend", baseBranch: "main",
    worktreePath: join(directory, "backend-version"), headCommit: commit("backend-version")
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "frontend-v1", branch: "feature/frontend", baseBranch: "main",
    worktreePath: join(directory, "frontend-version"), headCommit: commit("frontend-version")
  });
  const requirement = store.createRequirement({
    title: "Coordinated application", businessProblem: "Two projects must settle independently",
    expectedOutcome: "An applied sibling remains applied", priority: "high",
    primaryProjectId: backend.id, primaryProjectVersionId: backendVersion.id
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
  const snapshot = store.createRequirementProjectSnapshot(requirement.id);
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot,
    plan: {
      units: [
        { projectId: backend.id, moduleIds: ["src/backend"], acceptanceCriteria: ["backend passes"] },
        { projectId: frontend.id, moduleIds: ["src/frontend"], acceptanceCriteria: ["frontend passes"] }
      ],
      dependencies: [{
        upstreamProjectId: backend.id, downstreamProjectId: frontend.id,
        releaseCondition: "automated_testing_passed"
      }]
    }
  });
  database.prepare(`UPDATE delivery_units
    SET phase = 'acceptance_delivery', status = 'ready_for_acceptance'
    WHERE requirement_id = ?`).run(requirement.id);
  return {
    path, store, database, requirement, backend, frontend, backendVersion, frontendVersion,
    backendUnit: plan.units[0]!, frontendUnit: plan.units[1]!
  };
}

function commit(seed: string) {
  return createHash("sha1").update(seed).digest("hex");
}

function leaseApplication(
  store: WorkflowStore,
  unitId: string,
  evidenceVersion = 1,
  workerId = "apply-worker",
  now = CLOCK,
  leaseMs = 60_000,
  maxAttempts = 3
) {
  const queued = store.automationJobs.enqueue({
    ownerType: "delivery_unit", ownerId: unitId, evidenceVersion,
    action: "apply", payload: {}, maxAttempts
  });
  const leased = store.automationJobs.leaseNext(workerId, now, leaseMs);
  if (!leased || leased.id !== queued.id) throw new Error("expected application lease");
  return leased;
}

function claimInput(lease: AutomationJob, seed: string, expectedEvidenceVersion = 1) {
  return {
    expectedEvidenceVersion,
    claimToken: lease.claimToken,
    baseCommit: commit(`${seed}-base`),
    preApplyCommit: commit(`${seed}-pre-apply`),
    evidenceHash: commit(`${seed}-evidence`),
    preflight: { allowed: true, checks: [{ name: "identity", passed: true }] }
  };
}

function claimApplication(
  fixture: ReturnType<typeof createFixture>,
  unit: { id: string },
  seed: string,
  store = fixture.store,
  workerId = `${seed}-worker`
) {
  const lease = leaseApplication(store, unit.id, 1, workerId);
  return store.deliveryApplications.claim(unit.id, claimInput(lease, seed));
}

function bindSource(store: WorkflowStore, claim: ReturnType<typeof claimApplication>, seed: string) {
  return store.deliveryApplications.bindSourceCommit(claim, commit(`${seed}-source`));
}

function completedResult() {
  return {
    status: "applied" as const,
    commandResults: [{ command: "npm test", exitCode: 0, stdout: "ok", stderr: "" }]
  };
}

function conflictResult(files = ["src/api.ts"]) {
  return {
    status: "conflicted" as const,
    commandResults: [],
    conflictFiles: files,
    error: "APPLICATION_CONFLICT"
  };
}

function addSecondRequirement(fixture: ReturnType<typeof createFixture>) {
  const requirement = fixture.store.createRequirement({
    title: "Second requirement", businessProblem: "Shares the same version",
    expectedOutcome: "Cannot apply concurrently", priority: "medium",
    primaryProjectId: fixture.backend.id, primaryProjectVersionId: fixture.backendVersion.id
  });
  const snapshot = fixture.store.createRequirementProjectSnapshot(requirement.id);
  const plan = fixture.store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot,
    plan: {
      units: [{ projectId: fixture.backend.id, moduleIds: ["src/second"], acceptanceCriteria: ["passes"] }],
      dependencies: []
    }
  });
  const unit = plan.units[0]!;
  fixture.database.prepare(`UPDATE delivery_units
    SET phase = 'acceptance_delivery', status = 'ready_for_acceptance' WHERE id = ?`).run(unit.id);
  return { requirement, unit };
}

describe("DeliveryApplicationRepository", () => {
  it("preserves an applied backend when frontend conflicts", () => {
    const fixture = createFixture();
    const backendClaim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    fixture.store.deliveryApplications.complete(backendClaim, completedResult());
    const frontendClaim = bindSource(fixture.store,
      claimApplication(fixture, fixture.frontendUnit, "frontend"), "frontend");
    fixture.store.deliveryApplications.complete(frontendClaim, conflictResult());

    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
    expect(fixture.store.deliveryUnits.get(fixture.frontendUnit.id)?.status).toBe("conflicted");
    expect(fixture.store.deliveryApplications.aggregate(fixture.requirement.id)).toBe("partially_applied");
    expect(fixture.store.deliveryApplications.get(backendClaim.id)).toMatchObject({
      status: "applied", resolutionStatus: "pending"
    });
    expect(fixture.store.deliveryApplications.get(frontendClaim.id)).toMatchObject({
      status: "conflicted", conflictFiles: ["src/api.ts"], error: "APPLICATION_CONFLICT",
      resolutionStatus: "not_required"
    });
  });

  it("retains the fenced lease, frozen evidence, nullable source, and write-once source commit", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    const input = claimInput(lease, "backend");
    const fresh = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, input);

    expect(fresh).toMatchObject({
      requirementId: fixture.requirement.id,
      deliveryUnitId: fixture.backendUnit.id,
      projectVersionId: fixture.backendVersion.id,
      evidenceVersion: 1,
      automationJobId: lease.id,
      automationAttempt: 1,
      leaseOwner: lease.leaseOwner,
      claimToken: lease.claimToken,
      sourceCommit: null,
      baseCommit: input.baseCommit,
      preApplyCommit: input.preApplyCommit,
      evidenceHash: input.evidenceHash,
      preflight: input.preflight,
      status: "applying",
      resolutionStatus: "pending",
      createdAt: CLOCK_ISO,
      completedAt: null
    });

    const bound = fixture.store.deliveryApplications.bindSourceCommit(fresh, commit("backend-source"));
    expect(bound.sourceCommit).toBe(commit("backend-source"));
    expect(fixture.store.deliveryApplications.bindSourceCommit(bound, commit("backend-source"))).toEqual(bound);
    expect(() => fixture.store.deliveryApplications.bindSourceCommit(bound, commit("different-source")))
      .toThrow("DELIVERY_APPLICATION_SOURCE_COMMIT_BOUND");
  });

  it("requires expected evidence and a live apply lease before claiming", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);

    expect(() => fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend", 2)
    )).toThrow("DELIVERY_APPLICATION_EVIDENCE_STALE");
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "backend"), claimToken: "not-a-lease"
    })).toThrow("DELIVERY_APPLICATION_LEASE_INVALID");
    fixture.database.prepare(`UPDATE automation_jobs
      SET created_at = ?, updated_at = ?, lease_expires_at = ? WHERE id = ?`)
      .run(new Date(CLOCK.getTime() - 1).toISOString(),
        new Date(CLOCK.getTime() - 1).toISOString(), CLOCK_ISO, lease.id);
    expect(() => fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend")
    )).toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(fixture.database.prepare("SELECT * FROM delivery_application_runs").all()).toEqual([]);
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("ready_for_acceptance");
  });

  it("never labels an evidence-bumped unit as the requested evidence", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    fixture.database.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?")
      .run(fixture.backendUnit.id);

    expect(() => fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend", 1)
    )).toThrow("DELIVERY_APPLICATION_EVIDENCE_STALE");
    expect(fixture.database.prepare("SELECT * FROM delivery_application_runs").all()).toEqual([]);
  });

  it.each(["wrong action", "wrong owner", "wrong owner type", "wrong evidence"] as const)(
    "rejects a live-looking lease with %s", (mutation) => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    if (mutation === "wrong action") fixture.database.prepare(
      "UPDATE automation_jobs SET action = 'test', dedupe_key = ? WHERE id = ?"
    ).run(`test:${fixture.backendUnit.id}:v1`, lease.id);
    if (mutation === "wrong owner") fixture.database.prepare(
      "UPDATE automation_jobs SET owner_id = ?, dedupe_key = ? WHERE id = ?"
    ).run(fixture.frontendUnit.id, `apply:${fixture.frontendUnit.id}:v1`, lease.id);
    if (mutation === "wrong owner type") fixture.database.prepare(
      "UPDATE automation_jobs SET owner_type = 'requirement', owner_id = ?, dedupe_key = ? WHERE id = ?"
    ).run(fixture.requirement.id, `apply:requirement:${fixture.requirement.id}:v1`, lease.id);
    if (mutation === "wrong evidence") fixture.database.prepare(
      "UPDATE automation_jobs SET evidence_version = 2, dedupe_key = ? WHERE id = ?"
    ).run(`apply:${fixture.backendUnit.id}:v2`, lease.id);

    expect(() => fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend")
    )).toThrow("DELIVERY_APPLICATION_LEASE_STALE");
  });

  it("fences a stale completion after re-lease and resumes the same run with its source commit", () => {
    const fixture = createFixture();
    const firstLease = leaseApplication(fixture.store, fixture.backendUnit.id, 1, "worker-one", CLOCK, 10);
    const firstClaim = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(firstLease, "backend")
    );
    const bound = fixture.store.deliveryApplications.bindSourceCommit(firstClaim, commit("backend-source"));

    const retryTime = new Date(CLOCK.getTime() + 10);
    expect(fixture.store.automationJobs.recoverExpired(retryTime)).toBe(1);
    const secondLease = fixture.store.automationJobs.leaseNext("worker-two", retryTime, 60_000)!;
    expect(secondLease).toMatchObject({ id: firstLease.id, attempt: 2 });
    const resumed = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(secondLease, "backend")
    );

    expect(resumed).toMatchObject({ id: firstClaim.id, automationAttempt: 2, sourceCommit: commit("backend-source") });
    expect(() => fixture.store.deliveryApplications.complete(bound, completedResult()))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(() => fixture.store.deliveryApplications.bindSourceCommit(bound, commit("backend-source")))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(fixture.store.deliveryApplications.complete(resumed, completedResult()).status).toBe("applied");
  });

  it("continues to attempt three after a preclaim retryable failure", () => {
    const fixture = createFixture();
    const firstLease = leaseApplication(
      fixture.store, fixture.backendUnit.id, 1, "worker-one", CLOCK, 10
    );
    const firstClaim = bindSource(fixture.store, fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(firstLease, "backend")
    ), "backend");
    const retryTime = new Date(CLOCK.getTime() + 10);
    expect(fixture.store.automationJobs.recoverExpired(retryTime)).toBe(1);
    const secondLease = fixture.store.automationJobs.leaseNext("worker-two", retryTime, 60_000)!;
    expect(secondLease).toMatchObject({ id: firstLease.id, attempt: 2 });

    expect(fixture.store.automationJobs.fail(
      secondLease.id, "worker-two", secondLease.claimToken, "temporary", true
    )).toBe(true);
    expect(fixture.store.automationJobs.get(firstLease.id)?.status).toBe("pending");
    const thirdLease = fixture.store.automationJobs.leaseNext(
      "worker-three", new Date(CLOCK.getTime() + 11), 60_000
    );
    expect(thirdLease).toMatchObject({ id: firstLease.id, attempt: 3 });
    if (!thirdLease) throw new Error("expected third application lease");
    const resumed = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(thirdLease, "backend")
    );
    const secondClaim = {
      ...firstClaim, automationAttempt: 2, leaseOwner: "worker-two", claimToken: secondLease.claimToken
    };

    expect(resumed).toMatchObject({ id: firstClaim.id, automationAttempt: 3, sourceCommit: commit("backend-source") });
    expect(() => fixture.store.deliveryApplications.complete(firstClaim, completedResult()))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(() => fixture.store.deliveryApplications.complete(secondClaim, completedResult()))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(fixture.store.deliveryApplications.complete(resumed, completedResult()).status).toBe("applied");
  });

  it("continues to attempt three after a preclaim nonfinal expiry", () => {
    const fixture = createFixture();
    const firstLease = leaseApplication(
      fixture.store, fixture.backendUnit.id, 1, "worker-one", CLOCK, 10
    );
    const firstClaim = bindSource(fixture.store, fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(firstLease, "backend")
    ), "backend");
    const secondTime = new Date(CLOCK.getTime() + 10);
    expect(fixture.store.automationJobs.recoverExpired(secondTime)).toBe(1);
    const secondLease = fixture.store.automationJobs.leaseNext("worker-two", secondTime, 10)!;
    expect(secondLease).toMatchObject({ id: firstLease.id, attempt: 2 });

    const thirdTime = new Date(CLOCK.getTime() + 20);
    expect(fixture.store.automationJobs.recoverExpired(thirdTime)).toBe(1);
    expect(fixture.store.automationJobs.get(firstLease.id)?.status).toBe("pending");
    const thirdLease = fixture.store.automationJobs.leaseNext("worker-three", thirdTime, 60_000);
    expect(thirdLease).toMatchObject({ id: firstLease.id, attempt: 3 });
    if (!thirdLease) throw new Error("expected third application lease");
    const resumed = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(thirdLease, "backend")
    );
    const secondClaim = {
      ...firstClaim, automationAttempt: 2, leaseOwner: "worker-two", claimToken: secondLease.claimToken
    };

    expect(resumed).toMatchObject({ id: firstClaim.id, automationAttempt: 3, sourceCommit: commit("backend-source") });
    expect(() => fixture.store.deliveryApplications.complete(firstClaim, completedResult()))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(() => fixture.store.deliveryApplications.complete(secondClaim, completedResult()))
      .toThrow("DELIVERY_APPLICATION_LEASE_STALE");
    expect(fixture.store.deliveryApplications.complete(resumed, completedResult()).status).toBe("applied");
  });

  it("atomically reconciles a nonretryable apply failure from another connection", () => {
    const fixture = createFixture();
    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    const other = openStore(fixture.path);

    expect(other.automationJobs.fail(
      claim.automationJobId, claim.leaseOwner, claim.claimToken, "fatal", false
    )).toBe(true);
    expect(other.automationJobs.get(claim.automationJobId)?.status).toBe("failed");
    expect(other.deliveryApplications.get(claim.id)).toMatchObject({
      status: "failed", resolutionStatus: "pending", error: "DELIVERY_APPLICATION_JOB_TERMINAL"
    });
    expect(other.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("failed");
  });

  it("reconciles final-attempt expiry without releasing uncertain worktree ownership", () => {
    const fixture = createFixture();
    const lease = leaseApplication(
      fixture.store, fixture.backendUnit.id, 1, "final-worker", CLOCK, 10, 1
    );
    const claim = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend")
    );

    expect(fixture.store.automationJobs.recoverExpired(new Date(CLOCK.getTime() + 10))).toBe(1);
    expect(fixture.store.automationJobs.get(lease.id)?.status).toBe("failed");
    expect(fixture.store.deliveryApplications.get(claim.id)).toMatchObject({
      status: "failed", resolutionStatus: "pending"
    });
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("failed");
  });

  it("reconciles cancellation without discarding a possibly mutated target", () => {
    const fixture = createFixture();
    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");

    expect(fixture.store.automationJobs.cancelByOwnerVersion(fixture.backendUnit.id, 1)).toBe(1);
    expect(fixture.store.automationJobs.get(claim.automationJobId)?.status).toBe("canceled");
    expect(fixture.store.deliveryApplications.get(claim.id)).toMatchObject({
      status: "failed", resolutionStatus: "pending"
    });
  });

  it("reconciles a newer apply attempt that fails before application takeover", () => {
    const fixture = createFixture();
    const firstLease = leaseApplication(
      fixture.store, fixture.backendUnit.id, 1, "worker-one", CLOCK, 10
    );
    const claim = bindSource(fixture.store, fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(firstLease, "backend")
    ), "backend");
    const retryTime = new Date(CLOCK.getTime() + 10);

    expect(fixture.store.automationJobs.recoverExpired(retryTime)).toBe(1);
    const secondLease = fixture.store.automationJobs.leaseNext("worker-two", retryTime, 60_000)!;
    expect(secondLease).toMatchObject({ id: firstLease.id, attempt: 2 });
    expect(fixture.store.automationJobs.fail(
      secondLease.id, "worker-two", secondLease.claimToken, "fatal", false
    )).toBe(true);

    expect(fixture.store.deliveryApplications.get(claim.id)).toMatchObject({
      status: "failed", resolutionStatus: "pending", error: "DELIVERY_APPLICATION_JOB_TERMINAL"
    });
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("failed");
  });

  it("reconciles a newer apply attempt canceled before application takeover", () => {
    const fixture = createFixture();
    const firstLease = leaseApplication(
      fixture.store, fixture.backendUnit.id, 1, "worker-one", CLOCK, 10
    );
    const claim = bindSource(fixture.store, fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(firstLease, "backend")
    ), "backend");
    const retryTime = new Date(CLOCK.getTime() + 10);

    expect(fixture.store.automationJobs.recoverExpired(retryTime)).toBe(1);
    const secondLease = fixture.store.automationJobs.leaseNext("worker-two", retryTime, 60_000)!;
    expect(secondLease).toMatchObject({ id: firstLease.id, attempt: 2 });
    expect(fixture.store.automationJobs.cancelByOwnerVersion(fixture.backendUnit.id, 1)).toBe(1);

    expect(fixture.store.deliveryApplications.get(claim.id)).toMatchObject({
      status: "failed", resolutionStatus: "pending", error: "DELIVERY_APPLICATION_JOB_TERMINAL"
    });
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("failed");
  });

  it("finalizes an exact application job left incomplete across restart recovery", () => {
    const fixture = createFixture();
    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend", fixture.store, "restart-worker"), "backend");
    const applied = fixture.store.deliveryApplications.complete(claim, completedResult());
    expect(fixture.store.automationJobs.get(claim.automationJobId)?.status).toBe("completed");
    const restarted = openStore(fixture.path);

    expect(restarted.automationJobs.recoverExpired(new Date(CLOCK.getTime() + 60_000))).toBe(0);
    expect(restarted.automationJobs.get(claim.automationJobId)).toMatchObject({
      status: "completed", claimToken: claim.claimToken
    });
    expect(restarted.deliveryApplications.get(applied.id)).toMatchObject({
      status: "applied", resolutionStatus: "pending"
    });
    expect(restarted.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
  });

  it("requires a prepared source for applied or conflicted settlement but permits clean preflight failure", () => {
    const fixture = createFixture();
    const backendClaim = claimApplication(fixture, fixture.backendUnit, "backend");
    expect(() => fixture.store.deliveryApplications.complete(backendClaim, completedResult()))
      .toThrow("DELIVERY_APPLICATION_SOURCE_COMMIT_REQUIRED");
    const frontendClaim = claimApplication(fixture, fixture.frontendUnit, "frontend");
    expect(() => fixture.store.deliveryApplications.complete(frontendClaim, conflictResult()))
      .toThrow("DELIVERY_APPLICATION_SOURCE_COMMIT_REQUIRED");

    const failed = fixture.store.deliveryApplications.complete(backendClaim, {
      status: "failed", worktreeState: "clean", commandResults: [], error: "APPLICATION_PREFLIGHT_FAILED"
    });
    expect(failed).toMatchObject({ status: "failed", sourceCommit: null, resolutionStatus: "not_required" });
  });

  it("keeps an applied version occupied until explicit committed resolution", () => {
    const fixture = createFixture();
    const second = addSecondRequirement(fixture);
    const firstClaim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "first"), "first");
    const applied = fixture.store.deliveryApplications.complete(firstClaim, completedResult());
    const other = openStore(fixture.path);
    const secondLease = leaseApplication(other, second.unit.id, 1, "second-worker");

    expect(() => other.deliveryApplications.claim(
      second.unit.id, claimInput(secondLease, "second")
    )).toThrow("PROJECT_VERSION_APPLICATION_BUSY");
    const resolved = fixture.store.deliveryApplications.resolve(applied, "committed");
    expect(resolved).toMatchObject({ resolutionStatus: "committed", status: "applied" });
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
    expect(fixture.store.deliveryApplications.aggregate(fixture.requirement.id)).toBe("partially_applied");
    expect(other.deliveryApplications.claim(second.unit.id, claimInput(secondLease, "second")).status)
      .toBe("applying");
  });

  it.each(["committed", "reverted"] as const)("allows one fenced %s resolution only", (resolution) => {
    const fixture = createFixture();
    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    const applied = fixture.store.deliveryApplications.complete(claim, completedResult());
    const resolved = fixture.store.deliveryApplications.resolve(applied, resolution);

    expect(resolved.resolutionStatus).toBe(resolution);
    expect(resolved.resolvedAt).toBe(CLOCK_ISO);
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status)
      .toBe(resolution === "committed" ? "applied" : "ready_for_acceptance");
    expect(fixture.store.deliveryApplications.aggregate(fixture.requirement.id))
      .toBe(resolution === "committed" ? "partially_applied" : "awaiting_acceptance");
    expect(() => fixture.store.deliveryApplications.resolve(applied, resolution))
      .toThrow("DELIVERY_APPLICATION_RESOLUTION_STALE");
  });

  it("fences resolution against every persisted application identity field", () => {
    const fixture = createFixture();
    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    const applied = fixture.store.deliveryApplications.complete(claim, completedResult());

    expect(() => fixture.store.deliveryApplications.resolve({
      ...applied, projectVersionId: fixture.frontendVersion.id
    }, "committed")).toThrow("DELIVERY_APPLICATION_RESOLUTION_STALE");
    expect(() => fixture.store.deliveryApplications.resolve({
      ...applied, automationAttempt: applied.automationAttempt + 1
    }, "committed")).toThrow("DELIVERY_APPLICATION_RESOLUTION_STALE");
    expect(fixture.store.deliveryApplications.get(applied.id)?.resolutionStatus).toBe("pending");
  });

  it.each(["conflicted", "failed"] as const)("releases version ownership after clean %s settlement", (status) => {
    const fixture = createFixture();
    const second = addSecondRequirement(fixture);
    let firstClaim = claimApplication(fixture, fixture.backendUnit, "first");
    if (status === "conflicted") firstClaim = bindSource(fixture.store, firstClaim, "first");
    fixture.store.deliveryApplications.complete(firstClaim, status === "conflicted"
      ? conflictResult()
      : { status: "failed", worktreeState: "clean", commandResults: [], error: "APPLICATION_PREFLIGHT_FAILED" });
    const secondLease = leaseApplication(fixture.store, second.unit.id, 1, "second-worker");

    expect(fixture.store.deliveryApplications.claim(
      second.unit.id, claimInput(secondLease, "second")
    ).status).toBe("applying");
  });

  it("retains a dirty failed version until it is explicitly reverted", () => {
    const fixture = createFixture();
    const second = addSecondRequirement(fixture);
    const firstClaim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "first"), "first");
    const failed = fixture.store.deliveryApplications.complete(firstClaim, {
      status: "failed", worktreeState: "dirty_or_uncertain", error: "APPLICATION_TEST_FAILED"
    });
    const secondLease = leaseApplication(fixture.store, second.unit.id, 1, "second-worker");

    expect(failed.resolutionStatus).toBe("pending");
    expect(() => fixture.store.deliveryApplications.claim(
      second.unit.id, claimInput(secondLease, "second")
    )).toThrow("PROJECT_VERSION_APPLICATION_BUSY");
    fixture.store.deliveryApplications.resolve(failed, "reverted");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("ready_for_acceptance");
    expect(fixture.store.deliveryApplications.claim(
      second.unit.id, claimInput(secondLease, "second")
    ).status).toBe("applying");
  });

  it("rejects stale and mismatched fenced settlements without changing siblings", () => {
    const fixture = createFixture();
    const backendClaim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    fixture.store.deliveryApplications.complete(backendClaim, completedResult());
    const frontendClaim = claimApplication(fixture, fixture.frontendUnit, "frontend");

    expect(() => fixture.store.deliveryApplications.complete(backendClaim, conflictResult()))
      .toThrow("DELIVERY_APPLICATION_RUN_SETTLED");
    const mismatched = { ...frontendClaim, evidenceVersion: 2 };
    expect(() => fixture.store.deliveryApplications.complete(mismatched, {
      status: "failed", worktreeState: "clean", error: "FAILED"
    })).toThrow("DELIVERY_APPLICATION_CLAIM_STALE");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
    expect(fixture.store.deliveryApplications.get(frontendClaim.id)?.status).toBe("applying");
  });

  it("redacts frozen sensitive patterns before persisting application evidence", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    const claim = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "backend"), preflight: { detail: "token=CUSTOM_SECRET" }
    });
    fixture.store.deliveryApplications.complete(claim, {
      status: "failed", worktreeState: "clean", error: "CUSTOM_SECRET failed",
      commandResults: [{ stdout: "CUSTOM_SECRET", stderr: "" }]
    });

    const raw = fixture.database.prepare(`SELECT preflight_json, command_results_json, error
      FROM delivery_application_runs WHERE id = ?`).get(claim.id);
    expect(JSON.stringify(raw)).not.toContain("CUSTOM_SECRET");
    expect(JSON.stringify(raw)).toContain("[REDACTED]");
  });

  it("rejects accessors, serialization hooks, and proxy traps without invoking caller methods", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    let invoked = false;
    const nestedAccessor = {};
    Object.defineProperty(nestedAccessor, "detail", {
      enumerable: true,
      get() { invoked = true; return "unsafe"; }
    });
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "accessor"), preflight: nestedAccessor
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");
    expect(invoked).toBe(false);

    const ownHook = { detail: "safe" };
    Object.defineProperty(ownHook, "toJSON", {
      enumerable: false,
      value() { invoked = true; return { unsafe: true }; }
    });
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "own-hook"), preflight: ownHook
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");
    const inheritedHook = Object.create({
      toJSON() { invoked = true; return { unsafe: true }; }
    });
    inheritedHook.detail = "safe";
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "inherited-hook"), preflight: inheritedHook
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");

    const trapped = new Proxy(claimInput(lease, "proxy"), {
      getPrototypeOf(): never { throw new Error("PROTOTYPE_TRAP"); }
    });
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, trapped))
      .toThrow("DELIVERY_APPLICATION_CLAIM_INVALID");
    const nestedTrap = new Proxy({ detail: "safe" }, {
      ownKeys(): never { throw new Error("OWN_KEYS_TRAP"); }
    });
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "nested-proxy"), preflight: nestedTrap
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");
    let getTrapInvoked = false;
    const getTrap = new Proxy({ detail: "safe" }, {
      get(): never { getTrapInvoked = true; throw new Error("GET_TRAP"); }
    });
    const trapSafeClaim = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "valid"), preflight: getTrap
    });
    expect(trapSafeClaim.preflight).toEqual({ detail: "safe" });
    expect(getTrapInvoked).toBe(false);
    const claim = trapSafeClaim;
    const revoked = Proxy.revocable({
      status: "failed" as const, worktreeState: "clean" as const, error: "FAILED"
    }, {});
    revoked.revoke();
    expect(() => fixture.store.deliveryApplications.complete(claim, revoked.proxy))
      .toThrow("DELIVERY_APPLICATION_COMPLETION_INVALID");
    const trappedResults = new Proxy([] as unknown[], {
      ownKeys(): never { throw new Error("RESULT_KEYS_TRAP"); }
    });
    expect(() => fixture.store.deliveryApplications.complete(claim, {
      status: "failed", worktreeState: "clean", error: "FAILED", commandResults: trappedResults
    })).toThrow("DELIVERY_APPLICATION_COMMAND_RESULTS_INVALID");
    expect(fixture.store.deliveryApplications.get(claim.id)?.status).toBe("applying");
    let arrayGetInvoked = false;
    const safeResults = new Proxy([{ command: "test", exitCode: 0 }], {
      get(): never { arrayGetInvoked = true; throw new Error("ARRAY_GET_TRAP"); }
    });
    const frontendClaim = claimApplication(fixture, fixture.frontendUnit, "frontend");
    expect(fixture.store.deliveryApplications.complete(frontendClaim, {
      status: "failed", worktreeState: "clean", error: "FAILED", commandResults: safeResults
    }).status).toBe("failed");
    expect(arrayGetInvoked).toBe(false);
    expect(invoked).toBe(false);
  });

  it("bounds structured evidence and rolls invalid settlement back", () => {
    const fixture = createFixture();
    const lease = leaseApplication(fixture.store, fixture.backendUnit.id);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "backend"), preflight: cyclic
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput(lease, "backend"), preflight: { detail: "x".repeat(1_048_577) }
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_LIMIT");

    const claim = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput(lease, "backend")
    );
    expect(() => fixture.store.deliveryApplications.complete(claim, {
      status: "failed", worktreeState: "clean",
      commandResults: [{ output: "x".repeat(1_048_577) }], error: "FAILED"
    })).toThrow("DELIVERY_APPLICATION_COMMAND_RESULTS_LIMIT");
    expect(fixture.store.deliveryApplications.get(claim.id)?.status).toBe("applying");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applying");
  });

  it("keeps schema ownership, durable occupancy, and terminal evidence immutable", () => {
    const fixture = createFixture();
    const sql = (fixture.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delivery_application_runs'"
    ).get() as { sql: string }).sql;
    expect(sql).toContain("source_commit TEXT");
    expect(sql).not.toContain("source_commit TEXT NOT NULL");
    expect(sql).toContain("FOREIGN KEY(automation_job_id) REFERENCES automation_jobs(id)");
    const indexes = fixture.database.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'delivery_application_runs'`).all() as Array<{ name: string; sql: string }>;
    expect(indexes.find((index) => index.name === "idx_delivery_application_version_active")?.sql)
      .toContain("resolution_status = 'pending'");

    const claim = bindSource(fixture.store,
      claimApplication(fixture, fixture.backendUnit, "backend"), "backend");
    expect(() => fixture.database.prepare(
      "UPDATE delivery_application_runs SET delivery_unit_id = ? WHERE id = ?"
    ).run(fixture.frontendUnit.id, claim.id)).toThrow("DELIVERY_APPLICATION_IDENTITY_IMMUTABLE");
    expect(() => fixture.database.prepare("DELETE FROM delivery_application_runs WHERE id = ?")
      .run(claim.id)).toThrow("DELIVERY_APPLICATION_IMMUTABLE");
    const settled = fixture.store.deliveryApplications.complete(claim, completedResult());
    expect(() => fixture.database.prepare(`UPDATE delivery_application_runs
      SET command_results_json = '[]' WHERE id = ?`).run(settled.id))
      .toThrow("DELIVERY_APPLICATION_SETTLED_IMMUTABLE");
  });
});
