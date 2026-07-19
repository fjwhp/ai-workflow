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

function insertRequirement(db: DatabaseSync, id = "r1") {
  db.prepare(`INSERT INTO requirements
    (id, code, title, business_problem, expected_outcome, priority, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `REQ-${id}`, "Schema test", "Test owner-scoped evidence", "Artifacts remain independent", "medium",
      "implementation", "ai_ready", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
}

function insertArtifact(db: DatabaseSync, input: { id: string; ownerType: string | null; ownerId: string | null; stage?: string }) {
  db.prepare(`INSERT INTO artifacts
    (id, requirement_id, owner_type, owner_id, stage, version, title, content_json, created_at)
    VALUES (?, 'r1', ?, ?, ?, 1, 'Evidence', '{}', '2026-07-20T00:00:00.000Z')`)
    .run(input.id, input.ownerType, input.ownerId, input.stage ?? "implementation");
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

  it("keeps transitional owner columns nullable and constrains new domain values", () => {
    const db = openFreshStoreDatabase();
    const ownerColumns = ["stage_runs", "artifacts"].flatMap((table) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
        .filter(({ name }) => name === "owner_type" || name === "owner_id")
    );
    expect(ownerColumns).toHaveLength(4);
    expect(ownerColumns.every(({ notnull }) => notnull === 0)).toBe(true);
    expect(tableSql(db, "delivery_units")).toMatch(/phase TEXT NOT NULL CHECK\s*\(phase IN \('implementation', 'quality_verification', 'acceptance_delivery'\)\)/i);
    for (const status of [
      "waiting_dependency", "ready", "running", "awaiting_gate", "returned",
      "potentially_stale", "ready_for_acceptance", "applying", "applied",
      "conflicted", "failed", "skipped"
    ]) {
      expect(tableSql(db, "delivery_units")).toContain(`'${status}'`);
    }
    expect(tableSql(db, "automation_jobs")).toMatch(/owner_type TEXT NOT NULL CHECK\s*\(owner_type IN \('requirement', 'delivery_unit'\)\)/i);
    expect(tableSql(db, "automation_jobs")).toMatch(/status TEXT NOT NULL CHECK\s*\(status IN \('pending', 'leased', 'completed', 'failed', 'canceled'\)\)/i);
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
    db.close();
  });

  it("scopes delivery artifacts to their owner", () => {
    const db = openFreshStoreDatabase();
    insertRequirement(db);

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
