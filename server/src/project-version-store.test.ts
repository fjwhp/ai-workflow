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

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "project-version-store-"));
  directories.push(directory);
  return join(directory, "workflow.db");
}

function columns(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);
}

function requirementInput(projectId: string, title: string) {
  return {
    title,
    businessProblem: `${title} business problem`,
    expectedOutcome: `${title} expected outcome`,
    priority: "medium" as const,
    primaryProjectId: projectId,
    primaryProjectVersionId: "version-1"
  };
}

describe("project versions fresh schema", () => {
  it("owns branch and worktree state and removes the free integration target", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);

    expect(columns(database, "project_versions")).toEqual(expect.arrayContaining([
      "id", "project_id", "name", "branch", "base_branch", "worktree_path", "status",
      "head_commit", "pending_requirement_id", "pending_integration_run_id", "created_at",
      "updated_at", "closed_at"
    ]));
    expect(columns(database, "requirement_projects")).toContain("project_version_id");
    expect(columns(database, "executions")).toEqual(expect.arrayContaining(["project_version_id", "base_commit"]));
    expect(columns(database, "integration_runs")).toEqual(expect.arrayContaining([
      "project_version_id", "pre_apply_head", "resolution_status", "resolution_commit"
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requirement_integration_targets'").get()).toBeUndefined();
  });

  it("initializes the global requirement counter at zero", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);

    expect(columns(database, "counters")).toEqual(["key", "value"]);
    expect(database.prepare("SELECT key, value FROM counters WHERE key = 'requirement'").get()).toEqual({ key: "requirement", value: 0 });
  });
});

describe("requirement code allocation", () => {
  it("allocates committed codes across interleaved connections and rolls back failed allocations", () => {
    const path = databasePath();
    const firstStore = new WorkflowStore(path);
    const secondStore = new WorkflowStore(path);
    stores.push(firstStore, secondStore);
    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");

    const project = firstStore.createProject({
      name: "Shared project",
      repoPath: join(path, "..", "shared-project"),
      defaultBranch: "main",
      allowedCommands: [],
      sensitivePatterns: []
    });
    database.exec(`
      CREATE TRIGGER fail_next_requirement
      BEFORE INSERT ON requirements
      WHEN NEW.title = 'Forced rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    expect(() => firstStore.createRequirement(requirementInput(project.id, "Forced rollback"))).toThrow("forced rollback");
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 0 });
    database.exec("DROP TRIGGER fail_next_requirement");

    const firstCommitted = secondStore.createRequirement(requirementInput(project.id, "First committed"));
    database.exec("BEGIN");
    database.prepare("DELETE FROM requirement_projects WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirement_revisions WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirements WHERE id = ?").run(firstCommitted.id);
    database.exec("COMMIT");
    const secondCommitted = firstStore.createRequirement(requirementInput(project.id, "Second committed"));

    expect([firstCommitted.code, secondCommitted.code]).toEqual(["REQ-0001", "REQ-0002"]);
    expect(new Set([firstCommitted.code, secondCommitted.code]).size).toBe(2);
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 2 });
  });
});
