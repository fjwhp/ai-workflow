import type { DatabaseSync } from "node:sqlite";

export function createPhase2Schema(db: DatabaseSync) {
  db.exec(`
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
      stage TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      clarifications TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS delivery_units (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      association_snapshot_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_version_id TEXT NOT NULL,
      required INTEGER NOT NULL,
      position INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('implementation', 'quality_verification', 'acceptance_delivery')),
      status TEXT NOT NULL CHECK(status IN (
        'waiting_dependency', 'ready', 'running', 'awaiting_gate', 'returned',
        'potentially_stale', 'ready_for_acceptance', 'applying', 'applied',
        'conflicted', 'failed', 'skipped'
      )),
      evidence_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(association_snapshot_id) REFERENCES requirement_project_snapshots(id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(project_version_id) REFERENCES project_versions(id)
    );
    CREATE TABLE IF NOT EXISTS delivery_dependencies (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      upstream_unit_id TEXT NOT NULL,
      downstream_unit_id TEXT NOT NULL,
      release_condition TEXT NOT NULL CHECK(release_condition IN ('automated_testing_passed')),
      released_by_evidence_version INTEGER,
      released_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(upstream_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(downstream_unit_id) REFERENCES delivery_units(id)
    );
    CREATE TABLE IF NOT EXISTS delivery_unit_snapshots (
      id TEXT PRIMARY KEY,
      delivery_unit_id TEXT NOT NULL UNIQUE,
      requirement_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_version_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      module_ids_json TEXT NOT NULL,
      sensitive_patterns_json TEXT NOT NULL,
      allowed_commands_json TEXT NOT NULL,
      project_knowledge_version_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(project_version_id) REFERENCES project_versions(id),
      FOREIGN KEY(project_knowledge_version_id) REFERENCES project_knowledge_versions(id)
    );
    CREATE TABLE IF NOT EXISTS stage_runs (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, owner_type TEXT, owner_id TEXT, stage TEXT NOT NULL,
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
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, owner_type TEXT, owner_id TEXT, stage TEXT NOT NULL,
      version INTEGER NOT NULL, title TEXT NOT NULL, content_json TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(requirement_id, stage, version),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
      decision TEXT NOT NULL, comment TEXT NOT NULL, condition_text TEXT,
      target_stage TEXT, actor_type TEXT NOT NULL DEFAULT 'human', artifact_id TEXT,
      reasons_json TEXT NOT NULL DEFAULT '[]', override_json TEXT, return_count INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
      project_id TEXT NOT NULL, project_version_id TEXT, branch TEXT NOT NULL, worktree_path TEXT NOT NULL,
      base_commit TEXT,
      status TEXT NOT NULL, commands_json TEXT NOT NULL, diff_text TEXT NOT NULL,
      error TEXT, codex_thread_id TEXT, events_json TEXT NOT NULL DEFAULT '[]',
      diagnostics_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT,
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
    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('requirement', 'delivery_unit')),
      owner_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'completed', 'failed', 'canceled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_ai_gate_artifact
      ON approvals(artifact_id) WHERE actor_type = 'ai_gate' AND artifact_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_runs_active
      ON integration_runs(requirement_id) WHERE status = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_knowledge_active
      ON project_knowledge_versions(project_id) WHERE status = 'building';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_projects_active_primary
      ON requirement_projects(requirement_id) WHERE role = 'primary' AND status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_projects_active_project
      ON requirement_projects(requirement_id, project_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_project_snapshots_active
      ON requirement_project_snapshots(requirement_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_unit_project
      ON delivery_units(requirement_id, project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_dependency_edge
      ON delivery_dependencies(requirement_id, upstream_unit_id, downstream_unit_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_unit_active_run
      ON stage_runs(owner_type, owner_id, stage) WHERE status = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_job_dedupe
      ON automation_jobs(dedupe_key);
  `);
}
