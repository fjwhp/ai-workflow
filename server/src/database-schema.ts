import type { DatabaseSync } from "node:sqlite";
import { MAX_AUTOMATION_EVIDENCE_VERSION } from "@ai-workflow/shared";
import { MAX_EVIDENCE_TOTAL_BYTES } from "./evidence-tree.js";

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
      acceptance_criteria_json TEXT NOT NULL,
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
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('requirement', 'delivery_unit')),
      owner_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL DEFAULT 1 CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      stage TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
      CHECK(
        (owner_type IS NULL AND owner_id IS NULL)
        OR (owner_type IS NOT NULL AND owner_id IS NOT NULL AND owner_type IN ('requirement', 'delivery_unit'))
      ),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, stage TEXT NOT NULL,
      decision TEXT NOT NULL, comment TEXT NOT NULL, condition_text TEXT,
      target_stage TEXT, actor_type TEXT NOT NULL DEFAULT 'human', artifact_id TEXT,
      reasons_json TEXT NOT NULL DEFAULT '[]', return_count INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      stage TEXT NOT NULL,
      project_id TEXT NOT NULL, project_version_id TEXT, branch TEXT NOT NULL, worktree_path TEXT NOT NULL,
      base_commit TEXT,
      status TEXT NOT NULL, commands_json TEXT NOT NULL, diff_text TEXT NOT NULL,
      error TEXT, codex_thread_id TEXT, events_json TEXT NOT NULL DEFAULT '[]',
      diagnostics_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(project_version_id) REFERENCES project_versions(id),
      UNIQUE(delivery_unit_id, evidence_version)
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
      id TEXT PRIMARY KEY CHECK(
        instr(id, char(0)) = 0
        AND length(id) BETWEEN 1 AND 256
        AND id = trim(id, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')
      ),
      dedupe_key TEXT NOT NULL CHECK(
        instr(dedupe_key, char(0)) = 0 AND length(dedupe_key) BETWEEN 1 AND 512
      ),
      owner_type TEXT NOT NULL CHECK(
        instr(owner_type, char(0)) = 0 AND owner_type IN ('requirement', 'delivery_unit')
      ),
      owner_id TEXT NOT NULL CHECK(
        instr(owner_id, char(0)) = 0
        AND length(owner_id) BETWEEN 1 AND 256
        AND owner_id NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      action TEXT NOT NULL CHECK(
        instr(action, char(0)) = 0 AND action IN ('implement', 'review', 'test', 'apply')
      ),
      status TEXT NOT NULL CHECK(
        instr(status, char(0)) = 0 AND status IN ('pending', 'leased', 'completed', 'failed', 'canceled')
      ),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt) = 'integer' AND attempt >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(
        typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 100
      ),
      lease_owner TEXT CHECK(
        lease_owner IS NULL OR (
          instr(lease_owner, char(0)) = 0
          AND length(lease_owner) BETWEEN 1 AND 128
          AND lease_owner NOT GLOB '*[^A-Za-z0-9_-]*'
          AND lease_owner = trim(lease_owner, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')
        )
      ),
      lease_expires_at TEXT CHECK(
        lease_expires_at IS NULL OR instr(lease_expires_at, char(0)) = 0
      ),
      payload_json TEXT NOT NULL DEFAULT '{}'
        CHECK(
          instr(payload_json, char(0)) = 0
          AND json_valid(payload_json)
          AND length(CAST(payload_json AS BLOB)) <= 65536
        ),
      last_error TEXT CHECK(
        last_error IS NULL OR (
          instr(last_error, char(0)) = 0 AND length(last_error) <= 4096
        )
      ),
      created_at TEXT NOT NULL CHECK(
        instr(created_at, char(0)) = 0
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
      ),
      updated_at TEXT NOT NULL CHECK(
        instr(updated_at, char(0)) = 0
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
        AND updated_at >= created_at
      ),
      CHECK(
        dedupe_key = action || ':' ||
          CASE WHEN owner_type = 'delivery_unit' THEN owner_id ELSE 'requirement:' || owner_id END ||
          ':v' || CAST(evidence_version AS TEXT)
      ),
      CHECK(
        (status = 'pending' AND attempt < max_attempts)
        OR (status = 'leased' AND attempt BETWEEN 1 AND max_attempts)
        OR (status NOT IN ('pending', 'leased') AND attempt <= max_attempts)
      ),
      CHECK(
        lease_expires_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) = lease_expires_at
          AND lease_expires_at > updated_at
        )
      ),
      CHECK(
        (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS coding_evidence (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL, worktree_path TEXT NOT NULL, diff_hash TEXT NOT NULL, diff_text TEXT NOT NULL,
      source_repo_path TEXT NOT NULL, git_common_dir TEXT NOT NULL, source_head TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, changed_files_json TEXT NOT NULL,
      original_chars INTEGER NOT NULL, truncated INTEGER NOT NULL, files_json TEXT NOT NULL,
      additions INTEGER NOT NULL, deletions INTEGER NOT NULL, diagnostics_text TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK(
        length(CAST(diff_text AS BLOB)) + length(CAST(manifest_json AS BLOB))
          + length(CAST(changed_files_json AS BLOB)) <= ${MAX_EVIDENCE_TOTAL_BYTES}
      ),
      FOREIGN KEY(execution_id) REFERENCES executions(id),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      UNIQUE(delivery_unit_id, evidence_version)
    );
    CREATE TABLE IF NOT EXISTS delivery_quality_runs (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      kind TEXT NOT NULL CHECK(kind IN ('code_review', 'automated_testing')),
      claim_token TEXT NOT NULL CHECK(instr(claim_token, char(0)) = 0 AND length(claim_token) BETWEEN 1 AND 256),
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'aborted')),
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK(
        (status = 'running' AND error IS NULL AND completed_at IS NULL)
        OR (status IN ('completed', 'failed') AND error IS NULL AND completed_at IS NOT NULL)
        OR (status = 'aborted' AND error IS NOT NULL AND completed_at IS NOT NULL)
      ),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      UNIQUE(delivery_unit_id, evidence_version, kind)
    );
    CREATE TABLE IF NOT EXISTS delivery_quality_evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      kind TEXT NOT NULL CHECK(kind IN ('code_review', 'automated_testing')),
      result TEXT NOT NULL CHECK(result IN ('passed', 'failed')),
      input_coding_evidence_id TEXT NOT NULL,
      input_evidence_version INTEGER NOT NULL,
      input_diff_hash TEXT NOT NULL,
      content_json TEXT NOT NULL,
      command_results_json TEXT NOT NULL DEFAULT '[]',
      acceptance_trace_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES delivery_quality_runs(id),
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(input_coding_evidence_id) REFERENCES coding_evidence(id),
      UNIQUE(delivery_unit_id, evidence_version, kind)
    );
    CREATE TABLE IF NOT EXISTS delivery_quality_overrides (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      kind TEXT NOT NULL CHECK(kind IN ('code_review', 'automated_testing')),
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(instr(reason, char(0)) = 0 AND length(trim(reason)) BETWEEN 1 AND 4096),
      accepted_risk TEXT NOT NULL CHECK(
        instr(accepted_risk, char(0)) = 0 AND length(trim(accepted_risk)) BETWEEN 1 AND 4096
      ),
      coding_evidence_id TEXT NOT NULL,
      input_diff_hash TEXT NOT NULL,
      quality_evidence_id TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL CHECK(
        instr(evidence_ids_json, char(0)) = 0 AND json_valid(evidence_ids_json)
          AND json_type(evidence_ids_json) = 'array' AND json_array_length(evidence_ids_json) > 0
      ),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(coding_evidence_id) REFERENCES coding_evidence(id),
      FOREIGN KEY(quality_evidence_id) REFERENCES delivery_quality_evidence(id),
      UNIQUE(delivery_unit_id, evidence_version, kind)
    );
    CREATE TABLE IF NOT EXISTS delivery_contract_evidence (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK(
        typeof(evidence_version) = 'integer' AND evidence_version BETWEEN 1 AND ${MAX_AUTOMATION_EVIDENCE_VERSION}
      ),
      contract_hash TEXT NOT NULL CHECK(
        instr(contract_hash, char(0)) = 0 AND length(trim(contract_hash)) BETWEEN 1 AND 256
      ),
      content_json TEXT NOT NULL CHECK(
        instr(content_json, char(0)) = 0 AND json_valid(content_json)
          AND length(CAST(content_json AS BLOB)) <= 1048576
      ),
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id),
      UNIQUE(delivery_unit_id, evidence_version)
    );
    CREATE TABLE IF NOT EXISTS delivery_evidence_invalidations (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      source_unit_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('implementation', 'contract')),
      source_old_evidence_id TEXT NOT NULL,
      source_old_evidence_version INTEGER NOT NULL,
      source_old_evidence_hash TEXT NOT NULL,
      source_new_evidence_id TEXT NOT NULL,
      source_new_evidence_version INTEGER NOT NULL,
      source_new_evidence_hash TEXT NOT NULL,
      target_unit_id TEXT NOT NULL,
      target_evidence_version INTEGER NOT NULL,
      prior_phase TEXT NOT NULL CHECK(prior_phase IN ('implementation', 'quality_verification', 'acceptance_delivery')),
      prior_status TEXT NOT NULL,
      earliest_invalid_phase TEXT NOT NULL CHECK(earliest_invalid_phase IN ('implementation', 'quality_verification')),
      cause TEXT NOT NULL CHECK(instr(cause, char(0)) = 0 AND length(trim(cause)) BETWEEN 1 AND 4096),
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(source_unit_id) REFERENCES delivery_units(id),
      FOREIGN KEY(target_unit_id) REFERENCES delivery_units(id),
      UNIQUE(source_kind, source_unit_id, source_new_evidence_id,
        source_new_evidence_version, target_unit_id, target_evidence_version)
    );
    CREATE TABLE IF NOT EXISTS delivery_stale_decisions (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL,
      target_evidence_version INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('reuse', 'rerun')),
      resulting_evidence_version INTEGER NOT NULL,
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(instr(reason, char(0)) = 0 AND length(trim(reason)) BETWEEN 1 AND 4096),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id)
    );
    CREATE TABLE IF NOT EXISTS delivery_stale_decision_sources (
      decision_id TEXT NOT NULL,
      invalidation_id TEXT NOT NULL UNIQUE,
      source_current_evidence_id TEXT NOT NULL,
      source_current_evidence_version INTEGER NOT NULL,
      source_current_evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(decision_id, invalidation_id),
      FOREIGN KEY(decision_id) REFERENCES delivery_stale_decisions(id),
      FOREIGN KEY(invalidation_id) REFERENCES delivery_evidence_invalidations(id)
    );
    CREATE TABLE IF NOT EXISTS requirement_automation_state (
      requirement_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused')),
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(instr(reason, char(0)) = 0 AND length(trim(reason)) BETWEEN 1 AND 4096),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS requirement_automation_audit (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('pause', 'resume', 'pause_conflict', 'resume_conflict')),
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(instr(reason, char(0)) = 0 AND length(trim(reason)) BETWEEN 1 AND 4096),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
    );
    CREATE TABLE IF NOT EXISTS delivery_unit_skips (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      delivery_unit_id TEXT NOT NULL UNIQUE,
      evidence_version INTEGER NOT NULL,
      actor TEXT NOT NULL CHECK(instr(actor, char(0)) = 0 AND length(trim(actor)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(instr(reason, char(0)) = 0 AND length(trim(reason)) BETWEEN 1 AND 4096),
      created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id),
      FOREIGN KEY(delivery_unit_id) REFERENCES delivery_units(id)
    );
    CREATE TABLE IF NOT EXISTS rework_contexts (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE, artifact_id TEXT,
      source_stage TEXT NOT NULL, target_stage TEXT NOT NULL, actor_type TEXT NOT NULL, decision_at TEXT NOT NULL,
      unstructured INTEGER NOT NULL, items_json TEXT NOT NULL, risks_json TEXT NOT NULL, questions_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(requirement_id) REFERENCES requirements(id)
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_owner_version
      ON artifacts(owner_type, owner_id, stage, version)
      WHERE owner_type IS NOT NULL AND owner_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_requirement_version
      ON artifacts(requirement_id, stage, version)
      WHERE owner_type IS NULL AND owner_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_job_dedupe
      ON automation_jobs(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_pending_lease
      ON automation_jobs(status, created_at, id)
      WHERE status = 'pending' AND attempt < max_attempts;
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_expired_lease
      ON automation_jobs(status, lease_expires_at)
      WHERE status = 'leased';
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_owner_version_status
      ON automation_jobs(owner_type, owner_id, evidence_version, status);
    CREATE INDEX IF NOT EXISTS idx_executions_delivery_unit_version
      ON executions(delivery_unit_id, evidence_version);
    CREATE INDEX IF NOT EXISTS idx_coding_evidence_delivery_unit_version
      ON coding_evidence(delivery_unit_id, evidence_version);
    CREATE INDEX IF NOT EXISTS idx_delivery_quality_evidence_unit_version
      ON delivery_quality_evidence(delivery_unit_id, evidence_version, kind);
    CREATE INDEX IF NOT EXISTS idx_delivery_quality_override_unit_version
      ON delivery_quality_overrides(delivery_unit_id, evidence_version, kind);
    CREATE INDEX IF NOT EXISTS idx_delivery_evidence_invalidation_active
      ON delivery_evidence_invalidations(target_unit_id, target_evidence_version, created_at);
    DROP TRIGGER IF EXISTS validate_stage_run_owner_insert;
    DROP TRIGGER IF EXISTS validate_stage_run_owner_update;
    CREATE TRIGGER validate_stage_run_owner_insert
    BEFORE INSERT ON stage_runs
    BEGIN
      SELECT RAISE(ABORT, 'OWNER_NOT_FOUND')
      WHERE NEW.owner_id IS NOT NULL AND ((NEW.owner_type = 'requirement' AND NOT EXISTS (
        SELECT 1 FROM requirements WHERE id = NEW.owner_id
      )) OR (NEW.owner_type = 'delivery_unit' AND NOT EXISTS (
        SELECT 1 FROM delivery_units WHERE id = NEW.owner_id
      )));
      SELECT RAISE(ABORT, 'OWNER_REQUIREMENT_MISMATCH')
      WHERE (NEW.owner_type = 'requirement' AND NEW.owner_id <> NEW.requirement_id)
        OR (NEW.owner_type = 'delivery_unit' AND EXISTS (
          SELECT 1 FROM delivery_units WHERE id = NEW.owner_id AND requirement_id <> NEW.requirement_id
        ));
      SELECT RAISE(ABORT, 'OWNER_EVIDENCE_VERSION_MISMATCH')
      WHERE NEW.owner_type = 'delivery_unit' AND EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.owner_id AND evidence_version <> NEW.evidence_version
      );
    END;
    CREATE TRIGGER validate_stage_run_owner_update
    BEFORE UPDATE OF owner_type, owner_id, requirement_id, evidence_version ON stage_runs
    BEGIN
      SELECT RAISE(ABORT, 'STAGE_RUN_IDENTITY_IMMUTABLE')
      WHERE NEW.owner_type IS NOT OLD.owner_type
        OR NEW.owner_id IS NOT OLD.owner_id
        OR NEW.requirement_id IS NOT OLD.requirement_id
        OR NEW.evidence_version IS NOT OLD.evidence_version;
    END;
    CREATE TRIGGER IF NOT EXISTS validate_artifact_owner_insert
    BEFORE INSERT ON artifacts
    BEGIN
      SELECT RAISE(ABORT, 'OWNER_NOT_FOUND')
      WHERE NEW.owner_id IS NOT NULL AND ((NEW.owner_type = 'requirement' AND NOT EXISTS (
        SELECT 1 FROM requirements WHERE id = NEW.owner_id
      )) OR (NEW.owner_type = 'delivery_unit' AND NOT EXISTS (
        SELECT 1 FROM delivery_units WHERE id = NEW.owner_id
      )));
      SELECT RAISE(ABORT, 'OWNER_REQUIREMENT_MISMATCH')
      WHERE (NEW.owner_type = 'requirement' AND NEW.owner_id <> NEW.requirement_id)
        OR (NEW.owner_type = 'delivery_unit' AND EXISTS (
          SELECT 1 FROM delivery_units WHERE id = NEW.owner_id AND requirement_id <> NEW.requirement_id
        ));
    END;
    CREATE TRIGGER IF NOT EXISTS validate_artifact_owner_update
    BEFORE UPDATE OF owner_type, owner_id, requirement_id ON artifacts
    BEGIN
      SELECT RAISE(ABORT, 'OWNER_NOT_FOUND')
      WHERE NEW.owner_id IS NOT NULL AND ((NEW.owner_type = 'requirement' AND NOT EXISTS (
        SELECT 1 FROM requirements WHERE id = NEW.owner_id
      )) OR (NEW.owner_type = 'delivery_unit' AND NOT EXISTS (
        SELECT 1 FROM delivery_units WHERE id = NEW.owner_id
      )));
      SELECT RAISE(ABORT, 'OWNER_REQUIREMENT_MISMATCH')
      WHERE (NEW.owner_type = 'requirement' AND NEW.owner_id <> NEW.requirement_id)
        OR (NEW.owner_type = 'delivery_unit' AND EXISTS (
          SELECT 1 FROM delivery_units WHERE id = NEW.owner_id AND requirement_id <> NEW.requirement_id
        ));
    END;
    CREATE TRIGGER IF NOT EXISTS validate_automation_job_owner_insert
    BEFORE INSERT ON automation_jobs
    BEGIN
      SELECT RAISE(ABORT, 'OWNER_NOT_FOUND')
      WHERE (NEW.owner_type = 'requirement' AND NOT EXISTS (
        SELECT 1 FROM requirements WHERE id = NEW.owner_id
      )) OR (NEW.owner_type = 'delivery_unit' AND NOT EXISTS (
        SELECT 1 FROM delivery_units WHERE id = NEW.owner_id
      ));
    END;
    CREATE TRIGGER IF NOT EXISTS validate_automation_job_owner_update
    BEFORE UPDATE OF owner_type, owner_id ON automation_jobs
    BEGIN
      SELECT RAISE(ABORT, 'OWNER_NOT_FOUND')
      WHERE (NEW.owner_type = 'requirement' AND NOT EXISTS (
        SELECT 1 FROM requirements WHERE id = NEW.owner_id
      )) OR (NEW.owner_type = 'delivery_unit' AND NOT EXISTS (
        SELECT 1 FROM delivery_units WHERE id = NEW.owner_id
      ));
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_dependency_owner_insert
    BEFORE INSERT ON delivery_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_DEPENDENCY_SELF_EDGE')
      WHERE NEW.upstream_unit_id = NEW.downstream_unit_id;
      SELECT RAISE(ABORT, 'DELIVERY_DEPENDENCY_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.upstream_unit_id AND requirement_id = NEW.requirement_id
      ) OR NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.downstream_unit_id AND requirement_id = NEW.requirement_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_dependency_owner_update
    BEFORE UPDATE OF requirement_id, upstream_unit_id, downstream_unit_id ON delivery_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_DEPENDENCY_SELF_EDGE')
      WHERE NEW.upstream_unit_id = NEW.downstream_unit_id;
      SELECT RAISE(ABORT, 'DELIVERY_DEPENDENCY_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.upstream_unit_id AND requirement_id = NEW.requirement_id
      ) OR NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.downstream_unit_id AND requirement_id = NEW.requirement_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_unit_snapshot_owner_insert
    BEFORE INSERT ON delivery_unit_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.delivery_unit_id
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
          AND project_version_id = NEW.project_version_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_unit_snapshot_owner_update
    BEFORE UPDATE OF delivery_unit_id, requirement_id, project_id, project_version_id ON delivery_unit_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_UNIT_SNAPSHOT_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.delivery_unit_id
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
          AND project_version_id = NEW.project_version_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_execution_owner_insert
    BEFORE INSERT ON executions
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_UNIT_EXECUTION_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.delivery_unit_id
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
          AND project_version_id = NEW.project_version_id
          AND evidence_version = NEW.evidence_version
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_execution_owner_update
    BEFORE UPDATE OF delivery_unit_id, evidence_version, requirement_id, project_id, project_version_id ON executions
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_UNIT_EXECUTION_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.delivery_unit_id
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
          AND project_version_id = NEW.project_version_id
          AND evidence_version = NEW.evidence_version
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_coding_evidence_owner_insert
    BEFORE INSERT ON coding_evidence
    BEGIN
      SELECT RAISE(ABORT, 'CODING_EVIDENCE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM executions
        WHERE id = NEW.execution_id
          AND delivery_unit_id = NEW.delivery_unit_id
          AND evidence_version = NEW.evidence_version
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_coding_evidence_owner_update
    BEFORE UPDATE OF execution_id, delivery_unit_id, evidence_version, requirement_id, project_id ON coding_evidence
    BEGIN
      SELECT RAISE(ABORT, 'CODING_EVIDENCE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM executions
        WHERE id = NEW.execution_id
          AND delivery_unit_id = NEW.delivery_unit_id
          AND evidence_version = NEW.evidence_version
          AND requirement_id = NEW.requirement_id
          AND project_id = NEW.project_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS coding_evidence_immutable_update
    BEFORE UPDATE ON coding_evidence
    BEGIN SELECT RAISE(ABORT, 'CODING_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS coding_evidence_immutable_delete
    BEFORE DELETE ON coding_evidence
    BEGIN SELECT RAISE(ABORT, 'CODING_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_quality_run_insert
    BEFORE INSERT ON delivery_quality_runs
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_QUALITY_RUN_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units
        WHERE id = NEW.delivery_unit_id
          AND requirement_id = NEW.requirement_id
          AND evidence_version = NEW.evidence_version
      );
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_quality_run_identity_update
    BEFORE UPDATE OF requirement_id, delivery_unit_id, evidence_version, kind, claim_token ON delivery_quality_runs
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_QUALITY_RUN_IDENTITY_IMMUTABLE');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_quality_evidence_insert
    BEFORE INSERT ON delivery_quality_evidence
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_QUALITY_EVIDENCE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_quality_runs qr
        JOIN coding_evidence ce
          ON ce.id = NEW.input_coding_evidence_id
         AND ce.delivery_unit_id = NEW.delivery_unit_id
         AND ce.requirement_id = NEW.requirement_id
         AND ce.evidence_version = NEW.input_evidence_version
         AND ce.diff_hash = NEW.input_diff_hash
        WHERE qr.id = NEW.run_id
          AND qr.delivery_unit_id = NEW.delivery_unit_id
          AND qr.requirement_id = NEW.requirement_id
          AND qr.evidence_version = NEW.evidence_version
          AND qr.kind = NEW.kind
          AND qr.status = 'running'
      ) OR NEW.input_evidence_version <> NEW.evidence_version;
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_quality_evidence_immutable_update
    BEFORE UPDATE ON delivery_quality_evidence
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_QUALITY_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_quality_evidence_immutable_delete
    BEFORE DELETE ON delivery_quality_evidence
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_QUALITY_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_quality_override_insert
    BEFORE INSERT ON delivery_quality_overrides
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_QUALITY_OVERRIDE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units du
        JOIN coding_evidence ce
          ON ce.id = NEW.coding_evidence_id
         AND ce.delivery_unit_id = du.id
         AND ce.requirement_id = du.requirement_id
         AND ce.evidence_version = NEW.evidence_version
         AND ce.diff_hash = NEW.input_diff_hash
        JOIN delivery_quality_evidence quality
          ON quality.id = NEW.quality_evidence_id
         AND quality.delivery_unit_id = du.id
         AND quality.requirement_id = du.requirement_id
         AND quality.evidence_version = NEW.evidence_version
         AND quality.kind = NEW.kind
         AND quality.result = 'failed'
         AND quality.input_coding_evidence_id = ce.id
         AND quality.input_evidence_version = NEW.evidence_version
         AND quality.input_diff_hash = ce.diff_hash
        WHERE du.id = NEW.delivery_unit_id
          AND du.requirement_id = NEW.requirement_id
          AND du.evidence_version = NEW.evidence_version
          AND du.phase = 'quality_verification'
          AND du.status IN ('awaiting_gate', 'returned', 'failed')
      ) OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.evidence_ids_json) ids
        WHERE ids.value = NEW.quality_evidence_id
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.evidence_ids_json) ids
        WHERE typeof(ids.value) <> 'text' OR NOT EXISTS (
          SELECT 1 FROM delivery_quality_evidence quality
          WHERE quality.id = ids.value
            AND quality.delivery_unit_id = NEW.delivery_unit_id
            AND quality.requirement_id = NEW.requirement_id
            AND quality.evidence_version = NEW.evidence_version
            AND quality.input_coding_evidence_id = NEW.coding_evidence_id
            AND quality.input_evidence_version = NEW.evidence_version
            AND quality.input_diff_hash = NEW.input_diff_hash
        )
      );
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_quality_override_immutable_update
    BEFORE UPDATE ON delivery_quality_overrides
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_QUALITY_OVERRIDE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_quality_override_immutable_delete
    BEFORE DELETE ON delivery_quality_overrides
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_QUALITY_OVERRIDE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_contract_evidence_insert
    BEFORE INSERT ON delivery_contract_evidence
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_CONTRACT_EVIDENCE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units unit
        WHERE unit.id = NEW.delivery_unit_id AND unit.requirement_id = NEW.requirement_id
      );
      SELECT RAISE(ABORT, 'DELIVERY_CONTRACT_EVIDENCE_SEQUENCE_INVALID')
      WHERE NEW.evidence_version <> COALESCE((
        SELECT MAX(evidence_version) + 1 FROM delivery_contract_evidence
        WHERE delivery_unit_id = NEW.delivery_unit_id
      ), 1);
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_contract_evidence_immutable_update
    BEFORE UPDATE ON delivery_contract_evidence
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_CONTRACT_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_contract_evidence_immutable_delete
    BEFORE DELETE ON delivery_contract_evidence
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_CONTRACT_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_evidence_invalidation_insert
    BEFORE INSERT ON delivery_evidence_invalidations
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_EVIDENCE_INVALIDATION_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units source
        JOIN delivery_units target ON target.id = NEW.target_unit_id
          AND target.requirement_id = source.requirement_id
          AND target.evidence_version = NEW.target_evidence_version
        WHERE source.id = NEW.source_unit_id AND source.requirement_id = NEW.requirement_id
          AND NEW.source_new_evidence_version > NEW.source_old_evidence_version
          AND (
            (NEW.source_kind = 'implementation' AND EXISTS (
              SELECT 1 FROM coding_evidence old_evidence
              JOIN coding_evidence new_evidence ON new_evidence.id = NEW.source_new_evidence_id
                AND new_evidence.delivery_unit_id = source.id
                AND new_evidence.requirement_id = source.requirement_id
                AND new_evidence.evidence_version = NEW.source_new_evidence_version
                AND new_evidence.diff_hash = NEW.source_new_evidence_hash
              WHERE old_evidence.id = NEW.source_old_evidence_id
                AND old_evidence.delivery_unit_id = source.id
                AND old_evidence.requirement_id = source.requirement_id
                AND old_evidence.evidence_version = NEW.source_old_evidence_version
                AND old_evidence.diff_hash = NEW.source_old_evidence_hash
                AND source.evidence_version = NEW.source_new_evidence_version
            ))
            OR (NEW.source_kind = 'contract' AND EXISTS (
              SELECT 1 FROM delivery_contract_evidence old_evidence
              JOIN delivery_contract_evidence new_evidence ON new_evidence.id = NEW.source_new_evidence_id
                AND new_evidence.delivery_unit_id = source.id
                AND new_evidence.requirement_id = source.requirement_id
                AND new_evidence.evidence_version = NEW.source_new_evidence_version
                AND new_evidence.contract_hash = NEW.source_new_evidence_hash
              WHERE old_evidence.id = NEW.source_old_evidence_id
                AND old_evidence.delivery_unit_id = source.id
                AND old_evidence.requirement_id = source.requirement_id
                AND old_evidence.evidence_version = NEW.source_old_evidence_version
                AND old_evidence.contract_hash = NEW.source_old_evidence_hash
                AND NEW.source_new_evidence_version = (
                  SELECT MAX(current.evidence_version) FROM delivery_contract_evidence current
                  WHERE current.delivery_unit_id = source.id
                )
            ))
          )
      );
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_evidence_invalidation_immutable_update
    BEFORE UPDATE ON delivery_evidence_invalidations
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_EVIDENCE_INVALIDATION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_evidence_invalidation_immutable_delete
    BEFORE DELETE ON delivery_evidence_invalidations
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_EVIDENCE_INVALIDATION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_stale_decision_insert
    BEFORE INSERT ON delivery_stale_decisions
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units unit
        WHERE unit.id = NEW.delivery_unit_id
          AND unit.requirement_id = NEW.requirement_id
          AND unit.evidence_version = NEW.target_evidence_version
          AND unit.status = 'potentially_stale'
          AND EXISTS (
            SELECT 1 FROM delivery_evidence_invalidations invalidation
            WHERE invalidation.target_unit_id = unit.id
              AND invalidation.target_evidence_version = unit.evidence_version
              AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
                WHERE source.invalidation_id = invalidation.id)
          )
      ) OR (NEW.decision = 'reuse' AND NEW.resulting_evidence_version <> NEW.target_evidence_version)
        OR (NEW.decision = 'rerun' AND NEW.resulting_evidence_version <> NEW.target_evidence_version + 1);
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_stale_decision_immutable_update
    BEFORE UPDATE ON delivery_stale_decisions
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_stale_decision_immutable_delete
    BEFORE DELETE ON delivery_stale_decisions
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_stale_decision_source_insert
    BEFORE INSERT ON delivery_stale_decision_sources
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_SOURCE_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_stale_decisions decision
        JOIN delivery_evidence_invalidations invalidation ON invalidation.id = NEW.invalidation_id
          AND invalidation.requirement_id = decision.requirement_id
          AND invalidation.target_unit_id = decision.delivery_unit_id
          AND invalidation.target_evidence_version = decision.target_evidence_version
        WHERE decision.id = NEW.decision_id
          AND (
            (invalidation.source_kind = 'implementation' AND EXISTS (
              SELECT 1 FROM coding_evidence current
              WHERE current.id = NEW.source_current_evidence_id
                AND current.delivery_unit_id = invalidation.source_unit_id
                AND current.requirement_id = invalidation.requirement_id
                AND current.evidence_version = NEW.source_current_evidence_version
                AND current.diff_hash = NEW.source_current_evidence_hash
                AND current.evidence_version = (
                  SELECT unit.evidence_version FROM delivery_units unit
                  WHERE unit.id = invalidation.source_unit_id
                )
                AND current.evidence_version >= invalidation.source_new_evidence_version
            ))
            OR (invalidation.source_kind = 'contract' AND EXISTS (
              SELECT 1 FROM delivery_contract_evidence current
              WHERE current.id = NEW.source_current_evidence_id
                AND current.delivery_unit_id = invalidation.source_unit_id
                AND current.requirement_id = invalidation.requirement_id
                AND current.evidence_version = NEW.source_current_evidence_version
                AND current.contract_hash = NEW.source_current_evidence_hash
                AND current.evidence_version = (
                  SELECT MAX(latest.evidence_version) FROM delivery_contract_evidence latest
                  WHERE latest.delivery_unit_id = invalidation.source_unit_id
                )
                AND current.evidence_version >= invalidation.source_new_evidence_version
            ))
          )
      );
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_stale_decision_source_immutable_update
    BEFORE UPDATE ON delivery_stale_decision_sources
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_stale_decision_source_immutable_delete
    BEFORE DELETE ON delivery_stale_decision_sources
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_STALE_DECISION_SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_unresolved_delivery_stale_recovery
    BEFORE UPDATE OF status, evidence_version ON delivery_units
    WHEN OLD.status = 'potentially_stale' AND NEW.status NOT IN ('potentially_stale', 'skipped')
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_STALE_ACTIVE_FACTS_REMAIN')
      WHERE EXISTS (
        SELECT 1 FROM delivery_evidence_invalidations invalidation
        WHERE invalidation.target_unit_id = OLD.id
          AND invalidation.target_evidence_version = OLD.evidence_version
          AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
            WHERE source.invalidation_id = invalidation.id)
      );
    END;
    CREATE TRIGGER IF NOT EXISTS requirement_automation_audit_immutable_update
    BEFORE UPDATE ON requirement_automation_audit
    BEGIN SELECT RAISE(ABORT, 'REQUIREMENT_AUTOMATION_AUDIT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS requirement_automation_audit_immutable_delete
    BEFORE DELETE ON requirement_automation_audit
    BEGIN SELECT RAISE(ABORT, 'REQUIREMENT_AUTOMATION_AUDIT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_unit_skip_immutable_update
    BEFORE UPDATE ON delivery_unit_skips
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_UNIT_SKIP_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_unit_skip_immutable_delete
    BEFORE DELETE ON delivery_unit_skips
    BEGIN SELECT RAISE(ABORT, 'DELIVERY_UNIT_SKIP_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS validate_delivery_unit_skip_insert
    BEFORE INSERT ON delivery_unit_skips
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_UNIT_SKIP_OWNER_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM delivery_units unit
        WHERE unit.id = NEW.delivery_unit_id
          AND unit.requirement_id = NEW.requirement_id
          AND unit.evidence_version = NEW.evidence_version
          AND unit.required = 0
          AND unit.status NOT IN ('running', 'applying', 'applied')
          AND NOT EXISTS (SELECT 1 FROM delivery_quality_runs quality
            WHERE quality.delivery_unit_id = unit.id
              AND quality.evidence_version = unit.evidence_version AND quality.status = 'running')
          AND NOT EXISTS (SELECT 1 FROM automation_jobs job
            WHERE job.owner_type = 'delivery_unit' AND job.owner_id = unit.id
              AND job.evidence_version = unit.evidence_version AND job.status = 'leased')
          AND NOT EXISTS (SELECT 1 FROM stage_runs run
            WHERE run.owner_type = 'delivery_unit' AND run.owner_id = unit.id
              AND run.evidence_version = unit.evidence_version AND run.status = 'running')
      );
    END;
  `);
}
