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
  kind: DeliveryQualityKind; claimToken: string;
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

export interface DeliveryQualitySettlement {
  evidence: DeliveryQualityEvidence;
  replayed: boolean;
}

export interface DeliveryQualityPersistence {
  claim(unitId: string, evidenceVersion: number | undefined, kind: DeliveryQualityKind, claimToken?: string): DeliveryQualityClaim;
  complete(claim: DeliveryQualityClaim, completion: DeliveryQualityCompletion): DeliveryQualityEvidence;
  abort(claim: DeliveryQualityClaim, error: string): void;
  latest(unitId: string, kind: DeliveryQualityKind): DeliveryQualityEvidence | null;
}

export class DeliveryQualityRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

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
    const now = this.now();
    const automationLease = claimToken === undefined ? null : parseAutomationLeaseToken(claimToken);
    if (claimToken?.startsWith("lease:") && !automationLease) {
      throw new Error("DELIVERY_QUALITY_CLAIM_TOKEN_INVALID");
    }
    const automationAttempt = automationLease
      ? this.assertLiveAutomationLease(unitId, evidenceVersion, kind, claimToken!, automationLease, now)
      : null;
    const existingRuns = this.db.prepare(`SELECT id, requirement_id, status, claim_token, error
      FROM delivery_quality_runs WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ?
      ORDER BY created_at DESC, rowid DESC`).all(unitId, evidenceVersion, kind) as Array<{
        id: string; requirement_id: string; status: string; claim_token: string; error: string | null;
      }>;
    const existing = claimToken === undefined
      ? undefined
      : existingRuns.find((run) => run.claim_token === claimToken);
    if (existing) {
        const resumed = {
          id: existing.id, requirementId: existing.requirement_id,
          deliveryUnitId: unitId, evidenceVersion, kind, claimToken: existing.claim_token
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
    const terminal = existingRuns.find((run) => run.status === "completed" || run.status === "failed");
    if (terminal && automationLease) {
      const evidence = this.getEvidenceByRun(terminal.id);
      if (!evidence) throw new Error("DELIVERY_QUALITY_EVIDENCE_NOT_FOUND");
      return {
        id: terminal.id, requirementId: terminal.requirement_id, deliveryUnitId: unitId,
        evidenceVersion, kind, claimToken: terminal.claim_token,
        status: terminal.status as "completed" | "failed", evidence
      };
    }
    if (terminal) {
      throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    }
    const replayableAbort = automationLease && automationAttempt !== null && automationAttempt > 1
      ? existingRuns.find((run) => run.status === "aborted" && run.error !== null
        && !AUTOMATION_ATTEMPT_ABORTS.has(run.error)
        && belongsToAutomationJob(run.claim_token, automationLease.jobId))
      : undefined;
    if (replayableAbort) {
      return {
        id: replayableAbort.id, requirementId: replayableAbort.requirement_id,
        deliveryUnitId: unitId, evidenceVersion, kind, claimToken: replayableAbort.claim_token,
        status: "aborted", error: replayableAbort.error!
      };
    }
    if (existingRuns.some((run) => run.status === "running")) throw new Error("DELIVERY_QUALITY_RUN_ACTIVE");
    if (existingRuns.length > 0 && !automationLease) {
      throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    }
    const input = this.loadInput(unitId, evidenceVersion);
    const id = randomUUID();
    const persistedClaimToken = claimToken ?? randomUUID();
    this.db.prepare(`INSERT INTO delivery_quality_runs
      (id, requirement_id, delivery_unit_id, evidence_version, kind, claim_token, status, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`)
      .run(id, input.codingEvidence.requirementId, unitId, evidenceVersion, kind,
        persistedClaimToken, now);
    return {
      id, requirementId: input.codingEvidence.requirementId, deliveryUnitId: unitId,
      evidenceVersion, kind, claimToken: persistedClaimToken, input, status: "running"
    };
  }

  completeInTransaction(claim: DeliveryQualityClaim, completion: DeliveryQualityCompletion): DeliveryQualityEvidence {
    return this.completeWithReplayStateInTransaction(claim, completion).evidence;
  }

  completeWithReplayStateInTransaction(
    claim: DeliveryQualityClaim,
    completion: DeliveryQualityCompletion
  ): DeliveryQualitySettlement {
    validateKind(claim.kind);
    if (claim.status !== "running") throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    if (completion.result !== "passed" && completion.result !== "failed") throw new Error("DELIVERY_QUALITY_RESULT_INVALID");
    const run = this.db.prepare(`SELECT requirement_id, delivery_unit_id, evidence_version, kind, claim_token, status
      FROM delivery_quality_runs WHERE id = ?`).get(claim.id) as {
        requirement_id: string; delivery_unit_id: string; evidence_version: number;
        kind: DeliveryQualityKind; claim_token: string; status: string;
      } | undefined;
    if (!run || run.requirement_id !== claim.requirementId || run.delivery_unit_id !== claim.deliveryUnitId
      || run.evidence_version !== claim.evidenceVersion || run.kind !== claim.kind
      || run.claim_token !== claim.claimToken) {
      throw new Error("DELIVERY_QUALITY_RUN_STALE");
    }
    const now = this.now();
    const automationLease = parseAutomationLeaseToken(run.claim_token);
    if (automationLease) {
      this.assertLiveAutomationLease(
        run.delivery_unit_id, run.evidence_version, run.kind, run.claim_token, automationLease, now
      );
    }
    if (run.status === "aborted") throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    if (run.status === "completed" || run.status === "failed") {
      const evidence = this.getEvidenceByRun(claim.id);
      if (!evidence) throw new Error("DELIVERY_QUALITY_EVIDENCE_NOT_FOUND");
      const sanitized = sanitizeQualityCompletion(completion, this.loadFrozenSensitivePatterns(run.delivery_unit_id));
      if (evidence.result !== completion.result
        || canonicalPersistedJson(evidence.content) !== canonicalPersistedJson(sanitized.content)
        || canonicalPersistedJson(evidence.commandResults) !== canonicalPersistedJson(sanitized.commandResults)
        || canonicalPersistedJson(evidence.acceptanceTrace) !== canonicalPersistedJson(sanitized.acceptanceTrace)) {
        throw new Error("DELIVERY_QUALITY_REPLAY_CONFLICT");
      }
      return { evidence, replayed: true };
    }
    if (run.status !== "running") throw new Error("DELIVERY_QUALITY_RUN_STATUS_INVALID");
    const current = this.loadInput(run.delivery_unit_id, run.evidence_version);
    const expected = current.codingEvidence;
    const sanitized = sanitizeQualityCompletion(completion, current.snapshot.sensitivePatterns);
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
    return { evidence: this.getEvidence(evidenceId)!, replayed: false };
  }

  abortInTransaction(claim: DeliveryQualityClaim, error: string) {
    validateKind(claim.kind);
    if (claim.status !== "running") throw new Error("DELIVERY_QUALITY_RUN_SETTLED");
    if (!/^[A-Z][A-Z0-9_]*$/.test(error)) throw new Error("DELIVERY_QUALITY_ABORT_INVALID");
    const now = this.now();
    const settled = this.db.prepare(`UPDATE delivery_quality_runs SET status = 'aborted', error = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ? AND kind = ? AND status = 'running'`)
      .run(error, now, claim.id, claim.deliveryUnitId, claim.evidenceVersion, claim.kind);
    if (settled.changes !== 1) throw new Error("DELIVERY_QUALITY_RUN_STALE");
  }

  abortTerminalAutomationClaimsInTransaction() {
    const now = this.now();
    const settled = this.db.prepare(`UPDATE delivery_quality_runs AS quality
      SET status = 'aborted', error = CASE WHEN EXISTS (
        SELECT 1 FROM automation_jobs AS failed_job
        WHERE failed_job.claim_token = quality.claim_token AND failed_job.status = 'failed'
      ) THEN 'DELIVERY_QUALITY_AUTOMATION_FAILED'
      ELSE 'DELIVERY_QUALITY_AUTOMATION_LEASE_STALE' END, completed_at = ?
      WHERE quality.status = 'running' AND (
        EXISTS (
          SELECT 1 FROM automation_jobs AS inactive_job
          WHERE inactive_job.claim_token = quality.claim_token
            AND inactive_job.owner_type = 'delivery_unit'
            AND inactive_job.owner_id = quality.delivery_unit_id
            AND inactive_job.evidence_version = quality.evidence_version
            AND inactive_job.status <> 'leased'
            AND ((inactive_job.action = 'review' AND quality.kind = 'code_review')
              OR (inactive_job.action = 'test' AND quality.kind = 'automated_testing'))
        ) OR (
          quality.claim_token LIKE 'lease:%'
          AND NOT EXISTS (
            SELECT 1 FROM automation_jobs AS live_job
            WHERE live_job.claim_token = quality.claim_token
              AND live_job.status = 'leased' AND live_job.lease_expires_at > ?
              AND live_job.owner_type = 'delivery_unit'
              AND live_job.owner_id = quality.delivery_unit_id
              AND live_job.evidence_version = quality.evidence_version
              AND ((live_job.action = 'review' AND quality.kind = 'code_review')
                OR (live_job.action = 'test' AND quality.kind = 'automated_testing'))
          )
        )
      )`).run(now, now);
    return Number(settled.changes);
  }

  latest(unitId: string, kind: DeliveryQualityKind): DeliveryQualityEvidence | null {
    validateKind(kind);
    const row = this.db.prepare(`SELECT * FROM delivery_quality_evidence
      WHERE delivery_unit_id = ? AND kind = ? ORDER BY evidence_version DESC LIMIT 1`).get(unitId, kind);
    return row ? mapEvidence(row as any) : null;
  }

  private assertLiveAutomationLease(
    unitId: string,
    evidenceVersion: number,
    kind: DeliveryQualityKind,
    claimToken: string,
    lease: AutomationLeaseToken,
    now: string
  ) {
    const action = kind === "code_review" ? "review" : "test";
    const live = this.db.prepare(`SELECT attempt FROM automation_jobs
      WHERE id = ? AND claim_token = ? AND owner_type = 'delivery_unit' AND owner_id = ?
        AND evidence_version = ? AND action = ? AND status = 'leased' AND lease_owner = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`).get(
      lease.jobId, claimToken, unitId, evidenceVersion, action, lease.workerId, now
    ) as { attempt: number } | undefined;
    if (!live) throw new Error("DELIVERY_QUALITY_AUTOMATION_LEASE_STALE");
    return live.attempt;
  }

  private now() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("DELIVERY_QUALITY_DATE_INVALID");
    }
    return now.toISOString();
  }

  private getEvidence(id: string): DeliveryQualityEvidence | null {
    const row = this.db.prepare("SELECT * FROM delivery_quality_evidence WHERE id = ?").get(id);
    return row ? mapEvidence(row as any) : null;
  }

  private getEvidenceByRun(runId: string): DeliveryQualityEvidence | null {
    const row = this.db.prepare("SELECT * FROM delivery_quality_evidence WHERE run_id = ?").get(runId);
    return row ? mapEvidence(row as any) : null;
  }

  private loadFrozenSensitivePatterns(unitId: string): string[] {
    const row = this.db.prepare(`SELECT sensitive_patterns_json FROM delivery_unit_snapshots
      WHERE delivery_unit_id = ?`).get(unitId) as { sensitive_patterns_json: string } | undefined;
    if (!row) throw new Error("DELIVERY_UNIT_SNAPSHOT_NOT_FOUND");
    return parseStringArray(row.sensitive_patterns_json);
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
    if (!["awaiting_gate", "returned", "failed"].includes(row.unit_status)) {
      throw new Error("DELIVERY_UNIT_NOT_AWAITING_QUALITY");
    }
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

interface AutomationLeaseToken {
  jobId: string;
  workerId: string;
}

const AUTOMATION_LEASE_TOKEN = /^lease:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{1,128}):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseAutomationLeaseToken(token: string): AutomationLeaseToken | null {
  const match = AUTOMATION_LEASE_TOKEN.exec(token);
  return match ? { jobId: match[1]!, workerId: match[2]! } : null;
}

const AUTOMATION_ATTEMPT_ABORTS = new Set([
  "DELIVERY_QUALITY_AUTOMATION_FAILED",
  "DELIVERY_QUALITY_AUTOMATION_LEASE_STALE",
  "DELIVERY_QUALITY_AUTOMATION_ORPHANED"
]);

function belongsToAutomationJob(claimToken: string, jobId: string): boolean {
  return claimToken === jobId || parseAutomationLeaseToken(claimToken)?.jobId === jobId;
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
function canonicalPersistedJson(value: unknown): string {
  const parsed = JSON.parse(stringifyJson(value));
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(parsed));
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
