import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_AUTOMATION_EVIDENCE_VERSION } from "@ai-workflow/shared";
import { deliveryUnitHasActiveWork } from "./delivery-unit-eligibility.js";
import { AutomationJobRepository } from "./automation-job-repository.js";
import { deliveryUnitDependenciesSatisfied } from "./delivery-unit-eligibility.js";
import {
  DeliveryQualityRepository,
  type DeliveryQualityClaim,
  type DeliveryQualityCompletion,
  type DeliveryQualityEvidence,
  type DeliveryQualityKind
} from "./delivery-quality-repository.js";

export interface DeliveryQualityOverrideInput {
  unitId: string;
  evidenceVersion: number;
  kind: DeliveryQualityKind;
  actor: string;
  reason: string;
  acceptedRisk: string;
}

export interface DeliveryQualityOverride {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  evidenceVersion: number;
  kind: DeliveryQualityKind;
  actor: string;
  reason: string;
  acceptedRisk: string;
  codingEvidenceId: string;
  inputDiffHash: string;
  qualityEvidenceId: string;
  evidenceIds: string[];
  createdAt: string;
}

interface UnitIdentityRow {
  id: string;
  requirement_id: string;
  evidence_version: number;
  phase: string;
  status: string;
  coding_evidence_id: string;
  diff_hash: string;
}

interface GateEvidenceRow {
  id: string;
  kind: DeliveryQualityKind;
  result: "passed" | "failed";
}

interface OverrideRow {
  id: string;
  requirement_id: string;
  delivery_unit_id: string;
  evidence_version: number;
  kind: DeliveryQualityKind;
  actor: string;
  reason: string;
  accepted_risk: string;
  coding_evidence_id: string;
  input_diff_hash: string;
  quality_evidence_id: string;
  evidence_ids_json: string;
  created_at: string;
}

export interface DeliveryCoordinationPersistence {
  overrideQuality(input: DeliveryQualityOverrideInput): DeliveryQualityOverride;
  listQualityOverrides(unitId: string, evidenceVersion?: number): DeliveryQualityOverride[];
  resolveStale(input: DeliveryStaleResolutionInput): DeliveryStaleDecision;
  completeContractEvidence(input: DeliveryContractEvidenceInput): DeliveryContractEvidence;
  pauseAutomation(input: RequirementAutomationInput): RequirementAutomationState;
  resumeAutomation(input: RequirementAutomationInput): RequirementAutomationState;
  skipOptional(input: DeliverySkipInput): DeliveryUnitSkip;
  retryUnit(input: DeliveryUnitRetryInput): DeliveryUnitRetryAudit;
}

export interface DeliveryContractEvidenceInput {
  unitId: string;
  version: number;
  contractHash: string;
  content: unknown;
  actor: string;
}

export interface DeliveryContractEvidence {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  version: number;
  contractHash: string;
  content: unknown;
  actor: string;
  createdAt: string;
}

export interface RequirementAutomationInput {
  requirementId: string;
  actor: string;
  reason: string;
}

export interface RequirementAutomationState {
  requirementId: string;
  status: "active" | "paused";
  actor: string;
  reason: string;
  updatedAt: string;
}

export interface DeliverySkipInput { unitId: string; actor: string; reason: string }
export interface DeliveryUnitSkip {
  id: string; requirementId: string; deliveryUnitId: string; evidenceVersion: number;
  actor: string; reason: string; createdAt: string;
}

export type DeliveryUnitRetryTarget = "implementation" | "code_review" | "automated_testing";
export interface DeliveryUnitRetryInput {
  unitId: string;
  target: DeliveryUnitRetryTarget;
  actor: string;
  reason: string;
}
export interface DeliveryUnitRetryAudit {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  evidenceVersion: number;
  jobId: string;
  target: DeliveryUnitRetryTarget;
  actor: string;
  reason: string;
  createdAt: string;
}

export interface DeliveryStaleResolutionInput {
  unitId: string;
  decision: "reuse" | "rerun";
  reason: string;
  actor: string;
}

export interface DeliveryStaleDecision {
  id: string;
  invalidationId: string;
  requirementId: string;
  deliveryUnitId: string;
  targetEvidenceVersion: number;
  sourceOldEvidenceId: string;
  sourceOldEvidenceVersion: number;
  sourceNewEvidenceId: string;
  sourceNewEvidenceVersion: number;
  decision: "reuse" | "rerun";
  resultingEvidenceVersion: number;
  actor: string;
  reason: string;
  createdAt: string;
  sources: DeliveryStaleDecisionSource[];
}

export interface DeliveryStaleDecisionSource {
  invalidationId: string;
  sourceUnitId: string;
  sourceKind: "implementation" | "contract";
  sourceOldEvidenceId: string;
  sourceOldEvidenceVersion: number;
  sourceOldEvidenceHash: string;
  sourceNewEvidenceId: string;
  sourceNewEvidenceVersion: number;
  sourceNewEvidenceHash: string;
  sourceCurrentEvidenceId: string;
  sourceCurrentEvidenceVersion: number;
  sourceCurrentEvidenceHash: string;
}

interface InvalidationRow {
  id: string;
  requirement_id: string;
  source_unit_id: string;
  source_kind: "implementation" | "contract";
  source_old_evidence_id: string;
  source_old_evidence_version: number;
  source_old_evidence_hash: string;
  source_new_evidence_id: string;
  source_new_evidence_version: number;
  source_new_evidence_hash: string;
  target_unit_id: string;
  target_evidence_version: number;
  prior_phase: string;
  prior_status: string;
  earliest_invalid_phase: "implementation" | "quality_verification";
}

interface StaleDecisionRow {
  id: string;
  requirement_id: string;
  delivery_unit_id: string;
  target_evidence_version: number;
  decision: "reuse" | "rerun";
  resulting_evidence_version: number;
  actor: string;
  reason: string;
  created_at: string;
}

interface StaleDecisionSourceRow extends InvalidationRow {
  decision_id: string;
  source_current_evidence_id: string;
  source_current_evidence_version: number;
  source_current_evidence_hash: string;
}

interface ContractEvidenceRow {
  id: string;
  requirement_id: string;
  delivery_unit_id: string;
  evidence_version: number;
  contract_hash: string;
  content_json: string;
  actor: string;
  created_at: string;
}

export class DeliveryCoordinator {
  constructor(
    private readonly db: DatabaseSync,
    private readonly quality = new DeliveryQualityRepository(db)
  ) {}

  recordQualityInTransaction(
    claim: DeliveryQualityClaim,
    completion: DeliveryQualityCompletion
  ): DeliveryQualityEvidence {
    const { evidence, replayed } = this.quality.completeWithReplayStateInTransaction(claim, completion);
    if (replayed) return evidence;
    this.settleUnitInTransaction(evidence.deliveryUnitId, evidence.evidenceVersion);
    return evidence;
  }

  completeContractEvidenceInTransaction(input: DeliveryContractEvidenceInput): DeliveryContractEvidence {
    const contentJson = validateContractEvidenceInput(input);
    const actor = input.actor.trim();
    const existing = this.contractEvidence(input.unitId, input.version);
    if (existing) {
      if (existing.contractHash !== input.contractHash.trim() || existing.actor !== actor
        || JSON.stringify(existing.content) !== contentJson) {
        throw new Error("DELIVERY_CONTRACT_EVIDENCE_CONFLICT");
      }
      return existing;
    }
    const unit = this.db.prepare(`SELECT id, requirement_id FROM delivery_units WHERE id = ?`).get(input.unitId) as {
      id: string; requirement_id: string;
    } | undefined;
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    const latest = this.db.prepare(`SELECT MAX(evidence_version) AS version FROM delivery_contract_evidence
      WHERE delivery_unit_id = ?`).get(unit.id) as { version: number | null };
    const expectedVersion = latest.version === null ? 1 : latest.version + 1;
    if (input.version !== expectedVersion) throw new Error("DELIVERY_CONTRACT_EVIDENCE_SEQUENCE_INVALID");
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO delivery_contract_evidence
      (id, requirement_id, delivery_unit_id, evidence_version, contract_hash, content_json, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, unit.requirement_id, unit.id, input.version,
      input.contractHash.trim(), contentJson, actor, now);
    const persisted = this.contractEvidence(unit.id, input.version)!;
    if (input.version > 1) {
      const oldEvidence = this.db.prepare(`SELECT id, evidence_version, contract_hash
        FROM delivery_contract_evidence WHERE delivery_unit_id = ? AND evidence_version = ?`)
        .get(unit.id, input.version - 1) as { id: string; evidence_version: number; contract_hash: string } | undefined;
      if (!oldEvidence) throw new Error("DELIVERY_CONTRACT_EVIDENCE_SEQUENCE_INVALID");
      this.invalidateDescendantsInTransaction({
        requirementId: unit.requirement_id,
        sourceUnitId: unit.id,
        sourceKind: "contract",
        oldEvidenceId: oldEvidence.id,
        oldEvidenceVersion: oldEvidence.evidence_version,
        oldEvidenceHash: oldEvidence.contract_hash,
        newEvidenceId: persisted.id,
        newEvidenceVersion: persisted.version,
        newEvidenceHash: persisted.contractHash,
        actor
      });
    }
    return persisted;
  }

  recordImplementationEvidenceInTransaction(unitId: string, evidenceVersion: number, actor = "automation") {
    if (evidenceVersion <= 1) return;
    const evidence = this.db.prepare(`SELECT id, requirement_id, delivery_unit_id, evidence_version, diff_hash
      FROM coding_evidence WHERE delivery_unit_id = ? AND evidence_version IN (?, ?)
      ORDER BY evidence_version`).all(unitId, evidenceVersion - 1, evidenceVersion) as Array<{
        id: string; requirement_id: string; delivery_unit_id: string; evidence_version: number; diff_hash: string;
      }>;
    if (evidence.length !== 2 || evidence[0]!.evidence_version !== evidenceVersion - 1
      || evidence[1]!.evidence_version !== evidenceVersion) {
      throw new Error("DELIVERY_IMPLEMENTATION_EVIDENCE_CHAIN_INVALID");
    }
    const [oldEvidence, newEvidence] = evidence;
    this.invalidateDescendantsInTransaction({
      requirementId: newEvidence!.requirement_id,
      sourceUnitId: unitId,
      sourceKind: "implementation",
      oldEvidenceId: oldEvidence!.id,
      oldEvidenceVersion: oldEvidence!.evidence_version,
      oldEvidenceHash: oldEvidence!.diff_hash,
      newEvidenceId: newEvidence!.id,
      newEvidenceVersion: newEvidence!.evidence_version,
      newEvidenceHash: newEvidence!.diff_hash,
      actor
    });
  }

  private invalidateDescendantsInTransaction(change: {
    requirementId: string;
    sourceUnitId: string;
    sourceKind: "implementation" | "contract";
    oldEvidenceId: string;
    oldEvidenceVersion: number;
    oldEvidenceHash: string;
    newEvidenceId: string;
    newEvidenceVersion: number;
    newEvidenceHash: string;
    actor: string;
  }) {
    const descendants = this.descendantsFailClosed(change.sourceUnitId, change.requirementId);
    if (descendants.length === 0) return;
    const now = new Date().toISOString();
    const affectedIds = [...(change.sourceKind === "implementation" ? [change.sourceUnitId] : []), ...descendants
      .filter((row) => row.status !== "skipped" && row.status !== "applied")
      .map((row) => row.id)];
    if (affectedIds.length > 0) {
      const placeholders = affectedIds.map(() => "?").join(", ");
      this.db.prepare(`UPDATE delivery_dependencies SET released_by_evidence_version = NULL, released_at = NULL
        WHERE upstream_unit_id IN (${placeholders})`).run(...affectedIds);
    }
    for (const target of descendants) {
      if (target.status === "skipped" || target.status === "applied") continue;
      this.db.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
        WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ? AND status = 'pending'`)
        .run(now, target.id, target.evidence_version);
      const started = target.phase !== "implementation"
        || !["waiting_dependency", "ready"].includes(target.status)
        || Number((this.db.prepare(`SELECT COUNT(*) AS count FROM executions
          WHERE delivery_unit_id = ? AND evidence_version = ?`).get(target.id, target.evidence_version) as { count: number }).count) > 0;
      if (!started) {
        this.db.prepare(`UPDATE delivery_units SET status = 'waiting_dependency', updated_at = ?
          WHERE id = ? AND evidence_version = ? AND phase = 'implementation'
            AND status IN ('waiting_dependency', 'ready')`).run(now, target.id, target.evidence_version);
        continue;
      }
      const prior = this.activeInvalidations(target.id, target.evidence_version)[0];
      const priorPhase = prior?.prior_phase ?? target.phase;
      const priorStatus = prior?.prior_status ?? target.status;
      this.db.prepare(`INSERT INTO delivery_evidence_invalidations
        (id, requirement_id, source_unit_id, source_kind,
         source_old_evidence_id, source_old_evidence_version, source_old_evidence_hash,
         source_new_evidence_id, source_new_evidence_version, source_new_evidence_hash,
         target_unit_id, target_evidence_version, prior_phase, prior_status, earliest_invalid_phase,
         cause, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'implementation', ?, ?, ?)
        ON CONFLICT(source_kind, source_unit_id, source_new_evidence_id,
          source_new_evidence_version, target_unit_id, target_evidence_version) DO NOTHING`)
        .run(randomUUID(), change.requirementId, change.sourceUnitId, change.sourceKind,
          change.oldEvidenceId, change.oldEvidenceVersion, change.oldEvidenceHash,
          change.newEvidenceId, change.newEvidenceVersion, change.newEvidenceHash,
          target.id, target.evidence_version, priorPhase, priorStatus,
          `Upstream ${change.sourceKind} evidence changed from v${change.oldEvidenceVersion} to v${change.newEvidenceVersion}`,
          change.actor, now);
      const updated = this.db.prepare(`UPDATE delivery_units SET status = 'potentially_stale', updated_at = ?
        WHERE id = ? AND evidence_version = ? AND status IN (?, 'potentially_stale')`)
        .run(now, target.id, target.evidence_version, target.status);
      if (updated.changes !== 1) {
        throw new Error("DELIVERY_EVIDENCE_INVALIDATION_STALE");
      }
    }
    if (change.sourceKind === "contract") {
      const source = this.db.prepare(`SELECT requirement_id, status, evidence_version
        FROM delivery_units WHERE id = ?`).get(change.sourceUnitId) as {
          requirement_id: string; status: string; evidence_version: number;
        } | undefined;
      if (source && ["ready_for_acceptance", "applied"].includes(source.status)
        && !this.requirementPaused(source.requirement_id)) {
        this.releaseOutgoingInTransaction(change.sourceUnitId, source.evidence_version, now);
      }
    }
  }

  resolveStaleInTransaction(input: DeliveryStaleResolutionInput): DeliveryStaleDecision {
    validateStaleResolutionInput(input);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const active = this.activeInvalidations(input.unitId);
    if (active.length === 0) {
      const existing = this.latestStaleDecision(input.unitId);
      if (!existing) throw new Error("DELIVERY_STALE_RESOLUTION_NOT_ACTIVE");
      if (existing.decision !== input.decision || existing.actor !== actor || existing.reason !== reason) {
        throw new Error("DELIVERY_STALE_RESOLUTION_CONFLICT");
      }
      return existing;
    }
    const unit = this.db.prepare(`SELECT id, requirement_id, phase, status, evidence_version
      FROM delivery_units WHERE id = ?`).get(input.unitId) as {
        id: string; requirement_id: string; phase: string; status: string; evidence_version: number;
      } | undefined;
    const targetVersion = active[0]!.target_evidence_version;
    if (!unit || unit.status !== "potentially_stale" || unit.evidence_version !== targetVersion
      || active.some((fact) => fact.requirement_id !== unit.requirement_id
        || fact.target_evidence_version !== targetVersion)) {
      throw new Error("DELIVERY_STALE_RESOLUTION_STALE");
    }
    const sourceSnapshots = active.map((fact) => ({ fact, current: this.currentSourceEvidence(fact) }));
    const newerEvidence = this.db.prepare(`SELECT 1 FROM coding_evidence
      WHERE delivery_unit_id = ? AND evidence_version > ? LIMIT 1`).get(unit.id, unit.evidence_version);
    if (deliveryUnitHasActiveWork(this.db, unit.id, unit.evidence_version, { includePendingJobs: true })
      || newerEvidence) throw new Error("DELIVERY_STALE_RESOLUTION_CONFLICT");
    const dependenciesSatisfied = this.dependenciesSatisfied(unit.id);
    if (input.decision === "reuse" && !dependenciesSatisfied) {
      throw new Error("DELIVERY_STALE_DEPENDENCIES_UNSATISFIED");
    }
    if (input.decision === "rerun" && unit.evidence_version >= MAX_AUTOMATION_EVIDENCE_VERSION) {
      throw new Error("DELIVERY_STALE_EVIDENCE_VERSION_LIMIT");
    }
    const resultingVersion = input.decision === "reuse" ? unit.evidence_version : unit.evidence_version + 1;
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    this.db.prepare(`INSERT INTO delivery_stale_decisions
      (id, requirement_id, delivery_unit_id, target_evidence_version,
       decision, resulting_evidence_version, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(decisionId, unit.requirement_id, unit.id, targetVersion,
        input.decision, resultingVersion, actor, reason, now);
    const insertSource = this.db.prepare(`INSERT INTO delivery_stale_decision_sources
      (decision_id, invalidation_id, source_current_evidence_id,
       source_current_evidence_version, source_current_evidence_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const { fact, current } of sourceSnapshots) {
      insertSource.run(decisionId, fact.id, current.id, current.version, current.hash, now);
    }
    if (input.decision === "reuse") {
      const restored = this.db.prepare(`UPDATE delivery_units SET phase = ?, status = ?, updated_at = ?
        WHERE id = ? AND evidence_version = ? AND status = 'potentially_stale'`)
        .run(active[0]!.prior_phase, active[0]!.prior_status, now, unit.id, unit.evidence_version);
      if (restored.changes !== 1) throw new Error("DELIVERY_STALE_RESOLUTION_STALE");
      this.recomputeUnitInTransaction(unit.id, now, !this.requirementPaused(unit.requirement_id), true);
    } else {
      this.db.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
        WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ? AND status = 'pending'`)
        .run(now, unit.id, unit.evidence_version);
      const nextStatus = dependenciesSatisfied ? "ready" : "waiting_dependency";
      const rerun = this.db.prepare(`UPDATE delivery_units
        SET evidence_version = ?, phase = 'implementation', status = ?, completed_at = NULL, updated_at = ?
        WHERE id = ? AND evidence_version = ? AND status = 'potentially_stale'`)
        .run(resultingVersion, nextStatus, now, unit.id, unit.evidence_version);
      if (rerun.changes !== 1) throw new Error("DELIVERY_STALE_RESOLUTION_STALE");
      this.db.prepare(`UPDATE delivery_dependencies SET released_by_evidence_version = NULL, released_at = NULL
        WHERE upstream_unit_id = ?`).run(unit.id);
      if (nextStatus === "ready" && !this.requirementPaused(unit.requirement_id)) {
        new AutomationJobRepository(this.db).enqueue({ ownerType: "delivery_unit", ownerId: unit.id,
          evidenceVersion: resultingVersion, action: "implement", payload: {}, maxAttempts: 3 });
      }
    }
    return this.getStaleDecision(decisionId)!;
  }

  pauseAutomationInTransaction(input: RequirementAutomationInput): RequirementAutomationState {
    validateAutomationInput(input);
    this.assertRequirement(input.requirementId);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const existing = this.getAutomationState(input.requirementId);
    if (existing?.status === "paused") {
      if (existing.actor !== actor || existing.reason !== reason) {
        throw new Error("REQUIREMENT_AUTOMATION_STATE_CONFLICT");
      }
      return existing;
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO requirement_automation_state
      (requirement_id, status, actor, reason, updated_at) VALUES (?, 'paused', ?, ?, ?)
      ON CONFLICT(requirement_id) DO UPDATE SET status = 'paused', actor = excluded.actor,
        reason = excluded.reason, updated_at = excluded.updated_at`)
      .run(input.requirementId, actor, reason, now);
    this.db.prepare(`INSERT INTO requirement_automation_audit
      (id, requirement_id, action, actor, reason, created_at) VALUES (?, ?, 'pause', ?, ?, ?)`)
      .run(randomUUID(), input.requirementId, actor, reason, now);
    this.db.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
      WHERE status = 'pending' AND (
        (owner_type = 'requirement' AND owner_id = ?)
        OR (owner_type = 'delivery_unit' AND EXISTS (
          SELECT 1 FROM delivery_units unit WHERE unit.id = automation_jobs.owner_id
            AND unit.requirement_id = ?
        ))
      )`).run(now, input.requirementId, input.requirementId);
    return this.getAutomationState(input.requirementId)!;
  }

  resumeAutomationInTransaction(input: RequirementAutomationInput): RequirementAutomationState {
    validateAutomationInput(input);
    this.assertRequirement(input.requirementId);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const existing = this.getAutomationState(input.requirementId);
    if (existing?.status === "active") {
      if (existing.actor !== actor || existing.reason !== reason) {
        throw new Error("REQUIREMENT_AUTOMATION_STATE_CONFLICT");
      }
      return existing;
    }
    if (!existing || existing.status !== "paused") throw new Error("REQUIREMENT_AUTOMATION_NOT_PAUSED");
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE requirement_automation_state SET status = 'active', actor = ?, reason = ?, updated_at = ?
      WHERE requirement_id = ? AND status = 'paused'`).run(actor, reason, now, input.requirementId);
    this.db.prepare(`INSERT INTO requirement_automation_audit
      (id, requirement_id, action, actor, reason, created_at) VALUES (?, ?, 'resume', ?, ?, ?)`)
      .run(randomUUID(), input.requirementId, actor, reason, now);
    this.recomputeRequirementInTransaction(input.requirementId, now);
    return this.getAutomationState(input.requirementId)!;
  }

  auditAutomationConflictInTransaction(input: RequirementAutomationInput, action: "pause" | "resume") {
    validateAutomationInput(input);
    this.assertRequirement(input.requirementId);
    this.db.prepare(`INSERT INTO requirement_automation_audit
      (id, requirement_id, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.requirementId, `${action}_conflict`, input.actor.trim(), input.reason.trim(),
        new Date().toISOString());
  }

  skipOptionalInTransaction(input: DeliverySkipInput): DeliveryUnitSkip {
    validateSkipInput(input);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const existing = this.getSkip(input.unitId);
    if (existing) {
      if (existing.actor !== actor || existing.reason !== reason) throw new Error("DELIVERY_UNIT_SKIP_CONFLICT");
      return this.completeSkipInTransaction(existing, new Date().toISOString());
    }
    const unit = this.db.prepare(`SELECT id, requirement_id, required, phase, status, evidence_version
      FROM delivery_units WHERE id = ?`).get(input.unitId) as {
        id: string; requirement_id: string; required: number; phase: string; status: string; evidence_version: number;
      } | undefined;
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    if (unit.required === 1 || unit.status === "applied" || unit.status === "running" || unit.status === "applying") {
      throw new Error("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    }
    const active = this.db.prepare(`SELECT 1
      WHERE EXISTS (SELECT 1 FROM delivery_quality_runs quality
        WHERE quality.delivery_unit_id = ? AND quality.evidence_version = ? AND quality.status = 'running')
      OR EXISTS (SELECT 1 FROM automation_jobs job
        WHERE job.owner_type = 'delivery_unit' AND job.owner_id = ? AND job.evidence_version = ?
          AND job.status = 'leased')
      OR EXISTS (SELECT 1 FROM stage_runs run
        WHERE run.owner_type = 'delivery_unit' AND run.owner_id = ? AND run.evidence_version = ?
          AND run.status = 'running')`).get(unit.id, unit.evidence_version, unit.id, unit.evidence_version,
      unit.id, unit.evidence_version);
    if (active) throw new Error("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO delivery_unit_skips
      (id, requirement_id, delivery_unit_id, evidence_version, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), unit.requirement_id, unit.id, unit.evidence_version, actor, reason, now);
    return this.completeSkipInTransaction(this.getSkip(input.unitId)!, now);
  }

  retryUnitInTransaction(input: DeliveryUnitRetryInput): DeliveryUnitRetryAudit {
    validateRetryInput(input);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const unit = this.db.prepare(`SELECT id, requirement_id, evidence_version, phase, status
      FROM delivery_units WHERE id = ?`).get(input.unitId) as {
        id: string; requirement_id: string; evidence_version: number; phase: string; status: string;
      } | undefined;
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    if (this.requirementPaused(unit.requirement_id)) throw new Error("DELIVERY_UNIT_RETRY_NOT_ELIGIBLE");
    const action = retryAction(input.target);
    const job = this.db.prepare(`SELECT id FROM automation_jobs WHERE owner_type = 'delivery_unit'
      AND owner_id = ? AND evidence_version = ? AND action = ? AND status = 'failed'`)
      .get(unit.id, unit.evidence_version, action) as { id: string } | undefined;
    if (!job || this.hasActiveUnitWork(unit.id, unit.evidence_version)) {
      throw new Error("DELIVERY_UNIT_RETRY_NOT_ELIGIBLE");
    }
    if (input.target === "implementation") {
      const hasEvidence = this.db.prepare(`SELECT 1 FROM coding_evidence
        WHERE delivery_unit_id = ? AND evidence_version = ?`).get(unit.id, unit.evidence_version);
      if (unit.phase !== "implementation" || unit.status !== "failed" || hasEvidence
        || !this.dependenciesSatisfied(unit.id)) throw new Error("DELIVERY_UNIT_RETRY_NOT_ELIGIBLE");
    } else {
      const kind = input.target;
      const hasCoding = this.db.prepare(`SELECT 1 FROM coding_evidence
        WHERE delivery_unit_id = ? AND evidence_version = ?`).get(unit.id, unit.evidence_version);
      const hasEvidence = this.db.prepare(`SELECT 1 FROM delivery_quality_evidence
        WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ?`)
        .get(unit.id, unit.evidence_version, kind);
      if (!hasCoding || hasEvidence || !this.dependenciesSatisfied(unit.id)
        || !["awaiting_gate", "returned", "failed"].includes(unit.status)) {
        throw new Error("DELIVERY_UNIT_RETRY_NOT_ELIGIBLE");
      }
    }
    const now = new Date().toISOString();
    const audit: DeliveryUnitRetryAudit = {
      id: randomUUID(), requirementId: unit.requirement_id, deliveryUnitId: unit.id,
      evidenceVersion: unit.evidence_version, jobId: job.id, target: input.target, actor, reason, createdAt: now
    };
    this.db.prepare(`INSERT INTO delivery_unit_retry_audit
      (id, requirement_id, delivery_unit_id, evidence_version, job_id, target, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(audit.id, audit.requirementId, audit.deliveryUnitId,
      audit.evidenceVersion, audit.jobId, audit.target, audit.actor, audit.reason, audit.createdAt);
    if (input.target === "implementation") {
      const updated = this.db.prepare(`UPDATE delivery_units SET status = 'ready', updated_at = ?
        WHERE id = ? AND evidence_version = ? AND phase = 'implementation' AND status = 'failed'`)
        .run(now, unit.id, unit.evidence_version);
      if (updated.changes !== 1) throw new Error("DELIVERY_UNIT_RETRY_NOT_ELIGIBLE");
    }
    const revived = new AutomationJobRepository(this.db, () => new Date(now)).enqueue({
      ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: unit.evidence_version,
      action, payload: {}, maxAttempts: 3
    }, { reviveTerminal: true });
    if (revived.id !== job.id || revived.status !== "pending") throw new Error("DELIVERY_UNIT_RETRY_CONFLICT");
    return audit;
  }

  private completeSkipInTransaction(skip: DeliveryUnitSkip, now: string) {
    const unit = this.db.prepare(`SELECT required, status, evidence_version FROM delivery_units WHERE id = ?`)
      .get(skip.deliveryUnitId) as { required: number; status: string; evidence_version: number } | undefined;
    if (!unit || unit.required === 1 || unit.status === "applied" || unit.status === "running"
      || unit.status === "applying" || unit.evidence_version !== skip.evidenceVersion) {
      throw new Error("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    }
    const facts = this.activeInvalidations(skip.deliveryUnitId, skip.evidenceVersion);
    if (unit.status === "skipped" && facts.length === 0) return skip;
    if (unit.status !== "skipped") {
      const active = this.db.prepare(`SELECT 1
        WHERE EXISTS (SELECT 1 FROM delivery_quality_runs quality
          WHERE quality.delivery_unit_id = ? AND quality.evidence_version = ? AND quality.status = 'running')
        OR EXISTS (SELECT 1 FROM automation_jobs job
          WHERE job.owner_type = 'delivery_unit' AND job.owner_id = ? AND job.evidence_version = ?
            AND job.status = 'leased')
        OR EXISTS (SELECT 1 FROM stage_runs run
          WHERE run.owner_type = 'delivery_unit' AND run.owner_id = ? AND run.evidence_version = ?
            AND run.status = 'running')`).get(skip.deliveryUnitId, skip.evidenceVersion,
        skip.deliveryUnitId, skip.evidenceVersion, skip.deliveryUnitId, skip.evidenceVersion);
      if (active) throw new Error("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    }
    const insertSource = this.db.prepare(`INSERT INTO delivery_unit_skip_sources
      (skip_id, invalidation_id, created_at) VALUES (?, ?, ?)`);
    for (const fact of facts) insertSource.run(skip.id, fact.id, now);
    if (unit.status === "skipped") return skip;
    const updated = this.db.prepare(`UPDATE delivery_units SET status = 'skipped', completed_at = ?, updated_at = ?
      WHERE id = ? AND evidence_version = ? AND status NOT IN ('running', 'applying', 'applied')`)
      .run(now, now, skip.deliveryUnitId, skip.evidenceVersion);
    if (updated.changes !== 1) throw new Error("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    this.db.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
      WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ? AND status = 'pending'`)
      .run(now, skip.deliveryUnitId, skip.evidenceVersion);
    return this.getSkip(skip.deliveryUnitId)!;
  }

  private hasActiveUnitWork(unitId: string, evidenceVersion: number) {
    return Boolean(this.db.prepare(`SELECT 1 WHERE EXISTS (
        SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit' AND owner_id = ?
          AND evidence_version = ? AND status = 'leased'
      ) OR EXISTS (
        SELECT 1 FROM delivery_quality_runs WHERE delivery_unit_id = ? AND evidence_version = ? AND status = 'running'
      ) OR EXISTS (
        SELECT 1 FROM stage_runs WHERE owner_type = 'delivery_unit' AND owner_id = ?
          AND evidence_version = ? AND status = 'running'
      )`).get(unitId, evidenceVersion, unitId, evidenceVersion, unitId, evidenceVersion));
  }

  overrideQualityInTransaction(input: DeliveryQualityOverrideInput): DeliveryQualityOverride {
    validateOverrideInput(input);
    const unit = this.loadCurrentIdentity(input.unitId, input.evidenceVersion);
    const qualityRows = this.loadGateEvidence(unit);
    const target = qualityRows.find((row) => row.kind === input.kind);
    if (!target) throw new Error("DELIVERY_QUALITY_OVERRIDE_EVIDENCE_REQUIRED");
    const evidenceIds = qualityRows.map((row) => row.id).sort();
    const existing = this.getOverride(unit.id, unit.evidence_version, input.kind);
    if (existing) {
      if (existing.actor !== input.actor.trim()
        || existing.reason !== input.reason.trim()
        || existing.acceptedRisk !== input.acceptedRisk.trim()
        || existing.codingEvidenceId !== unit.coding_evidence_id
        || existing.inputDiffHash !== unit.diff_hash
        || existing.qualityEvidenceId !== target.id) {
        throw new Error("DELIVERY_QUALITY_OVERRIDE_CONFLICT");
      }
      return existing;
    }
    if (target.result !== "failed") throw new Error("DELIVERY_QUALITY_OVERRIDE_EVIDENCE_NOT_FAILED");
    if (unit.phase !== "quality_verification"
      || !["awaiting_gate", "returned", "failed"].includes(unit.status)) {
      throw new Error("DELIVERY_QUALITY_OVERRIDE_NOT_ELIGIBLE");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO delivery_quality_overrides
      (id, requirement_id, delivery_unit_id, evidence_version, kind, actor, reason, accepted_risk,
       coding_evidence_id, input_diff_hash, quality_evidence_id, evidence_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_unit_id, evidence_version, kind) DO NOTHING`)
      .run(id, unit.requirement_id, unit.id, unit.evidence_version, input.kind, input.actor.trim(),
        input.reason.trim(), input.acceptedRisk.trim(), unit.coding_evidence_id, unit.diff_hash,
        target.id, JSON.stringify(evidenceIds), now);
    const persisted = this.getOverride(unit.id, unit.evidence_version, input.kind);
    if (!persisted) throw new Error("DELIVERY_QUALITY_OVERRIDE_PERSISTENCE_FAILED");
    if (
      persisted.actor !== input.actor.trim()
      || persisted.reason !== input.reason.trim()
      || persisted.acceptedRisk !== input.acceptedRisk.trim()
      || persisted.codingEvidenceId !== unit.coding_evidence_id
      || persisted.inputDiffHash !== unit.diff_hash
      || persisted.qualityEvidenceId !== target.id
    ) {
      throw new Error("DELIVERY_QUALITY_OVERRIDE_CONFLICT");
    }
    this.settleUnitInTransaction(unit.id, unit.evidence_version);
    return persisted;
  }

  listQualityOverrides(unitId: string, evidenceVersion?: number): DeliveryQualityOverride[] {
    const rows = evidenceVersion === undefined
      ? this.db.prepare(`SELECT * FROM delivery_quality_overrides WHERE delivery_unit_id = ?
          ORDER BY evidence_version DESC, kind, created_at, rowid`).all(unitId)
      : this.db.prepare(`SELECT * FROM delivery_quality_overrides
          WHERE delivery_unit_id = ? AND evidence_version = ? ORDER BY kind, created_at, rowid`)
        .all(unitId, evidenceVersion);
    return (rows as unknown as OverrideRow[]).map(mapOverride);
  }

  isRequirementPaused(requirementId: string) {
    return this.requirementPaused(requirementId);
  }

  private descendantsFailClosed(sourceUnitId: string, requirementId: string) {
    const rows = this.db.prepare(`WITH RECURSIVE walk(id, path, cycle, blocked) AS (
        SELECT dependency.downstream_unit_id,
          '|' || dependency.upstream_unit_id || '|' || dependency.downstream_unit_id || '|', 0, 0
        FROM delivery_dependencies dependency
        WHERE dependency.requirement_id = ? AND dependency.upstream_unit_id = ?
        UNION ALL
        SELECT dependency.downstream_unit_id,
          walk.path || dependency.downstream_unit_id || '|',
          CASE WHEN instr(walk.path, '|' || dependency.downstream_unit_id || '|') > 0 THEN 1 ELSE 0 END,
          CASE WHEN walk.blocked = 1 OR parent.status IN ('skipped', 'applied') THEN 1 ELSE 0 END
        FROM walk
        JOIN delivery_units parent ON parent.id = walk.id
        JOIN delivery_dependencies dependency ON dependency.upstream_unit_id = walk.id
        WHERE dependency.requirement_id = ? AND walk.cycle = 0
      )
      SELECT walk.id, walk.cycle, walk.blocked, unit.phase, unit.status, unit.evidence_version
      FROM walk JOIN delivery_units unit ON unit.id = walk.id
      ORDER BY unit.position, unit.created_at, unit.rowid`).all(
      requirementId, sourceUnitId, requirementId
    ) as Array<{
      id: string; cycle: number; blocked: number; phase: string; status: string; evidence_version: number;
    }>;
    if (rows.some((row) => row.cycle === 1)) throw new Error("DELIVERY_DEPENDENCY_CYCLE_RUNTIME");
    const unique = new Map<string, typeof rows[number]>();
    for (const row of rows) if (row.blocked === 0 && !unique.has(row.id)) unique.set(row.id, row);
    return [...unique.values()];
  }

  private activeInvalidations(unitId: string, evidenceVersion?: number) {
    const versionFilter = evidenceVersion === undefined ? "" : "AND invalidation.target_evidence_version = ?";
    const parameters = evidenceVersion === undefined ? [unitId] : [unitId, evidenceVersion];
    return this.db.prepare(`SELECT invalidation.* FROM delivery_evidence_invalidations invalidation
      WHERE invalidation.target_unit_id = ? ${versionFilter}
        AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
          WHERE source.invalidation_id = invalidation.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_unit_skip_sources source
          WHERE source.invalidation_id = invalidation.id)
      ORDER BY invalidation.created_at, invalidation.rowid`)
      .all(...parameters) as unknown as InvalidationRow[];
  }

  private latestStaleDecision(unitId: string) {
    const row = this.db.prepare(`SELECT * FROM delivery_stale_decisions
      WHERE delivery_unit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(unitId) as StaleDecisionRow | undefined;
    return row ? this.getStaleDecision(row.id) : null;
  }

  private getStaleDecision(decisionId: string) {
    const row = this.db.prepare(`SELECT * FROM delivery_stale_decisions WHERE id = ?`)
      .get(decisionId) as StaleDecisionRow | undefined;
    if (!row) return null;
    const sources = this.db.prepare(`SELECT invalidation.*, source.decision_id,
        source.source_current_evidence_id, source.source_current_evidence_version,
        source.source_current_evidence_hash
      FROM delivery_stale_decision_sources source
      JOIN delivery_evidence_invalidations invalidation ON invalidation.id = source.invalidation_id
      WHERE source.decision_id = ? ORDER BY invalidation.created_at, invalidation.rowid`)
      .all(decisionId) as unknown as StaleDecisionSourceRow[];
    if (sources.length === 0) throw new Error("DELIVERY_STALE_DECISION_SOURCE_REQUIRED");
    return mapStaleDecision(row, sources);
  }

  private currentSourceEvidence(fact: InvalidationRow) {
    if (fact.source_kind === "implementation") {
      const row = this.db.prepare(`SELECT current.id, current.evidence_version AS version, current.diff_hash AS hash
        FROM delivery_units unit
        JOIN coding_evidence old_evidence ON old_evidence.id = ?
          AND old_evidence.delivery_unit_id = unit.id
          AND old_evidence.requirement_id = unit.requirement_id
          AND old_evidence.evidence_version = ? AND old_evidence.diff_hash = ?
        JOIN coding_evidence new_evidence ON new_evidence.id = ?
          AND new_evidence.delivery_unit_id = unit.id
          AND new_evidence.requirement_id = unit.requirement_id
          AND new_evidence.evidence_version = ? AND new_evidence.diff_hash = ?
        JOIN coding_evidence current ON current.delivery_unit_id = unit.id
          AND current.requirement_id = unit.requirement_id AND current.evidence_version = unit.evidence_version
        WHERE unit.id = ? AND unit.requirement_id = ? AND current.evidence_version >= new_evidence.evidence_version`)
        .get(fact.source_old_evidence_id, fact.source_old_evidence_version, fact.source_old_evidence_hash,
          fact.source_new_evidence_id, fact.source_new_evidence_version, fact.source_new_evidence_hash,
          fact.source_unit_id, fact.requirement_id) as { id: string; version: number; hash: string } | undefined;
      if (!row) throw new Error("DELIVERY_STALE_SOURCE_CHANGED");
      return row;
    }
    const row = this.db.prepare(`SELECT current.id, current.evidence_version AS version,
        current.contract_hash AS hash
      FROM delivery_contract_evidence old_evidence
      JOIN delivery_contract_evidence new_evidence ON new_evidence.id = ?
        AND new_evidence.delivery_unit_id = old_evidence.delivery_unit_id
        AND new_evidence.requirement_id = old_evidence.requirement_id
        AND new_evidence.evidence_version = ? AND new_evidence.contract_hash = ?
      JOIN delivery_contract_evidence current ON current.delivery_unit_id = old_evidence.delivery_unit_id
        AND current.evidence_version = (SELECT MAX(latest.evidence_version)
          FROM delivery_contract_evidence latest WHERE latest.delivery_unit_id = old_evidence.delivery_unit_id)
      WHERE old_evidence.id = ? AND old_evidence.delivery_unit_id = ?
        AND old_evidence.requirement_id = ? AND old_evidence.evidence_version = ?
        AND old_evidence.contract_hash = ? AND current.evidence_version >= new_evidence.evidence_version`)
      .get(fact.source_new_evidence_id, fact.source_new_evidence_version, fact.source_new_evidence_hash,
        fact.source_old_evidence_id, fact.source_unit_id, fact.requirement_id,
        fact.source_old_evidence_version, fact.source_old_evidence_hash) as {
          id: string; version: number; hash: string;
        } | undefined;
    if (!row) throw new Error("DELIVERY_STALE_SOURCE_CHANGED");
    return row;
  }

  private dependenciesSatisfied(unitId: string) {
    return deliveryUnitDependenciesSatisfied(this.db, unitId);
  }

  private requirementPaused(requirementId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM requirement_automation_state
      WHERE requirement_id = ? AND status = 'paused'`).get(requirementId));
  }

  private assertRequirement(requirementId: string) {
    if (!this.db.prepare("SELECT 1 FROM requirements WHERE id = ?").get(requirementId)) {
      throw new Error("REQUIREMENT_NOT_FOUND");
    }
  }

  private getAutomationState(requirementId: string): RequirementAutomationState | null {
    const row = this.db.prepare(`SELECT requirement_id, status, actor, reason, updated_at
      FROM requirement_automation_state WHERE requirement_id = ?`).get(requirementId) as {
        requirement_id: string; status: "active" | "paused"; actor: string; reason: string; updated_at: string;
      } | undefined;
    return row ? { requirementId: row.requirement_id, status: row.status, actor: row.actor,
      reason: row.reason, updatedAt: row.updated_at } : null;
  }

  private getSkip(unitId: string): DeliveryUnitSkip | null {
    const row = this.db.prepare(`SELECT id, requirement_id, delivery_unit_id, evidence_version, actor, reason, created_at
      FROM delivery_unit_skips WHERE delivery_unit_id = ?`).get(unitId) as {
        id: string; requirement_id: string; delivery_unit_id: string; evidence_version: number;
        actor: string; reason: string; created_at: string;
      } | undefined;
    return row ? { id: row.id, requirementId: row.requirement_id, deliveryUnitId: row.delivery_unit_id,
      evidenceVersion: row.evidence_version, actor: row.actor, reason: row.reason, createdAt: row.created_at } : null;
  }

  private contractEvidence(unitId: string, version: number): DeliveryContractEvidence | null {
    const row = this.db.prepare(`SELECT * FROM delivery_contract_evidence
      WHERE delivery_unit_id = ? AND evidence_version = ?`).get(unitId, version) as ContractEvidenceRow | undefined;
    return row ? mapContractEvidence(row) : null;
  }

  private recomputeRequirementInTransaction(requirementId: string, now: string) {
    const candidates = this.db.prepare(`SELECT id FROM delivery_units
      WHERE requirement_id = ? AND status NOT IN ('potentially_stale', 'skipped', 'applying', 'applied')
      ORDER BY position, created_at, rowid`).all(requirementId) as Array<{ id: string }>;
    for (const unit of candidates) this.recomputeUnitInTransaction(unit.id, now, true);
  }

  private recomputeUnitInTransaction(
    unitId: string,
    now: string,
    enqueue: boolean,
    reviveTerminalQuality = false
  ) {
    const unit = this.db.prepare(`SELECT id, requirement_id, evidence_version, status
      FROM delivery_units WHERE id = ?`).get(unitId) as {
        id: string; requirement_id: string; evidence_version: number; status: string;
      } | undefined;
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    if (unit.status === "applied" || unit.status === "skipped") return;
    const codingEvidence = this.db.prepare(`SELECT 1 FROM coding_evidence
      WHERE delivery_unit_id = ? AND evidence_version = ?`).get(unit.id, unit.evidence_version);
    const jobs = new AutomationJobRepository(this.db, () => new Date(now));
    if (!codingEvidence) {
      const activeOwner = this.db.prepare(`SELECT 1 WHERE EXISTS (
          SELECT 1 FROM executions WHERE delivery_unit_id = ? AND evidence_version = ? AND status = 'running'
        ) OR EXISTS (
          SELECT 1 FROM stage_runs WHERE owner_type = 'delivery_unit' AND owner_id = ?
            AND evidence_version = ? AND status = 'running'
        ) OR EXISTS (
          SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit' AND owner_id = ?
            AND evidence_version = ? AND status = 'leased'
        )`).get(unit.id, unit.evidence_version, unit.id, unit.evidence_version, unit.id, unit.evidence_version);
      const ready = this.dependenciesSatisfied(unit.id);
      const status = activeOwner ? "running" : ready ? "ready" : "waiting_dependency";
      this.db.prepare(`UPDATE delivery_units SET phase = 'implementation', status = ?, updated_at = ?
        WHERE id = ? AND evidence_version = ?`).run(status, now, unit.id, unit.evidence_version);
      if (!activeOwner && ready && enqueue) jobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id,
        evidenceVersion: unit.evidence_version, action: "implement", payload: {}, maxAttempts: 3 });
      return;
    }
    this.db.prepare(`UPDATE delivery_units SET phase = 'quality_verification', status = 'awaiting_gate', updated_at = ?
      WHERE id = ? AND evidence_version = ?`).run(now, unit.id, unit.evidence_version);
    this.settleUnitInTransaction(unit.id, unit.evidence_version);
    const current = this.db.prepare(`SELECT status FROM delivery_units WHERE id = ?`).get(unit.id) as { status: string };
    if (!enqueue || current.status === "ready_for_acceptance") return;
    for (const [kind, action] of [["code_review", "review"], ["automated_testing", "test"]] as const) {
      const settled = this.db.prepare(`SELECT 1 FROM delivery_quality_evidence
        WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ?`).get(unit.id, unit.evidence_version, kind);
      let running = this.db.prepare(`SELECT id, claim_token FROM delivery_quality_runs
        WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ? AND status = 'running'`)
        .get(unit.id, unit.evidence_version, kind) as { id: string; claim_token: string } | undefined;
      if (running && reviveTerminalQuality) {
        const liveJob = this.db.prepare(`SELECT 1 FROM automation_jobs
          WHERE claim_token = ? AND owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ?
            AND action = ? AND status IN ('pending', 'leased')`).get(
          running.claim_token, unit.id, unit.evidence_version, action
        );
        if (!liveJob) {
          this.db.prepare(`UPDATE delivery_quality_runs SET status = 'aborted',
            error = 'DELIVERY_QUALITY_AUTOMATION_ORPHANED', completed_at = ?
            WHERE id = ? AND status = 'running'`).run(now, running.id);
          running = undefined;
        }
      }
      if (!settled && !running) jobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id,
        evidenceVersion: unit.evidence_version, action, payload: {}, maxAttempts: 3 }, {
          reviveTerminal: reviveTerminalQuality
        });
    }
  }

  private releaseOutgoingInTransaction(unitId: string, evidenceVersion: number, now: string) {
    this.db.prepare(`UPDATE delivery_dependencies SET released_by_evidence_version = ?, released_at = ?
      WHERE upstream_unit_id = ? AND release_condition = 'automated_testing_passed'
        AND released_by_evidence_version IS NULL`)
      .run(evidenceVersion, now, unitId);
    const owner = this.db.prepare("SELECT requirement_id FROM delivery_units WHERE id = ?").get(unitId) as {
      requirement_id: string;
    } | undefined;
    if (!owner || this.requirementPaused(owner.requirement_id)) return;
    const downstream = this.db.prepare(`SELECT unit.id, unit.evidence_version
      FROM delivery_units unit
      WHERE unit.phase = 'implementation' AND unit.status = 'waiting_dependency'
        AND EXISTS (SELECT 1 FROM delivery_dependencies outgoing
          WHERE outgoing.upstream_unit_id = ? AND outgoing.downstream_unit_id = unit.id)
        AND NOT EXISTS (
          SELECT 1 FROM delivery_dependencies incoming
          JOIN delivery_units upstream ON upstream.id = incoming.upstream_unit_id
          WHERE incoming.downstream_unit_id = unit.id
            AND incoming.released_by_evidence_version IS NOT upstream.evidence_version
        )
      ORDER BY unit.position, unit.created_at, unit.rowid`).all(unitId) as Array<{
        id: string; evidence_version: number;
      }>;
    let offset = 0;
    const jobs = new AutomationJobRepository(this.db, () => new Date(Date.parse(now) + offset++));
    for (const candidate of downstream) {
      const ready = this.db.prepare(`UPDATE delivery_units SET status = 'ready', updated_at = ?
        WHERE id = ? AND evidence_version = ? AND phase = 'implementation' AND status = 'waiting_dependency'`)
        .run(now, candidate.id, candidate.evidence_version);
      if (ready.changes === 1) jobs.enqueue({ ownerType: "delivery_unit", ownerId: candidate.id,
        evidenceVersion: candidate.evidence_version, action: "implement", payload: {}, maxAttempts: 3 });
    }
  }

  private settleUnitInTransaction(unitId: string, evidenceVersion: number) {
    const unit = this.loadCurrentIdentity(unitId, evidenceVersion);
    const evidence = this.loadGateEvidence(unit);
    const evidenceByKind = new Map(evidence.map((row) => [row.kind, row]));
    const overrides = this.loadValidOverrides(unit);
    const review = evidenceByKind.get("code_review");
    const testing = evidenceByKind.get("automated_testing");
    const reviewSatisfied = review?.result === "passed" || overrides.has("code_review");
    const testingSatisfied = testing?.result === "passed" || overrides.has("automated_testing");
    const nextStatus = testing?.result === "failed" && !overrides.has("automated_testing")
      ? "failed"
      : review?.result === "failed" && !overrides.has("code_review")
        ? "returned"
        : reviewSatisfied && testingSatisfied
          ? "ready_for_acceptance"
          : "awaiting_gate";
    const nextPhase = nextStatus === "ready_for_acceptance" ? "acceptance_delivery" : "quality_verification";
    const now = new Date().toISOString();
    const updated = this.db.prepare(`UPDATE delivery_units SET phase = ?, status = ?, updated_at = ?
      WHERE id = ? AND evidence_version = ? AND status IN ('awaiting_gate', 'returned', 'failed', 'ready_for_acceptance')`)
      .run(nextPhase, nextStatus, now, unit.id, unit.evidence_version);
    if (updated.changes !== 1) throw new Error("DELIVERY_QUALITY_CALLBACK_STALE");
    if (nextStatus !== "ready_for_acceptance" || this.requirementPaused(unit.requirement_id)) return;

    this.releaseOutgoingInTransaction(unit.id, unit.evidence_version, now);
  }

  private loadCurrentIdentity(unitId: string, evidenceVersion: number): UnitIdentityRow {
    const row = this.db.prepare(`SELECT du.id, du.requirement_id, du.evidence_version, du.phase, du.status,
        ce.id AS coding_evidence_id, ce.diff_hash
      FROM delivery_units du
      JOIN coding_evidence ce ON ce.delivery_unit_id = du.id AND ce.evidence_version = du.evidence_version
      WHERE du.id = ? AND du.evidence_version = ?`).get(unitId, evidenceVersion) as UnitIdentityRow | undefined;
    if (!row) throw new Error("DELIVERY_QUALITY_CALLBACK_STALE");
    if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1) throw new Error("DELIVERY_QUALITY_CALLBACK_STALE");
    return row;
  }

  private loadGateEvidence(unit: UnitIdentityRow): GateEvidenceRow[] {
    return this.db.prepare(`SELECT id, kind, result FROM delivery_quality_evidence
      WHERE delivery_unit_id = ? AND evidence_version = ?
        AND input_coding_evidence_id = ? AND input_evidence_version = ? AND input_diff_hash = ?
      ORDER BY kind`).all(
      unit.id, unit.evidence_version, unit.coding_evidence_id, unit.evidence_version, unit.diff_hash
    ) as unknown as GateEvidenceRow[];
  }

  private loadValidOverrides(unit: UnitIdentityRow): Set<DeliveryQualityKind> {
    const rows = this.db.prepare(`SELECT override.kind FROM delivery_quality_overrides override
      JOIN delivery_quality_evidence quality ON quality.id = override.quality_evidence_id
      WHERE override.delivery_unit_id = ? AND override.evidence_version = ?
        AND override.coding_evidence_id = ? AND override.input_diff_hash = ?
        AND quality.delivery_unit_id = override.delivery_unit_id
        AND quality.evidence_version = override.evidence_version
        AND quality.kind = override.kind
        AND quality.result = 'failed'
        AND quality.input_coding_evidence_id = override.coding_evidence_id
        AND quality.input_diff_hash = override.input_diff_hash
        AND length(trim(override.actor)) > 0 AND length(trim(override.reason)) > 0
        AND length(trim(override.accepted_risk)) > 0`).all(
      unit.id, unit.evidence_version, unit.coding_evidence_id, unit.diff_hash
    ) as Array<{ kind: DeliveryQualityKind }>;
    return new Set(rows.map((row) => row.kind));
  }

  private getOverride(unitId: string, evidenceVersion: number, kind: DeliveryQualityKind) {
    const row = this.db.prepare(`SELECT * FROM delivery_quality_overrides
      WHERE delivery_unit_id = ? AND evidence_version = ? AND kind = ?`)
      .get(unitId, evidenceVersion, kind) as OverrideRow | undefined;
    return row ? mapOverride(row) : null;
  }
}

function validateOverrideInput(input: DeliveryQualityOverrideInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.unitId, 256)
    || !Number.isSafeInteger(input.evidenceVersion) || input.evidenceVersion < 1
    || (input.kind !== "code_review" && input.kind !== "automated_testing")
    || !validText(input.actor, 256) || !validText(input.reason, 4096) || !validText(input.acceptedRisk, 4096)) {
    throw new Error("DELIVERY_QUALITY_OVERRIDE_INVALID");
  }
}

function validateStaleResolutionInput(input: DeliveryStaleResolutionInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.unitId, 256)
    || (input.decision !== "reuse" && input.decision !== "rerun")
    || !validText(input.actor, 256) || !validText(input.reason, 4096)) {
    throw new Error("DELIVERY_STALE_RESOLUTION_INVALID");
  }
}

function validateContractEvidenceInput(input: DeliveryContractEvidenceInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.unitId, 256)
    || !Number.isSafeInteger(input.version) || input.version < 1 || input.version > MAX_AUTOMATION_EVIDENCE_VERSION
    || !validText(input.contractHash, 256) || !validText(input.actor, 256)) {
    throw new Error("DELIVERY_CONTRACT_EVIDENCE_INVALID");
  }
  let contentJson: string;
  try { contentJson = JSON.stringify(input.content); } catch { throw new Error("DELIVERY_CONTRACT_EVIDENCE_INVALID"); }
  if (contentJson === undefined || Buffer.byteLength(contentJson, "utf8") > 1_048_576) {
    throw new Error("DELIVERY_CONTRACT_EVIDENCE_INVALID");
  }
  return contentJson;
}

function validateAutomationInput(input: RequirementAutomationInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.requirementId, 256)
    || !validText(input.actor, 256) || !validText(input.reason, 4096)) {
    throw new Error("REQUIREMENT_AUTOMATION_INPUT_INVALID");
  }
}

function validateSkipInput(input: DeliverySkipInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.unitId, 256)
    || !validText(input.actor, 256) || !validText(input.reason, 4096)) {
    throw new Error("DELIVERY_UNIT_SKIP_INVALID");
  }
}

function validateRetryInput(input: DeliveryUnitRetryInput) {
  const validText = (value: unknown, max: number) => typeof value === "string"
    && value.trim().length > 0 && value.length <= max && !value.includes("\0");
  if (!input || typeof input !== "object" || !validText(input.unitId, 256)
    || !["implementation", "code_review", "automated_testing"].includes(input.target)
    || !validText(input.actor, 256) || !validText(input.reason, 4096)) {
    throw new Error("DELIVERY_UNIT_RETRY_INVALID");
  }
}

function retryAction(target: DeliveryUnitRetryTarget): "implement" | "review" | "test" {
  if (target === "implementation") return "implement";
  return target === "code_review" ? "review" : "test";
}

function mapStaleDecision(row: StaleDecisionRow, sourceRows: StaleDecisionSourceRow[]): DeliveryStaleDecision {
  const sources = sourceRows.map((source) => ({
    invalidationId: source.id,
    sourceUnitId: source.source_unit_id,
    sourceKind: source.source_kind,
    sourceOldEvidenceId: source.source_old_evidence_id,
    sourceOldEvidenceVersion: source.source_old_evidence_version,
    sourceOldEvidenceHash: source.source_old_evidence_hash,
    sourceNewEvidenceId: source.source_new_evidence_id,
    sourceNewEvidenceVersion: source.source_new_evidence_version,
    sourceNewEvidenceHash: source.source_new_evidence_hash,
    sourceCurrentEvidenceId: source.source_current_evidence_id,
    sourceCurrentEvidenceVersion: source.source_current_evidence_version,
    sourceCurrentEvidenceHash: source.source_current_evidence_hash
  }));
  const first = sources[0]!;
  return {
    id: row.id, invalidationId: first.invalidationId, requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id, targetEvidenceVersion: row.target_evidence_version,
    sourceOldEvidenceId: first.sourceOldEvidenceId,
    sourceOldEvidenceVersion: first.sourceOldEvidenceVersion,
    sourceNewEvidenceId: first.sourceNewEvidenceId,
    sourceNewEvidenceVersion: first.sourceNewEvidenceVersion,
    decision: row.decision, resultingEvidenceVersion: row.resulting_evidence_version,
    actor: row.actor, reason: row.reason, createdAt: row.created_at, sources
  };
}

function mapContractEvidence(row: ContractEvidenceRow): DeliveryContractEvidence {
  let content: unknown;
  try { content = JSON.parse(row.content_json); } catch { throw new Error("DELIVERY_CONTRACT_EVIDENCE_INVALID"); }
  return {
    id: row.id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    version: row.evidence_version,
    contractHash: row.contract_hash,
    content,
    actor: row.actor,
    createdAt: row.created_at
  };
}

function mapOverride(row: OverrideRow): DeliveryQualityOverride {
  let evidenceIds: unknown;
  try { evidenceIds = JSON.parse(row.evidence_ids_json); } catch {}
  if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== "string")) {
    throw new Error("DELIVERY_QUALITY_OVERRIDE_INVALID");
  }
  return {
    id: row.id, requirementId: row.requirement_id, deliveryUnitId: row.delivery_unit_id,
    evidenceVersion: row.evidence_version, kind: row.kind, actor: row.actor, reason: row.reason,
    acceptedRisk: row.accepted_risk, codingEvidenceId: row.coding_evidence_id,
    inputDiffHash: row.input_diff_hash, qualityEvidenceId: row.quality_evidence_id,
    evidenceIds, createdAt: row.created_at
  };
}
