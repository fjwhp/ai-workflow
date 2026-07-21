import type { DatabaseSync } from "node:sqlite";
import { mapDeliveryCodingEvidence } from "./delivery-execution-repository.js";
import {
  mapDeliveryQualityEvidence,
  type DeliveryQualityEvidence,
  type DeliveryQualityKind
} from "./delivery-quality-repository.js";
import type { DeliveryDependency, DeliveryUnit, DeliveryUnitRepository } from "./delivery-unit-repository.js";
import { isDeliveryUnitActiveWork } from "./delivery-unit-eligibility.js";

export type DeliveryUnitActionType =
  | "retry_implementation"
  | "retry_code_review"
  | "retry_automated_testing"
  | "reuse_evidence"
  | "rerun"
  | "skip_optional";

export interface AllowedDeliveryUnitAction {
  type: DeliveryUnitActionType;
  reasonRequired: true;
}

export interface RequirementAutomationDetail {
  status: "active" | "paused";
  actor?: string;
  reason?: string;
  updatedAt?: string;
}

export interface DeliveryRequirementDetail {
  automation: RequirementAutomationDetail & {
    allowedActions: Array<{ type: "pause_automation" | "resume_automation"; reasonRequired: true }>;
  };
  units: Array<DeliveryUnit & {
    implementationEvidence: unknown | null;
    codeReviewEvidence: unknown | null;
    automatedTestingEvidence: unknown | null;
    blocker: { code: string; message: string } | null;
    dependencyReleases: Array<DeliveryDependency & { direction: "incoming" | "outgoing" }>;
    automation: RequirementAutomationDetail;
    allowedActions: AllowedDeliveryUnitAction[];
  }>;
  dependencies: DeliveryDependency[];
}

export interface DeliveryUnitDetailPersistence {
  getForRequirement(requirementId: string): DeliveryRequirementDetail;
}

interface CurrentJobState {
  pending: boolean;
  leased: boolean;
  failedActions: Set<string>;
  latestFailure?: string | null;
}

interface DeliveryDetailSnapshot {
  implementationEvidence: Map<string, unknown>;
  qualityEvidence: Map<string, DeliveryQualityEvidence>;
  jobs: Map<string, CurrentJobState>;
  activeRuns: Set<string>;
  activeInvalidations: Set<string>;
  dependenciesSatisfied: Map<string, boolean>;
  dependencyReleases: Map<string, Array<DeliveryDependency & { direction: "incoming" | "outgoing" }>>;
}

export class DeliveryUnitDetailRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly units: DeliveryUnitRepository
  ) {}

  getForRequirement(requirementId: string): DeliveryRequirementDetail {
    const units = this.units.listForRequirement(requirementId);
    const dependencies = this.units.listDependencies(requirementId);
    const automation = this.automationState(requirementId);
    const snapshot = this.loadSnapshot(requirementId, units, dependencies);
    return {
      automation: {
        ...automation,
        allowedActions: [{
          type: automation.status === "paused" ? "resume_automation" : "pause_automation",
          reasonRequired: true
        }]
      },
      units: units.map((unit) => {
        const implementationEvidence = snapshot.implementationEvidence.get(unit.id) ?? null;
        const codeReviewEvidence = snapshot.qualityEvidence.get(qualityKey(unit.id, "code_review")) ?? null;
        const automatedTestingEvidence = snapshot.qualityEvidence.get(
          qualityKey(unit.id, "automated_testing")
        ) ?? null;
        return {
          ...unit,
          implementationEvidence,
          codeReviewEvidence,
          automatedTestingEvidence,
          blocker: this.blocker(unit, automation, snapshot),
          dependencyReleases: snapshot.dependencyReleases.get(unit.id) ?? [],
          automation,
          allowedActions: this.allowedActions(unit, automation, snapshot, {
            implementation: implementationEvidence,
            codeReview: codeReviewEvidence,
            automatedTesting: automatedTestingEvidence
          })
        };
      }),
      dependencies
    };
  }

  private automationState(requirementId: string): RequirementAutomationDetail {
    const row = this.db.prepare(`SELECT status, actor, reason, updated_at FROM requirement_automation_state
      WHERE requirement_id = ?`).get(requirementId) as {
        status: "active" | "paused"; actor: string; reason: string; updated_at: string;
      } | undefined;
    return row ? { status: row.status, actor: row.actor, reason: row.reason, updatedAt: row.updated_at }
      : { status: "active" };
  }

  private loadSnapshot(
    requirementId: string,
    units: DeliveryUnit[],
    dependencies: DeliveryDependency[]
  ): DeliveryDetailSnapshot {
    const implementationEvidence = new Map<string, unknown>();
    for (const row of this.db.prepare(`SELECT evidence.* FROM coding_evidence evidence
      JOIN delivery_units unit ON unit.id = evidence.delivery_unit_id
        AND unit.evidence_version = evidence.evidence_version
      WHERE unit.requirement_id = ?`).all(requirementId) as any[]) {
      implementationEvidence.set(row.delivery_unit_id, mapDeliveryCodingEvidence(row));
    }

    const qualityEvidence = new Map<string, DeliveryQualityEvidence>();
    for (const row of this.db.prepare(`SELECT evidence.* FROM delivery_quality_evidence evidence
      JOIN delivery_units unit ON unit.id = evidence.delivery_unit_id
        AND unit.evidence_version = evidence.evidence_version
      WHERE unit.requirement_id = ?
      ORDER BY evidence.completed_at DESC, evidence.rowid DESC`).all(requirementId) as any[]) {
      const key = qualityKey(row.delivery_unit_id, row.kind);
      if (!qualityEvidence.has(key)) qualityEvidence.set(key, mapDeliveryQualityEvidence(row));
    }

    const jobs = new Map<string, CurrentJobState>();
    const jobRows = this.db.prepare(`SELECT job.owner_id AS delivery_unit_id, job.action, job.status,
        job.last_error, job.updated_at, job.rowid
      FROM automation_jobs job
      JOIN delivery_units unit ON job.owner_type = 'delivery_unit' AND unit.id = job.owner_id
        AND unit.evidence_version = job.evidence_version
      WHERE unit.requirement_id = ?
      ORDER BY job.updated_at DESC, job.rowid DESC`).all(requirementId) as Array<{
        delivery_unit_id: string; action: string; status: string; last_error: string | null;
      }>;
    for (const row of jobRows) {
      const state = jobs.get(row.delivery_unit_id) ?? {
        pending: false, leased: false, failedActions: new Set<string>()
      };
      if (row.status === "pending") state.pending = true;
      if (row.status === "leased") state.leased = true;
      if (row.status === "failed") {
        state.failedActions.add(row.action);
        if (state.latestFailure === undefined) state.latestFailure = row.last_error;
      }
      jobs.set(row.delivery_unit_id, state);
    }

    const activeRuns = new Set<string>();
    const activeRows = this.db.prepare(`SELECT quality.delivery_unit_id
      FROM delivery_quality_runs quality
      JOIN delivery_units unit ON unit.id = quality.delivery_unit_id
        AND unit.evidence_version = quality.evidence_version
      WHERE unit.requirement_id = ? AND quality.status = 'running'
      UNION SELECT run.owner_id
      FROM stage_runs run
      JOIN delivery_units unit ON run.owner_type = 'delivery_unit' AND unit.id = run.owner_id
        AND unit.evidence_version = run.evidence_version
      WHERE unit.requirement_id = ? AND run.status = 'running'
      UNION SELECT execution.delivery_unit_id
      FROM executions execution
      JOIN delivery_units unit ON unit.id = execution.delivery_unit_id
        AND unit.evidence_version = execution.evidence_version
      WHERE unit.requirement_id = ? AND execution.status = 'running'`)
      .all(requirementId, requirementId, requirementId) as Array<{ delivery_unit_id: string }>;
    for (const row of activeRows) activeRuns.add(row.delivery_unit_id);

    const activeInvalidations = new Set<string>();
    const invalidationRows = this.db.prepare(`SELECT invalidation.target_unit_id
      FROM delivery_evidence_invalidations invalidation
      JOIN delivery_units unit ON unit.id = invalidation.target_unit_id
        AND unit.evidence_version = invalidation.target_evidence_version
      WHERE unit.requirement_id = ?
        AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
          WHERE source.invalidation_id = invalidation.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_unit_skip_sources source
          WHERE source.invalidation_id = invalidation.id)
      GROUP BY invalidation.target_unit_id`).all(requirementId) as Array<{ target_unit_id: string }>;
    for (const row of invalidationRows) activeInvalidations.add(row.target_unit_id);

    const dependencyReleases = new Map<
      string,
      Array<DeliveryDependency & { direction: "incoming" | "outgoing" }>
    >();
    const dependenciesSatisfied = new Map(units.map((unit) => [unit.id, true]));
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    for (const dependency of dependencies) {
      appendDependency(dependencyReleases, dependency.upstreamUnitId, { ...dependency, direction: "outgoing" });
      appendDependency(dependencyReleases, dependency.downstreamUnitId, { ...dependency, direction: "incoming" });
      if (dependency.releasedByEvidenceVersion !== unitById.get(dependency.upstreamUnitId)?.evidenceVersion) {
        dependenciesSatisfied.set(dependency.downstreamUnitId, false);
      }
    }
    return {
      implementationEvidence, qualityEvidence, jobs, activeRuns, activeInvalidations,
      dependenciesSatisfied, dependencyReleases
    };
  }

  private allowedActions(
    unit: DeliveryUnit,
    automation: RequirementAutomationDetail,
    snapshot: DeliveryDetailSnapshot,
    evidence: { implementation: unknown | null; codeReview: unknown | null; automatedTesting: unknown | null }
  ): AllowedDeliveryUnitAction[] {
    if (automation.status === "paused" || ["waiting_dependency", "running", "applying", "applied", "skipped"]
      .includes(unit.status)) return [];
    const jobs = snapshot.jobs.get(unit.id);
    const active = isDeliveryUnitActiveWork({
      pendingJob: Boolean(jobs?.pending),
      leasedJob: Boolean(jobs?.leased),
      runningExecution: snapshot.activeRuns.has(unit.id)
    }, { includePendingJobs: unit.status === "potentially_stale" });
    if (active) return [];
    const dependenciesSatisfied = snapshot.dependenciesSatisfied.get(unit.id) ?? true;
    if (unit.status === "potentially_stale") {
      return snapshot.activeInvalidations.has(unit.id)
        ? [...(dependenciesSatisfied ? [action("reuse_evidence")] : []), action("rerun")]
        : [];
    }
    const actions: AllowedDeliveryUnitAction[] = [];
    if (unit.phase === "implementation" && unit.status === "failed" && !evidence.implementation
      && dependenciesSatisfied && jobs?.failedActions.has("implement")) {
      actions.push(action("retry_implementation"));
    }
    if (evidence.implementation && dependenciesSatisfied
      && ["awaiting_gate", "returned", "failed"].includes(unit.status)) {
      if (!evidence.codeReview && jobs?.failedActions.has("review")) actions.push(action("retry_code_review"));
      if (!evidence.automatedTesting && jobs?.failedActions.has("test")) {
        actions.push(action("retry_automated_testing"));
      }
    }
    if (!unit.required && !["running", "applying", "applied", "skipped"].includes(unit.status)) {
      actions.push(action("skip_optional"));
    }
    return actions;
  }

  private blocker(
    unit: DeliveryUnit,
    automation: RequirementAutomationDetail,
    snapshot: DeliveryDetailSnapshot
  ) {
    if (automation.status === "paused") return {
      code: "REQUIREMENT_AUTOMATION_PAUSED",
      message: automation.reason ? `自动化已暂停：${automation.reason}` : "自动化已暂停"
    };
    if (unit.status === "potentially_stale") return {
      code: "DELIVERY_EVIDENCE_POTENTIALLY_STALE",
      message: "上游证据已变化，需要确认复用或重新执行"
    };
    if (unit.status === "waiting_dependency" || !(snapshot.dependenciesSatisfied.get(unit.id) ?? true)) return {
      code: "DELIVERY_DEPENDENCY_PENDING", message: "等待上游依赖释放"
    };
    if (unit.status === "returned") return {
      code: "DELIVERY_CODE_REVIEW_FAILED", message: "代码审查未通过，需要处理审查结论"
    };
    if (unit.status === "conflicted") return {
      code: "DELIVERY_APPLICATION_CONFLICT", message: "本地应用存在冲突"
    };
    if (unit.status === "failed") return {
      code: "DELIVERY_UNIT_FAILED",
      message: snapshot.jobs.get(unit.id)?.latestFailure || "交付处理失败"
    };
    return null;
  }
}

function action(type: DeliveryUnitActionType): AllowedDeliveryUnitAction {
  return { type, reasonRequired: true };
}

function qualityKey(unitId: string, kind: DeliveryQualityKind) {
  return `${unitId}:${kind}`;
}

function appendDependency(
  map: Map<string, Array<DeliveryDependency & { direction: "incoming" | "outgoing" }>>,
  unitId: string,
  dependency: DeliveryDependency & { direction: "incoming" | "outgoing" }
) {
  const current = map.get(unitId) ?? [];
  current.push(dependency);
  map.set(unitId, current);
}
