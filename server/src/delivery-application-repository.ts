import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  aggregateDeliveryStatus,
  deliveryUnitStatuses,
  MAX_AUTOMATION_EVIDENCE_VERSION,
  type AggregateDeliveryStatus,
  type DeliveryUnitStatus
} from "@ai-workflow/shared";
import { parseAutomationLeaseClaimToken } from "./automation-job-repository.js";
import {
  applicationOwnData as ownData,
  applicationOwnOptionalData as ownOptionalData,
  isApplicationRecord as isPlainRecord,
  parseApplicationSensitivePatterns as parseSensitivePatterns,
  sanitizeApplicationData as sanitizeEvidence,
  serializeApplicationData as serializeStructured
} from "./delivery-application-data.js";

const MAX_TEXT_LENGTH = 256;
const MAX_ERROR_LENGTH = 65_536;
const MAX_CONFLICT_FILES = 1_024;
const SOURCE_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const deliveryUnitStatusSet = new Set<string>(deliveryUnitStatuses);

export type DeliveryApplicationStatus = "applying" | "applied" | "conflicted" | "failed";
export type DeliveryApplicationResolutionStatus = "pending" | "not_required" | "committed" | "reverted";
export type DeliveryApplicationResolution = "committed" | "reverted";

export interface DeliveryApplicationClaimInput {
  expectedEvidenceVersion: number;
  claimToken: string;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflight: unknown;
}

interface DeliveryApplicationCompletionBase {
  commandResults?: unknown[];
  conflictFiles?: string[];
  error?: string | null;
}

export type DeliveryApplicationCompletion = DeliveryApplicationCompletionBase & (
  | { status: "applied" | "conflicted"; worktreeState?: never }
  | { status: "failed"; worktreeState: "clean" | "dirty_or_uncertain" }
);

export interface DeliveryApplicationRun {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  projectVersionId: string;
  evidenceVersion: number;
  automationJobId: string;
  automationAttempt: number;
  leaseOwner: string;
  claimToken: string;
  sourceCommit: string | null;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflight: unknown;
  commandResults: unknown[];
  conflictFiles: string[];
  error: string | null;
  status: DeliveryApplicationStatus;
  resolutionStatus: DeliveryApplicationResolutionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resolvedAt: string | null;
}

export interface DeliveryApplicationClaim extends DeliveryApplicationRun {
  status: "applying";
  resolutionStatus: "pending";
  completedAt: null;
  resolvedAt: null;
}

export interface DeliveryApplicationPersistence {
  claim(unitId: string, input: DeliveryApplicationClaimInput): DeliveryApplicationClaim;
  bindSourceCommit(claim: DeliveryApplicationClaim, sourceCommit: string): DeliveryApplicationClaim;
  complete(claim: DeliveryApplicationClaim, completion: DeliveryApplicationCompletion): DeliveryApplicationRun;
  resolve(run: DeliveryApplicationRun, resolution: DeliveryApplicationResolution): DeliveryApplicationRun;
  get(runId: string): DeliveryApplicationRun | null;
  listForUnit(unitId: string): DeliveryApplicationRun[];
  aggregate(requirementId: string): AggregateDeliveryStatus;
}

interface UnitRow {
  id: string;
  requirement_id: string;
  project_version_id: string;
  evidence_version: number;
  phase: string;
  status: string;
  version_status: string;
  sensitive_patterns_json: string;
}

interface LeaseIdentity {
  jobId: string;
  attempt: number;
  workerId: string;
  claimToken: string;
}

interface SerializedClaimInput {
  expectedEvidenceVersion: number;
  claimToken: string;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflightJson: string;
}

interface SerializedCompletion {
  status: "applied" | "conflicted" | "failed";
  resolutionStatus: "pending" | "not_required";
  commandResultsJson: string;
  conflictFilesJson: string;
  error: string | null;
}

interface ClaimFence {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  projectVersionId: string;
  evidenceVersion: number;
  automationJobId: string;
  automationAttempt: number;
  leaseOwner: string;
  claimToken: string;
}

export class DeliveryApplicationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

  claimInTransaction(unitId: string, input: DeliveryApplicationClaimInput): DeliveryApplicationClaim {
    validateId(unitId);
    let serialized = validateClaimInput(input);
    const unit = this.loadUnit(unitId);
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    if (unit.evidence_version !== serialized.expectedEvidenceVersion) {
      throw new Error("DELIVERY_APPLICATION_EVIDENCE_STALE");
    }
    if (unit.phase !== "acceptance_delivery" || unit.version_status !== "active") {
      throw new Error("DELIVERY_APPLICATION_UNIT_NOT_READY");
    }
    const now = this.now();
    const lease = this.assertLiveLease(
      unit.id, unit.evidence_version, serialized.claimToken, now
    );
    serialized = sanitizeClaim(serialized, parseSensitivePatterns(unit.sensitive_patterns_json));

    const activeUnit = this.db.prepare(`SELECT * FROM delivery_application_runs
      WHERE delivery_unit_id = ? AND resolution_status = 'pending'`).get(unit.id) as any;
    if (activeUnit) {
      if (activeUnit.status !== "applying" || unit.status !== "applying") {
        throw new Error("DELIVERY_APPLICATION_RUN_ACTIVE");
      }
      this.assertSameFrozenClaim(activeUnit, serialized, lease.jobId);
      if (
        activeUnit.claim_token === lease.claimToken
        && activeUnit.automation_attempt === lease.attempt
        && activeUnit.lease_owner === lease.workerId
      ) return mapClaim(activeUnit);
      if (activeUnit.automation_job_id !== lease.jobId || lease.attempt <= activeUnit.automation_attempt) {
        throw new Error("DELIVERY_APPLICATION_RUN_ACTIVE");
      }
      const resumed = this.db.prepare(`UPDATE delivery_application_runs
        SET claim_token = ?, automation_attempt = ?, lease_owner = ?, updated_at = ?
        WHERE id = ? AND status = 'applying' AND resolution_status = 'pending'
          AND automation_job_id = ? AND automation_attempt < ?`).run(
        lease.claimToken, lease.attempt, lease.workerId, now, activeUnit.id, lease.jobId, lease.attempt
      );
      if (resumed.changes !== 1) throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
      return this.getRequiredClaim(activeUnit.id);
    }

    if (unit.status !== "ready_for_acceptance") {
      throw new Error("DELIVERY_APPLICATION_UNIT_NOT_READY");
    }
    if (this.db.prepare(`SELECT 1 FROM delivery_application_runs
      WHERE project_version_id = ? AND resolution_status = 'pending'`).get(unit.project_version_id)) {
      throw new Error("PROJECT_VERSION_APPLICATION_BUSY");
    }

    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO delivery_application_runs
        (id, requirement_id, delivery_unit_id, project_version_id, evidence_version,
          automation_job_id, automation_attempt, lease_owner, claim_token, source_commit,
          base_commit, pre_apply_commit, evidence_hash, preflight_json,
          command_results_json, conflict_files_json, error, status, resolution_status,
          created_at, updated_at, completed_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', '[]', NULL,
          'applying', 'pending', ?, ?, NULL, NULL)`)
        .run(id, unit.requirement_id, unit.id, unit.project_version_id, unit.evidence_version,
          lease.jobId, lease.attempt, lease.workerId, lease.claimToken, serialized.baseCommit,
          serialized.preApplyCommit, serialized.evidenceHash, serialized.preflightJson, now, now);
    } catch (error) {
      throw mapClaimConstraint(error);
    }
    const updated = this.db.prepare(`UPDATE delivery_units
      SET status = 'applying', updated_at = ?, completed_at = NULL
      WHERE id = ? AND evidence_version = ? AND phase = 'acceptance_delivery'
        AND status = 'ready_for_acceptance'`).run(now, unit.id, unit.evidence_version);
    if (updated.changes !== 1) throw new Error("DELIVERY_APPLICATION_UNIT_STALE");
    return this.getRequiredClaim(id);
  }

  bindSourceCommitInTransaction(
    claim: DeliveryApplicationClaim,
    sourceCommit: string
  ): DeliveryApplicationClaim {
    const canonicalCommit = validateSourceCommit(sourceCommit);
    const { fence, row } = this.assertFencedClaim(claim);
    if (row.source_commit !== null) {
      if (row.source_commit === canonicalCommit) return mapClaim(row);
      throw new Error("DELIVERY_APPLICATION_SOURCE_COMMIT_BOUND");
    }
    const now = this.now();
    const updated = this.db.prepare(`UPDATE delivery_application_runs
      SET source_commit = ?, updated_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ?
        AND automation_job_id = ? AND automation_attempt = ? AND claim_token = ?
        AND status = 'applying' AND source_commit IS NULL`).run(
      canonicalCommit, now, fence.id, fence.deliveryUnitId, fence.evidenceVersion,
      fence.automationJobId, fence.automationAttempt, fence.claimToken
    );
    if (updated.changes !== 1) throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
    return this.getRequiredClaim(fence.id);
  }

  completeInTransaction(
    claim: DeliveryApplicationClaim,
    completion: DeliveryApplicationCompletion
  ): DeliveryApplicationRun {
    let serialized = validateCompletion(completion);
    const { fence, row } = this.assertFencedClaim(claim);
    if ((serialized.status === "applied" || serialized.status === "conflicted")
      && row.source_commit === null) {
      throw new Error("DELIVERY_APPLICATION_SOURCE_COMMIT_REQUIRED");
    }
    serialized = sanitizeCompletion(serialized, this.loadSensitivePatterns(fence.deliveryUnitId));
    const now = this.now();
    const settled = this.db.prepare(`UPDATE delivery_application_runs
      SET status = ?, resolution_status = ?, command_results_json = ?, conflict_files_json = ?,
        error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND project_version_id = ? AND evidence_version = ?
        AND automation_job_id = ? AND automation_attempt = ? AND claim_token = ?
        AND status = 'applying' AND resolution_status = 'pending'`).run(
      serialized.status, serialized.resolutionStatus, serialized.commandResultsJson,
      serialized.conflictFilesJson, serialized.error, now, now, fence.id, fence.deliveryUnitId,
      fence.projectVersionId, fence.evidenceVersion, fence.automationJobId,
      fence.automationAttempt, fence.claimToken
    );
    if (settled.changes !== 1) throw new Error("DELIVERY_APPLICATION_RUN_STALE");
    const unitSettled = this.db.prepare(`UPDATE delivery_units
      SET status = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
        AND phase = 'acceptance_delivery' AND status = 'applying'`).run(
      serialized.status, now, now, fence.deliveryUnitId, fence.requirementId,
      fence.projectVersionId, fence.evidenceVersion
    );
    if (unitSettled.changes !== 1) throw new Error("DELIVERY_APPLICATION_UNIT_STALE");
    this.aggregateInTransaction(fence.requirementId);
    return this.getRequired(fence.id);
  }

  resolveInTransaction(
    run: DeliveryApplicationRun,
    resolution: DeliveryApplicationResolution
  ): DeliveryApplicationRun {
    if (resolution !== "committed" && resolution !== "reverted") {
      throw new Error("DELIVERY_APPLICATION_RESOLUTION_INVALID");
    }
    const fence = validateResolutionFence(run);
    const current = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?")
      .get(fence.id) as any;
    if (!current) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    if (
      (current.status !== "applied" && current.status !== "failed")
      || current.resolution_status !== "pending"
      || current.claim_token !== fence.claimToken
      || current.updated_at !== fence.updatedAt
      || current.requirement_id !== fence.requirementId
      || current.delivery_unit_id !== fence.deliveryUnitId
      || current.project_version_id !== fence.projectVersionId
      || current.evidence_version !== fence.evidenceVersion
      || current.automation_job_id !== fence.automationJobId
      || current.automation_attempt !== fence.automationAttempt
      || current.lease_owner !== fence.leaseOwner
    ) throw new Error("DELIVERY_APPLICATION_RESOLUTION_STALE");
    if (!this.db.prepare(`SELECT 1 FROM delivery_units
      WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
        AND phase = 'acceptance_delivery' AND status = ?`).get(
      current.delivery_unit_id, current.requirement_id, current.project_version_id,
      current.evidence_version, current.status
    )) throw new Error("DELIVERY_APPLICATION_RESOLUTION_STALE");
    const now = this.now();
    const resolved = this.db.prepare(`UPDATE delivery_application_runs
      SET resolution_status = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('applied', 'failed') AND resolution_status = 'pending'
        AND claim_token = ? AND updated_at = ?`).run(
      resolution, now, now, fence.id, fence.claimToken, fence.updatedAt
    );
    if (resolved.changes !== 1) throw new Error("DELIVERY_APPLICATION_RESOLUTION_STALE");
    if (resolution === "reverted") {
      const unit = this.db.prepare(`UPDATE delivery_units
        SET status = 'ready_for_acceptance', completed_at = NULL, updated_at = ?
        WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
          AND phase = 'acceptance_delivery' AND status = ?`).run(
        now, current.delivery_unit_id, current.requirement_id, current.project_version_id,
        current.evidence_version, current.status
      );
      if (unit.changes !== 1) throw new Error("DELIVERY_APPLICATION_RESOLUTION_STALE");
    }
    this.aggregateInTransaction(current.requirement_id);
    return this.getRequired(fence.id);
  }

  reconcileAutomationJobsInTransaction(now: Date): number {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("DELIVERY_APPLICATION_DATE_INVALID");
    }
    const nowIso = now.toISOString();
    const rows = this.db.prepare(`SELECT application.*, job.status AS job_status
      FROM delivery_application_runs application
      JOIN automation_jobs job ON job.id = application.automation_job_id
        AND job.owner_type = 'delivery_unit'
        AND job.owner_id = application.delivery_unit_id
        AND job.evidence_version = application.evidence_version
        AND job.action = 'apply'
        AND job.attempt = application.automation_attempt
        AND job.claim_token = application.claim_token
      WHERE (application.status = 'applying' AND job.status IN ('completed', 'failed', 'canceled'))
        OR (application.status <> 'applying' AND job.status <> 'completed')
      ORDER BY application.created_at, application.id`).all() as any[];
    let reconciled = 0;
    for (const row of rows) {
      if (row.status === "applying") {
        const application = this.db.prepare(`UPDATE delivery_application_runs
          SET status = 'failed', resolution_status = 'pending',
            error = 'DELIVERY_APPLICATION_JOB_TERMINAL', updated_at = ?, completed_at = ?
          WHERE id = ? AND status = 'applying' AND resolution_status = 'pending'
            AND automation_job_id = ? AND automation_attempt = ? AND claim_token = ?`).run(
          nowIso, nowIso, row.id, row.automation_job_id, row.automation_attempt, row.claim_token
        );
        if (application.changes !== 1) throw new Error("DELIVERY_APPLICATION_RECONCILIATION_STALE");
        const unit = this.db.prepare(`UPDATE delivery_units
          SET status = 'failed', updated_at = ?, completed_at = ?
          WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
            AND phase = 'acceptance_delivery' AND status = 'applying'`).run(
          nowIso, nowIso, row.delivery_unit_id, row.requirement_id,
          row.project_version_id, row.evidence_version
        );
        if (unit.changes !== 1) throw new Error("DELIVERY_APPLICATION_RECONCILIATION_STALE");
        this.aggregateInTransaction(row.requirement_id);
      } else {
        const job = this.db.prepare(`UPDATE automation_jobs
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND owner_type = 'delivery_unit' AND owner_id = ?
            AND evidence_version = ? AND action = 'apply' AND attempt = ? AND claim_token = ?
            AND status <> 'completed'`).run(
          nowIso, row.automation_job_id, row.delivery_unit_id, row.evidence_version,
          row.automation_attempt, row.claim_token
        );
        if (job.changes !== 1) throw new Error("DELIVERY_APPLICATION_RECONCILIATION_STALE");
      }
      reconciled += 1;
    }
    return reconciled;
  }

  get(runId: string): DeliveryApplicationRun | null {
    validateId(runId);
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId);
    return row ? mapRun(row as any) : null;
  }

  listForUnit(unitId: string): DeliveryApplicationRun[] {
    validateId(unitId);
    return (this.db.prepare(`SELECT * FROM delivery_application_runs
      WHERE delivery_unit_id = ? ORDER BY created_at, id`).all(unitId) as any[]).map(mapRun);
  }

  aggregate(requirementId: string): AggregateDeliveryStatus {
    validateId(requirementId);
    if (!this.db.prepare("SELECT 1 FROM requirements WHERE id = ?").get(requirementId)) {
      throw new Error("REQUIREMENT_NOT_FOUND");
    }
    return this.aggregateInTransaction(requirementId);
  }

  private assertFencedClaim(claim: DeliveryApplicationClaim): { fence: ClaimFence; row: any } {
    const fence = validateClaimFence(claim);
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?")
      .get(fence.id) as any;
    if (!row) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    if (row.status !== "applying" || row.resolution_status !== "pending") {
      throw new Error("DELIVERY_APPLICATION_RUN_SETTLED");
    }
    if (
      row.requirement_id !== fence.requirementId
      || row.delivery_unit_id !== fence.deliveryUnitId
      || row.project_version_id !== fence.projectVersionId
      || row.evidence_version !== fence.evidenceVersion
      || row.automation_job_id !== fence.automationJobId
    ) throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
    if (
      row.automation_attempt !== fence.automationAttempt
      || row.claim_token !== fence.claimToken
      || row.lease_owner !== fence.leaseOwner
    ) throw new Error("DELIVERY_APPLICATION_LEASE_STALE");
    const now = this.now();
    this.assertLiveLease(fence.deliveryUnitId, fence.evidenceVersion, fence.claimToken, now, {
      jobId: fence.automationJobId,
      attempt: fence.automationAttempt,
      workerId: fence.leaseOwner
    });
    if (!this.db.prepare(`SELECT 1 FROM delivery_units
      WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
        AND phase = 'acceptance_delivery' AND status = 'applying'`).get(
      fence.deliveryUnitId, fence.requirementId, fence.projectVersionId, fence.evidenceVersion
    )) throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
    return { fence, row };
  }

  private assertLiveLease(
    unitId: string,
    evidenceVersion: number,
    claimToken: string,
    now: string,
    expected?: Omit<LeaseIdentity, "claimToken">
  ): LeaseIdentity {
    const parsed = parseLeaseToken(claimToken);
    if (expected && (parsed.jobId !== expected.jobId || parsed.workerId !== expected.workerId)) {
      throw new Error("DELIVERY_APPLICATION_LEASE_STALE");
    }
    const row = this.db.prepare(`SELECT job.attempt, job.lease_owner
      FROM automation_jobs job
      JOIN delivery_units unit ON unit.id = job.owner_id
        AND unit.requirement_id = (SELECT requirement_id FROM delivery_units WHERE id = ?)
      WHERE job.id = ? AND job.claim_token = ? AND job.owner_type = 'delivery_unit'
        AND job.owner_id = ? AND job.evidence_version = ? AND job.action = 'apply'
        AND job.status = 'leased' AND job.lease_owner = ?
        AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at > ?`).get(
      unitId, parsed.jobId, claimToken, unitId, evidenceVersion, parsed.workerId, now
    ) as { attempt: number; lease_owner: string } | undefined;
    if (!row || !Number.isSafeInteger(row.attempt) || row.attempt < 1
      || (expected && row.attempt !== expected.attempt)) {
      throw new Error("DELIVERY_APPLICATION_LEASE_STALE");
    }
    return { jobId: parsed.jobId, attempt: row.attempt, workerId: row.lease_owner, claimToken };
  }

  private assertSameFrozenClaim(row: any, input: SerializedClaimInput, jobId: string) {
    if (
      row.automation_job_id !== jobId
      || row.evidence_version !== input.expectedEvidenceVersion
      || row.base_commit !== input.baseCommit
      || row.pre_apply_commit !== input.preApplyCommit
      || row.evidence_hash !== input.evidenceHash
      || row.preflight_json !== input.preflightJson
    ) throw new Error("DELIVERY_APPLICATION_CLAIM_CONFLICT");
  }

  private loadUnit(unitId: string): UnitRow | null {
    return (this.db.prepare(`SELECT unit.id, unit.requirement_id, unit.project_version_id,
        unit.evidence_version, unit.phase, unit.status, version.status AS version_status,
        snapshot.sensitive_patterns_json
      FROM delivery_units unit
      JOIN project_versions version ON version.id = unit.project_version_id
      JOIN delivery_unit_snapshots snapshot ON snapshot.delivery_unit_id = unit.id
      WHERE unit.id = ?`).get(unitId) as UnitRow | undefined) ?? null;
  }

  private aggregateInTransaction(requirementId: string): AggregateDeliveryStatus {
    const rows = this.db.prepare(`SELECT required, status FROM delivery_units
      WHERE requirement_id = ? ORDER BY position, id`).all(requirementId) as Array<{
        required: number; status: string;
      }>;
    for (const row of rows) {
      if ((row.required !== 0 && row.required !== 1) || !deliveryUnitStatusSet.has(row.status)) {
        throw new Error("DELIVERY_APPLICATION_AGGREGATE_INVALID");
      }
    }
    return aggregateDeliveryStatus(rows.map((row) => ({
      required: row.required === 1,
      status: row.status as DeliveryUnitStatus
    })));
  }

  private getRequired(runId: string): DeliveryApplicationRun {
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId);
    if (!row) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    return mapRun(row as any);
  }

  private getRequiredClaim(runId: string): DeliveryApplicationClaim {
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId);
    if (!row) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    return mapClaim(row as any);
  }

  private loadSensitivePatterns(unitId: string): string[] {
    const row = this.db.prepare(`SELECT sensitive_patterns_json FROM delivery_unit_snapshots
      WHERE delivery_unit_id = ?`).get(unitId) as { sensitive_patterns_json: string } | undefined;
    if (!row) throw new Error("DELIVERY_UNIT_SNAPSHOT_NOT_FOUND");
    return parseSensitivePatterns(row.sensitive_patterns_json);
  }

  private now(): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("DELIVERY_APPLICATION_DATE_INVALID");
    }
    return now.toISOString();
  }
}

function validateClaimInput(input: DeliveryApplicationClaimInput): SerializedClaimInput {
  if (!isPlainRecord(input)) throw new Error("DELIVERY_APPLICATION_CLAIM_INVALID");
  const expectedEvidenceVersion = ownData(input, "expectedEvidenceVersion", "DELIVERY_APPLICATION_CLAIM_INVALID");
  if (!Number.isSafeInteger(expectedEvidenceVersion)
    || (expectedEvidenceVersion as number) < 1
    || (expectedEvidenceVersion as number) > MAX_AUTOMATION_EVIDENCE_VERSION) {
    throw new Error("DELIVERY_APPLICATION_CLAIM_INVALID");
  }
  const claimToken = validateText(ownData(input, "claimToken", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  parseLeaseToken(claimToken);
  const baseCommit = validateText(ownData(input, "baseCommit", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const preApplyCommit = validateText(ownData(input, "preApplyCommit", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const evidenceHash = validateText(ownData(input, "evidenceHash", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const preflightJson = serializeStructured(
    ownData(input, "preflight", "DELIVERY_APPLICATION_CLAIM_INVALID"), "PREFLIGHT"
  );
  return {
    expectedEvidenceVersion: expectedEvidenceVersion as number,
    claimToken, baseCommit, preApplyCommit, evidenceHash, preflightJson
  };
}

function validateClaimFence(value: unknown): ClaimFence {
  if (!isPlainRecord(value)) throw new Error("DELIVERY_APPLICATION_CLAIM_INVALID");
  const error = "DELIVERY_APPLICATION_CLAIM_INVALID";
  const fence = {
    id: validateText(ownData(value, "id", error), error),
    requirementId: validateText(ownData(value, "requirementId", error), error),
    deliveryUnitId: validateText(ownData(value, "deliveryUnitId", error), error),
    projectVersionId: validateText(ownData(value, "projectVersionId", error), error),
    evidenceVersion: ownData(value, "evidenceVersion", error),
    automationJobId: validateText(ownData(value, "automationJobId", error), error),
    automationAttempt: ownData(value, "automationAttempt", error),
    leaseOwner: validateText(ownData(value, "leaseOwner", error), error, 128),
    claimToken: validateText(ownData(value, "claimToken", error), error)
  };
  if (!Number.isSafeInteger(fence.evidenceVersion) || (fence.evidenceVersion as number) < 1
    || !Number.isSafeInteger(fence.automationAttempt) || (fence.automationAttempt as number) < 1) {
    throw new Error(error);
  }
  const parsed = parseLeaseToken(fence.claimToken);
  if (parsed.jobId !== fence.automationJobId || parsed.workerId !== fence.leaseOwner) {
    throw new Error("DELIVERY_APPLICATION_LEASE_STALE");
  }
  return fence as ClaimFence;
}

function validateResolutionFence(value: unknown): ClaimFence & { updatedAt: string } {
  const fence = validateClaimFence(value);
  return {
    ...fence,
    updatedAt: validateText(
      ownData(value as Record<string, any>, "updatedAt", "DELIVERY_APPLICATION_RESOLUTION_INVALID"),
      "DELIVERY_APPLICATION_RESOLUTION_INVALID"
    )
  };
}

function validateCompletion(completion: DeliveryApplicationCompletion): SerializedCompletion {
  if (!isPlainRecord(completion)) throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  const status = ownData(completion, "status", "DELIVERY_APPLICATION_COMPLETION_INVALID");
  if (status !== "applied" && status !== "conflicted" && status !== "failed") {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  const commandResults = ownOptionalData(
    completion, "commandResults", "DELIVERY_APPLICATION_COMPLETION_INVALID"
  ) ?? [];
  if (!Array.isArray(commandResults)) throw new Error("DELIVERY_APPLICATION_COMMAND_RESULTS_INVALID");
  const commandResultsJson = serializeStructured(commandResults, "COMMAND_RESULTS", true);
  const conflictFiles = validateConflictFiles(ownOptionalData(
    completion, "conflictFiles", "DELIVERY_APPLICATION_COMPLETION_INVALID"
  ) ?? []);
  const conflictFilesJson = serializeStructured(conflictFiles, "CONFLICT_FILES", true);
  const errorValue = ownOptionalData(completion, "error", "DELIVERY_APPLICATION_COMPLETION_INVALID");
  const error = errorValue == null
    ? null
    : validateText(errorValue, "DELIVERY_APPLICATION_ERROR_INVALID", MAX_ERROR_LENGTH);
  if (status === "applied") {
    if (conflictFiles.length > 0 || error !== null) throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
    return { status, resolutionStatus: "pending", commandResultsJson, conflictFilesJson, error };
  }
  if (status === "conflicted" && conflictFiles.length === 0) {
    throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  }
  if (error === null) throw new Error("DELIVERY_APPLICATION_ERROR_INVALID");
  if (status === "failed" && conflictFiles.length > 0) {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  const worktreeState = ownOptionalData(
    completion, "worktreeState", "DELIVERY_APPLICATION_COMPLETION_INVALID"
  );
  if (status !== "failed" && worktreeState !== undefined) {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  if (status === "failed" && worktreeState !== "clean" && worktreeState !== "dirty_or_uncertain") {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  return {
    status,
    resolutionStatus: status === "failed" && worktreeState === "dirty_or_uncertain"
      ? "pending" : "not_required",
    commandResultsJson,
    conflictFilesJson,
    error
  };
}

function validateConflictFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONFLICT_FILES) {
    throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  }
  const files = value.map((file) => validateText(
    file, "DELIVERY_APPLICATION_CONFLICT_FILES_INVALID", 4_096
  ));
  if (new Set(files).size !== files.length) throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  return files;
}

function sanitizeClaim(input: SerializedClaimInput, patterns: string[]): SerializedClaimInput {
  const preflight = sanitizeEvidence(JSON.parse(input.preflightJson), patterns);
  return { ...input, preflightJson: serializeStructured(preflight, "PREFLIGHT") };
}

function sanitizeCompletion(completion: SerializedCompletion, patterns: string[]): SerializedCompletion {
  const sanitized = sanitizeEvidence({
    commandResults: JSON.parse(completion.commandResultsJson),
    conflictFiles: JSON.parse(completion.conflictFilesJson),
    error: completion.error
  }, patterns) as { commandResults: unknown; conflictFiles: unknown; error: unknown };
  const commandResultsJson = serializeStructured(sanitized.commandResults, "COMMAND_RESULTS", true);
  const conflictFiles = validateConflictFiles(sanitized.conflictFiles);
  const conflictFilesJson = serializeStructured(conflictFiles, "CONFLICT_FILES", true);
  const error = sanitized.error === null
    ? null
    : validateText(sanitized.error, "DELIVERY_APPLICATION_ERROR_INVALID", MAX_ERROR_LENGTH);
  return { ...completion, commandResultsJson, conflictFilesJson, error };
}

function validateId(value: unknown): asserts value is string {
  validateText(value, "DELIVERY_APPLICATION_ID_INVALID");
}

function validateSourceCommit(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value)) {
    throw new Error("DELIVERY_APPLICATION_SOURCE_COMMIT_INVALID");
  }
  return value;
}

function validateText(value: unknown, error: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength
    || value.trim() !== value || value.includes("\0")) throw new Error(error);
  return value;
}

function parseLeaseToken(value: string): { jobId: string; workerId: string } {
  const parsed = parseAutomationLeaseClaimToken(value);
  if (!parsed) throw new Error("DELIVERY_APPLICATION_LEASE_INVALID");
  return parsed;
}

function mapRun(row: any): DeliveryApplicationRun {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    projectVersionId: row.project_version_id,
    evidenceVersion: row.evidence_version,
    automationJobId: row.automation_job_id,
    automationAttempt: row.automation_attempt,
    leaseOwner: row.lease_owner,
    claimToken: row.claim_token,
    sourceCommit: row.source_commit,
    baseCommit: row.base_commit,
    preApplyCommit: row.pre_apply_commit,
    evidenceHash: row.evidence_hash,
    preflight: JSON.parse(row.preflight_json),
    commandResults: JSON.parse(row.command_results_json),
    conflictFiles: JSON.parse(row.conflict_files_json),
    error: row.error,
    status: row.status,
    resolutionStatus: row.resolution_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    resolvedAt: row.resolved_at
  };
}

function mapClaim(row: any): DeliveryApplicationClaim {
  const run = mapRun(row);
  if (run.status !== "applying" || run.resolutionStatus !== "pending"
    || run.completedAt !== null || run.resolvedAt !== null) {
    throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
  }
  return run as DeliveryApplicationClaim;
}

function mapClaimConstraint(error: unknown): Error {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    if (error.message.includes("claim_token")) return new Error("DELIVERY_APPLICATION_LEASE_STALE");
    if (error.message.includes("delivery_unit_id")) return new Error("DELIVERY_APPLICATION_RUN_ACTIVE");
    if (error.message.includes("project_version_id")) return new Error("PROJECT_VERSION_APPLICATION_BUSY");
  }
  return error instanceof Error ? error : new Error("DELIVERY_APPLICATION_CLAIM_FAILED");
}
