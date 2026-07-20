import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AutomationJobRepository } from "./automation-job-repository.js";
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

  overrideQualityInTransaction(input: DeliveryQualityOverrideInput): DeliveryQualityOverride {
    validateOverrideInput(input);
    const unit = this.loadCurrentIdentity(input.unitId, input.evidenceVersion);
    const qualityRows = this.loadGateEvidence(unit);
    const target = qualityRows.find((row) => row.kind === input.kind);
    if (!target) throw new Error("DELIVERY_QUALITY_OVERRIDE_EVIDENCE_REQUIRED");
    const evidenceIds = qualityRows.map((row) => row.id).sort();
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
    if (nextStatus !== "ready_for_acceptance") return;

    this.db.prepare(`UPDATE delivery_dependencies
      SET released_by_evidence_version = ?, released_at = ?
      WHERE upstream_unit_id = ? AND release_condition = 'automated_testing_passed'
        AND released_by_evidence_version IS NULL`)
      .run(unit.evidence_version, now, unit.id);
    const downstream = this.db.prepare(`SELECT du.id, du.evidence_version
      FROM delivery_units du
      WHERE du.status = 'waiting_dependency'
        AND EXISTS (
          SELECT 1 FROM delivery_dependencies outgoing
          WHERE outgoing.upstream_unit_id = ? AND outgoing.downstream_unit_id = du.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_dependencies incoming
          WHERE incoming.downstream_unit_id = du.id AND incoming.released_by_evidence_version IS NULL
        )
      ORDER BY du.position, du.created_at, du.rowid`).all(unit.id) as Array<{ id: string; evidence_version: number }>;
    let enqueueOffset = 0;
    const jobs = new AutomationJobRepository(this.db, () => new Date(Date.parse(now) + enqueueOffset++));
    for (const candidate of downstream) {
      const ready = this.db.prepare(`UPDATE delivery_units SET status = 'ready', updated_at = ?
        WHERE id = ? AND evidence_version = ? AND status = 'waiting_dependency'`)
        .run(now, candidate.id, candidate.evidence_version);
      if (ready.changes !== 1) continue;
      jobs.enqueue({
        ownerType: "delivery_unit", ownerId: candidate.id, evidenceVersion: candidate.evidence_version,
        action: "implement", payload: {}, maxAttempts: 3
      });
    }
  }

  private loadCurrentIdentity(unitId: string, evidenceVersion: number): UnitIdentityRow {
    const row = this.db.prepare(`SELECT du.id, du.requirement_id, du.evidence_version, du.status,
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
