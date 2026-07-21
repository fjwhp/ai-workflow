import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(async () => {
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

function schemaObjectNames(database: DatabaseSync, type: "index" | "trigger") {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name").all(type) as { name: string }[])
    .map(({ name }) => name);
}

function requirementInput(projectId: string, projectVersionId: string, title: string) {
  return {
    title,
    businessProblem: `${title} business problem`,
    expectedOutcome: `${title} expected outcome`,
    priority: "medium" as const,
    primaryProjectId: projectId,
    primaryProjectVersionId: projectVersionId
  };
}

function createProject(store: WorkflowStore, name: string, repoPath: string) {
  return store.createProject({
    name, repoPath, defaultBranch: "main", allowedCommands: [], sensitivePatterns: []
  });
}

function createVersion(store: WorkflowStore, projectId: string, name = "1.0.0", worktreePath = `/tmp/version-${projectId}`) {
  return store.createProjectVersion({
    projectId, name, branch: `feature/${name}`, baseBranch: "main", worktreePath, headCommit: `head-${name}`
  });
}

describe("project versions fresh schema", () => {
  it("owns branch and worktree state and removes the free integration target", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);

    const projectVersionColumns = columns(database, "project_versions");
    expect(projectVersionColumns).toEqual([
      "id", "project_id", "name", "branch", "base_branch", "worktree_path", "status",
      "head_commit", "created_at", "updated_at", "closed_at"
    ]);
    expect(projectVersionColumns).not.toEqual(expect.arrayContaining([
      ["pending", "requirement", "id"].join("_"),
      ["pending", "integration", "run", "id"].join("_")
    ]));
    expect(columns(database, "requirement_projects")).toContain("project_version_id");
    expect(columns(database, "executions")).toEqual(expect.arrayContaining(["project_version_id", "base_commit"]));
    expect(columns(database, ["integration", "runs"].join("_"))).toEqual([]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(["requirement", "integration", "targets"].join("_"))).toBeUndefined();
    expect(columns(database, "approvals")).not.toContain(["override", "json"].join("_"));
    expect(schemaObjectNames(database, "index")).toEqual([
      "idx_approvals_ai_gate_artifact",
      "idx_artifacts_owner_version",
      "idx_artifacts_requirement_version",
      "idx_automation_job_dedupe",
      "idx_automation_jobs_expired_lease",
      "idx_automation_jobs_owner_version_status",
      "idx_automation_jobs_pending_lease",
      "idx_coding_evidence_delivery_unit_version",
      "idx_delivery_dependency_edge",
      "idx_delivery_evidence_invalidation_active",
      "idx_delivery_quality_evidence_unit_version",
      "idx_delivery_quality_override_unit_version",
      "idx_delivery_quality_run_active",
      "idx_delivery_unit_active_run",
      "idx_delivery_unit_project",
      "idx_executions_delivery_unit_version",
      "idx_project_knowledge_active",
      "idx_requirement_project_snapshots_active",
      "idx_requirement_projects_active_primary",
      "idx_requirement_projects_active_project"
    ]);
    expect(schemaObjectNames(database, "trigger")).toEqual([
      "coding_evidence_immutable_delete",
      "coding_evidence_immutable_update",
      "delivery_contract_evidence_immutable_delete",
      "delivery_contract_evidence_immutable_update",
      "delivery_evidence_invalidation_immutable_delete",
      "delivery_evidence_invalidation_immutable_update",
      "delivery_quality_evidence_immutable_delete",
      "delivery_quality_evidence_immutable_update",
      "delivery_quality_override_immutable_delete",
      "delivery_quality_override_immutable_update",
      "delivery_quality_run_immutable_delete",
      "delivery_quality_run_terminal_update",
      "delivery_stale_decision_immutable_delete",
      "delivery_stale_decision_immutable_update",
      "delivery_stale_decision_source_immutable_delete",
      "delivery_stale_decision_source_immutable_update",
      "delivery_unit_skip_immutable_delete",
      "delivery_unit_skip_immutable_update",
      "delivery_unit_skip_source_immutable_delete",
      "delivery_unit_skip_source_immutable_update",
      "prevent_unresolved_delivery_stale_recovery",
      "requirement_automation_audit_immutable_delete",
      "requirement_automation_audit_immutable_update",
      "validate_artifact_owner_insert",
      "validate_artifact_owner_update",
      "validate_automation_job_owner_insert",
      "validate_automation_job_owner_update",
      "validate_coding_evidence_owner_insert",
      "validate_coding_evidence_owner_update",
      "validate_delivery_contract_evidence_insert",
      "validate_delivery_dependency_owner_insert",
      "validate_delivery_dependency_owner_update",
      "validate_delivery_evidence_invalidation_insert",
      "validate_delivery_quality_evidence_insert",
      "validate_delivery_quality_override_insert",
      "validate_delivery_quality_run_identity_update",
      "validate_delivery_quality_run_insert",
      "validate_delivery_stale_decision_insert",
      "validate_delivery_stale_decision_source_insert",
      "validate_delivery_unit_skip_insert",
      "validate_delivery_unit_skip_source_insert",
      "validate_delivery_unit_snapshot_owner_insert",
      "validate_delivery_unit_snapshot_owner_update",
      "validate_execution_owner_insert",
      "validate_execution_owner_update",
      "validate_stage_run_owner_insert",
      "validate_stage_run_owner_update"
    ]);
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
  it("reports a missing counter and keeps the connection usable after rollback", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);
    const project = createProject(store, "Counter recovery project", join(path, "..", "counter-recovery-project"));
    const version = createVersion(store, project.id, "1.0.0", join(path, "..", "counter-recovery-version"));
    database.prepare("DELETE FROM counters WHERE key = 'requirement'").run();

    expect(() => store.createRequirement(requirementInput(project.id, version.id, "Missing counter")))
      .toThrow("REQUIREMENT_COUNTER_MISSING");
    expect(store.listRequirements()).toEqual([]);

    database.prepare("INSERT INTO counters (key, value) VALUES ('requirement', 0)").run();
    expect(store.createRequirement(requirementInput(project.id, version.id, "Recovered counter")).code).toBe("REQ-0001");
  });

  it("allocates committed codes across interleaved connections and rolls back failed allocations", () => {
    const path = databasePath();
    const firstStore = new WorkflowStore(path);
    const secondStore = new WorkflowStore(path);
    stores.push(firstStore, secondStore);
    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");

    const project = createProject(firstStore, "Shared project", join(path, "..", "shared-project"));
    const version = createVersion(firstStore, project.id, "1.0.0", join(path, "..", "shared-version"));
    database.exec(`
      CREATE TRIGGER fail_next_requirement
      BEFORE INSERT ON requirements
      WHEN NEW.title = 'Forced rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    expect(() => firstStore.createRequirement(requirementInput(project.id, version.id, "Forced rollback"))).toThrow("forced rollback");
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 0 });
    database.exec("DROP TRIGGER fail_next_requirement");

    const firstCommitted = secondStore.createRequirement(requirementInput(project.id, version.id, "First committed"));
    database.exec("BEGIN");
    database.prepare("DELETE FROM requirement_projects WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirement_revisions WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirements WHERE id = ?").run(firstCommitted.id);
    database.exec("COMMIT");
    const secondCommitted = firstStore.createRequirement(requirementInput(project.id, version.id, "Second committed"));

    expect([firstCommitted.code, secondCommitted.code]).toEqual(["REQ-0001", "REQ-0002"]);
    expect(new Set([firstCommitted.code, secondCommitted.code]).size).toBe(2);
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 2 });
  });

  it("validates the primary version inside the allocation transaction and rolls back the code", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Atomic project", "/tmp/atomic-project");
    const other = createProject(store, "Other project", "/tmp/atomic-other");
    const version = createVersion(store, project.id, "1.0.0", "/tmp/atomic-version");
    const otherVersion = createVersion(store, other.id, "1.0.0", "/tmp/atomic-other-version");

    expect(() => store.createRequirement(requirementInput(project.id, otherVersion.id, "Wrong version")))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(store.createRequirement(requirementInput(project.id, version.id, "Committed version")).code).toBe("REQ-0001");
  });
});

describe("project version persistence", () => {
  it("persists a caller-provided id and maps duplicate ids to a stable error", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Explicit ID", "/tmp/project-version-explicit-id");
    const input = {
      id: "version-explicit", projectId: project.id, name: "1.0.0", branch: "feature/explicit",
      baseBranch: "main", worktreePath: "/tmp/version-explicit", headCommit: "explicit-head"
    };

    expect(store.createProjectVersion(input)).toMatchObject({ id: "version-explicit" });
    expect(store.getProjectVersion("version-explicit")).toMatchObject({ name: "1.0.0" });
    expect(() => store.createProjectVersion({
      ...input, name: "2.0.0", branch: "feature/explicit-two", worktreePath: "/tmp/version-explicit-two"
    })).toThrow("PROJECT_VERSION_ID_EXISTS");
  });

  it("creates, lists, gets, and updates a complete joined project version", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "API", "/tmp/project-version-api");
    const version = createVersion(store, project.id, "2.2.1", "/tmp/api-v221");

    expect(version).toMatchObject({
      projectId: project.id, projectName: "API", name: "2.2.1", branch: "feature/2.2.1",
      baseBranch: "main", worktreePath: "/tmp/api-v221", status: "active", headCommit: "head-2.2.1",
      closedAt: undefined
    });
    expect(version.createdAt).toBe(version.updatedAt);
    expect(store.getProjectVersion(version.id)).toEqual(version);
    expect(store.getProjectVersion("missing")).toBeNull();
    expect(store.listProjectVersions(project.id, "active")).toEqual([version]);
    expect(store.listProjectVersions(project.id, "closed")).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.updateProjectVersionHead(version.id, "def456");
    expect(updated).toMatchObject({ id: version.id, headCommit: "def456" });
    expect(updated!.updatedAt > version.updatedAt).toBe(true);
    expect(store.getProjectVersion(version.id)?.headCommit).toBe("def456");
    expect(store.updateProjectVersionHead("missing", "noop")).toBeNull();
  });

  it("does not update a closed version head", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Closed head", "/tmp/project-version-closed-head");
    const version = createVersion(store, project.id, "closed-head", "/tmp/version-closed-head");
    store.closeProjectVersion(version.id);

    expect(store.updateProjectVersionHead(version.id, "unexpected-head")).toBeNull();
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "closed", headCommit: version.headCommit });
  });

  it("does not update an active version head after its project is archived externally", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const database = new DatabaseSync(path); databases.push(database);
    const project = createProject(store, "Archived update", join(path, "..", "archived-update"));
    const version = createVersion(store, project.id, "archived-update", join(path, "..", "archived-update-version"));
    database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project.id);

    expect(store.updateProjectVersionHead(version.id, "unexpected-head")).toBeNull();
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", headCommit: version.headCommit });
  });

  it("does not close an active version after its project is archived externally", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const database = new DatabaseSync(path); databases.push(database);
    const project = createProject(store, "Archived close", join(path, "..", "archived-close"));
    const version = createVersion(store, project.id, "archived-close", join(path, "..", "archived-close-version"));
    database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project.id);

    expect(() => store.closeProjectVersion(version.id)).toThrow("PROJECT_NOT_ACTIVE");
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", closedAt: undefined });
  });

  it("maps unique conflicts to stable errors while scoping name and branch per project", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const first = createProject(store, "First", "/tmp/version-first");
    const second = createProject(store, "Second", "/tmp/version-second");
    createVersion(store, first.id, "2.0.0", "/tmp/version-first-v2");

    expect(() => store.createProjectVersion({ projectId: first.id, name: "2.0.0", branch: "other", baseBranch: "main", worktreePath: "/tmp/version-name-clash", headCommit: "a" }))
      .toThrow("PROJECT_VERSION_NAME_EXISTS");
    expect(() => store.createProjectVersion({ projectId: first.id, name: "other", branch: "feature/2.0.0", baseBranch: "main", worktreePath: "/tmp/version-branch-clash", headCommit: "b" }))
      .toThrow("PROJECT_VERSION_BRANCH_EXISTS");
    expect(() => store.createProjectVersion({ projectId: second.id, name: "2.0.0", branch: "feature/2.0.0", baseBranch: "main", worktreePath: "/tmp/version-first-v2", headCommit: "c" }))
      .toThrow("PROJECT_VERSION_WORKTREE_EXISTS");
    expect(createVersion(store, second.id, "2.0.0", "/tmp/version-second-v2")).toMatchObject({ name: "2.0.0", branch: "feature/2.0.0" });
    store.archiveProject(second.id);
    expect(() => createVersion(store, second.id, "3.0.0", "/tmp/version-archived"))
      .toThrow("PROJECT_NOT_ACTIVE");
  });

  it("blocks close for active requirements and keeps closed history readable", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const project = createProject(store, "Close policy", join(path, "..", "close-project"));
    const version = createVersion(store, project.id, "delivery", join(path, "..", "delivery-version"));
    const requirement = store.createRequirement(requirementInput(project.id, version.id, "Active delivery"));
    expect(store.listVersionRequirements(version.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(() => store.closeProjectVersion(version.id)).toThrow("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
    store.updateRequirementState(requirement.id, "acceptance_delivery", "completed");
    const closed = store.closeProjectVersion(version.id);
    expect(closed).toMatchObject({ id: version.id, status: "closed" });
    expect(closed.closedAt).toBeTruthy();
    expect(store.closeProjectVersion(version.id)).toEqual(closed);
    expect(store.listProjectVersions(project.id, "active")).toEqual([]);
    expect(store.listProjectVersions(project.id, "closed")).toEqual([closed]);
    expect(store.listProjectVersions(project.id, "all")).toHaveLength(1);
    expect(store.getProjectVersion(version.id)).toEqual(closed);
    expect(store.listVersionRequirements(version.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(() => store.closeProjectVersion("missing")).toThrow("PROJECT_VERSION_NOT_FOUND");
  });

  it("preserves archived version associations when a project moves to a new version", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const project = createProject(store, "Version history", join(path, "..", "history-project"));
    const firstVersion = createVersion(store, project.id, "1.0.0", join(path, "..", "history-v1"));
    const secondVersion = createVersion(store, project.id, "2.0.0", join(path, "..", "history-v2"));
    const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, "Version history"));
    const snapshot = store.createRequirementProjectSnapshot(requirement.id);

    store.supersedeRequirementProjectSnapshot(requirement.id);
    store.replaceRequirementProjects(requirement.id, [{
      projectId: project.id, projectVersionId: secondVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    }]);

    expect(store.listRequirementProjects(requirement.id)[0]).toMatchObject({
      projectVersionId: secondVersion.id, status: "active"
    });
    const database = new DatabaseSync(path); databases.push(database);
    expect(database.prepare(`SELECT project_version_id, status FROM requirement_projects
      WHERE requirement_id = ? ORDER BY status`).all(requirement.id)).toEqual([
      { project_version_id: secondVersion.id, status: "active" },
      { project_version_id: firstVersion.id, status: "archived" }
    ]);
    expect(store.listVersionRequirements(firstVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(store.listVersionRequirements(secondVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(snapshot.associations[0]).toMatchObject({ projectVersionId: firstVersion.id, projectVersionHead: "head-1.0.0" });
    expect(store.getRequirementProjectSnapshot(requirement.id)).toBeNull();
    expect(store.listRequirementProjectSnapshots(requirement.id)[0]?.associations[0]).toMatchObject({
      projectVersionId: firstVersion.id, projectVersionHead: "head-1.0.0"
    });
  });

  it.each(["completed", "closed", "cancelled"])(
    "blocks closing a historical version until its requirement is %s",
    (terminalStatus) => {
      const store = new WorkflowStore(":memory:"); stores.push(store);
      const project = createProject(store, `Historical close ${terminalStatus}`, `/tmp/historical-close-${terminalStatus}`);
      const firstVersion = createVersion(store, project.id, "1.0.0", `/tmp/historical-close-${terminalStatus}-v1`);
      const secondVersion = createVersion(store, project.id, "2.0.0", `/tmp/historical-close-${terminalStatus}-v2`);
      const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, `Historical ${terminalStatus}`));
      store.replaceRequirementProjects(requirement.id, [{
        projectId: project.id, projectVersionId: secondVersion.id, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
      }]);

      expect(() => store.closeProjectVersion(firstVersion.id)).toThrow("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
      store.updateRequirementState(requirement.id, "acceptance_delivery", terminalStatus);
      expect(store.closeProjectVersion(firstVersion.id)).toMatchObject({ id: firstVersion.id, status: "closed" });
    }
  );

  it("deduplicates requirements linked to the same version multiple times", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Deduplicated history", "/tmp/deduplicated-history");
    const firstVersion = createVersion(store, project.id, "1.0.0", "/tmp/deduplicated-history-v1");
    const secondVersion = createVersion(store, project.id, "2.0.0", "/tmp/deduplicated-history-v2");
    const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, "Deduplicated history"));
    for (const projectVersionId of [secondVersion.id, firstVersion.id, secondVersion.id]) {
      store.replaceRequirementProjects(requirement.id, [{
        projectId: project.id, projectVersionId, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
      }]);
    }

    expect(store.listVersionRequirements(firstVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(store.listVersionRequirements(secondVersion.id).map((item) => item.id)).toEqual([requirement.id]);
  });
});
