import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { DeliveryApplicationRun } from "./delivery-application-repository.js";
import type { DeliveryExecutionSuccess } from "./delivery-execution-repository.js";
import type { DeliveryQualityKind } from "./delivery-quality-repository.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function createAcceptanceFixture(options: { frontendQuality?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "delivery-acceptance-route-"));
  directories.push(directory);
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  stores.push(store);
  const projects = [0, 1].map((position) => store.createProject({
    name: `Acceptance project ${position}`,
    repoPath: join(directory, `project-${position}`),
    defaultBranch: "main",
    allowedCommands: [],
    sensitivePatterns: ["secret-"]
  }));
  const versions = projects.map((project, position) => store.createProjectVersion({
    projectId: project.id,
    name: "v1",
    branch: `feature/${position}`,
    baseBranch: "main",
    worktreePath: join(directory, `worktree-${position}`),
    headCommit: `head-${position}`
  }));
  const requirement = store.createRequirement({
    title: "Accept coordinated delivery",
    businessProblem: "Both project versions must be applied in order",
    expectedOutcome: "A human accepts the aggregate delivery",
    priority: "high",
    primaryProjectId: projects[0]!.id,
    primaryProjectVersionId: versions[0]!.id
  });
  store.replaceRequirementProjects(requirement.id, projects.map((project, position) => ({
    projectId: project.id,
    projectVersionId: versions[position]!.id,
    role: position === 0 ? "primary" as const : "collaborator" as const,
    usage: "delivery" as const,
    deliveryRequired: true,
    moduleMode: "all" as const,
    moduleIds: [],
    position
  })));
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: {
      units: projects.map((project, position) => ({
        projectId: project.id,
        moduleIds: [`src/p${position}`],
        acceptanceCriteria: [`project ${position} passes`]
      })),
      dependencies: [{
        upstreamProjectId: projects[0]!.id,
        downstreamProjectId: projects[1]!.id,
        releaseCondition: "automated_testing_passed" as const
      }]
    }
  });
  const [backend, frontend] = plan.units;
  completeImplementation(store, backend!.id);
  passQuality(store, backend!.id);
  completeImplementation(store, frontend!.id);
  if (options.frontendQuality !== false) passQuality(store, frontend!.id);
  store.updateRequirementState(requirement.id, "implementation", "ai_ready");
  return { store, databasePath, projects, versions, requirement, backend: backend!, frontend: frontend! };
}

function completeImplementation(store: WorkflowStore, unitId: string) {
  const claim = store.deliveryExecutions.claimImplementation(unitId, "route-test-model");
  const version = claim.deliveryUnit.evidenceVersion;
  const completion: DeliveryExecutionSuccess = {
    branch: `ai/${unitId}`,
    worktreePath: `/tmp/${unitId}`,
    baseCommit: "base",
    commands: [],
    diff: `diff-${unitId}-v${version}`,
    diffHash: `hash-${unitId}-v${version}`,
    changedFiles: [],
    identity: {
      repositoryPath: `/tmp/source-${unitId}`,
      gitCommonDir: `/tmp/source-${unitId}/.git`,
      worktreePath: `/tmp/${unitId}`,
      branch: `ai/${unitId}`,
      headCommit: "base"
    },
    manifest: { version: 1, entries: [] },
    manifestHash: `manifest-${unitId}-v${version}`,
    originalChars: 4,
    truncated: false,
    files: [],
    additions: 1,
    deletions: 0,
    diagnostics: "",
    output: {}
  };
  store.deliveryExecutions.completeImplementation(claim, completion);
}

function passQuality(store: WorkflowStore, unitId: string) {
  for (const kind of ["code_review", "automated_testing"] as DeliveryQualityKind[]) {
    const version = store.deliveryUnits.get(unitId)!.evidenceVersion;
    const claim = store.deliveryQuality.claim(unitId, version, kind, `${kind}-${unitId}-v${version}`);
    if (claim.status !== "running") throw new Error("expected running quality claim");
    store.deliveryQuality.complete(claim, { result: "passed", content: { result: "passed" } });
  }
}

function acceptInStore(fixture: ReturnType<typeof createAcceptanceFixture>) {
  return fixture.store.deliveryCoordination.acceptRequirement({
    requirementId: fixture.requirement.id,
    actor: "local-human",
    comment: "Business acceptance passed"
  });
}

function settleApplication(
  fixture: ReturnType<typeof createAcceptanceFixture>,
  unitId: string,
  status: "applied" | "conflicted"
): DeliveryApplicationRun {
  const lease = fixture.store.automationJobs.leaseNext("application-route-worker", new Date(), 60_000);
  if (!lease || lease.ownerId !== unitId || lease.action !== "apply") {
    throw new Error("expected application lease");
  }
  let claim = fixture.store.deliveryApplications.claim(unitId, {
    expectedEvidenceVersion: lease.evidenceVersion,
    claimToken: lease.claimToken,
    baseCommit: "b".repeat(40),
    preApplyCommit: "c".repeat(40),
    evidenceHash: "d".repeat(64),
    preflight: { allowed: true, token: "secret-preflight" }
  });
  claim = fixture.store.deliveryApplications.bindSourceCommit(claim, "e".repeat(40));
  return fixture.store.deliveryApplications.complete(claim, status === "applied"
    ? { status: "applied", commandResults: [{ command: "git", stdout: "ok" }] }
    : {
      status: "conflicted",
      conflictFiles: ["src/conflict.ts"],
      commandResults: [{ command: "git", stderr: "secret-command" }],
      error: "APPLICATION_CONFLICT secret-error"
    });
}

describe("delivery acceptance routes", () => {
  it("accepts aggregate delivery with the server-owned actor and returns the first persistent job", async () => {
    const fixture = createAcceptanceFixture();
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "  Business checks passed  ", actor: "spoofed-client" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      acceptance: {
        requirementId: fixture.requirement.id,
        actor: "local-human",
        comment: "Business checks passed",
        plan: [
          { unitId: fixture.backend.id, evidenceVersion: 1 },
          { unitId: fixture.frontend.id, evidenceVersion: 1 }
        ]
      },
      applicationJob: {
        id: expect.any(String),
        action: "apply",
        ownerId: fixture.backend.id,
        evidenceVersion: 1,
        status: "pending"
      }
    });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toContainEqual(expect.objectContaining({
      stage: "acceptance_delivery",
      actor: "local-human",
      comment: "Business checks passed"
    }));
    for (const internalField of ["claimToken", "leaseOwner", "leaseExpiresAt", "dedupeKey", "payload", "lastError"]) {
      expect(response.body).not.toContain(internalField);
    }
    await app.close();
  });

  it("retries only the conflicted unit without resetting its applied sibling", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    const app = await buildApp(fixture.store);

    const response = await app.inject({
      method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "  Conflict repaired  ", actor: "spoofed-client" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      retry: {
        deliveryUnitId: fixture.frontend.id,
        requirementId: fixture.requirement.id,
        retryAttempt: 1,
        jobId: expect.any(String)
      },
      applicationJob: {
        action: "apply",
        ownerId: fixture.frontend.id,
        status: "pending"
      }
    });
    expect(fixture.store.deliveryUnits.get(fixture.backend.id)).toMatchObject({ status: "applied" });
    expect(fixture.store.deliveryCoordination.listApplicationRetryAudits(fixture.frontend.id)).toEqual([
      expect.objectContaining({ actor: "local-human", reason: "Conflict repaired", attempt: 1 })
    ]);
    for (const internalField of ["claimToken", "leaseOwner", "leaseExpiresAt", "dedupeKey", "payload", "lastError"]) {
      expect(response.body).not.toContain(internalField);
    }
    await app.close();
  });

  it("lists sanitized application runs and retry audits after reopening the Store", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    fixture.store.deliveryCoordination.retryApplication({
      unitId: fixture.frontend.id,
      actor: "local-human",
      reason: "Conflict repaired"
    });
    stores.splice(stores.indexOf(fixture.store), 1);
    fixture.store.close();
    const reopened = new WorkflowStore(fixture.databasePath);
    stores.push(reopened);
    const app = await buildApp(reopened);

    const response = await app.inject({
      method: "GET",
      url: `/api/delivery-units/${fixture.frontend.id}/application-runs`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runs: [expect.objectContaining({
        deliveryUnitId: fixture.frontend.id,
        automationAttempt: 1,
        sourceCommit: "e".repeat(40),
        baseCommit: "b".repeat(40),
        preApplyCommit: "c".repeat(40),
        evidenceHash: "d".repeat(64),
        preflight: { allowed: true, token: "[REDACTED]" },
        commandResults: [{ command: "git", stderr: "[REDACTED]command" }],
        conflictFiles: ["src/conflict.ts"],
        error: "APPLICATION_CONFLICT [REDACTED]error",
        status: "conflicted",
        resolutionStatus: "not_required",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        completedAt: expect.any(String)
      })],
      retries: [expect.objectContaining({
        deliveryUnitId: fixture.frontend.id,
        target: "application",
        attempt: 1,
        actor: "local-human",
        reason: "Conflict repaired",
        createdAt: expect.any(String)
      })]
    });
    expect(response.body).not.toContain("claimToken");
    expect(response.body).not.toContain("leaseOwner");
    await app.close();
  });

  it("validates human comments and retry reasons without accepting client-owned actors", async () => {
    const fixture = createAcceptanceFixture();
    const app = await buildApp(fixture.store);

    for (const payload of [{}, { comment: " " }, { comment: "x".repeat(4097) }, { comment: "ok\0bad" }]) {
      const response = await app.inject({ method: "POST",
        url: `/api/requirements/${fixture.requirement.id}/accept-delivery`, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "VALIDATION_ERROR" });
    }
    for (const payload of [{}, { reason: " " }, { reason: "x".repeat(4097) }, { reason: "ok\0bad" }]) {
      const response = await app.inject({ method: "POST",
        url: `/api/delivery-units/${fixture.frontend.id}/application/retry`, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "VALIDATION_ERROR" });
    }
    await app.close();
  });

  it("returns 404 for missing requirement and delivery units", async () => {
    const fixture = createAcceptanceFixture();
    const app = await buildApp(fixture.store);

    const acceptance = await app.inject({ method: "POST",
      url: "/api/requirements/missing/accept-delivery", payload: { comment: "checked" } });
    expect(acceptance.statusCode).toBe(404);
    expect(acceptance.json()).toEqual({ error: "NOT_FOUND", detailCode: "REQUIREMENT_NOT_FOUND" });
    for (const request of [{ method: "POST" as const, url: "/api/delivery-units/missing/application/retry",
      payload: { reason: "repair" } },
    { method: "GET" as const, url: "/api/delivery-units/missing/application-runs" }]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "NOT_FOUND", detailCode: "DELIVERY_UNIT_NOT_FOUND" });
    }
    await app.close();
  });

  it("maps incomplete aggregate quality to QUALITY_NOT_COMPLETE", async () => {
    const fixture = createAcceptanceFixture({ frontendQuality: false });
    const app = await buildApp(fixture.store);

    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Cannot bypass aggregate quality" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "QUALITY_NOT_COMPLETE",
      detailCode: "DELIVERY_UNIT_NOT_VERIFIED"
    });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toEqual([]);
    await app.close();
  });

  it("maps potentially stale evidence to STALE_DELIVERY_EVIDENCE", async () => {
    const fixture = createAcceptanceFixture();
    (fixture.store as any).db.prepare("UPDATE delivery_units SET status = 'potentially_stale' WHERE id = ?")
      .run(fixture.frontend.id);
    const app = await buildApp(fixture.store);

    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Cannot accept stale evidence" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "STALE_DELIVERY_EVIDENCE" });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toEqual([]);
    await app.close();
  });

  it("maps duplicate acceptance to APPLICATION_ALREADY_ACTIVE", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    const app = await buildApp(fixture.store);

    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Duplicate acceptance" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "APPLICATION_ALREADY_ACTIVE",
      detailCode: "DELIVERY_ACCEPTANCE_ALREADY_RECORDED"
    });
    await app.close();
  });

  it("maps ineligible and conflicting retry identities to APPLICATION_RETRY_NOT_ALLOWED", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    const app = await buildApp(fixture.store);

    const applied = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.backend.id}/application/retry`,
      payload: { reason: "Applied units are terminal" } });
    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toEqual({
      error: "APPLICATION_RETRY_NOT_ALLOWED",
      detailCode: "DELIVERY_APPLICATION_RETRY_NOT_ELIGIBLE"
    });

    const input = { reason: "Conflict repaired" };
    const first = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`, payload: input });
    const replay = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`, payload: input });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().retry.jobId).toBe(first.json().retry.jobId);
    const conflict = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "A different repair identity" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: "APPLICATION_RETRY_NOT_ALLOWED",
      detailCode: "DELIVERY_APPLICATION_RETRY_AUDIT_CONFLICT"
    });
    await app.close();
  });

  it("rejects acceptance when a participating project version has an active application", async () => {
    const fixture = createAcceptanceFixture();
    const blocker = fixture.store.createRequirement({
      title: "Occupy shared version",
      businessProblem: "Another application owns the version",
      expectedOutcome: "Concurrent application is rejected",
      priority: "high",
      primaryProjectId: fixture.projects[0]!.id,
      primaryProjectVersionId: fixture.versions[0]!.id
    });
    fixture.store.replaceRequirementProjects(blocker.id, [{
      projectId: fixture.projects[0]!.id,
      projectVersionId: fixture.versions[0]!.id,
      role: "primary",
      usage: "delivery",
      deliveryRequired: true,
      moduleMode: "all",
      moduleIds: [],
      position: 0
    }]);
    const blockerPlan = fixture.store.deliveryUnits.createPlan({
      requirementId: blocker.id,
      snapshot: fixture.store.createRequirementProjectSnapshot(blocker.id),
      plan: { units: [{ projectId: fixture.projects[0]!.id, moduleIds: [], acceptanceCriteria: ["done"] }],
        dependencies: [] }
    });
    const blockerUnit = blockerPlan.units[0]!;
    completeImplementation(fixture.store, blockerUnit.id);
    passQuality(fixture.store, blockerUnit.id);
    fixture.store.updateRequirementState(blocker.id, "implementation", "ai_ready");
    fixture.store.deliveryCoordination.acceptRequirement({
      requirementId: blocker.id,
      actor: "local-human",
      comment: "Start the blocking application"
    });
    const blockerLease = fixture.store.automationJobs.leaseNext("blocking-application", new Date(), 60_000)!;
    expect(blockerLease.ownerId).toBe(blockerUnit.id);
    fixture.store.deliveryApplications.claim(blockerUnit.id, {
      expectedEvidenceVersion: blockerLease.evidenceVersion,
      claimToken: blockerLease.claimToken,
      baseCommit: "1".repeat(40),
      preApplyCommit: "2".repeat(40),
      evidenceHash: "3".repeat(64),
      preflight: { allowed: true }
    });
    const app = await buildApp(fixture.store);

    const busyDetail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(busyDetail.allowedActions).toEqual([]);

    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Version checked" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "PROJECT_VERSION_APPLICATION_BUSY" });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toEqual([]);
    await app.close();
  });

  it("does not expose unexpected internal error messages", async () => {
    const fixture = createAcceptanceFixture();
    (fixture.store.deliveryCoordination as any).retryApplication = () => {
      throw new Error("database password=super-secret-value");
    };
    const app = await buildApp(fixture.store);

    const response = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Attempt recovery" } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("super-secret-value");
    await app.close();
  });

  it("serializes concurrent HTTP acceptance across two Stores", async () => {
    const fixture = createAcceptanceFixture();
    const second = new WorkflowStore(fixture.databasePath);
    stores.push(second);
    const firstApp = await buildApp(fixture.store);
    const secondApp = await buildApp(second);
    const request = {
      method: "POST" as const,
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "One authoritative acceptance" }
    };

    const responses = await Promise.all([firstApp.inject(request), secondApp.inject(request)]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    expect(responses.find((response) => response.statusCode === 409)!.json()).toEqual({
      error: "APPLICATION_ALREADY_ACTIVE",
      detailCode: "DELIVERY_ACCEPTANCE_ALREADY_RECORDED"
    });
    expect(fixture.store.listApprovals(fixture.requirement.id)
      .filter((approval) => approval.stage === "acceptance_delivery")).toHaveLength(1);
    expect(fixture.store.automationJobs.listPending().filter((job) => job.action === "apply")).toHaveLength(1);
    await firstApp.close();
    await secondApp.close();
  });

  it("exposes accept_delivery only while aggregate acceptance is server-authorized", async () => {
    const fixture = createAcceptanceFixture();
    const app = await buildApp(fixture.store);

    const ready = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(ready.allowedActions).toEqual([{ type: "accept_delivery", commentRequired: true }]);

    (fixture.store as any).db.prepare("UPDATE delivery_units SET status = 'potentially_stale' WHERE id = ?")
      .run(fixture.frontend.id);
    const stale = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(stale.allowedActions).toEqual([]);

    (fixture.store as any).db.prepare("UPDATE delivery_units SET status = 'ready_for_acceptance' WHERE id = ?")
      .run(fixture.frontend.id);
    await app.inject({ method: "POST", url: `/api/requirements/${fixture.requirement.id}/automation/pause`,
      payload: { reason: "Acceptance paused" } });
    const paused = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(paused.allowedActions).toEqual([]);
    expect(paused.deliveryUnits.every((unit: any) => unit.allowedActions.length === 0)).toBe(true);
    await app.close();

    const incomplete = createAcceptanceFixture({ frontendQuality: false });
    const incompleteApp = await buildApp(incomplete.store);
    const qualityIncomplete = (await incompleteApp.inject({ method: "GET",
      url: `/api/requirements/${incomplete.requirement.id}` })).json();
    expect(qualityIncomplete.allowedActions).toEqual([]);
    await incompleteApp.close();
  });

  it("exposes retry_application only for the recoverable settled unit", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    const app = await buildApp(fixture.store);

    const failed = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(failed.allowedActions).toEqual([]);
    expect(failed.deliveryUnits.find((unit: any) => unit.id === fixture.backend.id).allowedActions).toEqual([]);
    expect(failed.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([
      { type: "retry_application", reasonRequired: true }
    ]);

    await app.inject({ method: "POST", url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Conflict repaired" } });
    const retryActive = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(retryActive.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
    await app.close();
  });
});
