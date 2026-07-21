import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryUnit } from "./delivery-unit-repository.js";
import type { EvidenceChangedFile, EvidenceManifest, WorktreeEvidenceIdentity } from "./evidence-tree.js";

export interface DeliveryExecutionClaim {
  deliveryUnit: DeliveryUnit;
  runId: string;
  executionId: string;
  requirement: {
    id: string;
    code: string;
    title: string;
    businessProblem: string;
    expectedOutcome: string;
    priority: string;
    clarifications: string;
  };
  artifacts: Array<{
    id: string;
    stage: string;
    version: number;
    title: string;
    content: unknown;
    createdAt: string;
  }>;
  project: {
    id: string;
    repoPath: string;
    defaultBranch: string;
    allowedCommands: Array<{ command: string; argsPrefix?: string[] }>;
  };
  version: {
    id: string;
    projectId: string;
    branch: string;
    worktreePath: string;
    status: "active";
    headCommit: string;
  };
  deliveryContext: {
    deliveryUnitId: string;
    requirementId: string;
    evidenceVersion: number;
    moduleIds: string[];
    acceptanceCriteria: string[];
    sensitivePatterns: string[];
    allowedCommands: Array<{ command: string; argsPrefix?: string[] }>;
    projectKnowledgeVersionId: string | null;
  };
  automationLease?: DeliveryImplementationAutomationLease;
}

export interface DeliveryImplementationAutomationInput {
  evidenceVersion: number;
  claimToken: string;
}

export interface DeliveryImplementationAutomationLease extends DeliveryImplementationAutomationInput {
  jobId: string;
  workerId: string;
}

export interface DeliveryExecutionSuccess {
  branch: string;
  worktreePath: string;
  baseCommit: string;
  commands: readonly [];
  diff: string;
  diffHash: string;
  changedFiles: EvidenceChangedFile[];
  identity: WorktreeEvidenceIdentity;
  manifest: EvidenceManifest;
  manifestHash: string;
  originalChars: number;
  truncated: boolean;
  files: string[];
  additions: number;
  deletions: number;
  diagnostics: string;
  codexThreadId?: string;
  events?: unknown[];
  output: unknown;
}

export interface DeliveryExecutionPersistence {
  claimImplementation(
    unitId: string,
    model: string,
    automation?: DeliveryImplementationAutomationInput
  ): DeliveryExecutionClaim;
  completeImplementation(claim: DeliveryExecutionClaim, result: DeliveryExecutionSuccess): DeliveryUnit;
  failImplementation(claim: DeliveryExecutionClaim, error: string): DeliveryUnit;
  listExecutions(deliveryUnitId: string, evidenceVersion?: number): unknown[];
  getCodingEvidence(deliveryUnitId: string, evidenceVersion: number): unknown | null;
}

export class DeliveryExecutionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

  claimImplementationInTransaction(
    unitId: string,
    model: string,
    automation?: DeliveryImplementationAutomationInput
  ): DeliveryExecutionClaim {
    const row = this.db.prepare(`SELECT
        du.*, dus.repo_path, dus.branch AS snapshot_branch, dus.base_branch,
        dus.worktree_path AS snapshot_worktree_path, dus.head_commit,
        dus.module_ids_json, dus.acceptance_criteria_json, dus.sensitive_patterns_json,
        dus.allowed_commands_json, dus.project_knowledge_version_id,
        r.code, r.title, r.business_problem, r.expected_outcome, r.priority, r.clarifications
      FROM delivery_units du
      JOIN delivery_unit_snapshots dus ON dus.delivery_unit_id = du.id
      JOIN requirements r ON r.id = du.requirement_id
      WHERE du.id = ?`).get(unitId) as any;
    if (!row) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    const automationLease = automation === undefined ? undefined
      : this.assertLiveAutomationLease(unitId, row.evidence_version, automation);
    if (row.status === "running") throw new Error("DELIVERY_UNIT_RUN_ACTIVE");
    if (row.phase !== "implementation" || row.status !== "ready") throw new Error("DELIVERY_UNIT_NOT_READY");

    const moduleIds = parseStringArray(row.module_ids_json);
    const acceptanceCriteria = parseStringArray(row.acceptance_criteria_json);
    const sensitivePatterns = parseStringArray(row.sensitive_patterns_json);
    const allowedCommands = parseAllowedCommands(row.allowed_commands_json);
    const artifacts = (this.db.prepare(`SELECT id, stage, version, title, content_json, created_at
      FROM artifacts WHERE requirement_id = ? AND stage IN ('definition', 'solution_design')
      ORDER BY stage, version, created_at, rowid`).all(row.requirement_id) as any[]).map((artifact) => ({
      id: artifact.id,
      stage: artifact.stage,
      version: artifact.version,
      title: artifact.title,
      content: JSON.parse(artifact.content_json),
      createdAt: artifact.created_at
    }));
    const now = new Date().toISOString();
    const runId = randomUUID();
    const executionId = randomUUID();
    const claimed = this.db.prepare(`UPDATE delivery_units SET status = 'running', updated_at = ?
      WHERE id = ? AND phase = 'implementation' AND status = 'ready' AND evidence_version = ?`)
      .run(now, unitId, row.evidence_version);
    if (claimed.changes !== 1) {
      const current = this.db.prepare("SELECT status FROM delivery_units WHERE id = ?").get(unitId) as { status: string } | undefined;
      if (current?.status === "running") throw new Error("DELIVERY_UNIT_RUN_ACTIVE");
      throw new Error("DELIVERY_UNIT_CLAIM_STALE");
    }

    const requirement = {
      id: row.requirement_id,
      code: row.code,
      title: row.title,
      businessProblem: row.business_problem,
      expectedOutcome: row.expected_outcome,
      priority: row.priority,
      clarifications: row.clarifications
    };
    const deliveryContext = {
      deliveryUnitId: unitId,
      requirementId: row.requirement_id,
      evidenceVersion: row.evidence_version,
      moduleIds,
      acceptanceCriteria,
      sensitivePatterns,
      allowedCommands,
      projectKnowledgeVersionId: row.project_knowledge_version_id ?? null
    };
    const input = { requirement, artifacts, deliveryContext };
    this.db.prepare(`INSERT INTO stage_runs
      (id, requirement_id, owner_type, owner_id, evidence_version, stage, status, model, input_json, created_at)
      VALUES (?, ?, 'delivery_unit', ?, ?, 'implementation', 'running', ?, ?, ?)`)
      .run(runId, row.requirement_id, unitId, row.evidence_version, model, JSON.stringify(input), now);
    this.insertRunEvent(runId, 1, "run.started", {
      stage: "implementation", model, deliveryUnitId: unitId, evidenceVersion: row.evidence_version
    }, now);
    this.db.prepare(`INSERT INTO executions
      (id, requirement_id, delivery_unit_id, evidence_version, stage, project_id, project_version_id,
       branch, worktree_path, base_commit, status, commands_json, diff_text, error, created_at,
       completed_at, codex_thread_id, events_json, diagnostics_text)
      VALUES (?, ?, ?, ?, 'implementation', ?, ?, ?, ?, ?, 'running', '[]', '', NULL, ?, NULL, NULL, '[]', '')`)
      .run(executionId, row.requirement_id, unitId, row.evidence_version, row.project_id,
        row.project_version_id, row.snapshot_branch, row.snapshot_worktree_path, row.head_commit, now);

    return {
      deliveryUnit: mapDeliveryUnit(row, "running", now),
      runId,
      executionId,
      requirement,
      artifacts,
      project: {
        id: row.project_id,
        repoPath: row.repo_path,
        defaultBranch: row.base_branch,
        allowedCommands
      },
      version: {
        id: row.project_version_id,
        projectId: row.project_id,
        branch: row.snapshot_branch,
        worktreePath: row.snapshot_worktree_path,
        status: "active",
        headCommit: row.head_commit
      },
      deliveryContext,
      ...(automationLease ? { automationLease } : {})
    };
  }

  completeImplementationInTransaction(claim: DeliveryExecutionClaim, result: DeliveryExecutionSuccess): DeliveryUnit {
    const now = new Date().toISOString();
    const unitId = claim.deliveryUnit.id;
    const evidenceVersion = claim.deliveryUnit.evidenceVersion;
    this.assertClaimAutomationLease(claim);
    const settled = this.db.prepare(`UPDATE delivery_units SET status = 'awaiting_gate', updated_at = ?
      WHERE id = ? AND phase = 'implementation' AND status = 'running' AND evidence_version = ?`)
      .run(now, unitId, evidenceVersion);
    if (settled.changes !== 1) throw new Error("DELIVERY_UNIT_RUN_STALE");
    const execution = this.db.prepare(`UPDATE executions SET branch = ?, worktree_path = ?, base_commit = ?,
        status = 'completed', commands_json = ?, diff_text = ?, error = NULL, completed_at = ?,
        codex_thread_id = ?, events_json = ?, diagnostics_text = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ? AND status = 'running'`)
      .run(result.branch, result.worktreePath, result.baseCommit, JSON.stringify(result.commands), result.diff,
        now, result.codexThreadId ?? null, JSON.stringify(result.events ?? []), result.diagnostics,
        claim.executionId, unitId, evidenceVersion);
    const run = this.db.prepare(`UPDATE stage_runs SET status = 'completed', output_json = ?, completed_at = ?
      WHERE id = ? AND owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ?
        AND stage = 'implementation' AND status = 'running'`)
      .run(JSON.stringify(result.output), now, claim.runId, unitId, evidenceVersion);
    if (execution.changes !== 1 || run.changes !== 1) throw new Error("DELIVERY_UNIT_RUN_STALE");
    this.insertRunEvent(claim.runId, 2, "run.completed", { completedAt: now }, now);
    this.db.prepare(`INSERT INTO coding_evidence
      (id, execution_id, requirement_id, delivery_unit_id, evidence_version, project_id, branch,
       worktree_path, diff_hash, diff_text, source_repo_path, git_common_dir, source_head,
       manifest_hash, manifest_json, changed_files_json, original_chars, truncated, files_json,
       additions, deletions, diagnostics_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), claim.executionId, claim.deliveryUnit.requirementId, unitId, evidenceVersion,
        claim.deliveryUnit.projectId, result.branch, result.worktreePath, result.diffHash, result.diff,
        result.identity.repositoryPath, result.identity.gitCommonDir, result.identity.headCommit,
        result.manifestHash, JSON.stringify(result.manifest), JSON.stringify(result.changedFiles),
        result.originalChars, result.truncated ? 1 : 0, JSON.stringify(result.files),
        result.additions, result.deletions, result.diagnostics, now);
    return this.getUnit(unitId)!;
  }

  failImplementationInTransaction(claim: DeliveryExecutionClaim, error: string): DeliveryUnit {
    const now = new Date().toISOString();
    const unitId = claim.deliveryUnit.id;
    const evidenceVersion = claim.deliveryUnit.evidenceVersion;
    this.assertClaimAutomationLease(claim);
    const settled = this.db.prepare(`UPDATE delivery_units SET status = 'failed', updated_at = ?
      WHERE id = ? AND phase = 'implementation' AND status = 'running' AND evidence_version = ?`)
      .run(now, unitId, evidenceVersion);
    if (settled.changes !== 1) throw new Error("DELIVERY_UNIT_RUN_STALE");
    const execution = this.db.prepare(`UPDATE executions SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ? AND status = 'running'`)
      .run(error, now, claim.executionId, unitId, evidenceVersion);
    const run = this.db.prepare(`UPDATE stage_runs SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ? AND owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ?
        AND stage = 'implementation' AND status = 'running'`)
      .run(error, now, claim.runId, unitId, evidenceVersion);
    if (execution.changes !== 1 || run.changes !== 1) throw new Error("DELIVERY_UNIT_RUN_STALE");
    this.insertRunEvent(claim.runId, 2, "run.failed", { error }, now);
    return this.getUnit(unitId)!;
  }

  listExecutions(deliveryUnitId: string, evidenceVersion?: number) {
    const rows = evidenceVersion === undefined
      ? this.db.prepare(`SELECT * FROM executions WHERE delivery_unit_id = ?
          ORDER BY evidence_version DESC, created_at DESC, rowid DESC`).all(deliveryUnitId)
      : this.db.prepare(`SELECT * FROM executions WHERE delivery_unit_id = ? AND evidence_version = ?
          ORDER BY created_at DESC, rowid DESC`).all(deliveryUnitId, evidenceVersion);
    return (rows as any[]).map(mapDeliveryExecution);
  }

  getCodingEvidence(deliveryUnitId: string, evidenceVersion: number) {
    const row = this.db.prepare(`SELECT * FROM coding_evidence
      WHERE delivery_unit_id = ? AND evidence_version = ?`).get(deliveryUnitId, evidenceVersion);
    return row ? mapDeliveryCodingEvidence(row as any) : null;
  }

  private getUnit(id: string): DeliveryUnit | null {
    const row = this.db.prepare("SELECT * FROM delivery_units WHERE id = ?").get(id);
    return row ? mapDeliveryUnit(row as any) : null;
  }

  private insertRunEvent(runId: string, sequence: number, type: string, payload: unknown, createdAt: string) {
    this.db.prepare(`INSERT INTO stage_run_events
      (id, run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, sequence, type, JSON.stringify(payload), createdAt);
  }

  private assertClaimAutomationLease(claim: DeliveryExecutionClaim) {
    if (!claim.automationLease) return;
    this.assertLiveAutomationLease(
      claim.deliveryUnit.id,
      claim.deliveryUnit.evidenceVersion,
      claim.automationLease
    );
  }

  private assertLiveAutomationLease(
    unitId: string,
    currentEvidenceVersion: number,
    input: DeliveryImplementationAutomationInput
  ): DeliveryImplementationAutomationLease {
    if (!Number.isSafeInteger(input.evidenceVersion) || input.evidenceVersion < 1
      || input.evidenceVersion !== currentEvidenceVersion || typeof input.claimToken !== "string") {
      throw new Error("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    }
    const parsed = parseImplementationLeaseToken(input.claimToken);
    if (!parsed) throw new Error("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    const live = this.db.prepare(`SELECT id FROM automation_jobs
      WHERE id = ? AND claim_token = ? AND owner_type = 'delivery_unit' AND owner_id = ?
        AND evidence_version = ? AND action = 'implement' AND status = 'leased'
        AND lease_owner = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`).get(
      parsed.jobId, input.claimToken, unitId, input.evidenceVersion, parsed.workerId, this.now()
    );
    if (!live) throw new Error("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    return { ...input, ...parsed };
  }

  private now() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("DELIVERY_IMPLEMENTATION_DATE_INVALID");
    }
    return now.toISOString();
  }
}

const IMPLEMENTATION_LEASE_TOKEN = /^lease:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{1,128}):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseImplementationLeaseToken(token: string) {
  const match = IMPLEMENTATION_LEASE_TOKEN.exec(token);
  return match ? { jobId: match[1]!, workerId: match[2]! } : null;
}

function parseStringArray(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("DELIVERY_UNIT_SNAPSHOT_INVALID"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("DELIVERY_UNIT_SNAPSHOT_INVALID");
  }
  return parsed;
}

function parseAllowedCommands(value: string): Array<{ command: string; argsPrefix?: string[] }> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("DELIVERY_UNIT_SNAPSHOT_INVALID"); }
  if (!Array.isArray(parsed) || parsed.some((item) => {
    if (!item || typeof item !== "object") return true;
    const command = item as Record<string, unknown>;
    return typeof command.command !== "string"
      || (command.argsPrefix !== undefined
        && (!Array.isArray(command.argsPrefix) || command.argsPrefix.some((arg) => typeof arg !== "string")));
  })) throw new Error("DELIVERY_UNIT_SNAPSHOT_INVALID");
  return parsed as Array<{ command: string; argsPrefix?: string[] }>;
}

function mapDeliveryUnit(row: any, status = row.status, updatedAt = row.updated_at): DeliveryUnit {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    associationSnapshotId: row.association_snapshot_id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    required: Boolean(row.required),
    position: row.position,
    phase: row.phase,
    status,
    evidenceVersion: row.evidence_version,
    createdAt: row.created_at,
    updatedAt,
    completedAt: row.completed_at ?? null
  };
}

function mapDeliveryExecution(row: any) {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    evidenceVersion: row.evidence_version,
    stage: row.stage,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    status: row.status,
    commands: JSON.parse(row.commands_json),
    diff: row.diff_text,
    error: row.error,
    codexThreadId: row.codex_thread_id,
    events: JSON.parse(row.events_json || "[]"),
    diagnostics: row.diagnostics_text,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export function mapDeliveryCodingEvidence(row: any) {
  const files = JSON.parse(row.files_json || "[]");
  return {
    id: row.id,
    executionId: row.execution_id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    evidenceVersion: row.evidence_version,
    projectId: row.project_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    diffHash: row.diff_hash,
    diff: row.diff_text,
    sourceRepoPath: row.source_repo_path,
    gitCommonDir: row.git_common_dir,
    sourceHead: row.source_head,
    manifestHash: row.manifest_hash,
    manifest: JSON.parse(row.manifest_json),
    changedFiles: JSON.parse(row.changed_files_json),
    originalChars: row.original_chars,
    truncated: Boolean(row.truncated),
    files,
    fileCount: files.length,
    additions: row.additions,
    deletions: row.deletions,
    diagnostics: row.diagnostics_text,
    createdAt: row.created_at
  };
}
