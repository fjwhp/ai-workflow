import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowStage } from "@ai-workflow/shared";
import type { EvidenceChangedFile, EvidenceManifest } from "./evidence-tree.js";

export interface ExecutionInput {
  requirementId: string;
  deliveryUnitId: string;
  evidenceVersion: number;
  stage: WorkflowStage;
  projectId: string;
  projectVersionId?: string;
  branch: string;
  worktreePath: string;
  baseCommit?: string;
  status: string;
  commands?: unknown[];
  diff?: string;
  error?: string;
  codexThreadId?: string;
  events?: unknown[];
  diagnostics?: string;
  completedAt?: string;
}

export interface CodingEvidenceInput {
  executionId: string;
  requirementId: string;
  deliveryUnitId: string;
  evidenceVersion: number;
  projectId: string;
  branch: string;
  worktreePath: string;
  diffHash: string;
  diff: string;
  sourceRepoPath: string;
  gitCommonDir: string;
  sourceHead: string;
  manifestHash: string;
  manifest: EvidenceManifest;
  changedFiles: EvidenceChangedFile[];
  originalChars: number;
  truncated: boolean;
  files?: string[];
  additions?: number;
  deletions?: number;
  diagnostics?: string;
}

export class ExecutionRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(input: ExecutionInput) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.projectVersionId && !input.baseCommit) throw new Error("REQUIREMENT_VERSION_REQUIRED");
      if (input.projectVersionId) {
        const version = this.db.prepare("SELECT project_id FROM project_versions WHERE id = ?")
          .get(input.projectVersionId) as { project_id: string } | undefined;
        if (!version || version.project_id !== input.projectId) {
          throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
        }
      }
      const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
      this.db.prepare(`INSERT INTO executions
        (id, requirement_id, delivery_unit_id, evidence_version, stage, project_id, project_version_id,
         branch, worktree_path, base_commit, status, commands_json, diff_text, error, created_at,
         completed_at, codex_thread_id, events_json, diagnostics_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        item.id, item.requirementId, item.deliveryUnitId, item.evidenceVersion, item.stage, item.projectId,
        item.projectVersionId ?? null, item.branch, item.worktreePath, item.baseCommit ?? null,
        item.status, JSON.stringify(item.commands ?? []), item.diff ?? "", item.error ?? null,
        item.createdAt, item.completedAt ?? null, item.codexThreadId ?? null,
        JSON.stringify(item.events ?? []), item.diagnostics ?? ""
      );
      this.db.exec("COMMIT");
      return item;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listForRequirement(requirementId: string) {
    return (this.db.prepare(`SELECT * FROM executions WHERE requirement_id = ?
      ORDER BY created_at DESC`).all(requirementId) as any[]).map(mapExecution);
  }

  addCodingEvidence(input: CodingEvidenceInput) {
    const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db.prepare(`INSERT INTO coding_evidence
      (id, execution_id, requirement_id, delivery_unit_id, evidence_version, project_id, branch,
       worktree_path, diff_hash, diff_text, source_repo_path, git_common_dir, source_head,
       manifest_hash, manifest_json, changed_files_json, original_chars, truncated, files_json,
       additions, deletions, diagnostics_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, item.executionId, item.requirementId, item.deliveryUnitId, item.evidenceVersion,
      item.projectId, item.branch, item.worktreePath, item.diffHash, item.diff,
      item.sourceRepoPath, item.gitCommonDir, item.sourceHead, item.manifestHash,
      JSON.stringify(item.manifest), JSON.stringify(item.changedFiles),
      item.originalChars, item.truncated ? 1 : 0, JSON.stringify(item.files ?? []),
      item.additions ?? 0, item.deletions ?? 0, item.diagnostics ?? "", item.createdAt
    );
    return item;
  }

  getLatestCodingEvidence(requirementId: string) {
    const row = this.db.prepare(`SELECT ce.*, dus.sensitive_patterns_json
      FROM coding_evidence ce
      JOIN delivery_unit_snapshots dus ON dus.delivery_unit_id = ce.delivery_unit_id
      WHERE ce.requirement_id = ? ORDER BY ce.created_at DESC LIMIT 1`).get(requirementId);
    return row ? mapCodingEvidence(row as any) : null;
  }
}

function mapExecution(row: any) {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    evidenceVersion: row.evidence_version,
    stage: row.stage,
    projectId: row.project_id,
    projectVersionId: row.project_version_id ?? undefined,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit ?? undefined,
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

function mapCodingEvidence(row: any) {
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
    sensitivePatterns: JSON.parse(row.sensitive_patterns_json),
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
