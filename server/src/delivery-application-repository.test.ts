import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  const directory = mkdtempSync(join(tmpdir(), "delivery-application-repository-"));
  directories.push(directory);
  const path = join(directory, "workflow.db");
  const store = new WorkflowStore(path, () => new Date("2026-07-22T01:02:03.000Z"));
  stores.push(store);
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
    worktreePath: join(directory, "backend-version"), headCommit: "backend-version-head"
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "frontend-v1", branch: "feature/frontend", baseBranch: "main",
    worktreePath: join(directory, "frontend-version"), headCommit: "frontend-version-head"
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

function claimInput(seed: string) {
  return {
    claimToken: `claim-${seed}`,
    sourceCommit: `${seed}-source`,
    baseCommit: `${seed}-base`,
    preApplyCommit: `${seed}-pre-apply`,
    evidenceHash: `${seed}-evidence`,
    preflight: { allowed: true, checks: [{ name: "identity", passed: true }] }
  };
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

describe("DeliveryApplicationRepository", () => {
  it("preserves an applied backend when frontend conflicts", () => {
    const fixture = createFixture();
    const backendRun = fixture.store.deliveryApplications.claim(
      fixture.backendUnit.id, claimInput("backend")
    );
    fixture.store.deliveryApplications.complete(backendRun.id, completedResult());
    const frontendRun = fixture.store.deliveryApplications.claim(
      fixture.frontendUnit.id, claimInput("frontend")
    );
    fixture.store.deliveryApplications.complete(frontendRun.id, conflictResult());

    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
    expect(fixture.store.deliveryUnits.get(fixture.frontendUnit.id)?.status).toBe("conflicted");
    expect(fixture.store.deliveryApplications.aggregate(fixture.requirement.id)).toBe("partially_applied");
    expect(fixture.store.deliveryApplications.get(backendRun.id)).toMatchObject({
      status: "applied", resolutionStatus: "not_required"
    });
    expect(fixture.store.deliveryApplications.get(frontendRun.id)).toMatchObject({
      status: "conflicted", conflictFiles: ["src/api.ts"], error: "APPLICATION_CONFLICT",
      resolutionStatus: "pending"
    });
  });

  it("retains the frozen commits, evidence, preflight, and command results", () => {
    const fixture = createFixture();
    const input = claimInput("backend");
    const run = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, input);
    const settled = fixture.store.deliveryApplications.complete(run.id, completedResult());

    expect(settled).toMatchObject({
      requirementId: fixture.requirement.id,
      deliveryUnitId: fixture.backendUnit.id,
      projectVersionId: fixture.backendVersion.id,
      evidenceVersion: 1,
      claimToken: input.claimToken,
      sourceCommit: input.sourceCommit,
      baseCommit: input.baseCommit,
      preApplyCommit: input.preApplyCommit,
      evidenceHash: input.evidenceHash,
      preflight: input.preflight,
      commandResults: completedResult().commandResults,
      conflictFiles: [],
      error: null,
      status: "applied",
      resolutionStatus: "not_required",
      createdAt: "2026-07-22T01:02:03.000Z",
      completedAt: "2026-07-22T01:02:03.000Z"
    });
    expect(fixture.store.deliveryApplications.listForUnit(fixture.backendUnit.id)).toEqual([settled]);
  });

  it("atomically enforces one active run per unit across store connections", () => {
    const fixture = createFixture();
    const other = new WorkflowStore(fixture.path);
    stores.push(other);
    fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("first"));

    expect(() => other.deliveryApplications.claim(fixture.backendUnit.id, claimInput("second")))
      .toThrow("DELIVERY_APPLICATION_RUN_ACTIVE");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applying");
  });

  it("atomically reserves one owner per project-version worktree across store connections", () => {
    const fixture = createFixture();
    const secondRequirement = fixture.store.createRequirement({
      title: "Second requirement", businessProblem: "Shares the same version",
      expectedOutcome: "Cannot apply concurrently", priority: "medium",
      primaryProjectId: fixture.backend.id, primaryProjectVersionId: fixture.backendVersion.id
    });
    const secondSnapshot = fixture.store.createRequirementProjectSnapshot(secondRequirement.id);
    const secondPlan = fixture.store.deliveryUnits.createPlan({
      requirementId: secondRequirement.id,
      snapshot: secondSnapshot,
      plan: {
        units: [{ projectId: fixture.backend.id, moduleIds: ["src/second"], acceptanceCriteria: ["passes"] }],
        dependencies: []
      }
    });
    fixture.database.prepare(`UPDATE delivery_units
      SET phase = 'acceptance_delivery', status = 'ready_for_acceptance' WHERE id = ?`)
      .run(secondPlan.units[0]!.id);
    const other = new WorkflowStore(fixture.path);
    stores.push(other);
    fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("first"));

    expect(() => other.deliveryApplications.claim(secondPlan.units[0]!.id, claimInput("second")))
      .toThrow("DELIVERY_APPLICATION_VERSION_ACTIVE");
    expect(other.deliveryUnits.get(secondPlan.units[0]!.id)?.status).toBe("ready_for_acceptance");
  });

  it("rejects stale completion and cannot overwrite a settled run or sibling", () => {
    const fixture = createFixture();
    const backendRun = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("backend"));
    fixture.store.deliveryApplications.complete(backendRun.id, completedResult());
    const frontendRun = fixture.store.deliveryApplications.claim(fixture.frontendUnit.id, claimInput("frontend"));

    expect(() => fixture.store.deliveryApplications.complete(backendRun.id, conflictResult()))
      .toThrow("DELIVERY_APPLICATION_RUN_SETTLED");
    expect(() => fixture.store.deliveryApplications.complete("missing-run", completedResult()))
      .toThrow("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applied");
    expect(fixture.store.deliveryApplications.get(frontendRun.id)?.status).toBe("applying");

    fixture.database.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?")
      .run(fixture.frontendUnit.id);
    expect(() => fixture.store.deliveryApplications.claim(
      fixture.frontendUnit.id, claimInput("frontend")
    )).toThrow("DELIVERY_APPLICATION_CLAIM_STALE");
  });

  it("redacts frozen sensitive patterns before persisting application evidence", () => {
    const fixture = createFixture();
    const run = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput("backend"), preflight: { detail: "token=CUSTOM_SECRET" }
    });
    fixture.store.deliveryApplications.complete(run.id, {
      status: "failed", error: "CUSTOM_SECRET failed",
      commandResults: [{ stdout: "CUSTOM_SECRET", stderr: "" }]
    });

    const raw = fixture.database.prepare(`SELECT preflight_json, command_results_json, error
      FROM delivery_application_runs WHERE id = ?`).get(run.id);
    expect(JSON.stringify(raw)).not.toContain("CUSTOM_SECRET");
    expect(JSON.stringify(raw)).toContain("[REDACTED]");
  });

  it("requires an acceptance-ready active unit and rejects malformed claims without writes", () => {
    const fixture = createFixture();
    fixture.database.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?")
      .run(fixture.backendUnit.id);
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("backend")))
      .toThrow("DELIVERY_APPLICATION_UNIT_NOT_READY");
    expect(() => fixture.store.deliveryApplications.claim(" missing ", claimInput("backend")))
      .toThrow("DELIVERY_APPLICATION_ID_INVALID");
    expect(() => fixture.store.deliveryApplications.claim(fixture.frontendUnit.id, {
      ...claimInput("frontend"), evidenceHash: "bad\0hash"
    })).toThrow("DELIVERY_APPLICATION_CLAIM_INVALID");
    const accessorClaim = claimInput("accessor");
    Object.defineProperty(accessorClaim, "claimToken", {
      enumerable: true,
      get(): never { throw new Error("CLAIM_TOKEN_ACCESSED"); }
    });
    expect(() => fixture.store.deliveryApplications.claim(fixture.frontendUnit.id, accessorClaim))
      .toThrow("DELIVERY_APPLICATION_CLAIM_INVALID");
    expect(fixture.database.prepare("SELECT * FROM delivery_application_runs").all()).toEqual([]);
  });

  it("bounds and validates structured application evidence", () => {
    const fixture = createFixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput("backend"), preflight: cyclic
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_INVALID");
    expect(() => fixture.store.deliveryApplications.claim(fixture.backendUnit.id, {
      ...claimInput("backend"), preflight: { detail: "x".repeat(1_048_577) }
    })).toThrow("DELIVERY_APPLICATION_PREFLIGHT_LIMIT");

    const run = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("backend"));
    expect(() => fixture.store.deliveryApplications.complete(run.id, {
      status: "conflicted", commandResults: [], conflictFiles: [" src/api.ts"]
    })).toThrow("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
    expect(() => fixture.store.deliveryApplications.complete(run.id, {
      status: "failed", commandResults: [{ output: "x".repeat(1_048_577) }], error: "FAILED"
    })).toThrow("DELIVERY_APPLICATION_COMMAND_RESULTS_LIMIT");
    const accessorCompletion = { status: "failed" as const, error: "FAILED" };
    Object.defineProperty(accessorCompletion, "commandResults", {
      enumerable: true,
      get(): never { throw new Error("COMMAND_RESULTS_ACCESSED"); }
    });
    expect(() => fixture.store.deliveryApplications.complete(run.id, accessorCompletion))
      .toThrow("DELIVERY_APPLICATION_COMPLETION_INVALID");
    expect(fixture.store.deliveryApplications.get(run.id)?.status).toBe("applying");
    expect(fixture.store.deliveryUnits.get(fixture.backendUnit.id)?.status).toBe("applying");
  });

  it("keeps schema ownership, identity, and active-owner constraints in the database", () => {
    const fixture = createFixture();
    const sql = (fixture.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delivery_application_runs'"
    ).get() as { sql: string }).sql;
    expect(sql).toContain("FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id)");
    expect(sql).toContain("FOREIGN KEY(project_version_id) REFERENCES project_versions(id)");
    expect(sql).toContain("length(CAST(preflight_json AS BLOB)) <= 1048576");
    const indexes = fixture.database.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'delivery_application_runs'`).all() as Array<{ name: string; sql: string }>;
    expect(indexes.find((index) => index.name === "idx_delivery_application_unit_active")?.sql)
      .toContain("WHERE status = 'applying'");
    expect(indexes.find((index) => index.name === "idx_delivery_application_version_active")?.sql)
      .toContain("WHERE status = 'applying'");

    const run = fixture.store.deliveryApplications.claim(fixture.backendUnit.id, claimInput("backend"));
    expect(() => fixture.database.prepare(
      "UPDATE delivery_application_runs SET delivery_unit_id = ? WHERE id = ?"
    ).run(fixture.frontendUnit.id, run.id)).toThrow("DELIVERY_APPLICATION_IDENTITY_IMMUTABLE");
    expect(() => fixture.database.prepare("DELETE FROM delivery_application_runs WHERE id = ?")
      .run(run.id)).toThrow("DELIVERY_APPLICATION_IMMUTABLE");
    fixture.store.deliveryApplications.complete(run.id, completedResult());
    expect(() => fixture.database.prepare(`UPDATE delivery_application_runs
      SET command_results_json = '[]' WHERE id = ?`).run(run.id))
      .toThrow("DELIVERY_APPLICATION_SETTLED_IMMUTABLE");
  });
});
