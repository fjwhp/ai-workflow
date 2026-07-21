import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type TimerHandle = any;

export function deliveryEventGeneration(db: DatabaseSync, requirementId: string): string {
  const snapshot = [
    rows(db, `SELECT id, phase, status, evidence_version, updated_at, completed_at
      FROM delivery_units WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, upstream_unit_id, downstream_unit_id, released_by_evidence_version, released_at
      FROM delivery_dependencies WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT job.id, job.action, job.status, job.attempt, job.evidence_version, job.updated_at
      FROM automation_jobs job JOIN delivery_units unit ON unit.id = job.owner_id
      WHERE job.owner_type = 'delivery_unit' AND unit.requirement_id = ? ORDER BY job.id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, status, completed_at
      FROM executions WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, diff_hash, created_at
      FROM coding_evidence WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, kind, status, completed_at
      FROM delivery_quality_runs WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, kind, result, completed_at
      FROM delivery_quality_evidence WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, kind, created_at
      FROM delivery_quality_overrides WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, contract_hash, created_at
      FROM delivery_contract_evidence WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, source_unit_id, target_unit_id, target_evidence_version, created_at
      FROM delivery_evidence_invalidations WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, target_evidence_version, decision, resulting_evidence_version, created_at
      FROM delivery_stale_decisions WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT requirement_id, status, actor, reason, updated_at
      FROM requirement_automation_state WHERE requirement_id = ?`, requirementId),
    rows(db, `SELECT id, action, actor, reason, created_at
      FROM requirement_automation_audit WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, created_at
      FROM delivery_unit_skips WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, delivery_unit_id, evidence_version, target, job_id, created_at
      FROM delivery_unit_retry_audit WHERE requirement_id = ? ORDER BY id`, requirementId),
    rows(db, `SELECT id, owner_id, evidence_version, stage, status, completed_at
      FROM stage_runs WHERE requirement_id = ? AND owner_type = 'delivery_unit' ORDER BY id`, requirementId)
  ];
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function watchDeliveryEvents(input: {
  generation: () => string;
  emit: (generation: string) => void;
  setInterval?: (callback: () => void, delay: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  intervalMs?: number;
}) {
  const schedule = input.setInterval ?? globalThis.setInterval;
  const cancel = input.clearInterval ?? globalThis.clearInterval;
  let stopped = false;
  let current = input.generation();
  input.emit(current);
  const timer = schedule(() => {
    if (stopped) return;
    const next = input.generation();
    if (next === current) return;
    current = next;
    input.emit(next);
  }, input.intervalMs ?? 500);
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(timer);
  };
}

function rows(db: DatabaseSync, query: string, requirementId: string) {
  return db.prepare(query).all(requirementId);
}
