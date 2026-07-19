import { AlertTriangle, Rows3 } from "lucide-react";

export type DeliveryUnitView = {
  id: string;
  projectId: string;
  projectVersionId: string;
  required: boolean;
  phase: "implementation" | "quality_verification" | "acceptance_delivery";
  status: "waiting_dependency" | "ready" | "running" | "awaiting_gate" | "returned" |
    "potentially_stale" | "ready_for_acceptance" | "applying" | "applied" |
    "conflicted" | "failed" | "skipped";
  evidenceVersion: number;
};

export type DeliveryDependencyView = {
  upstreamUnitId: string;
  downstreamUnitId: string;
  upstreamProjectName?: string;
  releaseCondition: "automated_testing_passed";
  releasedByEvidenceVersion?: number | null;
  releasedAt: string | null;
};

export type DeliveryProjectView = {
  projectId: string;
  projectName: string;
  projectVersionId?: string;
  projectVersionName?: string;
  projectVersionBranch?: string;
};

export type DeliveryMatrixProps = {
  units: readonly DeliveryUnitView[];
  dependencies: readonly DeliveryDependencyView[];
  projects: readonly DeliveryProjectView[];
};

const blockedStatusLabels: Partial<Record<DeliveryUnitView["status"], string>> = {
  returned: "交付单元已退回",
  potentially_stale: "交付证据可能已过期",
  conflicted: "应用存在冲突",
  failed: "交付处理失败"
};

const implementationStatusLabels: Record<DeliveryUnitView["status"], string> = {
  waiting_dependency: "等待依赖",
  ready: "待开始",
  running: "进行中",
  awaiting_gate: "等待门禁",
  returned: "已退回",
  potentially_stale: "证据可能过期",
  ready_for_acceptance: "已完成",
  applying: "已完成",
  applied: "已完成",
  conflicted: "已完成",
  failed: "需要检查",
  skipped: "已跳过"
};

export function deliveryRowView(
  unit: DeliveryUnitView,
  dependencies: readonly DeliveryDependencyView[]
) {
  const pending = dependencies.find((dependency) =>
    dependency.downstreamUnitId === unit.id && dependency.releasedAt === null
  );
  const released = dependencies.filter((dependency) => dependency.downstreamUnitId === unit.id);
  const dependencyLabel = unit.status === "skipped"
    ? "无需等待 · 已跳过"
    : pending ? `等待 ${pending.upstreamProjectName ?? pending.upstreamUnitId} 自动化测试`
      : released.length > 0 ? "依赖已释放" : "无等待依赖";
  const quality = qualityLabels(unit);

  return {
    dependencyLabel,
    implementationLabel: unit.status === "skipped"
      ? "已跳过"
      : unit.phase === "implementation"
      ? implementationStatusLabels[unit.status]
      : "已完成",
    reviewLabel: quality.review,
    automatedTestingLabel: quality.testing,
    applicationLabel: applicationLabel(unit),
    blocker: unit.status === "skipped"
      ? `${unit.required ? "必需" : "可选"}交付已跳过`
      : pending ? dependencyLabel : blockedStatusLabels[unit.status] ?? null,
    nextAction: null
  };
}

export function DeliveryMatrix({ units, dependencies, projects }: DeliveryMatrixProps) {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const namedDependencies = dependencies.map((dependency) => {
    const upstreamUnit = unitById.get(dependency.upstreamUnitId);
    return {
      ...dependency,
      upstreamProjectName: upstreamUnit
        ? projectById.get(upstreamUnit.projectId)?.projectName
        : dependency.upstreamProjectName
    };
  });

  return <section className="delivery-matrix" aria-labelledby="delivery-matrix-title">
    <div className="delivery-matrix-title">
      <div><Rows3 size={17}/><h3 id="delivery-matrix-title">项目交付矩阵</h3></div>
      <span>只读</span>
    </div>
    <div className="delivery-matrix-header delivery-row-grid" aria-hidden="true">
      {['项目 / 版本', '依赖', '实现', 'Code Review', '自动化测试', '应用', 'Blocker', '下一步'].map((label) => <span key={label}>{label}</span>)}
    </div>
    <div className="delivery-matrix-rows">
      {units.map((unit) => {
        const project = projectById.get(unit.projectId);
        const view = deliveryRowView(unit, namedDependencies);
        const version = project?.projectVersionName ?? unit.projectVersionId;
        const branch = project?.projectVersionBranch;
        return <article className="delivery-row-grid delivery-row-stack" data-delivery-row={unit.id} key={unit.id}>
          <div className="delivery-project"><span className="delivery-field-label">项目 / 版本</span><b>{project?.projectName ?? unit.projectId}<span className="delivery-requirement">{unit.required ? "必需" : "可选"}</span></b><small>{version}{branch ? ` · ${branch}` : ""}</small></div>
          <DeliveryField label="依赖" value={view.dependencyLabel}/>
          <DeliveryField label="实现" value={view.implementationLabel}/>
          <DeliveryField label="Code Review" field="code-review" value={view.reviewLabel}/>
          <DeliveryField label="自动化测试" field="automated-testing" value={view.automatedTestingLabel}/>
          <DeliveryField label="应用" value={view.applicationLabel}/>
          <DeliveryField label="Blocker" value={view.blocker ?? "无"} blocker={Boolean(view.blocker) && (unit.status !== "skipped" || unit.required)}/>
          <DeliveryField label="下一步" field="next-action" value={view.nextAction ?? "—"}/>
        </article>;
      })}
    </div>
  </section>;
}

function DeliveryField({ label, value, field, blocker = false }: {
  label: string;
  value: string;
  field?: string;
  blocker?: boolean;
}) {
  return <div className={blocker ? "delivery-field delivery-blocker" : "delivery-field"} data-field={field}>
    <span className="delivery-field-label">{label}</span>
    {blocker && <AlertTriangle size={14}/>}<span>{value}</span>
  </div>;
}

function applicationLabel(unit: DeliveryUnitView): string {
  if (unit.status === "skipped") return "已跳过";
  if (unit.status === "applied") return "已应用";
  if (unit.status === "applying") return "应用中";
  if (unit.status === "conflicted") return "存在冲突";
  if (unit.status === "failed" && unit.phase === "acceptance_delivery") return "应用失败";
  return unit.phase === "acceptance_delivery" ? "待应用" : "尚未开始";
}

function qualityLabels(unit: DeliveryUnitView): { review: string; testing: string } {
  if (unit.status === "skipped") return { review: "已跳过", testing: "已跳过" };
  if (["ready_for_acceptance", "applying", "applied"].includes(unit.status)) {
    return { review: "已通过", testing: "已通过" };
  }
  return { review: "等待独立审查证据", testing: "等待自动化测试证据" };
}
