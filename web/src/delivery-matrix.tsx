import { AlertTriangle, Rows3 } from "lucide-react";
import {
  deliveryReleaseConditions,
  deliveryUnitPhases,
  deliveryUnitStatuses
} from "@ai-workflow/shared";

type DeliveryUnitPhase = typeof deliveryUnitPhases[number];
type DeliveryUnitStatus = typeof deliveryUnitStatuses[number];
type DeliveryReleaseCondition = typeof deliveryReleaseConditions[number];

export type DeliveryUnitView = {
  id: string;
  projectId: string;
  projectVersionId: string;
  required: boolean;
  phase: DeliveryUnitPhase;
  status: DeliveryUnitStatus;
  evidenceVersion: number;
};

export type DeliveryDependencyView = {
  upstreamUnitId: string;
  downstreamUnitId: string;
  upstreamProjectName?: string;
  releaseCondition: DeliveryReleaseCondition;
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

type DeliveryStatusView = {
  implementationLabel: string;
  blockerLabel: string | null;
  quality: { review: string; testing: string };
  applicationLabel: string | null;
};

const neutralQuality = { review: "等待独立审查证据", testing: "等待自动化测试证据" };
const passedQuality = { review: "已通过", testing: "已通过" };
const skippedQuality = { review: "已跳过", testing: "已跳过" };

export const deliveryStatusViews = {
  waiting_dependency: { implementationLabel: "等待依赖", blockerLabel: null, quality: neutralQuality, applicationLabel: null },
  ready: { implementationLabel: "待开始", blockerLabel: null, quality: neutralQuality, applicationLabel: null },
  running: { implementationLabel: "进行中", blockerLabel: null, quality: neutralQuality, applicationLabel: null },
  awaiting_gate: { implementationLabel: "等待门禁", blockerLabel: null, quality: neutralQuality, applicationLabel: null },
  returned: { implementationLabel: "已退回", blockerLabel: "交付单元已退回", quality: neutralQuality, applicationLabel: null },
  potentially_stale: { implementationLabel: "证据可能过期", blockerLabel: "交付证据可能已过期", quality: neutralQuality, applicationLabel: null },
  ready_for_acceptance: { implementationLabel: "已完成", blockerLabel: null, quality: passedQuality, applicationLabel: null },
  applying: { implementationLabel: "已完成", blockerLabel: null, quality: passedQuality, applicationLabel: "应用中" },
  applied: { implementationLabel: "已完成", blockerLabel: null, quality: passedQuality, applicationLabel: "已应用" },
  conflicted: { implementationLabel: "已完成", blockerLabel: "应用存在冲突", quality: neutralQuality, applicationLabel: "存在冲突" },
  failed: { implementationLabel: "需要检查", blockerLabel: "交付处理失败", quality: neutralQuality, applicationLabel: null },
  skipped: { implementationLabel: "已跳过", blockerLabel: null, quality: skippedQuality, applicationLabel: "已跳过" }
} satisfies Record<DeliveryUnitStatus, DeliveryStatusView>;

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
  const statusView = deliveryStatusViews[unit.status];

  return {
    dependencyLabel,
    implementationLabel: unit.status === "skipped"
      ? "已跳过"
      : unit.phase === "implementation"
      ? statusView.implementationLabel
      : "已完成",
    reviewLabel: statusView.quality.review,
    automatedTestingLabel: statusView.quality.testing,
    applicationLabel: applicationLabel(unit),
    blocker: unit.status === "skipped"
      ? `${unit.required ? "必需" : "可选"}交付已跳过`
      : pending ? dependencyLabel : statusView.blockerLabel,
    nextAction: null
  };
}

export function deliveryMatrixRowViews(
  units: readonly DeliveryUnitView[],
  dependencies: readonly DeliveryDependencyView[]
): ReadonlyMap<string, ReturnType<typeof deliveryRowView>> {
  const unitIds = new Set(units.map((unit) => unit.id));
  const invalidUnitIds = new Set<string>();
  const validDependencies: DeliveryDependencyView[] = [];

  for (const dependency of dependencies) {
    const hasUpstream = unitIds.has(dependency.upstreamUnitId);
    const hasDownstream = unitIds.has(dependency.downstreamUnitId);
    if (!hasUpstream || !hasDownstream) {
      if (hasUpstream) invalidUnitIds.add(dependency.upstreamUnitId);
      if (hasDownstream) invalidUnitIds.add(dependency.downstreamUnitId);
      continue;
    }
    validDependencies.push(dependency);
  }

  for (const unitId of cyclicUnitIds(unitIds, validDependencies)) invalidUnitIds.add(unitId);

  return new Map(units.map((unit) => {
    const view = deliveryRowView(unit, dependencies);
    return [unit.id, invalidUnitIds.has(unit.id) ? {
      ...view,
      dependencyLabel: "交付依赖数据异常",
      blocker: "交付依赖数据异常",
      nextAction: null
    } : view];
  }));
}

function cyclicUnitIds(
  unitIds: ReadonlySet<string>,
  dependencies: readonly DeliveryDependencyView[]
): ReadonlySet<string> {
  const adjacency = new Map([...unitIds].map((unitId) => [unitId, [] as string[]]));
  for (const dependency of dependencies) {
    adjacency.get(dependency.upstreamUnitId)!.push(dependency.downstreamUnitId);
  }

  const cyclic = new Set<string>();
  for (const startUnitId of unitIds) {
    const pending = [...adjacency.get(startUnitId)!];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const unitId = pending.pop()!;
      if (unitId === startUnitId) {
        cyclic.add(startUnitId);
        break;
      }
      if (visited.has(unitId)) continue;
      visited.add(unitId);
      pending.push(...adjacency.get(unitId)!);
    }
  }
  return cyclic;
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
  const rowViews = deliveryMatrixRowViews(units, namedDependencies);

  return <section className="delivery-matrix" aria-labelledby="delivery-matrix-title">
    <div className="delivery-matrix-title">
      <div><Rows3 size={17}/><h3 id="delivery-matrix-title">项目交付矩阵</h3></div>
      <span>只读</span>
    </div>
    <table className="delivery-matrix-table" aria-labelledby="delivery-matrix-title">
      <thead>
        <tr className="delivery-matrix-header delivery-row-grid">
          {['项目 / 版本', '依赖', '实现', 'Code Review', '自动化测试', '应用', 'Blocker', '下一步'].map((label) => <th scope="col" key={label}>{label}</th>)}
        </tr>
      </thead>
      <tbody className="delivery-matrix-rows">
      {units.map((unit) => {
        const project = projectById.get(unit.projectId);
        const view = rowViews.get(unit.id)!;
        const version = project?.projectVersionName ?? unit.projectVersionId;
        const branch = project?.projectVersionBranch;
        return <tr className="delivery-row-grid delivery-row-stack" data-delivery-row={unit.id} key={unit.id}>
          <td className="delivery-project"><span className="delivery-field-label" aria-hidden="true">项目 / 版本</span><b>{project?.projectName ?? unit.projectId}<span className="delivery-requirement">{unit.required ? "必需" : "可选"}</span></b><small>{version}{branch ? ` · ${branch}` : ""}</small></td>
          <DeliveryField label="依赖" value={view.dependencyLabel}/>
          <DeliveryField label="实现" value={view.implementationLabel}/>
          <DeliveryField label="Code Review" field="code-review" value={view.reviewLabel}/>
          <DeliveryField label="自动化测试" field="automated-testing" value={view.automatedTestingLabel}/>
          <DeliveryField label="应用" value={view.applicationLabel}/>
          <DeliveryField label="Blocker" value={view.blocker ?? "无"} blocker={Boolean(view.blocker) && (unit.status !== "skipped" || unit.required)}/>
          <DeliveryField label="下一步" field="next-action" value={view.nextAction ?? "—"}/>
        </tr>;
      })}
      </tbody>
    </table>
  </section>;
}

function DeliveryField({ label, value, field, blocker = false }: {
  label: string;
  value: string;
  field?: string;
  blocker?: boolean;
}) {
  return <td className={blocker ? "delivery-field delivery-blocker" : "delivery-field"} data-field={field}>
    <span className="delivery-field-label" aria-hidden="true">{label}</span>
    {blocker && <AlertTriangle size={14}/>}<span>{value}</span>
  </td>;
}

function applicationLabel(unit: DeliveryUnitView): string {
  const statusLabel = deliveryStatusViews[unit.status].applicationLabel;
  if (statusLabel) return statusLabel;
  if (unit.status === "failed" && unit.phase === "acceptance_delivery") return "应用失败";
  return unit.phase === "acceptance_delivery" ? "待应用" : "尚未开始";
}
