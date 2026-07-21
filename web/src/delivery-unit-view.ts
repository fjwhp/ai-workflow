import {
  deliveryUnitPhases,
  deliveryUnitStatuses
} from "@ai-workflow/shared";

export type DeliveryUnitActionType =
  | "retry_implementation"
  | "retry_code_review"
  | "retry_automated_testing"
  | "reuse_evidence"
  | "rerun"
  | "skip_optional";

export interface DeliveryUnitAllowedAction {
  type: DeliveryUnitActionType;
  reasonRequired: true;
}

export interface DeliveryEvidenceSummary {
  id: string;
  evidenceVersion?: number;
  inputEvidenceVersion?: number;
  diffHash?: string;
  fileCount?: number;
  additions?: number;
  deletions?: number;
  kind?: "code_review" | "automated_testing";
  result?: "passed" | "failed";
}

export interface DeliveryDependencyRelease {
  id?: string;
  upstreamUnitId: string;
  downstreamUnitId: string;
  direction: "incoming" | "outgoing";
  releaseCondition: "automated_testing_passed";
  releasedByEvidenceVersion?: number | null;
  releasedAt: string | null;
}

export interface RequirementAutomationView {
  status: "active" | "paused";
  actor?: string;
  reason?: string;
  updatedAt?: string;
}

export interface LiveDeliveryUnit {
  id: string;
  projectId: string;
  projectVersionId: string;
  required: boolean;
  phase: typeof deliveryUnitPhases[number];
  status: typeof deliveryUnitStatuses[number];
  evidenceVersion: number;
  implementationEvidence: DeliveryEvidenceSummary | null;
  codeReviewEvidence: DeliveryEvidenceSummary | null;
  automatedTestingEvidence: DeliveryEvidenceSummary | null;
  blocker: { code: string; message: string } | null;
  dependencyReleases: DeliveryDependencyRelease[];
  automation: RequirementAutomationView;
  allowedActions: readonly DeliveryUnitAllowedAction[];
}

export type DeliveryTone = "neutral" | "progress" | "success" | "warning" | "danger";

const actionLabels: Record<DeliveryUnitActionType, string> = {
  retry_implementation: "重试实现",
  retry_code_review: "重试审查",
  retry_automated_testing: "重试测试",
  reuse_evidence: "复用证据",
  rerun: "重新执行",
  skip_optional: "跳过可选交付"
};

const implementationStatusLabels: Record<LiveDeliveryUnit["status"], { label: string; tone: DeliveryTone }> = {
  waiting_dependency: { label: "等待依赖", tone: "neutral" },
  ready: { label: "待开始", tone: "neutral" },
  running: { label: "进行中", tone: "progress" },
  awaiting_gate: { label: "实现完成", tone: "success" },
  returned: { label: "已退回", tone: "warning" },
  potentially_stale: { label: "证据待确认", tone: "warning" },
  ready_for_acceptance: { label: "已完成", tone: "success" },
  applying: { label: "已完成", tone: "success" },
  applied: { label: "已完成", tone: "success" },
  conflicted: { label: "已完成", tone: "success" },
  failed: { label: "执行失败", tone: "danger" },
  skipped: { label: "已跳过", tone: "neutral" }
};

export function deliveryUnitView(unit: LiveDeliveryUnit) {
  return {
    implementation: implementationView(unit),
    review: qualityView(unit.codeReviewEvidence, unit.status === "skipped"),
    testing: qualityView(unit.automatedTestingEvidence, unit.status === "skipped"),
    blocker: unit.blocker?.message ?? null,
    automationLabel: unit.automation.status === "paused"
      ? `自动化已暂停${unit.automation.reason ? ` · ${unit.automation.reason}` : ""}`
      : "自动化运行中",
    actions: unit.allowedActions.map((allowed) => ({
      type: allowed.type,
      label: actionLabels[allowed.type],
      reasonRequired: allowed.reasonRequired
    }))
  };
}

export function deliveryActionSubmission(action: DeliveryUnitAllowedAction, reason: string) {
  const normalized = reason.trim();
  if (action.reasonRequired && !normalized) return { ok: false as const, error: "请填写操作原因" };
  return { ok: true as const, value: { type: action.type, reason: normalized } };
}

export function deliveryActionRequest(requirementId: string, request: {
  type: DeliveryUnitActionType | "pause_automation" | "resume_automation";
  reason: string;
  unitId?: string;
}) {
  if (request.type === "pause_automation" || request.type === "resume_automation") {
    return {
      path: `/requirements/${requirementId}/automation/${request.type === "pause_automation" ? "pause" : "resume"}`,
      body: { reason: request.reason }
    };
  }
  if (!request.unitId) throw new Error("DELIVERY_UNIT_ACTION_ID_REQUIRED");
  if (request.type === "reuse_evidence" || request.type === "rerun") return {
    path: `/delivery-units/${request.unitId}/stale-resolution`,
    body: { decision: request.type === "reuse_evidence" ? "reuse" : "rerun", reason: request.reason }
  };
  if (request.type === "skip_optional") return {
    path: `/delivery-units/${request.unitId}/skip`, body: { reason: request.reason }
  };
  const target = request.type === "retry_implementation" ? "implementation"
    : request.type === "retry_code_review" ? "code_review" : "automated_testing";
  return { path: `/delivery-units/${request.unitId}/retry`, body: { target, reason: request.reason } };
}

function implementationView(unit: LiveDeliveryUnit): { label: string; tone: DeliveryTone } {
  const evidence = unit.implementationEvidence;
  if (!evidence) return implementationStatusLabels[unit.status];
  if (typeof evidence.fileCount === "number" && typeof evidence.additions === "number"
    && typeof evidence.deletions === "number") {
    return { label: `${evidence.fileCount} 个文件 · +${evidence.additions} / -${evidence.deletions}`, tone: "neutral" };
  }
  return { label: `证据 v${evidence.evidenceVersion ?? unit.evidenceVersion}`, tone: "neutral" };
}

function qualityView(evidence: DeliveryEvidenceSummary | null, skipped: boolean) {
  if (skipped) return { label: "已跳过", tone: "neutral" as const };
  if (!evidence) return { label: "等待证据", tone: "neutral" as const };
  return evidence.result === "passed"
    ? { label: "已通过", tone: "success" as const }
    : { label: "未通过", tone: "danger" as const };
}
