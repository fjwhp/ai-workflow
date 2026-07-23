import type { DatabaseSync } from "node:sqlite";
import { mapDeliveryCodingEvidence } from "./delivery-execution-repository.js";
import {
  mapDeliveryQualityEvidence,
  type DeliveryQualityEvidence,
  type DeliveryQualityKind
} from "./delivery-quality-repository.js";
import type { DeliveryDependency, DeliveryUnit, DeliveryUnitRepository } from "./delivery-unit-repository.js";
import { isDeliveryUnitActiveWork } from "./delivery-unit-eligibility.js";
import { frozenApplicationRetryPlanValid } from "./delivery-application-planner.js";
import { parseDeliveryApplicationJob } from "./delivery-coordinator.js";

export type DeliveryUnitActionType =
  | "retry_implementation"
  | "retry_code_review"
  | "retry_automated_testing"
  | "reuse_evidence"
  | "rerun"
  | "skip_optional"
  | "retry_application";

export interface AllowedDeliveryAcceptanceAction {
  type: "accept_delivery";
  commentRequired: true;
}

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
  allowedActions: AllowedDeliveryAcceptanceAction[];
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
  latestApplications: Map<string, {
    status: string;
    resolutionStatus: string;
    projectVersionId: string;
  }>;
  activeApplicationProjectVersions: Set<string>;
  frozenApplicationUnits: Set<string>;
  retryableApplicationUnits: Set<string>;
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
      allowedActions: this.acceptanceActions(requirementId, units, automation, snapshot),
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
    const frozenApplicationUnits = new Set<string>();
    const settledApplicationJobs = new Map<string, {
      id: string; evidenceVersion: number; payloadJson: string;
      retryAuditAttempt: number | null; rowid: number;
    }>();
    const jobRows = this.db.prepare(`SELECT job.owner_id AS delivery_unit_id, job.action, job.status,
        job.last_error, job.updated_at, job.rowid AS job_rowid, NULL AS frozen_unit_id,
        NULL AS frozen_evidence_version, job.id AS job_id,
        job.evidence_version AS job_evidence_version, job.payload_json,
        retry_audit.attempt AS retry_audit_attempt
      FROM automation_jobs job
      JOIN delivery_units unit ON job.owner_type = 'delivery_unit' AND unit.id = job.owner_id
        AND unit.evidence_version = job.evidence_version
      LEFT JOIN delivery_unit_retry_audit retry_audit ON retry_audit.job_id = job.id
        AND retry_audit.requirement_id = unit.requirement_id
        AND retry_audit.delivery_unit_id = unit.id
        AND retry_audit.evidence_version = unit.evidence_version
        AND retry_audit.target = 'application'
      WHERE unit.requirement_id = ?
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, job.updated_at, job.rowid,
        json_extract(plan_unit.value, '$.unitId'),
        json_extract(plan_unit.value, '$.evidenceVersion'), NULL, NULL, NULL, NULL
      FROM automation_jobs job, json_each(job.payload_json, '$.units') plan_unit
      WHERE job.owner_type = 'delivery_unit' AND job.action = 'apply'
        AND json_extract(job.payload_json, '$.type') = 'delivery_application_plan'
        AND json_extract(job.payload_json, '$.requirementId') = ?
      ORDER BY job.updated_at DESC, job.rowid DESC`).all(requirementId, requirementId) as Array<{
        delivery_unit_id: string | null; action: string | null; status: string | null;
        last_error: string | null;
        frozen_unit_id: string | null; frozen_evidence_version: number | null;
        job_id: string | null; job_evidence_version: number | null; payload_json: string | null;
        retry_audit_attempt: number | null; job_rowid: number;
      }>;
    for (const row of jobRows) {
      if (row.frozen_unit_id !== null && row.frozen_evidence_version !== null) {
        frozenApplicationUnits.add(applicationUnitKey(row.frozen_unit_id, row.frozen_evidence_version));
      }
      if (row.delivery_unit_id === null || row.action === null || row.status === null) continue;
      if (row.action === "apply" && (row.status === "completed" || row.status === "failed")
        && row.job_id !== null && row.job_evidence_version !== null && row.payload_json !== null) {
        const existing = settledApplicationJobs.get(row.delivery_unit_id);
        if (!existing || existing.rowid < row.job_rowid) {
          settledApplicationJobs.set(row.delivery_unit_id, {
            id: row.job_id,
            evidenceVersion: row.job_evidence_version,
            payloadJson: row.payload_json,
            retryAuditAttempt: row.retry_audit_attempt,
            rowid: row.job_rowid
          });
        }
      }
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

    const latestApplications = new Map<string, {
      status: string; resolutionStatus: string; projectVersionId: string;
    }>();
    const applicationsByJobId = new Map<string, {
      deliveryUnitId: string; evidenceVersion: number; status: string; resolutionStatus: string;
    }>();
    const activeApplicationProjectVersions = new Set<string>();
    const applicationRows = this.db.prepare(`SELECT application.delivery_unit_id,
        application.project_version_id, application.evidence_version, application.automation_job_id,
        application.status, application.resolution_status
      FROM delivery_application_runs application
      WHERE application.delivery_unit_id IN (
          SELECT id FROM delivery_units WHERE requirement_id = ?
        ) OR application.project_version_id IN (
          SELECT project_version_id FROM delivery_units WHERE requirement_id = ?
        )
      ORDER BY application.updated_at DESC, application.rowid DESC`).all(
        requirementId, requirementId
      ) as Array<{
        delivery_unit_id: string; project_version_id: string;
        evidence_version: number; automation_job_id: string;
        status: string; resolution_status: string;
      }>;
    const ownUnitIds = new Set(units.map((unit) => unit.id));
    for (const row of applicationRows) {
      if (row.resolution_status === "pending") {
        activeApplicationProjectVersions.add(row.project_version_id);
      }
      if (ownUnitIds.has(row.delivery_unit_id) && !latestApplications.has(row.delivery_unit_id)) {
        latestApplications.set(row.delivery_unit_id, {
          status: row.status,
          resolutionStatus: row.resolution_status,
          projectVersionId: row.project_version_id
        });
      }
      if (ownUnitIds.has(row.delivery_unit_id) && !applicationsByJobId.has(row.automation_job_id)) {
        applicationsByJobId.set(row.automation_job_id, {
          deliveryUnitId: row.delivery_unit_id,
          evidenceVersion: row.evidence_version,
          status: row.status,
          resolutionStatus: row.resolution_status
        });
      }
    }

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
    const retryableApplicationUnits = new Set<string>();
    for (const unit of units) {
      const job = settledApplicationJobs.get(unit.id);
      if (!job) continue;
      const application = applicationsByJobId.get(job.id);
      if (!application || application.deliveryUnitId !== unit.id
        || application.evidenceVersion !== unit.evidenceVersion) continue;
      const retryable = (unit.status === "conflicted" && application.status === "conflicted"
          && application.resolutionStatus === "not_required")
        || (unit.status === "failed" && application.status === "failed"
          && application.resolutionStatus === "not_required")
        || (unit.status === "ready_for_acceptance"
          && (application.status === "failed" || application.status === "applied")
          && application.resolutionStatus === "reverted");
      if (!retryable) continue;
      try {
        const payload = parseDeliveryApplicationJob({
          ownerType: "delivery_unit",
          ownerId: unit.id,
          evidenceVersion: job.evidenceVersion,
          action: "apply",
          payload: JSON.parse(job.payloadJson)
        });
        if (payload.requirementId !== unit.requirementId || payload.retryAttempt >= 100
          || (payload.retryAttempt > 0 && job.retryAuditAttempt !== payload.retryAttempt)
          || !frozenApplicationRetryPlanValid({
            entries: payload.units,
            cursor: payload.cursor,
            targetUnitId: unit.id,
            units: units.map((current) => ({
              id: current.id,
              position: current.position,
              required: current.required,
              status: current.status,
              evidenceVersion: current.evidenceVersion
            })),
            dependencies: dependencies.map((dependency) => ({
              upstreamUnitId: dependency.upstreamUnitId,
              downstreamUnitId: dependency.downstreamUnitId,
              releaseCondition: dependency.releaseCondition,
              releasedByEvidenceVersion: dependency.releasedByEvidenceVersion,
              releasedAt: dependency.releasedAt
            }))
          })) continue;
        retryableApplicationUnits.add(unit.id);
      } catch {
        // Malformed persisted jobs fail closed in the public action projection.
      }
    }
    return {
      implementationEvidence, qualityEvidence, jobs, activeRuns, activeInvalidations,
      dependenciesSatisfied, dependencyReleases, latestApplications, activeApplicationProjectVersions,
      frozenApplicationUnits, retryableApplicationUnits
    };
  }

  private acceptanceActions(
    requirementId: string,
    units: DeliveryUnit[],
    automation: RequirementAutomationDetail,
    snapshot: DeliveryDetailSnapshot
  ): AllowedDeliveryAcceptanceAction[] {
    if (automation.status === "paused" || units.length === 0 || snapshot.activeInvalidations.size > 0) return [];
    const requirement = this.db.prepare("SELECT stage, status FROM requirements WHERE id = ?")
      .get(requirementId) as { stage: string; status: string } | undefined;
    if (requirement?.stage !== "implementation" || requirement.status !== "ai_ready") return [];
    if (units.some((unit) => {
      const participating = unit.required || unit.status !== "skipped";
      return unit.status === "potentially_stale"
        || (unit.required ? unit.status !== "ready_for_acceptance"
          : unit.status !== "ready_for_acceptance" && unit.status !== "skipped")
        || (participating && (!(snapshot.dependenciesSatisfied.get(unit.id) ?? true)
          || snapshot.jobs.get(unit.id)?.pending
          || snapshot.jobs.get(unit.id)?.leased
          || snapshot.activeRuns.has(unit.id)
          || snapshot.activeApplicationProjectVersions.has(unit.projectVersionId)));
    })) return [];
    return [{ type: "accept_delivery", commentRequired: true }];
  }

  private allowedActions(
    unit: DeliveryUnit,
    automation: RequirementAutomationDetail,
    snapshot: DeliveryDetailSnapshot,
    evidence: { implementation: unknown | null; codeReview: unknown | null; automatedTesting: unknown | null }
  ): AllowedDeliveryUnitAction[] {
    if (automation.status === "paused") return [];
    const jobs = snapshot.jobs.get(unit.id);
    const active = isDeliveryUnitActiveWork({
      pendingJob: Boolean(jobs?.pending),
      leasedJob: Boolean(jobs?.leased),
      runningExecution: snapshot.activeRuns.has(unit.id)
    }, { includePendingJobs: unit.status === "potentially_stale" });
    if (active) return [];
    if (unit.phase === "acceptance_delivery") {
      const application = snapshot.latestApplications.get(unit.id);
      if (!application) {
        return !unit.required && unit.status === "ready_for_acceptance"
          && !snapshot.frozenApplicationUnits.has(applicationUnitKey(unit.id, unit.evidenceVersion))
          ? [action("skip_optional")]
          : [];
      }
      if (snapshot.activeApplicationProjectVersions.has(unit.projectVersionId)) return [];
      return snapshot.retryableApplicationUnits.has(unit.id) ? [action("retry_application")] : [];
    }
    if (["waiting_dependency", "running", "applying", "applied", "skipped"].includes(unit.status)) return [];
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

function applicationUnitKey(unitId: string, evidenceVersion: number) {
  return `${unitId}:${evidenceVersion}`;
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
