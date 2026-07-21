import type { DatabaseSync } from "node:sqlite";
import type { DeliveryExecutionRepository } from "./delivery-execution-repository.js";
import type { DeliveryQualityRepository } from "./delivery-quality-repository.js";
import type { DeliveryDependency, DeliveryUnit, DeliveryUnitRepository } from "./delivery-unit-repository.js";

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

export class DeliveryUnitDetailRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly units: DeliveryUnitRepository,
    private readonly executions: DeliveryExecutionRepository,
    private readonly quality: DeliveryQualityRepository
  ) {}

  getForRequirement(requirementId: string): DeliveryRequirementDetail {
    const units = this.units.listForRequirement(requirementId);
    const dependencies = this.units.listDependencies(requirementId);
    const automation = this.automationState(requirementId);
    return {
      automation: {
        ...automation,
        allowedActions: [{
          type: automation.status === "paused" ? "resume_automation" : "pause_automation",
          reasonRequired: true
        }]
      },
      units: units.map((unit) => {
        const implementationEvidence = this.executions.getCodingEvidence(unit.id, unit.evidenceVersion);
        const codeReviewEvidence = currentEvidence(this.quality.latest(unit.id, "code_review"), unit.evidenceVersion);
        const automatedTestingEvidence = currentEvidence(
          this.quality.latest(unit.id, "automated_testing"), unit.evidenceVersion
        );
        const dependencyReleases: Array<DeliveryDependency & { direction: "incoming" | "outgoing" }> = [];
        for (const dependency of dependencies) {
          if (dependency.upstreamUnitId === unit.id) {
            dependencyReleases.push({ ...dependency, direction: "outgoing" });
          } else if (dependency.downstreamUnitId === unit.id) {
            dependencyReleases.push({ ...dependency, direction: "incoming" });
          }
        }
        return {
          ...unit,
          implementationEvidence,
          codeReviewEvidence,
          automatedTestingEvidence,
          blocker: this.blocker(unit, automation, dependencyReleases),
          dependencyReleases,
          automation,
          allowedActions: this.allowedActions(unit, automation, {
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

  private allowedActions(
    unit: DeliveryUnit,
    automation: RequirementAutomationDetail,
    evidence: { implementation: unknown | null; codeReview: unknown | null; automatedTesting: unknown | null }
  ): AllowedDeliveryUnitAction[] {
    if (automation.status === "paused" || ["waiting_dependency", "running", "applying", "applied", "skipped"]
      .includes(unit.status)) return [];
    if (unit.status === "potentially_stale") {
      return this.hasActiveInvalidation(unit)
        ? [action("reuse_evidence"), action("rerun")]
        : [];
    }
    const active = this.hasActiveWork(unit);
    const actions: AllowedDeliveryUnitAction[] = [];
    if (!active && unit.phase === "implementation" && unit.status === "failed" && !evidence.implementation
      && this.dependenciesSatisfied(unit.id) && this.failedJob(unit, "implement")) {
      actions.push(action("retry_implementation"));
    }
    if (!active && evidence.implementation && ["awaiting_gate", "returned", "failed"].includes(unit.status)) {
      if (!evidence.codeReview && this.failedJob(unit, "review")) actions.push(action("retry_code_review"));
      if (!evidence.automatedTesting && this.failedJob(unit, "test")) {
        actions.push(action("retry_automated_testing"));
      }
    }
    if (!active && !unit.required && !["running", "applying", "applied", "skipped"].includes(unit.status)) {
      actions.push(action("skip_optional"));
    }
    return actions;
  }

  private blocker(
    unit: DeliveryUnit,
    automation: RequirementAutomationDetail,
    dependencies: Array<DeliveryDependency & { direction: "incoming" | "outgoing" }>
  ) {
    if (automation.status === "paused") return {
      code: "REQUIREMENT_AUTOMATION_PAUSED",
      message: automation.reason ? `自动化已暂停：${automation.reason}` : "自动化已暂停"
    };
    if (unit.status === "potentially_stale") return {
      code: "DELIVERY_EVIDENCE_POTENTIALLY_STALE",
      message: "上游证据已变化，需要确认复用或重新执行"
    };
    if (unit.status === "waiting_dependency" || dependencies.some((edge) =>
      edge.direction === "incoming" && edge.releasedAt === null)) return {
      code: "DELIVERY_DEPENDENCY_PENDING", message: "等待上游依赖释放"
    };
    if (unit.status === "returned") return {
      code: "DELIVERY_CODE_REVIEW_FAILED", message: "代码审查未通过，需要处理审查结论"
    };
    if (unit.status === "conflicted") return {
      code: "DELIVERY_APPLICATION_CONFLICT", message: "本地应用存在冲突"
    };
    if (unit.status === "failed") {
      const failure = this.latestFailedJob(unit);
      return { code: "DELIVERY_UNIT_FAILED", message: failure?.last_error || "交付处理失败" };
    }
    return null;
  }

  private failedJob(unit: DeliveryUnit, action: "implement" | "review" | "test") {
    return Boolean(this.db.prepare(`SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit'
      AND owner_id = ? AND evidence_version = ? AND action = ? AND status = 'failed'`)
      .get(unit.id, unit.evidenceVersion, action));
  }

  private latestFailedJob(unit: DeliveryUnit) {
    return this.db.prepare(`SELECT last_error FROM automation_jobs WHERE owner_type = 'delivery_unit'
      AND owner_id = ? AND evidence_version = ? AND status = 'failed' ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(unit.id, unit.evidenceVersion) as { last_error: string | null } | undefined;
  }

  private hasActiveWork(unit: DeliveryUnit) {
    return Boolean(this.db.prepare(`SELECT 1 WHERE EXISTS (
        SELECT 1 FROM automation_jobs WHERE owner_type = 'delivery_unit' AND owner_id = ?
          AND evidence_version = ? AND status = 'leased'
      ) OR EXISTS (
        SELECT 1 FROM delivery_quality_runs WHERE delivery_unit_id = ? AND evidence_version = ? AND status = 'running'
      ) OR EXISTS (
        SELECT 1 FROM stage_runs WHERE owner_type = 'delivery_unit' AND owner_id = ?
          AND evidence_version = ? AND status = 'running'
      )`).get(unit.id, unit.evidenceVersion, unit.id, unit.evidenceVersion, unit.id, unit.evidenceVersion));
  }

  private hasActiveInvalidation(unit: DeliveryUnit) {
    return Boolean(this.db.prepare(`SELECT 1 FROM delivery_evidence_invalidations invalidation
      WHERE invalidation.target_unit_id = ? AND invalidation.target_evidence_version = ?
        AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
          WHERE source.invalidation_id = invalidation.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_unit_skip_sources source
          WHERE source.invalidation_id = invalidation.id) LIMIT 1`).get(unit.id, unit.evidenceVersion));
  }

  private dependenciesSatisfied(unitId: string) {
    return !this.db.prepare(`SELECT 1 FROM delivery_dependencies
      WHERE downstream_unit_id = ? AND released_by_evidence_version IS NULL LIMIT 1`).get(unitId);
  }
}

function action(type: DeliveryUnitActionType): AllowedDeliveryUnitAction {
  return { type, reasonRequired: true };
}

function currentEvidence<T extends { evidenceVersion: number }>(evidence: T | null, version: number): T | null {
  return evidence?.evidenceVersion === version ? evidence : null;
}
