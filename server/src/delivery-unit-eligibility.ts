import type { DatabaseSync } from "node:sqlite";

export function deliveryUnitDependenciesSatisfied(db: DatabaseSync, unitId: string): boolean {
  return !db.prepare(`SELECT 1 FROM delivery_dependencies dependency
    JOIN delivery_units upstream ON upstream.id = dependency.upstream_unit_id
    WHERE dependency.downstream_unit_id = ?
      AND dependency.released_by_evidence_version IS NOT upstream.evidence_version
    LIMIT 1`).get(unitId);
}

export function deliveryUnitHasActiveWork(
  db: DatabaseSync,
  unitId: string,
  evidenceVersion: number,
  options: { includePendingJobs?: boolean } = {}
): boolean {
  const row = db.prepare(`SELECT
      EXISTS (SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit' AND owner_id = ?
        AND evidence_version = ? AND status = 'pending') AS pending_job,
      EXISTS (SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit' AND owner_id = ?
        AND evidence_version = ? AND status = 'leased') AS leased_job,
      (EXISTS (SELECT 1 FROM delivery_quality_runs WHERE delivery_unit_id = ?
        AND evidence_version = ? AND status = 'running')
      OR EXISTS (SELECT 1 FROM stage_runs WHERE owner_type = 'delivery_unit' AND owner_id = ?
        AND evidence_version = ? AND status = 'running')
      OR EXISTS (SELECT 1 FROM executions WHERE delivery_unit_id = ?
        AND evidence_version = ? AND status = 'running')) AS running_execution`).get(
      unitId, evidenceVersion,
      unitId, evidenceVersion,
      unitId, evidenceVersion,
      unitId, evidenceVersion,
      unitId, evidenceVersion
    ) as { pending_job: number; leased_job: number; running_execution: number };
  return isDeliveryUnitActiveWork({
    pendingJob: Boolean(row.pending_job),
    leasedJob: Boolean(row.leased_job),
    runningExecution: Boolean(row.running_execution)
  }, options);
}

export function isDeliveryUnitActiveWork(
  state: { pendingJob: boolean; leasedJob: boolean; runningExecution: boolean },
  options: { includePendingJobs?: boolean } = {}
) {
  return state.leasedJob || state.runningExecution || (Boolean(options.includePendingJobs) && state.pendingJob);
}
