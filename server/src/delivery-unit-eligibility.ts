import type { DatabaseSync } from "node:sqlite";

export function deliveryUnitDependenciesSatisfied(db: DatabaseSync, unitId: string): boolean {
  return !db.prepare(`SELECT 1 FROM delivery_dependencies dependency
    JOIN delivery_units upstream ON upstream.id = dependency.upstream_unit_id
    WHERE dependency.downstream_unit_id = ?
      AND dependency.released_by_evidence_version IS NOT upstream.evidence_version
    LIMIT 1`).get(unitId);
}
