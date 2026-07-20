import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EvidenceChangedFile, EvidenceManifest } from "./evidence-tree.js";
import { redactSensitive } from "./redaction.js";

export type DeliveryQualityKind = "code_review" | "automated_testing";
export type DeliveryQualityResult = "passed" | "failed";

export interface DeliveryQualityInput {
  requirement: unknown;
  artifacts: unknown[];
  snapshot: {
    repoPath: string; branch: string; baseBranch: string; worktreePath: string; headCommit: string;
    moduleIds: string[]; acceptanceCriteria: string[]; sensitivePatterns: string[];
    allowedCommands: Array<{ command: string; argsPrefix?: string[] }>;
  };
  codingEvidence: {
    id: string; deliveryUnitId: string; requirementId: string; evidenceVersion: number;
    diffHash: string; diff: string; changedFiles: EvidenceChangedFile[]; worktreePath: string; branch: string;
    sourceRepoPath: string; gitCommonDir: string; sourceHead: string;
    manifestHash: string; manifest: EvidenceManifest;
  };
}

interface DeliveryQualityClaimBase {
  id: string; requirementId: string; deliveryUnitId: string; evidenceVersion: number;
  kind: DeliveryQualityKind;
}

export type DeliveryQualityClaim =
  | (DeliveryQualityClaimBase & { status: "running"; input: DeliveryQualityInput })
  | (DeliveryQualityClaimBase & { status: "completed" | "failed"; evidence: DeliveryQualityEvidence })
  | (DeliveryQualityClaimBase & { status: "aborted"; error: string });

export interface DeliveryQualityCompletion {
  result: DeliveryQualityResult;
  content: unknown;
  commandResults?: unknown[];
  acceptanceTrace?: unknown[];
}

export interface DeliveryQualityEvidence {
  id: string; runId: string; requirementId: string; deliveryUnitId: string; evidenceVersion: number;
  kind: DeliveryQualityKind; result: DeliveryQualityResult; inputCodingEvidenceId: string;
  inputEvidenceVersion: number; inputDiffHash: string; content: unknown;
  commandResults: unknown[]; acceptanceTrace: unknown[]; createdAt: string; completedAt: string;
}

export interface DeliveryQualityPersistence {
  claim(unitId: string, evidenceVersion: number | undefined, kind: DeliveryQualityKind, claimToken?: string): DeliveryQualityClaim;
  complete(claim: DeliveryQualityClaim, completion: DeliveryQualityCompletion): DeliveryQualityEvidence;
  abort(claim: DeliveryQualityClaim, error: string): void;
  latest(unitId: string, kind: DeliveryQualityKind): DeliveryQualityEvidence | null;
}

export class DeliveryQualityRepository {
  constructor(private readonly db: DatabaseSync) {}

  claimInTransaction(
    unitId: string,
    evidenceVersion: number | undefined,
    kind: DeliveryQualityKind,
    claimToken?: string
  ): DeliveryQualityClaim {
    validateKind(kind);
    if (claimToken !== undefined && (claimToken.length < 1 || claimToken.length > 256 || claimToken.includes("\0"))) {
      throw new Error("DELIVERY_QUALITY_CLAIM_TOKEN_INVALID");
    }
    if (evidenceVersion === undefined) {
      const row = this.db.prepare("SELECT evidence_version FROM delivery_units WHERE id = ?").get(unitId) as
        { evidence_version: number } | undefined;
      if (!row) throw new Error("DELIVERY_UNIT_NOT_FOUND");
      evidenceVersion = row.evidence_version;
    }
    const existing = this.db.prepare(`SELECT id, requirement_id, status, claim_token, error FROM delivery_quality_runs
      WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ?`).get(unitId, evidenceVersion, kind) as
      { id: string; requirement_id: string; status: string; claim_token: string; error: string | null } | undefined;
    if (existing) {
      if (claimToken !== undefined && existing.claim_token === claimToken) {
        const resumed = {
          id: existing.id, requirementId: existing.requirement_id,
          deliveryUnitId: unitId, evidenceVersion, kind
        };
        if (existing.status === "running") {
          return { ...resumed, status: "running", input: this.loadInput(unitId, evidenceVersion) };
        }
        if (existing.status === "aborted") {
          if (!existing.error) throw new Error("DELIVERY_QUALITY_ABORT_NOT_FOUND");
          return { ...resumed, status: "aborted", error: existing.error };
        }
        if (existing.status === "completed" || existing.status === "failed") {
          const evidence = this.getEvidenceByRun(existing.id);
          if (!evidence) throw new Error("DELIVERY_QUALITY_EVIDENCE_NOT_FOUND");
          return { ...resumed, status: existing.status, evidence };
        }
        throw new Error("DELIVERY_QUALITY_RUN_STATUS_INVALID");
      }
      throw new Error(existing.status === "running" ? "DELIVERY_QUALITY_RUN_ACTIVE" : "DELIVERY_QUALITY_RUN_SETTLED");
    }
    const input = this.loadInput(unitId, evidenceVersion);
    const id = randomUUID();
    const persistedClaimToken = claimToken ?? randomUUID();
    this.db.prepare(`INSERT INTO delivery_quality_runs
      (id, requirement_id, delivery_unit_id, evidence_version, kind, claim_token, status, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`)
      .run(id, input.codingEvidence.requirementId, unitId, evidenceVersion, kind,
        persistedClaimToken, new Date().toISOString());
    return {
      id, requirementId: input.codingEvidence.requirementId, deliveryUnitId: unitId,
      evidenceVersion, kind, input, status: "running"
    };
  }

  completeInTransaction(claim: DeliveryQualityClaim, completion: DeliveryQualityCompletion): DeliveryQualityEvidence {
    validateKind(claim.kind);
    if (claim.status !== "running") throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    if (completion.result !== "passed" && completion.result !== "failed") throw new Error("DELIVERY_QUALITY_RESULT_INVALID");
    const current = this.loadInput(claim.deliveryUnitId, claim.evidenceVersion).codingEvidence;
    const expected = claim.input.codingEvidence;
    if (current.id !== expected.id || current.diffHash !== expected.diffHash || current.evidenceVersion !== expected.evidenceVersion) {
      throw new Error("DELIVERY_QUALITY_INPUT_STALE");
    }
    const sanitized = sanitizeQualityCompletion(completion, claim.input.snapshot.sensitivePatterns);
    const now = new Date().toISOString();
    const evidenceId = randomUUID();
    this.db.prepare(`INSERT INTO delivery_quality_evidence
      (id, run_id, requirement_id, delivery_unit_id, evidence_version, kind, result,
       input_coding_evidence_id, input_evidence_version, input_diff_hash, content_json,
       command_results_json, acceptance_trace_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidenceId, claim.id, claim.requirementId, claim.deliveryUnitId, claim.evidenceVersion,
        claim.kind, completion.result, expected.id, expected.evidenceVersion, expected.diffHash,
        stringifyJson(sanitized.content), stringifyJson(sanitized.commandResults),
        stringifyJson(sanitized.acceptanceTrace), now, now);
    const settled = this.db.prepare(`UPDATE delivery_quality_runs SET status = ?, error = NULL, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ? AND kind = ? AND status = 'running'`)
      .run(completion.result === "passed" ? "completed" : "failed", now, claim.id,
        claim.deliveryUnitId, claim.evidenceVersion, claim.kind);
    if (settled.changes !== 1) throw new Error("DELIVERY_QUALITY_RUN_STALE");
    return this.getEvidence(evidenceId)!;
  }

  abortInTransaction(claim: DeliveryQualityClaim, error: string) {
    validateKind(claim.kind);
    if (claim.status !== "running") throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    if (!/^[A-Z][A-Z0-9_]*$/.test(error)) throw new Error("DELIVERY_QUALITY_ABORT_INVALID");
    const now = new Date().toISOString();
    const settled = this.db.prepare(`UPDATE delivery_quality_runs SET status = 'aborted', error = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ? AND kind = ? AND status = 'running'`)
      .run(error, now, claim.id, claim.deliveryUnitId, claim.evidenceVersion, claim.kind);
    if (settled.changes !== 1) throw new Error("DELIVERY_QUALITY_RUN_STALE");
  }

  abortTerminalAutomationClaimsInTransaction() {
    const now = new Date().toISOString();
    const settled = this.db.prepare(`UPDATE delivery_quality_runs AS quality
      SET status = 'aborted', error = 'DELIVERY_QUALITY_AUTOMATION_FAILED', completed_at = ?
      WHERE quality.status = 'running' AND EXISTS (
        SELECT 1 FROM automation_jobs AS job
        WHERE job.id = quality.claim_token
          AND job.status = 'failed'
          AND job.owner_type = 'delivery_unit'
          AND job.owner_id = quality.delivery_unit_id
          AND job.evidence_version = quality.evidence_version
          AND (
            (job.action = 'review' AND quality.kind = 'code_review')
            OR (job.action = 'test' AND quality.kind = 'automated_testing')
          )
      )`).run(now);
    return Number(settled.changes);
  }

  latest(unitId: string, kind: DeliveryQualityKind): DeliveryQualityEvidence | null {
    validateKind(kind);
    const row = this.db.prepare(`SELECT * FROM delivery_quality_evidence
      WHERE delivery_unit_id = ? AND kind = ? ORDER BY evidence_version DESC LIMIT 1`).get(unitId, kind);
    return row ? mapEvidence(row as any) : null;
  }

  private getEvidence(id: string): DeliveryQualityEvidence | null {
    const row = this.db.prepare("SELECT * FROM delivery_quality_evidence WHERE id = ?").get(id);
    return row ? mapEvidence(row as any) : null;
  }

  private getEvidenceByRun(runId: string): DeliveryQualityEvidence | null {
    const row = this.db.prepare("SELECT * FROM delivery_quality_evidence WHERE run_id = ?").get(runId);
    return row ? mapEvidence(row as any) : null;
  }

  private loadInput(unitId: string, evidenceVersion: number): DeliveryQualityInput {
    const row = this.db.prepare(`SELECT du.requirement_id, du.status AS unit_status,
        dus.repo_path, dus.branch, dus.base_branch, dus.worktree_path AS snapshot_worktree_path,
        dus.head_commit, dus.module_ids_json, dus.acceptance_criteria_json,
        dus.sensitive_patterns_json, dus.allowed_commands_json,
        ce.id AS coding_evidence_id, ce.evidence_version AS coding_evidence_version,
        ce.diff_hash, ce.diff_text, ce.changed_files_json, ce.worktree_path AS coding_worktree_path,
        ce.branch AS coding_branch, ce.source_repo_path, ce.git_common_dir, ce.source_head,
        ce.manifest_hash, ce.manifest_json, sr.input_json
      FROM delivery_units du
      JOIN delivery_unit_snapshots dus ON dus.delivery_unit_id = du.id
      JOIN coding_evidence ce ON ce.delivery_unit_id = du.id AND ce.evidence_version = ?
      JOIN stage_runs sr ON sr.owner_type = 'delivery_unit' AND sr.owner_id = du.id
        AND sr.evidence_version = ce.evidence_version AND sr.stage = 'implementation' AND sr.status = 'completed'
      WHERE du.id = ? AND du.evidence_version = ?`).get(evidenceVersion, unitId, evidenceVersion) as any;
    if (!row) throw new Error("IMPLEMENTATION_EVIDENCE_NOT_FOUND");
    if (row.unit_status !== "awaiting_gate") throw new Error("DELIVERY_UNIT_NOT_AWAITING_QUALITY");
    const implementationInput = parseObject(row.input_json);
    return {
      requirement: implementationInput.requirement,
      artifacts: Array.isArray(implementationInput.artifacts) ? implementationInput.artifacts : [],
      snapshot: {
        repoPath: row.repo_path, branch: row.branch, baseBranch: row.base_branch,
        worktreePath: row.snapshot_worktree_path, headCommit: row.head_commit,
        moduleIds: parseStringArray(row.module_ids_json),
        acceptanceCriteria: parseStringArray(row.acceptance_criteria_json),
        sensitivePatterns: parseStringArray(row.sensitive_patterns_json),
        allowedCommands: parseCommands(row.allowed_commands_json)
      },
      codingEvidence: {
        id: row.coding_evidence_id, deliveryUnitId: unitId, requirementId: row.requirement_id,
        evidenceVersion: row.coding_evidence_version, diffHash: row.diff_hash,
        diff: row.diff_text, changedFiles: parseJsonArray(row.changed_files_json) as EvidenceChangedFile[],
        worktreePath: row.coding_worktree_path, branch: row.coding_branch,
        sourceRepoPath: row.source_repo_path, gitCommonDir: row.git_common_dir,
        sourceHead: row.source_head, manifestHash: row.manifest_hash,
        manifest: parseManifest(row.manifest_json)
      }
    };
  }
}

const QUALITY_REDACTION_LIMITS = {
  maxDepth: 24,
  maxNodes: 20_000,
  maxStringCodePoints: 1_048_576,
  maxCollectionItems: 10_000,
  maxBytes: 1_500_000
} as const;

function sanitizeQualityCompletion(
  completion: DeliveryQualityCompletion,
  sensitivePatterns: string[]
): { content: unknown; commandResults: unknown[]; acceptanceTrace: unknown[] } {
  try {
    return redactSensitive({
      content: completion.content,
      commandResults: completion.commandResults ?? [],
      acceptanceTrace: completion.acceptanceTrace ?? []
    }, sensitivePatterns, QUALITY_REDACTION_LIMITS);
  } catch (error) {
    throw new Error("DELIVERY_QUALITY_PERSISTENCE_LIMIT", { cause: error });
  }
}

function validateKind(kind: unknown): asserts kind is DeliveryQualityKind {
  if (kind !== "code_review" && kind !== "automated_testing") throw new Error("DELIVERY_QUALITY_KIND_INVALID");
}
function parseObject(json: string): Record<string, any> {
  try { const value = JSON.parse(json); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
  throw new Error("DELIVERY_QUALITY_INPUT_INVALID");
}
function parseStringArray(json: string): string[] {
  try { const value = JSON.parse(json); if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value; } catch {}
  throw new Error("DELIVERY_QUALITY_INPUT_INVALID");
}
function parseCommands(json: string): Array<{ command: string; argsPrefix?: string[] }> {
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value) && value.every((item) => item && typeof item === "object"
      && typeof item.command === "string" && item.command.length > 0
      && (item.argsPrefix === undefined || (Array.isArray(item.argsPrefix)
        && item.argsPrefix.every((arg: unknown) => typeof arg === "string"))))) return value;
  } catch {}
  throw new Error("DELIVERY_QUALITY_INPUT_INVALID");
}
function parseJsonArray(json: string): unknown[] {
  try { const value = JSON.parse(json); if (Array.isArray(value)) return value; } catch {}
  throw new Error("DELIVERY_QUALITY_INPUT_INVALID");
}
function parseManifest(json: string): EvidenceManifest {
  const value = parseObject(json);
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("DELIVERY_QUALITY_INPUT_INVALID");
  return value as unknown as EvidenceManifest;
}
function stringifyJson(value: unknown) {
  const json = JSON.stringify(value); if (json === undefined) throw new Error("DELIVERY_QUALITY_CONTENT_INVALID"); return json;
}
function mapEvidence(row: any): DeliveryQualityEvidence {
  return {
    id: row.id, runId: row.run_id, requirementId: row.requirement_id, deliveryUnitId: row.delivery_unit_id,
    evidenceVersion: row.evidence_version, kind: row.kind, result: row.result,
    inputCodingEvidenceId: row.input_coding_evidence_id, inputEvidenceVersion: row.input_evidence_version,
    inputDiffHash: row.input_diff_hash, content: JSON.parse(row.content_json),
    commandResults: JSON.parse(row.command_results_json), acceptanceTrace: JSON.parse(row.acceptance_trace_json),
    createdAt: row.created_at, completedAt: row.completed_at
  };
}
