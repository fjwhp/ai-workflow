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

function createAcceptanceFixture(options: { frontendQuality?: boolean; frontendRequired?: boolean } = {}) {
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
    deliveryRequired: position === 0 || options.frontendRequired !== false,
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
  for (const unit of plan.units) store.automationJobs.cancelByOwnerVersion(unit.id, unit.evidenceVersion);
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
  status: "applied" | "conflicted",
  options: {
    baseCommit?: string; preApplyCommit?: string; evidenceHash?: string;
    preflight?: unknown; commandResults?: unknown[]; error?: string;
  } = {}
): DeliveryApplicationRun {
  const lease = fixture.store.automationJobs.leaseNext("application-route-worker", new Date(), 60_000);
  if (!lease || lease.ownerId !== unitId || lease.action !== "apply") {
    throw new Error("expected application lease");
  }
  let claim = fixture.store.deliveryApplications.claim(unitId, {
    expectedEvidenceVersion: lease.evidenceVersion,
    claimToken: lease.claimToken,
    baseCommit: options.baseCommit ?? "b".repeat(40),
    preApplyCommit: options.preApplyCommit ?? "c".repeat(40),
    evidenceHash: options.evidenceHash ?? "d".repeat(64),
    preflight: options.preflight ?? { allowed: true, token: "secret-preflight" }
  });
  claim = fixture.store.deliveryApplications.bindSourceCommit(claim, "e".repeat(40));
  return fixture.store.deliveryApplications.complete(claim, status === "applied"
    ? { status: "applied", commandResults: options.commandResults ?? [{ command: "git", stdout: "ok" }] }
    : {
      status: "conflicted",
      conflictFiles: ["src/conflict.ts"],
      commandResults: options.commandResults ?? [{ command: "git", stderr: "secret-command" }],
      error: options.error ?? "APPLICATION_CONFLICT secret-error"
    });
}

function occupyProjectVersion(
  fixture: ReturnType<typeof createAcceptanceFixture>,
  position: number,
  worker: string
) {
  const blocker = fixture.store.createRequirement({
    title: `Occupy project version ${position}`,
    businessProblem: "Another requirement owns this project version",
    expectedOutcome: "Acceptance respects participating version ownership",
    priority: "high",
    primaryProjectId: fixture.projects[position]!.id,
    primaryProjectVersionId: fixture.versions[position]!.id
  });
  fixture.store.replaceRequirementProjects(blocker.id, [{
    projectId: fixture.projects[position]!.id,
    projectVersionId: fixture.versions[position]!.id,
    role: "primary",
    usage: "delivery",
    deliveryRequired: true,
    moduleMode: "all",
    moduleIds: [],
    position: 0
  }]);
  const unit = fixture.store.deliveryUnits.createPlan({
    requirementId: blocker.id,
    snapshot: fixture.store.createRequirementProjectSnapshot(blocker.id),
    plan: { units: [{ projectId: fixture.projects[position]!.id, moduleIds: [], acceptanceCriteria: ["done"] }],
      dependencies: [] }
  }).units[0]!;
  completeImplementation(fixture.store, unit.id);
  passQuality(fixture.store, unit.id);
  fixture.store.automationJobs.cancelByOwnerVersion(unit.id, unit.evidenceVersion);
  fixture.store.updateRequirementState(blocker.id, "implementation", "ai_ready");
  fixture.store.deliveryCoordination.acceptRequirement({
    requirementId: blocker.id,
    actor: "local-human",
    comment: "Start blocking application"
  });
  const lease = fixture.store.automationJobs.leaseNext(worker, new Date(), 60_000)!;
  expect(lease.ownerId).toBe(unit.id);
  return fixture.store.deliveryApplications.claim(unit.id, {
    expectedEvidenceVersion: lease.evidenceVersion,
    claimToken: lease.claimToken,
    baseCommit: "7".repeat(40),
    preApplyCommit: "8".repeat(40),
    evidenceHash: "9".repeat(64),
    preflight: { allowed: true }
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
    settleApplication(fixture, fixture.frontend.id, "conflicted", {
      baseCommit: "//server/share/base",
      preApplyCommit: "wrapped=(\\\\server\\share\\pre-apply)",
      evidenceHash: "FiLe://server/share/evidence",
      preflight: {
        allowed: true,
        checks: [{ id: "target_identity", label: "Target identity", ok: true,
          name: "identity", passed: true, code: "OK", detail: "wrapped=(//server/share/check)" }],
        changedModules: [
          "src/file.ts",
          "/Users/alice/Clients/SecretCo/private-module",
          "//server/share/private-module",
          "FILE://server/share/uri-module"
        ],
        plannedCommands: [
          { command: "npm", argsPrefix: ["test"] },
          { command: "node", argsPrefix: ["//server/share/tool.js"] },
          { command: "bash", argsPrefix: ["\\\\server\\share\\tool.sh"] },
          { command: "sh", argsPrefix: ["file://server/share/tool.sh"] }
        ],
        commandSource: "module_inference",
        evidenceMode: "commit",
        sourceCommit: "e".repeat(40),
        sourceBranch: "feature/1",
        targetBranch: "main",
        targetHead: "f".repeat(40),
        sourceWorktreePath: "/Users/alice/Clients/SecretCo/source",
        targetWorktreePath: "/Users/alice/Clients/SecretCo/target",
        repositoryPath: "/Users/alice/Clients/SecretCo/repo",
        identity: { gitCommonDir: "/Users/alice/Clients/SecretCo/repo/.git" }
      },
      commandResults: [
        { command: "npm", args: ["test"], code: 0,
          stdout: "docs https://example.com/guide", stderr: "relative src/file.ts" },
        { command: "node", args: ["run"], code: 1,
          stdout: "wrapped=(//server/share/output)", stderr: "FiLe://server/share/error" },
        { command: "git", args: ["status"], stdout: "\\\\server\\share\\secret" },
        { command: "status", stderr: "ordinary // text" },
        { command: "sh", args: ["//server/share/arg"],
          identity: { repositoryPath: "/opt/private/repo" } },
        { command: "cat", args: ["config"],
          stdout: "loaded path:/Users/alice/Clients/SecretCo/config via file:///opt/private/tool" }
      ],
      error: "APPLICATION_CONFLICT at FILE://server/share/error"
    });
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
        baseCommit: null,
        preApplyCommit: null,
        evidenceHash: null,
        preflight: {
          allowed: true,
          checks: [{ id: "target_identity", label: "Target identity", ok: true,
            name: "identity", passed: true, code: "OK" }],
          changedModules: ["src/file.ts"],
          plannedCommands: [{ command: "npm", argsPrefix: ["test"] }],
          commandSource: "module_inference",
          evidenceMode: "commit",
          sourceCommit: "e".repeat(40),
          sourceBranch: "feature/1",
          targetBranch: "main",
          targetHead: "f".repeat(40)
        },
        commandResults: [
          { command: "npm", args: ["test"], code: 0,
            stdout: "docs https://example.com/guide", stderr: "relative src/file.ts" },
          { command: "node", args: ["run"], code: 1 },
          { command: "git", args: ["status"] },
          { command: "status" },
          { command: "sh" },
          { command: "cat", args: ["config"] }
        ],
        conflictFiles: ["src/conflict.ts"],
        error: null,
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
    expect(response.body).not.toContain("/Users/alice/Clients/SecretCo");
    expect(response.body).not.toContain("/opt/private");
    expect(response.body).not.toContain("//server/share");
    expect(response.body).not.toContain("\\\\server\\share");
    expect(response.body.toLowerCase()).not.toContain("file://server/share");
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

  it("blocks acceptance while a quality automation lease remains active after readiness", async () => {
    const fixture = createAcceptanceFixture();
    const database = (fixture.store as any).db;
    const qualityJob = database.prepare(`SELECT id FROM automation_jobs
      WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ? AND action = 'test'`)
      .get(fixture.frontend.id, fixture.frontend.evidenceVersion) as { id: string };
    database.prepare(`UPDATE automation_jobs SET status = 'leased', attempt = 1,
      lease_owner = 'quality-callback', lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
      WHERE id = ?`).run(new Date().toISOString(), qualityJob.id);
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Must wait for lease settlement" } });

    expect(detail.allowedActions).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "APPLICATION_ALREADY_ACTIVE",
      detailCode: "DELIVERY_ACCEPTANCE_ACTIVE_WORK"
    });
    expect(fixture.store.listApprovals(fixture.requirement.id)).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_jobs WHERE action = 'apply'").get())
      .toEqual({ count: 0 });
    await app.close();
  });

  it("ignores active work owned by an optional unit that no longer participates", async () => {
    const fixture = createAcceptanceFixture({ frontendRequired: false });
    fixture.store.deliveryCoordination.skipOptional({
      unitId: fixture.frontend.id,
      actor: "local-human",
      reason: "Exclude optional delivery"
    });
    const database = (fixture.store as any).db;
    const qualityJob = database.prepare(`SELECT id FROM automation_jobs
      WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ? AND action = 'test'`)
      .get(fixture.frontend.id, fixture.frontend.evidenceVersion) as { id: string };
    database.prepare(`UPDATE automation_jobs SET status = 'leased', attempt = 1,
      lease_owner = 'ignored-quality', lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
      WHERE id = ?`).run(new Date().toISOString(), qualityJob.id);
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Accept participating delivery" } });

    expect(detail.allowedActions).toEqual([{ type: "accept_delivery", commentRequired: true }]);
    expect(response.statusCode).toBe(202);
    await app.close();
  });

  it("ignores a busy project version owned only by a skipped optional unit", async () => {
    const fixture = createAcceptanceFixture({ frontendRequired: false });
    fixture.store.deliveryCoordination.skipOptional({
      unitId: fixture.frontend.id,
      actor: "local-human",
      reason: "Exclude optional project"
    });
    occupyProjectVersion(fixture, 1, "skipped-version-owner");
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Accept required project only" } });

    expect(detail.allowedActions).toEqual([{ type: "accept_delivery", commentRequired: true }]);
    expect(response.statusCode).toBe(202);
    expect(response.json().acceptance.plan).toEqual([
      { unitId: fixture.backend.id, evidenceVersion: fixture.backend.evidenceVersion }
    ]);
    await app.close();
  });

  it("keeps a busy optional ready project version in the participating set", async () => {
    const fixture = createAcceptanceFixture({ frontendRequired: false });
    occupyProjectVersion(fixture, 1, "optional-version-owner");
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
      payload: { comment: "Cannot accept occupied optional project" } });

    expect(detail.allowedActions).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "PROJECT_VERSION_APPLICATION_BUSY" });
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

  it("blocks retry when another requirement actively owns the target project version", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    const blocker = fixture.store.createRequirement({
      title: "Occupy retry version",
      businessProblem: "Another requirement is applying the same version",
      expectedOutcome: "Retry waits for version ownership",
      priority: "high",
      primaryProjectId: fixture.projects[1]!.id,
      primaryProjectVersionId: fixture.versions[1]!.id
    });
    fixture.store.replaceRequirementProjects(blocker.id, [{
      projectId: fixture.projects[1]!.id,
      projectVersionId: fixture.versions[1]!.id,
      role: "primary",
      usage: "delivery",
      deliveryRequired: true,
      moduleMode: "all",
      moduleIds: [],
      position: 0
    }]);
    const blockerUnit = fixture.store.deliveryUnits.createPlan({
      requirementId: blocker.id,
      snapshot: fixture.store.createRequirementProjectSnapshot(blocker.id),
      plan: { units: [{ projectId: fixture.projects[1]!.id, moduleIds: [], acceptanceCriteria: ["done"] }],
        dependencies: [] }
    }).units[0]!;
    completeImplementation(fixture.store, blockerUnit.id);
    passQuality(fixture.store, blockerUnit.id);
    fixture.store.automationJobs.cancelByOwnerVersion(blockerUnit.id, blockerUnit.evidenceVersion);
    fixture.store.updateRequirementState(blocker.id, "implementation", "ai_ready");
    fixture.store.deliveryCoordination.acceptRequirement({
      requirementId: blocker.id,
      actor: "local-human",
      comment: "Start competing application"
    });
    const blockerLease = fixture.store.automationJobs.leaseNext("competing-application", new Date(), 60_000)!;
    expect(blockerLease.ownerId).toBe(blockerUnit.id);
    fixture.store.deliveryApplications.claim(blockerUnit.id, {
      expectedEvidenceVersion: blockerLease.evidenceVersion,
      claimToken: blockerLease.claimToken,
      baseCommit: "4".repeat(40),
      preApplyCommit: "5".repeat(40),
      evidenceHash: "6".repeat(64),
      preflight: { allowed: true }
    });
    const beforeJobs = (fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM automation_jobs WHERE owner_id = ? AND action = 'apply'"
    ).get(fixture.frontend.id);
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Wait for competing application" } });

    expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "PROJECT_VERSION_APPLICATION_BUSY" });
    expect((fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM automation_jobs WHERE owner_id = ? AND action = 'apply'"
    ).get(fixture.frontend.id)).toEqual(beforeJobs);
    expect(fixture.store.deliveryCoordination.listApplicationRetryAudits(fixture.frontend.id)).toEqual([]);
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
    fixture.store.automationJobs.cancelByOwnerVersion(blockerUnit.id, blockerUnit.evidenceVersion);
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

  it.each(["DATABASE_NOT_FOUND", "DATABASE_INVALID", "database password=super-secret-value"])(
    "does not classify unknown coordinator code %s by suffix",
    async (code) => {
      const fixture = createAcceptanceFixture();
      (fixture.store.deliveryCoordination as any).acceptRequirement = () => { throw new Error(code); };
      (fixture.store.deliveryCoordination as any).retryApplication = () => { throw new Error(code); };
      const app = await buildApp(fixture.store);

      const responses = await Promise.all([
        app.inject({ method: "POST", url: `/api/requirements/${fixture.requirement.id}/accept-delivery`,
          payload: { comment: "Attempt acceptance" } }),
        app.inject({ method: "POST", url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
          payload: { reason: "Attempt recovery" } })
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
        expect(response.body).not.toContain(code);
      }
      await app.close();
    }
  );

  it("maps retry sequence conflicts to APPLICATION_RETRY_NOT_ALLOWED", async () => {
    const fixture = createAcceptanceFixture();
    (fixture.store.deliveryCoordination as any).retryApplication = () => {
      throw new Error("DELIVERY_APPLICATION_SEQUENCE_STALE");
    };
    const app = await buildApp(fixture.store);

    const response = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Attempt recovery" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "APPLICATION_RETRY_NOT_ALLOWED",
      detailCode: "DELIVERY_APPLICATION_SEQUENCE_STALE"
    });
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

  it.each(["evidence", "status"] as const)(
    "hides retry_application when a frozen prefix %s no longer matches",
    async (mismatch) => {
      const fixture = createAcceptanceFixture();
      acceptInStore(fixture);
      settleApplication(fixture, fixture.backend.id, "applied");
      settleApplication(fixture, fixture.frontend.id, "conflicted");
      const database = (fixture.store as any).db;
      if (mismatch === "evidence") {
        database.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?").run(fixture.backend.id);
      } else {
        database.prepare("UPDATE delivery_units SET status = 'ready_for_acceptance' WHERE id = ?")
          .run(fixture.backend.id);
      }
      const app = await buildApp(fixture.store);

      const detail = (await app.inject({ method: "GET",
        url: `/api/requirements/${fixture.requirement.id}` })).json();
      const response = await app.inject({ method: "POST",
        url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
        payload: { reason: "Attempt stale retry" } });

      expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "APPLICATION_RETRY_NOT_ALLOWED",
        detailCode: "DELIVERY_APPLICATION_SEQUENCE_STALE"
      });
      await app.close();
    }
  );

  it("hides retry_application when a reverted run has a non-retryable status", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    const conflict = settleApplication(fixture, fixture.frontend.id, "conflicted");
    const database = (fixture.store as any).db;
    database.exec("DROP TRIGGER delivery_application_settled_immutable; PRAGMA ignore_check_constraints = ON");
    database.prepare(`UPDATE delivery_application_runs
      SET resolution_status = 'reverted', resolved_at = updated_at WHERE id = ?`).run(conflict.id);
    database.prepare("UPDATE delivery_units SET status = 'ready_for_acceptance' WHERE id = ?")
      .run(fixture.frontend.id);
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Reject mismatched reverted run" } });

    expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "APPLICATION_RETRY_NOT_ALLOWED",
      detailCode: "DELIVERY_APPLICATION_RETRY_NOT_ELIGIBLE"
    });
    await app.close();
  });

  it("hides retry_application when the settled retry job has no authoritative audit", async () => {
    const fixture = createAcceptanceFixture();
    acceptInStore(fixture);
    settleApplication(fixture, fixture.backend.id, "applied");
    const firstConflict = settleApplication(fixture, fixture.frontend.id, "conflicted");
    const previousJob = fixture.store.automationJobs.get(firstConflict.automationJobId)!;
    (fixture.store as any).db.prepare(
      "UPDATE delivery_units SET status = 'ready_for_acceptance' WHERE id = ?"
    ).run(fixture.frontend.id);
    fixture.store.automationJobs.enqueue({
      ownerType: "delivery_unit",
      ownerId: fixture.frontend.id,
      evidenceVersion: fixture.frontend.evidenceVersion,
      action: "apply",
      payload: { ...(previousJob.payload as any), retryAttempt: 1 },
      maxAttempts: 3
    });
    settleApplication(fixture, fixture.frontend.id, "conflicted");
    const app = await buildApp(fixture.store);

    const detail = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    const response = await app.inject({ method: "POST",
      url: `/api/delivery-units/${fixture.frontend.id}/application/retry`,
      payload: { reason: "Retry without audit" } });

    expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "APPLICATION_RETRY_NOT_ALLOWED",
      detailCode: "DELIVERY_APPLICATION_RETRY_AUDIT_STALE"
    });
    await app.close();
  });

  it("exposes skip_optional before acceptance but suppresses it after plan membership is frozen", async () => {
    const fixture = createAcceptanceFixture({ frontendRequired: false });
    const app = await buildApp(fixture.store);

    const before = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(before.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([
      { type: "skip_optional", reasonRequired: true }
    ]);

    acceptInStore(fixture);
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontend.id)).toEqual([]);
    const after = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(after.deliveryUnits.find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);

    (fixture.store as any).db.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?")
      .run(fixture.backend.id);
    const afterOwnerEvidenceChange = (await app.inject({ method: "GET",
      url: `/api/requirements/${fixture.requirement.id}` })).json();
    expect(afterOwnerEvidenceChange.deliveryUnits
      .find((unit: any) => unit.id === fixture.frontend.id).allowedActions).toEqual([]);
    await app.close();
  });
});
