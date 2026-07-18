import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultGateConfig, returnStage, workflowStages, type GateConfig, type ProjectVersion, type RequirementInput, type RequirementProject, type RequirementProjectInput, type WorkflowStage } from "@ai-workflow/shared";
import { buildHumanOverrideEligibility, buildHumanOverrideSnapshot } from "./human-override.js";
import { validateRequirementProjects } from "./requirement-projects.js";

export class WorkflowStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL, allowed_commands TEXT NOT NULL DEFAULT '[]',
        sensitive_patterns TEXT NOT NULL DEFAULT '[]', category TEXT, technology_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active','closed')),
        head_commit TEXT NOT NULL,
        pending_requirement_id TEXT,
        pending_integration_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE(project_id,name),
        UNIQUE(project_id,branch),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO counters (key,value)
        SELECT 'requirement',0 WHERE NOT EXISTS (SELECT 1 FROM counters WHERE key = 'requirement');
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        business_problem TEXT NOT NULL, expected_outcome TEXT NOT NULL, priority TEXT NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requirement_projects (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_version_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('primary', 'collaborator')),
        usage TEXT NOT NULL CHECK(usage IN ('context', 'delivery')),
        delivery_required INTEGER NOT NULL,
        module_mode TEXT NOT NULL CHECK(module_mode IN ('auto', 'all', 'selected')),
        module_ids_json TEXT NOT NULL DEFAULT '[]',
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(requirement_id, project_id),
        FOREIGN KEY(requirement_id) REFERENCES requirements(id),
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(project_version_id) REFERENCES project_versions(id)
      );
      CREATE TABLE IF NOT EXISTS requirement_project_snapshots (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        associations_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
        superseded_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(requirement_id, version),
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS stage_runs (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
        status TEXT NOT NULL, model TEXT, input_json TEXT NOT NULL, output_json TEXT,
        error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS stage_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence), FOREIGN KEY(run_id) REFERENCES stage_runs(id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
        version INTEGER NOT NULL, title TEXT NOT NULL, content_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(requirement_id, stage, version),
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
        decision TEXT NOT NULL, comment TEXT NOT NULL, condition_text TEXT,
        target_stage TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
        project_id TEXT NOT NULL, project_version_id TEXT, branch TEXT NOT NULL, worktree_path TEXT NOT NULL,
        base_commit TEXT,
        status TEXT NOT NULL, commands_json TEXT NOT NULL, diff_text TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id),
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(project_version_id) REFERENCES project_versions(id)
      );
      CREATE TABLE IF NOT EXISTS requirement_revisions (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, version INTEGER NOT NULL,
        title TEXT NOT NULL, business_problem TEXT NOT NULL, expected_outcome TEXT NOT NULL,
        priority TEXT NOT NULL, clarifications TEXT NOT NULL DEFAULT '', change_summary TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(requirement_id, version),
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coding_evidence (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, requirement_id TEXT NOT NULL, project_id TEXT NOT NULL,
        branch TEXT NOT NULL, worktree_path TEXT NOT NULL, diff_hash TEXT NOT NULL, diff_text TEXT NOT NULL,
        original_chars INTEGER NOT NULL, truncated INTEGER NOT NULL, files_json TEXT NOT NULL,
        additions INTEGER NOT NULL, deletions INTEGER NOT NULL, diagnostics_text TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(execution_id) REFERENCES executions(id), FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS rework_contexts (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE, artifact_id TEXT,
        source_stage TEXT NOT NULL, target_stage TEXT NOT NULL, actor_type TEXT NOT NULL, decision_at TEXT NOT NULL,
        unstructured INTEGER NOT NULL, items_json TEXT NOT NULL, risks_json TEXT NOT NULL, questions_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      CREATE TABLE IF NOT EXISTS integration_runs (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, project_id TEXT NOT NULL, project_version_id TEXT,
        execution_id TEXT, evidence_id TEXT, status TEXT NOT NULL,
        source_branch TEXT NOT NULL, worktree_path TEXT NOT NULL, target_branch TEXT NOT NULL,
        source_commit TEXT, target_commit TEXT, pre_apply_head TEXT,
        resolution_status TEXT, resolution_commit TEXT, preflight_json TEXT NOT NULL,
        commands_json TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id),
        FOREIGN KEY(project_version_id) REFERENCES project_versions(id)
      );
      CREATE TABLE IF NOT EXISTS project_knowledge_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
        source_head TEXT NOT NULL, refresh_reason TEXT NOT NULL, summary TEXT, entries_json TEXT NOT NULL DEFAULT '[]',
        entry_count INTEGER NOT NULL DEFAULT 0, module_count INTEGER NOT NULL DEFAULT 0, error TEXT,
        created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(project_id,version), FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_records (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject_key TEXT NOT NULL, layer TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id,subject_key), FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_record_versions (
        id TEXT PRIMARY KEY, record_id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        modules_json TEXT NOT NULL, tags_json TEXT NOT NULL, evidence_json TEXT NOT NULL, source_requirement_id TEXT NOT NULL,
        source_stage TEXT NOT NULL, confidence REAL NOT NULL, risk_level TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(record_id,version), FOREIGN KEY(record_id) REFERENCES knowledge_records(id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, project_id TEXT NOT NULL, subject_key TEXT NOT NULL,
        status TEXT NOT NULL, publish_decision TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(requirement_id,subject_key), FOREIGN KEY(requirement_id) REFERENCES requirements(id), FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_change_sets (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, status TEXT NOT NULL,
        published_count INTEGER NOT NULL, review_count INTEGER NOT NULL, conflict_count INTEGER NOT NULL,
        created_at TEXT NOT NULL, completed_at TEXT NOT NULL, FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
    `);
    this.ensureColumn("requirements", "version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("projects", "category", "TEXT");
    this.ensureColumn("projects", "technology_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("projects", "status", "TEXT NOT NULL DEFAULT 'active'");
    this.ensureColumn("projects", "updated_at", "TEXT");
    this.ensureColumn("requirements", "clarifications", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("executions", "codex_thread_id", "TEXT");
    this.ensureColumn("executions", "events_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("executions", "diagnostics_text", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("approvals", "actor_type", "TEXT NOT NULL DEFAULT 'human'");
    this.ensureColumn("approvals", "artifact_id", "TEXT");
    this.ensureColumn("approvals", "reasons_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("approvals", "override_json", "TEXT");
    this.ensureColumn("approvals", "return_count", "INTEGER");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_ai_gate_artifact ON approvals(artifact_id) WHERE actor_type = 'ai_gate' AND artifact_id IS NOT NULL");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_runs_active ON integration_runs(requirement_id) WHERE status = 'running'");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_knowledge_active ON project_knowledge_versions(project_id) WHERE status = 'building'");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_projects_active_primary ON requirement_projects(requirement_id) WHERE role = 'primary' AND status = 'active'");
    this.migrateRequirementProjectSnapshots();
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_project_snapshots_active ON requirement_project_snapshots(requirement_id) WHERE status = 'active'");
  }

  private migrateRequirementProjectSnapshots() {
    const columns = this.db.prepare("PRAGMA table_info(requirement_project_snapshots)").all() as { name: string }[];
    if (columns.some(({ name }) => name === "status")) return;
    this.db.exec(`
      ALTER TABLE requirement_project_snapshots RENAME TO requirement_project_snapshots_legacy;
      CREATE TABLE requirement_project_snapshots (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, version INTEGER NOT NULL,
        associations_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
        superseded_at TEXT, created_at TEXT NOT NULL, UNIQUE(requirement_id, version),
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );
      INSERT INTO requirement_project_snapshots (id, requirement_id, version, associations_json, status, created_at)
        SELECT id, requirement_id, version, associations_json, 'active', created_at FROM requirement_project_snapshots_legacy;
      DROP TABLE requirement_project_snapshots_legacy;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createRequirement(input: RequirementInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const association = validateRequirementProjects([{
        projectId: input.primaryProjectId, projectVersionId: input.primaryProjectVersionId,
        role: "primary", usage: "delivery", deliveryRequired: true,
        moduleMode: "auto", moduleIds: [], position: 0
      }], {
        projects: this.projectValidationRows([input.primaryProjectId]),
        versions: this.versionValidationRows([input.primaryProjectVersionId])
      })[0]!;
      const code = this.nextRequirementCode();
      this.db.prepare(`INSERT INTO requirements
        (id, code, title, business_problem, expected_outcome, priority, stage, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'prd', 'ai_ready', ?, ?)`)
        .run(id, code, input.title, input.businessProblem, input.expectedOutcome, input.priority, now, now);
      this.insertRequirementRevision(id, 1, { ...input, clarifications: "" }, "创建需求", now);
      this.insertRequirementAssociation(id, association, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getRequirement(id)!;
  }

  private nextRequirementCode() {
    const row = this.db.prepare(
      "UPDATE counters SET value = value + 1 WHERE key = 'requirement' RETURNING value"
    ).get() as { value: number } | undefined;
    if (!row) throw new Error("REQUIREMENT_COUNTER_MISSING");
    return `REQ-${String(row.value).padStart(4, "0")}`;
  }

  listRequirements() {
    return this.db.prepare("SELECT r.* FROM requirements r ORDER BY r.created_at DESC").all()
      .map((row) => this.mapRequirementWithProjects(row as any));
  }

  getRequirement(id: string) {
    const row = this.db.prepare("SELECT r.* FROM requirements r WHERE r.id = ?").get(id);
    return row ? this.mapRequirementWithProjects(row as any) : null;
  }

  setRequirementProject(id: string, projectId: string | null, projectVersionId?: string): any {
    if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(id)) return null;
    if (!projectId || !projectVersionId || !this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(projectId)) return null;
    this.replaceRequirementProjects(id, [{ projectId, projectVersionId, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 0 }]);
    return this.getRequirement(id);
  }

  private insertRequirementAssociation(requirementId: string, input: RequirementProjectInput, now: string) {
    this.db.prepare(`INSERT INTO requirement_projects
      (id, requirement_id, project_id, project_version_id, role, usage, delivery_required, module_mode, module_ids_json, position, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(randomUUID(), requirementId, input.projectId, input.projectVersionId ?? null, input.role, input.usage, input.deliveryRequired ? 1 : 0,
        input.moduleMode, JSON.stringify(input.moduleIds), input.position, now, now);
  }

  listRequirementProjects(requirementId: string): RequirementProject[] {
    return (this.db.prepare(`SELECT rp.*, p.name AS project_name, p.status AS project_status,
        pv.name AS project_version_name, pv.branch AS project_version_branch,
        pv.status AS project_version_status, pv.worktree_path AS project_version_worktree_path,
        pv.head_commit AS project_version_head
      FROM requirement_projects rp JOIN projects p ON p.id = rp.project_id
      LEFT JOIN project_versions pv ON pv.id = rp.project_version_id
      WHERE rp.requirement_id = ? AND rp.status = 'active' ORDER BY rp.position, rp.created_at`).all(requirementId) as any[])
      .map(mapRequirementProject);
  }

  listArchivedRequirementProjectHistory(requirementId: string): RequirementProject[] {
    return (this.db.prepare(`SELECT rp.*, p.name AS project_name, p.status AS project_status,
        pv.name AS project_version_name, pv.branch AS project_version_branch,
        pv.status AS project_version_status, pv.worktree_path AS project_version_worktree_path,
        pv.head_commit AS project_version_head
      FROM requirement_projects rp JOIN projects p ON p.id = rp.project_id
      LEFT JOIN project_versions pv ON pv.id = rp.project_version_id
      WHERE rp.requirement_id = ? AND rp.status = 'archived' AND p.status = 'archived'
      ORDER BY rp.position, rp.created_at`).all(requirementId) as any[]).map(mapRequirementProject);
  }

  replaceRequirementProjects(requirementId: string, inputs: RequirementProjectInput[]): RequirementProject[] {
    const projectIds = [...new Set(inputs.map((item) => item.projectId))];
    const versionIds = [...new Set(inputs.flatMap((item) => item.projectVersionId ? [item.projectVersionId] : []))];
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(requirementId)) throw new Error("REQUIREMENT_NOT_FOUND");
      const validated = validateRequirementProjects(inputs, {
        projects: this.projectValidationRows(projectIds),
        versions: this.versionValidationRows(versionIds),
        modulesByProject: this.moduleIndexes(projectIds)
      });
      this.db.prepare("UPDATE requirement_projects SET status = 'archived', updated_at = ? WHERE requirement_id = ? AND status = 'active'").run(now, requirementId);
      for (const input of validated) {
        const existing = this.db.prepare("SELECT id FROM requirement_projects WHERE requirement_id = ? AND project_id = ?").get(requirementId, input.projectId) as { id: string } | undefined;
        if (existing) {
          this.db.prepare(`UPDATE requirement_projects SET project_version_id = ?, role = ?, usage = ?, delivery_required = ?, module_mode = ?,
            module_ids_json = ?, position = ?, status = 'active', updated_at = ? WHERE id = ?`)
            .run(input.projectVersionId ?? null, input.role, input.usage, input.deliveryRequired ? 1 : 0, input.moduleMode, JSON.stringify(input.moduleIds), input.position, now, existing.id);
        } else this.insertRequirementAssociation(requirementId, input, now);
      }
      this.db.prepare("UPDATE requirements SET updated_at = ? WHERE id = ?").run(now, requirementId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.listRequirementProjects(requirementId);
  }

  createRequirementProjectSnapshot(requirementId: string) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(requirementId)) throw new Error("REQUIREMENT_NOT_FOUND");
      const associations = this.listRequirementProjects(requirementId);
      const version = (this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM requirement_project_snapshots WHERE requirement_id = ?").get(requirementId) as { version: number }).version;
      const item = { id: randomUUID(), requirementId, version, associations, status: "active" as const, supersededAt: null, createdAt: now };
      this.db.prepare("UPDATE requirement_project_snapshots SET status = 'superseded', superseded_at = ? WHERE requirement_id = ? AND status = 'active'").run(now, requirementId);
      this.db.prepare(`INSERT INTO requirement_project_snapshots
        (id, requirement_id, version, associations_json, status, superseded_at, created_at) VALUES (?, ?, ?, ?, 'active', NULL, ?)`)
        .run(item.id, requirementId, version, JSON.stringify(associations), now);
      this.db.exec("COMMIT");
      return item;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getRequirementProjectSnapshot(requirementId: string) {
    const row = this.db.prepare("SELECT * FROM requirement_project_snapshots WHERE requirement_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(requirementId) as any;
    return row ? mapRequirementProjectSnapshot(row) : null;
  }

  listRequirementProjectSnapshots(requirementId: string) {
    return (this.db.prepare("SELECT * FROM requirement_project_snapshots WHERE requirement_id = ? ORDER BY version DESC").all(requirementId) as any[])
      .map(mapRequirementProjectSnapshot);
  }

  supersedeRequirementProjectSnapshot(requirementId: string) {
    this.db.prepare("UPDATE requirement_project_snapshots SET status = 'superseded', superseded_at = ? WHERE requirement_id = ? AND status = 'active'")
      .run(new Date().toISOString(), requirementId);
  }

  invalidateTechnicalDesignForProjectChange(requirementId: string) {
    const requirement = this.getRequirement(requirementId);
    if (!requirement || workflowStages.indexOf(requirement.stage) < workflowStages.indexOf("technical_design")) return false;
    const approved = this.db.prepare("SELECT id FROM approvals WHERE requirement_id = ? AND stage = 'technical_design' AND decision = 'approve' LIMIT 1").get(requirementId);
    const artifact = this.db.prepare("SELECT id FROM artifacts WHERE requirement_id = ? AND stage = 'technical_design' LIMIT 1").get(requirementId);
    if (!approved || !artifact || !this.getRequirementProjectSnapshot(requirementId)) return false;
    const reason = "项目关联或模块范围发生变化";
    this.addApproval(requirementId, "technical_design", { decision: "return", comment: reason, targetStage: "technical_design", actorType: "system", reasons: [reason] });
    this.supersedeRequirementProjectSnapshot(requirementId);
    this.updateRequirementState(requirementId, "technical_design", "ai_ready");
    return true;
  }

  projectHasActiveDelivery(projectId: string) {
    return Boolean(this.db.prepare(`SELECT r.id FROM requirements r JOIN requirement_projects rp ON rp.requirement_id = r.id
      WHERE rp.project_id = ? AND rp.status = 'active' AND rp.usage = 'delivery'
      AND r.stage IN ('coding','code_review','testing','acceptance','integration') AND r.status != 'completed' LIMIT 1`).get(projectId));
  }

  private projectValidationRows(projectIds: string[]) {
    if (!projectIds.length) return [];
    const placeholders = projectIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT id, status FROM projects WHERE id IN (${placeholders})`).all(...projectIds) as Array<{ id: string; status: string }>;
  }

  private versionValidationRows(versionIds: string[]) {
    const result = new Map<string, { id: string; projectId: string; status: string }>();
    if (!versionIds.length) return result;
    const placeholders = versionIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, project_id, status FROM project_versions WHERE id IN (${placeholders})`)
      .all(...versionIds) as Array<{ id: string; project_id: string; status: string }>;
    for (const row of rows) result.set(row.id, { id: row.id, projectId: row.project_id, status: row.status });
    return result;
  }

  private moduleIndexes(projectIds: string[]) {
    const result = new Map<string, string[]>();
    for (const projectId of projectIds) {
      const project = this.getProject(projectId);
      const row = this.db.prepare(`SELECT entries_json FROM project_knowledge_versions
        WHERE project_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1`).get(projectId) as { entries_json: string } | undefined;
      const entries = row ? JSON.parse(row.entries_json) as any[] : [];
      const modules = entries.filter((entry) => entry.kind === "module").flatMap((entry) => [entry.moduleId, entry.id, entry.path].filter((value): value is string => typeof value === "string"));
      const detected = (project?.technology ?? []).filter((value: unknown): value is string => typeof value === "string");
      if (modules.length || detected.length) result.set(projectId, [...modules, ...detected]);
    }
    return result;
  }

  private mapRequirementWithProjects(row: any) {
    const projects = this.listRequirementProjects(row.id);
    const primary = projects.find((item) => item.role === "primary");
    const deliveries = projects.filter((item) => item.status === "active" && item.usage === "delivery");
    const delivery = deliveries.length === 1 ? deliveries[0] : null;
    return {
      ...mapRequirement(row), projects,
      primaryProjectId: primary?.projectId, primaryProjectName: primary?.projectName,
      projectId: delivery?.projectId, projectName: delivery?.projectName
    };
  }

  reviseRequirement(id: string, input: any) {
    const current = this.getRequirement(id);
    if (!current || !["returned", "blocked", "draft"].includes(current.status)) return null;
    const version = (current.version ?? 1) + 1;
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const resumeStage = current.stage === "intake" ? "prd" : current.stage;
      this.db.prepare(`UPDATE requirements SET title = ?, business_problem = ?, expected_outcome = ?, priority = ?,
        clarifications = ?, version = ?, stage = ?, status = 'ai_ready', updated_at = ? WHERE id = ?`)
        .run(input.title, input.businessProblem, input.expectedOutcome, input.priority, input.clarifications ?? "", version, resumeStage, now, id);
      if (!this.db.prepare("SELECT id FROM requirement_revisions WHERE requirement_id = ? AND version = 1").get(id)) {
        this.insertRequirementRevision(id, 1, current, "历史版本", current.createdAt);
      }
      this.insertRequirementRevision(id, version, input, input.changeSummary ?? "根据打回意见补充需求", now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getRequirement(id);
  }

  private insertRequirementRevision(requirementId: string, version: number, input: any, changeSummary: string, createdAt: string) {
    this.db.prepare("INSERT INTO requirement_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), requirementId, version, input.title, input.businessProblem, input.expectedOutcome,
      input.priority, input.clarifications ?? "", changeSummary, createdAt
    );
  }

  listRequirementRevisions(requirementId: string) {
    return this.db.prepare("SELECT * FROM requirement_revisions WHERE requirement_id = ? ORDER BY version DESC").all(requirementId).map((row: any) => ({
      id: row.id, requirementId: row.requirement_id, version: row.version, title: row.title,
      businessProblem: row.business_problem, expectedOutcome: row.expected_outcome, priority: row.priority,
      clarifications: row.clarifications, changeSummary: row.change_summary, createdAt: row.created_at
    }));
  }

  updateRequirementState(id: string, stage: WorkflowStage, status: string) {
    this.db.prepare("UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(stage, status, new Date().toISOString(), id);
    return this.getRequirement(id);
  }

  addArtifact(requirementId: string, stage: WorkflowStage, title: string, content: unknown) {
    const versionRow = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts WHERE requirement_id = ? AND stage = ?")
      .get(requirementId, stage) as { version: number };
    const artifact = { id: randomUUID(), requirementId, stage, version: versionRow.version, title, content, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(artifact.id, requirementId, stage, artifact.version, title, JSON.stringify(content), artifact.createdAt);
    return artifact;
  }

  listArtifacts(requirementId: string) {
    return this.db.prepare("SELECT * FROM artifacts WHERE requirement_id = ? ORDER BY created_at DESC").all(requirementId).map((row: any) => ({
      id: row.id, requirementId: row.requirement_id, stage: row.stage, version: row.version,
      title: row.title, content: JSON.parse(row.content_json), createdAt: row.created_at
    }));
  }

  createStageRun(input: { requirementId: string; stage: WorkflowStage; model: string; input: unknown }) {
    const active = this.db.prepare("SELECT id FROM stage_runs WHERE requirement_id = ? AND stage = ? AND status = 'running'").get(input.requirementId, input.stage);
    if (active) throw new Error("RUN_ALREADY_ACTIVE");
    const item = { id: randomUUID(), ...input, status: "running", createdAt: new Date().toISOString(), completedAt: null };
    this.db.prepare("INSERT INTO stage_runs (id, requirement_id, stage, status, model, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(item.id, item.requirementId, item.stage, item.status, item.model, JSON.stringify(item.input), item.createdAt);
    this.appendStageRunEvent(item.id, "run.started", { stage: item.stage, model: item.model });
    return item;
  }

  appendStageRunEvent(runId: string, type: string, payload: unknown) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM stage_run_events WHERE run_id = ?").get(runId) as { sequence: number };
    const event = { id: randomUUID(), runId, sequence: row.sequence, type, payload, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO stage_run_events VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, runId, event.sequence, type, JSON.stringify(payload), event.createdAt);
    return event;
  }

  getStageRun(id: string) {
    const row = this.db.prepare("SELECT * FROM stage_runs WHERE id = ?").get(id) as any;
    if (!row) return null;
    const events = this.db.prepare("SELECT * FROM stage_run_events WHERE run_id = ? ORDER BY sequence").all(id).map(mapStageRunEvent);
    return mapStageRun(row, events);
  }

  listStageRuns(requirementId: string, stage?: WorkflowStage) {
    const rows = stage
      ? this.db.prepare("SELECT * FROM stage_runs WHERE requirement_id = ? AND stage = ? ORDER BY created_at DESC").all(requirementId, stage)
      : this.db.prepare("SELECT * FROM stage_runs WHERE requirement_id = ? ORDER BY created_at DESC").all(requirementId);
    return rows.map((row: any) => mapStageRun(row, []));
  }

  completeStageRun(id: string, output: unknown) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE stage_runs SET status = 'completed', output_json = ?, completed_at = ? WHERE id = ?").run(JSON.stringify(output), now, id);
    this.appendStageRunEvent(id, "run.completed", { completedAt: now });
    return this.getStageRun(id);
  }

  failStageRun(id: string, error: string, status = "failed") {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE stage_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").run(status, error, now, id);
    this.appendStageRunEvent(id, status === "interrupted" ? "run.interrupted" : "run.failed", { error });
    return this.getStageRun(id);
  }

  interruptActiveStageRuns() {
    const rows = this.db.prepare("SELECT id FROM stage_runs WHERE status = 'running'").all() as { id: string }[];
    rows.forEach(({ id }) => this.failStageRun(id, "服务进程已重启，运行被中断", "interrupted"));
    return rows.length;
  }

  recoverInterruptedRequirements() {
    const result = this.db.prepare(`UPDATE requirements SET status = 'ai_ready', updated_at = ?
      WHERE status = 'ai_running' AND NOT EXISTS (
        SELECT 1 FROM stage_runs WHERE stage_runs.requirement_id = requirements.id
          AND stage_runs.stage = requirements.stage AND stage_runs.status = 'running'
      )`).run(new Date().toISOString());
    return Number(result.changes);
  }

  addApproval(requirementId: string, stage: WorkflowStage, input: any) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO approvals
      (id, requirement_id, stage, decision, comment, condition_text, target_stage, created_at, actor_type, artifact_id, reasons_json, override_json, return_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requirementId, stage, input.decision, input.comment, input.condition ?? null, input.targetStage ?? null, now,
        input.actorType ?? "human", input.artifactId ?? null, JSON.stringify(input.reasons ?? []), input.override ? JSON.stringify(input.override) : null, input.returnCount ?? null);
    return { id, requirement_id: requirementId, stage, decision: input.decision, comment: input.comment, target_stage: input.targetStage ?? null, created_at: now, actor_type: input.actorType ?? "human", artifact_id: input.artifactId ?? null, return_count: input.returnCount ?? null, override: input.override ?? null };
  }

  listApprovals(requirementId: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE requirement_id = ? ORDER BY created_at DESC").all(requirementId).map((row: any) => ({
      ...row, override: row.override_json ? JSON.parse(row.override_json) : null
    }));
  }

  applyHumanOverride(requirementId: string, stage: "code_review" | "testing", comment: string) {
    this.db.exec("BEGIN");
    try {
      const requirement: any = this.getRequirement(requirementId);
      const artifact = this.listArtifacts(requirementId).find((item: any) => item.stage === stage);
      const eligibility = buildHumanOverrideEligibility({ stage: requirement?.stage ?? "", status: requirement?.status ?? "", artifact });
      if (!requirement || requirement.stage !== stage || !eligibility.allowed) throw new Error(eligibility.reason || "HUMAN_OVERRIDE_NOT_ALLOWED");
      const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE requirement_id = ? AND stage = ? AND decision = 'return'").get(requirementId, stage) as { count: number };
      const snapshot = buildHumanOverrideSnapshot({ stage, comment, artifact, returnCount: countRow.count });
      const approval = this.addApproval(requirementId, stage, {
        decision: "approve", comment: snapshot.comment, targetStage: snapshot.targetStage,
        actorType: "human_override", artifactId: snapshot.artifactId, returnCount: snapshot.returnCount, override: snapshot
      });
      this.db.prepare("UPDATE requirements SET stage = ?, status = 'ai_ready', updated_at = ? WHERE id = ?")
        .run(snapshot.targetStage, new Date().toISOString(), requirementId);
      this.db.exec("COMMIT");
      return { requirement: this.getRequirement(requirementId), approval };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createIntegrationRun(input: any) {
    if (this.db.prepare("SELECT id FROM integration_runs WHERE requirement_id = ? AND status = 'running'").get(input.requirementId)) throw new Error("INTEGRATION_ALREADY_ACTIVE");
    const item = { id: randomUUID(), status: "running", createdAt: new Date().toISOString(), ...input };
    this.db.prepare(`INSERT INTO integration_runs
      (id,requirement_id,project_id,execution_id,evidence_id,status,source_branch,worktree_path,target_branch,preflight_json,commands_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,item.requirementId,item.projectId,item.executionId??null,item.evidenceId??null,item.status,item.sourceBranch,item.worktreePath,item.targetBranch,JSON.stringify(item.preflight??{}),JSON.stringify([]),item.createdAt);
    return this.getIntegrationRun(item.id);
  }

  completeIntegrationRun(id: string, result: any) {
    const now = new Date().toISOString();
    const current:any=this.db.prepare("SELECT preflight_json FROM integration_runs WHERE id = ?").get(id);
    const preflight={...JSON.parse(current?.preflight_json||"{}"),conflictFiles:result.conflictFiles??[]};
    this.db.prepare(`UPDATE integration_runs SET status=?,source_commit=?,target_commit=?,preflight_json=?,commands_json=?,error=?,completed_at=? WHERE id=?`)
      .run(result.status,result.sourceCommit??null,result.targetCommit??null,JSON.stringify(preflight),JSON.stringify(result.commandResults??[]),result.error??null,now,id);
    return this.getIntegrationRun(id);
  }

  getIntegrationRun(id: string) { const row:any=this.db.prepare("SELECT * FROM integration_runs WHERE id = ?").get(id); return row?mapIntegrationRun(row):null; }
  getLatestIntegrationRun(requirementId: string) { const row:any=this.db.prepare("SELECT * FROM integration_runs WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 1").get(requirementId); return row?mapIntegrationRun(row):null; }
  interruptActiveIntegrationRuns(){return Number(this.db.prepare("UPDATE integration_runs SET status='failed',error='服务进程已重启，合并操作被中断',completed_at=? WHERE status='running'").run(new Date().toISOString()).changes);}

  getGateConfig(): GateConfig {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = 'gate_config'").get() as { value_json: string } | undefined;
    return row ? { ...defaultGateConfig, ...JSON.parse(row.value_json) } : { ...defaultGateConfig, mandatoryHumanStages: [...defaultGateConfig.mandatoryHumanStages] };
  }

  updateGateConfig(config: GateConfig) {
    const value = { ...config, mandatoryHumanStages: [...config.mandatoryHumanStages] };
    this.db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('gate_config', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(value), new Date().toISOString());
    return this.getGateConfig();
  }

  applyGateDecision(input: { requirementId: string; stage: WorkflowStage; artifactId: string; decision: "auto_approve" | "auto_return" | "human_review"; reasons: string[] }) {
    if (this.db.prepare("SELECT id FROM approvals WHERE actor_type = 'ai_gate' AND artifact_id = ?").get(input.artifactId)) return { applied: false, requirement: this.getRequirement(input.requirementId) };
    const now = new Date().toISOString();
    let gateApproval: any;
    this.db.exec("BEGIN");
    try {
      const approvalDecision = input.decision === "auto_approve" ? "approve" : input.decision === "auto_return" ? "return" : "review";
      const targetStage = input.decision === "auto_return" ? returnStage(input.stage) : null;
      gateApproval = this.addApproval(input.requirementId, input.stage, {
        decision: approvalDecision, comment: input.reasons.join("；"), targetStage,
        actorType: "ai_gate", artifactId: input.artifactId, reasons: input.reasons
      });
      if (input.decision === "auto_approve") {
        const index = workflowStages.indexOf(input.stage);
        const nextStage = workflowStages[index + 1];
        this.db.prepare("UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(nextStage ?? input.stage, input.stage === "acceptance" ? "awaiting_merge" : nextStage ? "ai_ready" : "completed", now, input.requirementId);
      } else if (input.decision === "auto_return") {
        this.db.prepare("UPDATE requirements SET stage = ?, status = 'returned', updated_at = ? WHERE id = ?")
          .run(targetStage, now, input.requirementId);
      } else {
        this.db.prepare("UPDATE requirements SET status = 'awaiting_approval', updated_at = ? WHERE id = ?").run(now, input.requirementId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { applied: true, requirement: this.getRequirement(input.requirementId), approval: gateApproval };
  }

  createProject(input: any) {
    const repoPath = canonicalRepoPath(input.repoPath);
    if (this.findProjectByRepoPath(repoPath)) throw new Error("PROJECT_REPO_PATH_EXISTS");
    const now = new Date().toISOString();
    const item = { id: randomUUID(), ...input, repoPath, category: input.category ?? null, technology: input.technology ?? [], status: "active", createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO projects (id,name,repo_path,default_branch,allowed_commands,sensitive_patterns,category,technology_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.name, item.repoPath, item.defaultBranch,
      JSON.stringify(item.allowedCommands ?? []), JSON.stringify(item.sensitivePatterns ?? []), item.category, JSON.stringify(item.technology), item.status, item.createdAt, item.updatedAt);
    return item;
  }

  createProjectVersion(input: {
    projectId: string;
    name: string;
    branch: string;
    baseBranch: string;
    worktreePath: string;
    headCommit: string;
  }): ProjectVersion {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(input.projectId)) {
        throw new Error("PROJECT_NOT_ACTIVE");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE project_id = ? AND name = ?").get(input.projectId, input.name)) {
        throw new Error("PROJECT_VERSION_NAME_EXISTS");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE project_id = ? AND branch = ?").get(input.projectId, input.branch)) {
        throw new Error("PROJECT_VERSION_BRANCH_EXISTS");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE worktree_path = ?").get(input.worktreePath)) {
        throw new Error("PROJECT_VERSION_WORKTREE_EXISTS");
      }
      this.db.prepare(`INSERT INTO project_versions
        (id, project_id, name, branch, base_branch, worktree_path, status, head_commit,
         pending_requirement_id, pending_integration_run_id, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?, NULL)`)
        .run(id, input.projectId, input.name, input.branch, input.baseBranch, input.worktreePath, input.headCommit, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw mapProjectVersionConstraint(error);
    }
    return this.getProjectVersion(id)!;
  }

  listProjectVersions(projectId: string, status: "active" | "closed" | "all"): ProjectVersion[] {
    const statusClause = status === "all" ? "" : " AND pv.status = ?";
    const parameters = status === "all" ? [projectId] : [projectId, status];
    return (this.db.prepare(`SELECT pv.*, p.name AS project_name FROM project_versions pv
      JOIN projects p ON p.id = pv.project_id WHERE pv.project_id = ?${statusClause}
      ORDER BY pv.created_at DESC`).all(...parameters) as any[]).map(mapProjectVersion);
  }

  getProjectVersion(id: string): ProjectVersion | null {
    const row = this.db.prepare(`SELECT pv.*, p.name AS project_name FROM project_versions pv
      JOIN projects p ON p.id = pv.project_id WHERE pv.id = ?`).get(id);
    return row ? mapProjectVersion(row as any) : null;
  }

  updateProjectVersionHead(id: string, headCommit: string): ProjectVersion | null {
    const result = this.db.prepare("UPDATE project_versions SET head_commit = ?, updated_at = ? WHERE id = ?")
      .run(headCommit, new Date().toISOString(), id);
    return result.changes ? this.getProjectVersion(id) : null;
  }

  closeProjectVersion(id: string): ProjectVersion {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.db.prepare("SELECT * FROM project_versions WHERE id = ?").get(id) as any;
      if (!version) throw new Error("PROJECT_VERSION_NOT_FOUND");
      if (version.status === "closed") {
        this.db.exec("COMMIT");
        return this.getProjectVersion(id)!;
      }
      if (version.pending_requirement_id || version.pending_integration_run_id) {
        throw new Error("PROJECT_VERSION_CLOSE_BLOCKED");
      }
      const activeRequirement = this.db.prepare(`SELECT r.id FROM requirements r
        JOIN requirement_projects rp ON rp.requirement_id = r.id
        WHERE rp.project_version_id = ? AND rp.status = 'active'
          AND r.status NOT IN ('completed', 'closed', 'cancelled') LIMIT 1`).get(id);
      if (activeRequirement) throw new Error("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE project_versions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      this.db.exec("COMMIT");
      return this.getProjectVersion(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listVersionRequirements(id: string): any[] {
    return (this.db.prepare(`SELECT DISTINCT r.* FROM requirements r
      JOIN requirement_projects rp ON rp.requirement_id = r.id
      WHERE rp.project_version_id = ? ORDER BY r.created_at DESC`).all(id) as any[])
      .map((row) => this.mapRequirementWithProjects(row));
  }

  updateProject(id: string, input: any) {
    const current = this.getProject(id);
    if (!current) return null;
    const repoPath = input.repoPath === undefined ? current.repoPath : canonicalRepoPath(input.repoPath);
    const duplicate = this.findProjectByRepoPath(repoPath);
    if (duplicate && duplicate.id !== id) throw new Error("PROJECT_REPO_PATH_EXISTS");
    const item = { ...current, ...input, repoPath, category: input.category === undefined ? current.category : input.category, updatedAt: new Date().toISOString() };
    this.db.prepare(`UPDATE projects SET name=?,repo_path=?,default_branch=?,allowed_commands=?,sensitive_patterns=?,category=?,technology_json=?,updated_at=? WHERE id=?`)
      .run(item.name, item.repoPath, item.defaultBranch, JSON.stringify(item.allowedCommands), JSON.stringify(item.sensitivePatterns), item.category, JSON.stringify(item.technology), item.updatedAt, id);
    return this.getProject(id);
  }

  archiveProject(id: string) {
    if (!this.getProject(id)) return null;
    this.db.prepare("UPDATE projects SET status='archived',updated_at=? WHERE id=? AND status!='archived'").run(new Date().toISOString(), id);
    return this.getProject(id);
  }

  beginProjectKnowledge(projectId:string,sourceHead:string,refreshReason:string){
    const row=this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM project_knowledge_versions WHERE project_id=?").get(projectId) as {version:number};
    const item={id:randomUUID(),projectId,version:row.version,status:"building",sourceHead,refreshReason,createdAt:new Date().toISOString()};
    this.db.prepare(`INSERT INTO project_knowledge_versions (id,project_id,version,status,source_head,refresh_reason,created_at) VALUES (?,?,?,?,?,?,?)`).run(item.id,projectId,item.version,item.status,sourceHead,refreshReason,item.createdAt);
    return item;
  }

  completeProjectKnowledge(id:string,input:{summary:string;entries:any[]}){
    const completedAt=new Date().toISOString(),modules=new Set(input.entries.filter(entry=>entry.kind==="module").map(entry=>entry.path)).size;
    this.db.prepare("UPDATE project_knowledge_versions SET status='ready',summary=?,entries_json=?,entry_count=?,module_count=?,completed_at=? WHERE id=? AND status='building'").run(input.summary,JSON.stringify(input.entries),input.entries.length,modules,completedAt,id);
    return this.getProjectKnowledgeVersion(id);
  }

  failProjectKnowledge(id:string,error:string){this.db.prepare("UPDATE project_knowledge_versions SET status='failed',error=?,completed_at=? WHERE id=? AND status='building'").run(error,new Date().toISOString(),id);return this.getProjectKnowledgeVersion(id);}
  cancelBuildingProjectKnowledge(projectId:string,reason:string){return Number(this.db.prepare("UPDATE project_knowledge_versions SET status='canceled',error=?,completed_at=? WHERE project_id=? AND status='building'").run(reason,new Date().toISOString(),projectId).changes);}
  getProjectKnowledgeVersion(id:string){const row:any=this.db.prepare("SELECT * FROM project_knowledge_versions WHERE id=?").get(id);return row?mapProjectKnowledge(row):null;}
  getLatestProjectKnowledge(projectId:string){const row:any=this.db.prepare("SELECT * FROM project_knowledge_versions WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId);return row?mapProjectKnowledge(row):null;}
  getProjectKnowledgeStatus(projectId:string){return this.getLatestProjectKnowledge(projectId)??{projectId,status:"missing",version:0};}
  listProjectKnowledgeVersions(projectId:string){return (this.db.prepare("SELECT * FROM project_knowledge_versions WHERE project_id=? ORDER BY version DESC").all(projectId) as any[]).map(mapProjectKnowledge);}
  interruptActiveProjectKnowledge(){return Number(this.db.prepare("UPDATE project_knowledge_versions SET status='failed',error='服务进程已重启，知识库生成被中断',completed_at=? WHERE status='building'").run(new Date().toISOString()).changes);}

  replaceKnowledgeCandidates(requirementId:string,projectId:string,candidates:any[]){
    const now=new Date().toISOString();this.db.exec("BEGIN");
    try{this.db.prepare("DELETE FROM knowledge_candidates WHERE requirement_id=?").run(requirementId);const insert=this.db.prepare("INSERT INTO knowledge_candidates VALUES (?,?,?,?,?,?,?,?,?)");
      for(const candidate of candidates)insert.run(randomUUID(),requirementId,projectId,candidate.subjectKey,"candidate",candidate.publishDecision,JSON.stringify(candidate),now,now);
      this.db.exec("COMMIT");return this.listKnowledgeCandidates(requirementId);
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  listKnowledgeCandidates(requirementId:string){return (this.db.prepare("SELECT * FROM knowledge_candidates WHERE requirement_id=? ORDER BY created_at").all(requirementId) as any[]).map(row=>({...JSON.parse(row.payload_json),id:row.id,status:row.status,publishDecision:row.publish_decision,createdAt:row.created_at,updatedAt:row.updated_at}));}

  publishKnowledgeCandidates(requirementId:string){
    const candidates=this.listKnowledgeCandidates(requirementId).filter((item:any)=>item.status==="candidate");const projectId=candidates[0]?.projectId;if(!projectId)throw new Error("PROJECT_REQUIRED");
    const now=new Date().toISOString();let publishedCount=0,reviewCount=0,conflictCount=0;this.db.exec("BEGIN");
    try{for(const candidate of candidates){if(candidate.publishDecision==="human_review"||candidate.riskLevel==="high"){this.db.prepare("UPDATE knowledge_candidates SET status='review',updated_at=? WHERE id=?").run(now,candidate.id);reviewCount++;continue;}
        const record:any=this.db.prepare("SELECT * FROM knowledge_records WHERE project_id=? AND subject_key=?").get(projectId,candidate.subjectKey);
        if(record){const active:any=this.db.prepare("SELECT content FROM knowledge_record_versions WHERE record_id=? AND version=?").get(record.id,record.current_version);if(active?.content!==candidate.content){this.db.prepare("UPDATE knowledge_candidates SET status='conflict',updated_at=? WHERE id=?").run(now,candidate.id);conflictCount++;}else this.db.prepare("UPDATE knowledge_candidates SET status='published',updated_at=? WHERE id=?").run(now,candidate.id);continue;}
        const recordId=randomUUID();this.db.prepare("INSERT INTO knowledge_records VALUES (?,?,?,?,?,'active',1,?,?)").run(recordId,projectId,candidate.subjectKey,candidate.layer,candidate.type,now,now);
        this.db.prepare("INSERT INTO knowledge_record_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),recordId,1,candidate.title,candidate.content,JSON.stringify(candidate.modules||[]),JSON.stringify(candidate.tags||[]),JSON.stringify(candidate.evidence||[]),requirementId,candidate.sourceStage,candidate.confidence,candidate.riskLevel,now);
        this.db.prepare("UPDATE knowledge_candidates SET status='published',updated_at=? WHERE id=?").run(now,candidate.id);publishedCount++;}
      const status=conflictCount?"conflict":reviewCount?"review":"published";this.db.prepare("INSERT INTO knowledge_change_sets VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(requirement_id) DO UPDATE SET status=excluded.status,published_count=excluded.published_count,review_count=excluded.review_count,conflict_count=excluded.conflict_count,completed_at=excluded.completed_at").run(randomUUID(),requirementId,projectId,status,publishedCount,reviewCount,conflictCount,now,now);
      this.db.exec("COMMIT");return {status,publishedCount,reviewCount,conflictCount,candidates:this.listKnowledgeCandidates(requirementId)};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  getKnowledgeChangeSet(requirementId:string){const row:any=this.db.prepare("SELECT * FROM knowledge_change_sets WHERE requirement_id=?").get(requirementId);return row?{id:row.id,requirementId:row.requirement_id,projectId:row.project_id,status:row.status,publishedCount:row.published_count,reviewCount:row.review_count,conflictCount:row.conflict_count,createdAt:row.created_at,completedAt:row.completed_at,candidates:this.listKnowledgeCandidates(requirementId)}:{status:"candidate",publishedCount:0,reviewCount:0,conflictCount:0,candidates:this.listKnowledgeCandidates(requirementId)};}

  listProjectMemory(projectId:string){const rows=this.db.prepare(`SELECT r.*,v.title,v.content,v.modules_json,v.tags_json,v.evidence_json,v.source_requirement_id,v.source_stage,v.confidence,v.risk_level,v.created_at AS version_created_at FROM knowledge_records r JOIN knowledge_record_versions v ON v.record_id=r.id AND v.version=r.current_version WHERE r.project_id=? ORDER BY r.updated_at DESC`).all(projectId) as any[];const records=rows.map(row=>({id:row.id,projectId:row.project_id,subjectKey:row.subject_key,layer:row.layer,type:row.type,status:row.status,version:row.current_version,title:row.title,content:row.content,modules:JSON.parse(row.modules_json),tags:JSON.parse(row.tags_json),evidence:JSON.parse(row.evidence_json),sourceRequirementId:row.source_requirement_id,sourceStage:row.source_stage,confidence:row.confidence,riskLevel:row.risk_level,createdAt:row.version_created_at}));return {records,total:records.length,layers:Object.fromEntries(["source_fact","project_rule","decision","requirement_experience"].map(layer=>[layer,records.filter(item=>item.layer===layer).length]))};}

  listProjects(options: { activeOnly?: boolean } = {}) {
    const sql = `SELECT * FROM projects${options.activeOnly ? " WHERE status = 'active'" : ""} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all().map(mapProject);
  }

  getProject(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? mapProject(row as any) : null;
  }

  findProjectByRepoPath(repoPath: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(canonicalRepoPath(repoPath));
    return row ? mapProject(row as any) : null;
  }

  addExecution(input: any) {
    const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db.prepare(`INSERT INTO executions
      (id, requirement_id, stage, project_id, branch, worktree_path, status, commands_json, diff_text, error, created_at, completed_at, codex_thread_id, events_json, diagnostics_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
      item.id, item.requirementId, item.stage, item.projectId, item.branch, item.worktreePath,
      item.status, JSON.stringify(item.commands ?? []), item.diff ?? "", item.error ?? null,
      item.createdAt, item.completedAt ?? null, item.codexThreadId ?? null,
      JSON.stringify(item.events ?? []), item.diagnostics ?? ""
    );
    return item;
  }

  listExecutions(requirementId: string) {
    return this.db.prepare("SELECT * FROM executions WHERE requirement_id = ? ORDER BY created_at DESC").all(requirementId).map((row: any) => ({
      id: row.id, requirementId: row.requirement_id, stage: row.stage, projectId: row.project_id,
      branch: row.branch, worktreePath: row.worktree_path, status: row.status,
      commands: JSON.parse(row.commands_json), diff: row.diff_text, error: row.error,
      codexThreadId: row.codex_thread_id, events: JSON.parse(row.events_json || "[]"), diagnostics: row.diagnostics_text,
      createdAt: row.created_at, completedAt: row.completed_at
    }));
  }

  addCodingEvidence(input: any) {
    const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db.prepare(`INSERT INTO coding_evidence
      (id, execution_id, requirement_id, project_id, branch, worktree_path, diff_hash, diff_text, original_chars, truncated, files_json, additions, deletions, diagnostics_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.executionId, item.requirementId, item.projectId, item.branch, item.worktreePath, item.diffHash, item.diff,
        item.originalChars, item.truncated ? 1 : 0, JSON.stringify(item.files ?? []), item.additions ?? 0, item.deletions ?? 0, item.diagnostics ?? "", item.createdAt);
    return item;
  }

  getLatestCodingEvidence(requirementId: string) {
    const row = this.db.prepare("SELECT * FROM coding_evidence WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 1").get(requirementId);
    return row ? mapCodingEvidence(row as any) : null;
  }

  addReworkContext(requirementId: string,input:any){
    const item={id:randomUUID(),requirementId,createdAt:new Date().toISOString(),...input};
    this.db.prepare(`INSERT INTO rework_contexts
      (id,requirement_id,approval_id,artifact_id,source_stage,target_stage,actor_type,decision_at,unstructured,items_json,risks_json,questions_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,requirementId,item.approvalId,item.artifactId??null,item.sourceStage,item.targetStage,item.actorType,item.decisionAt,item.unstructured?1:0,JSON.stringify(item.items||[]),JSON.stringify(item.risks||[]),JSON.stringify(item.openQuestions||[]),item.createdAt);
    return item;
  }

  getLatestReworkContext(requirementId:string){
    const row=this.db.prepare("SELECT * FROM rework_contexts WHERE requirement_id=? ORDER BY decision_at DESC LIMIT 1").get(requirementId) as any;
    return row?{id:row.id,requirementId:row.requirement_id,approvalId:row.approval_id,artifactId:row.artifact_id,sourceStage:row.source_stage,targetStage:row.target_stage,actorType:row.actor_type,decisionAt:row.decision_at,unstructured:Boolean(row.unstructured),items:JSON.parse(row.items_json),risks:JSON.parse(row.risks_json),openQuestions:JSON.parse(row.questions_json),createdAt:row.created_at}:null;
  }

  close() { this.db.close(); }
}

function mapRequirement(row: any) {
  return {
    id: row.id, code: row.code, title: row.title, businessProblem: row.business_problem,
    expectedOutcome: row.expected_outcome, priority: row.priority, projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined, version: row.version ?? 1, clarifications: row.clarifications ?? "",
    stage: row.stage, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRequirementProject(row: any): RequirementProject & {
  projectVersionWorktreePath?: string;
  projectVersionHead?: string;
} {
  return {
    id: row.id, requirementId: row.requirement_id, projectId: row.project_id, projectName: row.project_name,
    projectVersionId: row.project_version_id ?? undefined,
    projectVersionName: row.project_version_name ?? undefined,
    projectVersionBranch: row.project_version_branch ?? undefined,
    projectVersionStatus: row.project_version_status ?? undefined,
    projectVersionWorktreePath: row.project_version_worktree_path ?? undefined,
    projectVersionHead: row.project_version_head ?? undefined,
    role: row.role, usage: row.usage, deliveryRequired: Boolean(row.delivery_required), moduleMode: row.module_mode,
    moduleIds: JSON.parse(row.module_ids_json || "[]"), position: row.position, status: row.status,
    projectStatus: row.project_status,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRequirementProjectSnapshot(row: any) {
  return {
    id: row.id, requirementId: row.requirement_id, version: row.version,
    associations: JSON.parse(row.associations_json || "[]"), status: row.status,
    supersededAt: row.superseded_at, createdAt: row.created_at
  };
}

function mapProject(row: any) {
  return { id: row.id, name: row.name, repoPath: row.repo_path, defaultBranch: row.default_branch,
    allowedCommands: JSON.parse(row.allowed_commands || "[]"), sensitivePatterns: JSON.parse(row.sensitive_patterns || "[]"),
    category: row.category ?? null, technology: JSON.parse(row.technology_json || "[]"), status: row.status || "active",
    createdAt: row.created_at, updatedAt: row.updated_at || row.created_at };
}

function mapProjectVersion(row: any): ProjectVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    name: row.name,
    branch: row.branch,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    status: row.status,
    headCommit: row.head_commit,
    pendingRequirementId: row.pending_requirement_id ?? undefined,
    pendingIntegrationRunId: row.pending_integration_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined
  };
}

function mapProjectVersionConstraint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("project_versions.project_id, project_versions.name")) return new Error("PROJECT_VERSION_NAME_EXISTS");
  if (message.includes("project_versions.project_id, project_versions.branch")) return new Error("PROJECT_VERSION_BRANCH_EXISTS");
  if (message.includes("project_versions.worktree_path")) return new Error("PROJECT_VERSION_WORKTREE_EXISTS");
  return error;
}

function canonicalRepoPath(repoPath: string) {
  const resolved = resolve(repoPath);
  try { return realpathSync(resolved); }
  catch { return resolved; }
}

function mapStageRun(row: any, events: any[]) {
  return { id: row.id, requirementId: row.requirement_id, stage: row.stage, status: row.status, model: row.model,
    input: JSON.parse(row.input_json || "null"), output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error, createdAt: row.created_at, completedAt: row.completed_at, events };
}

function mapStageRunEvent(row: any) {
  return { id: row.id, runId: row.run_id, sequence: row.sequence, type: row.type,
    payload: JSON.parse(row.payload_json), createdAt: row.created_at };
}

function mapCodingEvidence(row: any) {
  return { id: row.id, executionId: row.execution_id, requirementId: row.requirement_id, projectId: row.project_id,
    branch: row.branch, worktreePath: row.worktree_path, diffHash: row.diff_hash, diff: row.diff_text,
    originalChars: row.original_chars, truncated: Boolean(row.truncated), files: JSON.parse(row.files_json || "[]"),
    fileCount: JSON.parse(row.files_json || "[]").length, additions: row.additions, deletions: row.deletions,
    diagnostics: row.diagnostics_text, createdAt: row.created_at };
}

function mapIntegrationRun(row:any){return {id:row.id,requirementId:row.requirement_id,projectId:row.project_id,executionId:row.execution_id,evidenceId:row.evidence_id,status:row.status,sourceBranch:row.source_branch,worktreePath:row.worktree_path,targetBranch:row.target_branch,sourceCommit:row.source_commit,targetCommit:row.target_commit,preflight:JSON.parse(row.preflight_json||"{}"),commandResults:JSON.parse(row.commands_json||"[]"),error:row.error,createdAt:row.created_at,completedAt:row.completed_at};}
function mapProjectKnowledge(row:any){return {id:row.id,projectId:row.project_id,version:row.version,status:row.status,sourceHead:row.source_head,refreshReason:row.refresh_reason,summary:row.summary??"",entries:JSON.parse(row.entries_json||"[]"),entryCount:row.entry_count,moduleCount:row.module_count,error:row.error,createdAt:row.created_at,completedAt:row.completed_at};}
