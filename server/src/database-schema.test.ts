import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "workflow-phase-2-schema-"));
  directories.push(directory);
  return join(directory, "workflow.db");
}

function openFreshStoreDatabase(path = databasePath()) {
  const store = new WorkflowStore(path);
  store.close();
  return new DatabaseSync(path);
}

function tableNames(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => name);
}

function columns(db: DatabaseSync, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function tableSql(db: DatabaseSync, table: string) {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function indexSql(db: DatabaseSync, index: string) {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) as { sql: string }).sql;
}

function foreignKeys(db: DatabaseSync, table: string) {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string }>).map((row) => ({
    from: row.from,
    table: row.table,
    to: row.to
  }));
}

function triggerNames(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => name);
}

function insertRequirement(db: DatabaseSync, id = "r1") {
  db.prepare(`INSERT INTO requirements
    (id, code, title, business_problem, expected_outcome, priority, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `REQ-${id}`, "Schema test", "Test owner-scoped evidence", "Artifacts remain independent", "medium",
      "implementation", "ai_ready", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
}

function insertDeliveryFixture(db: DatabaseSync) {
  insertRequirement(db, "r1");
  insertRequirement(db, "r2");
  const now = "2026-07-20T00:00:00.000Z";
  const insertProject = db.prepare(`INSERT INTO projects
    (id, name, repo_path, default_branch, created_at, updated_at) VALUES (?, ?, ?, 'main', ?, ?)`);
  const insertVersion = db.prepare(`INSERT INTO project_versions
    (id, project_id, name, branch, base_branch, worktree_path, status, head_commit, created_at, updated_at)
    VALUES (?, ?, 'fixture', ?, 'main', ?, 'active', 'head', ?, ?)`);
  for (const suffix of ["1", "2", "3"]) {
    insertProject.run(`p${suffix}`, `Project ${suffix}`, `/tmp/project-${suffix}`, now, now);
    insertVersion.run(`v${suffix}`, `p${suffix}`, `branch-${suffix}`, `/tmp/worktree-${suffix}`, now, now);
  }
  db.prepare(`INSERT INTO requirement_project_snapshots
    (id, requirement_id, version, associations_json, status, created_at) VALUES (?, ?, 1, '[]', 'active', ?)`)
    .run("s1", "r1", now);
  db.prepare(`INSERT INTO requirement_project_snapshots
    (id, requirement_id, version, associations_json, status, created_at) VALUES (?, ?, 1, '[]', 'active', ?)`)
    .run("s2", "r2", now);
  const insertUnit = db.prepare(`INSERT INTO delivery_units
    (id, requirement_id, association_snapshot_id, project_id, project_version_id, required, position,
      phase, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, 'implementation', 'ready', ?, ?)`);
  insertUnit.run("u1", "r1", "s1", "p1", "v1", 0, now, now);
  insertUnit.run("u2", "r1", "s1", "p2", "v2", 1, now, now);
  insertUnit.run("u3", "r2", "s2", "p3", "v3", 0, now, now);
}

function insertDeliveryDependency(db: DatabaseSync, id: string, requirementId: string, upstreamUnitId: string, downstreamUnitId: string) {
  db.prepare(`INSERT INTO delivery_dependencies
    (id, requirement_id, upstream_unit_id, downstream_unit_id, release_condition, created_at)
    VALUES (?, ?, ?, ?, 'automated_testing_passed', '2026-07-20T00:00:00.000Z')`)
    .run(id, requirementId, upstreamUnitId, downstreamUnitId);
}

function insertDeliveryUnitSnapshot(db: DatabaseSync, input: { id: string; unitId: string; requirementId: string; projectId: string; versionId: string }) {
  db.prepare(`INSERT INTO delivery_unit_snapshots
    (id, delivery_unit_id, requirement_id, project_id, project_version_id, repo_path, branch, base_branch,
      worktree_path, head_commit, module_ids_json, sensitive_patterns_json, allowed_commands_json, created_at)
    VALUES (?, ?, ?, ?, ?, '/tmp/repo', 'main', 'main', '/tmp/worktree', 'head', '[]', '[]', '[]',
      '2026-07-20T00:00:00.000Z')`)
    .run(input.id, input.unitId, input.requirementId, input.projectId, input.versionId);
}

function insertArtifact(db: DatabaseSync, input: { id: string; ownerType: string | null; ownerId: string | null; stage?: string }) {
  db.prepare(`INSERT INTO artifacts
    (id, requirement_id, owner_type, owner_id, stage, version, title, content_json, created_at)
    VALUES (?, 'r1', ?, ?, ?, 1, 'Evidence', '{}', '2026-07-20T00:00:00.000Z')`)
    .run(input.id, input.ownerType, input.ownerId, input.stage ?? "implementation");
}

function insertStageRun(db: DatabaseSync, input: { id: string; requirementId?: string; ownerType: string | null; ownerId: string | null; stage?: string; status?: string }) {
  db.prepare(`INSERT INTO stage_runs
    (id, requirement_id, owner_type, owner_id, stage, status, input_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-07-20T00:00:00.000Z')`)
    .run(input.id, input.requirementId ?? "r1", input.ownerType, input.ownerId, input.stage ?? "implementation", input.status ?? "running");
}

function insertAutomationJob(db: DatabaseSync, input: {
  id: string;
  ownerType?: string;
  ownerId?: string;
  status?: string;
  attempt?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  action?: string;
  evidenceVersion?: number;
  maxAttempts?: number;
  lastError?: string | null;
  payloadJson?: string;
}) {
  db.prepare(`INSERT INTO automation_jobs
    (id, dedupe_key, owner_type, owner_id, evidence_version, action, status, attempt, max_attempts,
      lease_owner, lease_expires_at, payload_json, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`)
    .run(input.id, `dedupe-${input.id}`, input.ownerType ?? "requirement", input.ownerId ?? "r1",
      input.evidenceVersion ?? 1, input.action ?? "implement", input.status ?? "pending",
      input.attempt ?? 0, input.maxAttempts ?? 3, input.leaseOwner ?? null, input.leaseExpiresAt ?? null,
      input.payloadJson ?? "{}", input.lastError ?? null);
}

describe("Phase 2 database schema", () => {
  it("creates only the Phase 2 delivery schema on a fresh database", () => {
    const db = openFreshStoreDatabase();
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      "delivery_units", "delivery_dependencies", "delivery_unit_snapshots",
      "automation_jobs"
    ]));
    expect(columns(db, "stage_runs")).toEqual(expect.arrayContaining(["owner_type", "owner_id"]));
    expect(columns(db, "artifacts")).toEqual(expect.arrayContaining(["owner_type", "owner_id"]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_stage_runs_running'").get()).toBeUndefined();
    db.close();
  });

  it("requires stage run owners while keeping transitional artifact owners nullable", () => {
    const db = openFreshStoreDatabase();
    const stageOwnerColumns = (db.prepare("PRAGMA table_info(stage_runs)").all() as Array<{ name: string; notnull: number }>)
      .filter(({ name }) => name === "owner_type" || name === "owner_id");
    const artifactOwnerColumns = (db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string; notnull: number }>)
      .filter(({ name }) => name === "owner_type" || name === "owner_id");
    expect(stageOwnerColumns).toHaveLength(2);
    expect(stageOwnerColumns.every(({ notnull }) => notnull === 1)).toBe(true);
    expect(artifactOwnerColumns).toHaveLength(2);
    expect(artifactOwnerColumns.every(({ notnull }) => notnull === 0)).toBe(true);
    expect(tableSql(db, "delivery_units")).toMatch(/phase TEXT NOT NULL CHECK\s*\(phase IN \('implementation', 'quality_verification', 'acceptance_delivery'\)\)/i);
    for (const status of [
      "waiting_dependency", "ready", "running", "awaiting_gate", "returned",
      "potentially_stale", "ready_for_acceptance", "applying", "applied",
      "conflicted", "failed", "skipped"
    ]) {
      expect(tableSql(db, "delivery_units")).toContain(`'${status}'`);
    }
    expect(tableSql(db, "automation_jobs")).toMatch(/owner_type TEXT NOT NULL CHECK\s*\(owner_type IN \('requirement', 'delivery_unit'\)\)/i);
    expect(tableSql(db, "automation_jobs")).toMatch(/action TEXT NOT NULL CHECK\s*\(action IN \('implement', 'review', 'test', 'apply'\)\)/i);
    expect(tableSql(db, "automation_jobs")).toMatch(/status TEXT NOT NULL CHECK\s*\(status IN \('pending', 'leased', 'completed', 'failed', 'canceled'\)\)/i);
    expect(columns(db, "automation_jobs")).toEqual(expect.arrayContaining(["evidence_version", "max_attempts"]));
    db.close();
  });

  it("creates the delivery foreign keys and safety indexes", () => {
    const db = openFreshStoreDatabase();
    expect(foreignKeys(db, "delivery_units")).toEqual(expect.arrayContaining([
      { from: "requirement_id", table: "requirements", to: "id" },
      { from: "association_snapshot_id", table: "requirement_project_snapshots", to: "id" },
      { from: "project_id", table: "projects", to: "id" },
      { from: "project_version_id", table: "project_versions", to: "id" }
    ]));
    expect(foreignKeys(db, "delivery_dependencies")).toEqual(expect.arrayContaining([
      { from: "requirement_id", table: "requirements", to: "id" },
      { from: "upstream_unit_id", table: "delivery_units", to: "id" },
      { from: "downstream_unit_id", table: "delivery_units", to: "id" }
    ]));
    expect(foreignKeys(db, "delivery_unit_snapshots")).toEqual(expect.arrayContaining([
      { from: "delivery_unit_id", table: "delivery_units", to: "id" },
      { from: "requirement_id", table: "requirements", to: "id" },
      { from: "project_id", table: "projects", to: "id" },
      { from: "project_version_id", table: "project_versions", to: "id" }
    ]));
    expect(indexSql(db, "idx_delivery_unit_project")).toMatch(/UNIQUE[\s\S]*delivery_units\s*\(requirement_id,\s*project_id\)/i);
    expect(indexSql(db, "idx_delivery_dependency_edge")).toMatch(/UNIQUE[\s\S]*delivery_dependencies\s*\(requirement_id,\s*upstream_unit_id,\s*downstream_unit_id\)/i);
    expect(indexSql(db, "idx_delivery_unit_active_run")).toMatch(/UNIQUE[\s\S]*stage_runs\s*\(owner_type,\s*owner_id,\s*stage\)[\s\S]*WHERE status = 'running'/i);
    expect(indexSql(db, "idx_automation_job_dedupe")).toMatch(/UNIQUE[\s\S]*automation_jobs\s*\(dedupe_key\)/i);
    expect(triggerNames(db)).toEqual(expect.arrayContaining([
      "validate_delivery_dependency_owner_insert",
      "validate_delivery_dependency_owner_update",
      "validate_delivery_unit_snapshot_owner_insert",
      "validate_delivery_unit_snapshot_owner_update"
    ]));
    db.close();
  });

  it("scopes delivery artifacts to their owner", () => {
    const db = openFreshStoreDatabase();
    insertDeliveryFixture(db);

    insertArtifact(db, { id: "a1", ownerType: "delivery_unit", ownerId: "u1" });
    expect(() => insertArtifact(db, { id: "a2", ownerType: "delivery_unit", ownerId: "u2" })).not.toThrow();
    expect(() => insertArtifact(db, { id: "a3", ownerType: "delivery_unit", ownerId: "u1" }))
      .toThrow(/UNIQUE constraint failed: artifacts\.owner_type, artifacts\.owner_id, artifacts\.stage, artifacts\.version/);
    db.close();
  });

  it("keeps transitional requirement artifacts unique when owner is absent", () => {
    const db = openFreshStoreDatabase();
    insertRequirement(db);

    insertArtifact(db, { id: "a1", ownerType: null, ownerId: null });
    expect(() => insertArtifact(db, { id: "a2", ownerType: null, ownerId: null }))
      .toThrow(/UNIQUE constraint failed: artifacts\.requirement_id, artifacts\.stage, artifacts\.version/);
    db.close();
  });

  it("requires artifact owner fields together and rejects unknown owner types", () => {
    const db = openFreshStoreDatabase();
    insertRequirement(db);

    expect(() => insertArtifact(db, { id: "a1", ownerType: "delivery_unit", ownerId: null }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertArtifact(db, { id: "a2", ownerType: null, ownerId: "u1" }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertArtifact(db, { id: "a3", ownerType: "project", ownerId: "p1" }))
      .toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("enforces stage run owners and running uniqueness", () => {
    const db = openFreshStoreDatabase();
    insertRequirement(db);

    insertStageRun(db, { id: "run-1", ownerType: "requirement", ownerId: "r1" });
    expect(() => insertStageRun(db, { id: "run-2", ownerType: "requirement", ownerId: "r1" }))
      .toThrow(/UNIQUE constraint failed: stage_runs\.owner_type, stage_runs\.owner_id, stage_runs\.stage/);
    expect(() => insertStageRun(db, { id: "run-3", ownerType: "requirement", ownerId: null, stage: "solution_design" }))
      .toThrow(/NOT NULL constraint failed/);
    expect(() => insertStageRun(db, { id: "run-4", ownerType: null, ownerId: "r1", stage: "quality_verification" }))
      .toThrow(/NOT NULL constraint failed/);
    expect(() => insertStageRun(db, { id: "run-5", ownerType: "project", ownerId: "p1", stage: "acceptance_delivery" }))
      .toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("enforces automation job attempts and lease field invariants", () => {
    const db = openFreshStoreDatabase();
    insertRequirement(db);

    expect(() => insertAutomationJob(db, { id: "job-negative", attempt: -1 })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-invalid-action", action: "invented" })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-invalid-evidence", evidenceVersion: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-invalid-max", maxAttempts: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-attempt-cap", attempt: 4, maxAttempts: 3 })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-leased-empty", status: "leased" })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-half-lease", leaseOwner: "worker-1" })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-half-expiry", leaseExpiresAt: "2026-07-20T00:05:00.000Z" })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, {
      id: "job-leased", status: "leased", leaseOwner: "worker-1", leaseExpiresAt: "2026-07-20T00:05:00.000Z"
    })).not.toThrow();
    expect(() => insertAutomationJob(db, {
      id: "job-pending-leased", leaseOwner: "worker-1", leaseExpiresAt: "2026-07-20T00:05:00.000Z"
    })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "", lastError: "failure" })).toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, { id: "job-long-error", lastError: "x".repeat(4097) }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertAutomationJob(db, {
      id: "job-multibyte-payload", payloadJson: JSON.stringify({ value: "界".repeat(22_000) })
    })).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("rejects missing polymorphic owners and cross-requirement evidence", () => {
    const db = openFreshStoreDatabase();
    insertDeliveryFixture(db);

    expect(() => insertAutomationJob(db, { id: "job-missing-requirement", ownerId: "missing" })).toThrow("OWNER_NOT_FOUND");
    expect(() => insertAutomationJob(db, { id: "job-missing-unit", ownerType: "delivery_unit", ownerId: "missing" })).toThrow("OWNER_NOT_FOUND");
    expect(() => insertArtifact(db, { id: "artifact-cross-requirement", ownerType: "delivery_unit", ownerId: "u3" }))
      .toThrow("OWNER_REQUIREMENT_MISMATCH");
    expect(() => insertStageRun(db, { id: "run-missing", ownerType: "delivery_unit", ownerId: "missing" })).toThrow("OWNER_NOT_FOUND");
    db.close();
  });

  it("validates polymorphic owners when owner or requirement fields change", () => {
    const db = openFreshStoreDatabase();
    insertDeliveryFixture(db);
    insertArtifact(db, { id: "artifact-1", ownerType: "delivery_unit", ownerId: "u1" });
    insertStageRun(db, { id: "run-1", ownerType: "delivery_unit", ownerId: "u1" });
    insertAutomationJob(db, { id: "job-1", ownerType: "delivery_unit", ownerId: "u1" });

    expect(() => db.prepare("UPDATE artifacts SET requirement_id = 'r2' WHERE id = 'artifact-1'").run()).toThrow("OWNER_REQUIREMENT_MISMATCH");
    expect(() => db.prepare("UPDATE stage_runs SET requirement_id = 'r2' WHERE id = 'run-1'").run()).toThrow("OWNER_REQUIREMENT_MISMATCH");
    expect(() => db.prepare("UPDATE automation_jobs SET owner_id = 'missing' WHERE id = 'job-1'").run()).toThrow("OWNER_NOT_FOUND");
    db.close();
  });

  it("rejects cross-requirement and self delivery dependencies on insert and update", () => {
    const db = openFreshStoreDatabase();
    insertDeliveryFixture(db);

    expect(() => insertDeliveryDependency(db, "d-cross", "r1", "u1", "u3"))
      .toThrow("DELIVERY_DEPENDENCY_OWNER_MISMATCH");
    expect(() => insertDeliveryDependency(db, "d-self", "r1", "u1", "u1"))
      .toThrow("DELIVERY_DEPENDENCY_SELF_EDGE");
    insertDeliveryDependency(db, "d-valid", "r1", "u1", "u2");
    expect(() => db.prepare("UPDATE delivery_dependencies SET downstream_unit_id = 'u3' WHERE id = 'd-valid'").run())
      .toThrow("DELIVERY_DEPENDENCY_OWNER_MISMATCH");
    expect(() => db.prepare("UPDATE delivery_dependencies SET downstream_unit_id = 'u1' WHERE id = 'd-valid'").run())
      .toThrow("DELIVERY_DEPENDENCY_SELF_EDGE");
    db.close();
  });

  it("rejects delivery unit snapshots whose owner fields do not match the unit", () => {
    const db = openFreshStoreDatabase();
    insertDeliveryFixture(db);

    expect(() => insertDeliveryUnitSnapshot(db, { id: "us-cross-requirement", unitId: "u1", requirementId: "r2", projectId: "p1", versionId: "v1" }))
      .toThrow("DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH");
    expect(() => insertDeliveryUnitSnapshot(db, { id: "us-cross-project", unitId: "u1", requirementId: "r1", projectId: "p2", versionId: "v1" }))
      .toThrow("DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH");
    expect(() => insertDeliveryUnitSnapshot(db, { id: "us-cross-version", unitId: "u1", requirementId: "r1", projectId: "p1", versionId: "v2" }))
      .toThrow("DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH");
    insertDeliveryUnitSnapshot(db, { id: "us-valid", unitId: "u1", requirementId: "r1", projectId: "p1", versionId: "v1" });
    expect(() => db.prepare("UPDATE delivery_unit_snapshots SET project_id = 'p2' WHERE id = 'us-valid'").run())
      .toThrow("DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH");
    db.close();
  });

  it("reopens the same Phase 2 database idempotently", () => {
    const path = databasePath();
    const first = openFreshStoreDatabase(path);
    first.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").run("schema-test", "{}", "2026-07-19T00:00:00.000Z");
    first.close();

    const second = openFreshStoreDatabase(path);
    expect(second.prepare("SELECT value_json FROM settings WHERE key = ?").get("schema-test")).toEqual({ value_json: "{}" });
    expect(tableNames(second)).toEqual(expect.arrayContaining(["delivery_units", "automation_jobs"]));
    expect(indexSql(second, "idx_delivery_unit_active_run")).toContain("owner_type");
    second.close();
  });
});
