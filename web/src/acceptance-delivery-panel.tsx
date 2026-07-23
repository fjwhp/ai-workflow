import { useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FileClock,
  RefreshCw
} from "lucide-react";
import { aggregateDeliveryStatus, type AggregateDeliveryStatus } from "@ai-workflow/shared";
import { DeliveryActionDialog, type DeliveryProjectView, type DeliveryUnitView } from "./delivery-matrix.js";
import { submitDeliveryMutation } from "./delivery-unit-view.js";

export type AcceptanceDeliveryAction = { type: "accept_delivery"; commentRequired: true };

export type ApplicationRun = {
  id: string;
  deliveryUnitId: string;
  projectVersionId: string;
  evidenceVersion: number;
  automationAttempt: number;
  sourceCommit?: string | null;
  baseCommit?: string | null;
  preApplyCommit?: string | null;
  evidenceHash?: string | null;
  preflight?: {
    allowed?: boolean;
    checks?: Array<{ id?: string; label?: string; name?: string; ok?: boolean; passed?: boolean; code?: string | number }>;
    plannedCommands?: Array<{ command?: string; argsPrefix?: string[] }>;
  };
  commandResults?: Array<{ command?: string; args?: string[]; code?: number; stdout?: string; stderr?: string }>;
  conflictFiles?: string[];
  error?: string | null;
  status: string;
  resolutionStatus: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  resolvedAt?: string | null;
};

export type ApplicationRetryAudit = {
  attempt?: number;
  reason?: string;
  actor?: string;
  createdAt?: string;
};

export type ApplicationRunsResponse = {
  runs: ApplicationRun[];
  retries: ApplicationRetryAudit[];
};

export type ApplicationRunsState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; data: ApplicationRunsResponse }
  | { state: "error"; error: string };

export function acceptanceErrorView(error: unknown) {
  const value = typeof error === "object" && error !== null
    ? error as { status?: unknown; code?: unknown; error?: unknown; message?: unknown }
    : null;
  const status = typeof value?.status === "number" ? value.status : undefined;
  const code = typeof value?.code === "string" ? value.code
    : typeof value?.error === "string" ? value.error : undefined;
  if (status === 400 || code === "VALIDATION_ERROR") return "输入内容无效，请检查后重试";
  if (status === 404 || code === "NOT_FOUND") return "记录不存在或已变化，请刷新后重试";
  if ((status !== undefined && status >= 500) || code === "INTERNAL_ERROR") {
    return "服务暂时不可用，请稍后重试";
  }
  if (status !== undefined || code !== undefined) return "操作失败，请重试";
  if (error instanceof Error && error.message && !/^[A-Z][A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return "操作失败，请重试";
}

export async function loadApplicationRuns(
  unitId: string,
  loadingUnitIds: Set<string>,
  request: (unitId: string) => Promise<ApplicationRunsResponse>,
  setState: (state: ApplicationRunsState) => void
) {
  if (loadingUnitIds.has(unitId)) return false;
  loadingUnitIds.add(unitId);
  setState({ state: "loading" });
  try {
    setState({ state: "loaded", data: await request(unitId) });
    return true;
  } catch (error) {
    setState({ state: "error", error: acceptanceErrorView(error) });
    return false;
  } finally {
    loadingUnitIds.delete(unitId);
  }
}

export async function toggleApplicationRuns(
  unitId: string,
  state: ApplicationRunsState,
  loadingUnitIds: Set<string>,
  request: (unitId: string) => Promise<ApplicationRunsResponse>,
  setState: (state: ApplicationRunsState) => void
) {
  if (state.state === "loading") return false;
  if (state.state !== "idle") {
    setState({ state: "idle" });
    return true;
  }
  return loadApplicationRuns(unitId, loadingUnitIds, request, setState);
}

const aggregateLabels: Record<AggregateDeliveryStatus, string> = {
  in_progress: "进行中",
  awaiting_acceptance: "等待验收",
  applying: "应用中",
  partially_applied: "部分应用",
  completed: "完成",
  blocked: "阻塞"
};

const applicationLabels: Record<DeliveryUnitView["status"], string> = {
  waiting_dependency: "尚未开始",
  ready: "尚未开始",
  running: "尚未开始",
  awaiting_gate: "尚未开始",
  returned: "尚未开始",
  potentially_stale: "证据待确认",
  ready_for_acceptance: "等待验收",
  applying: "应用中",
  applied: "已应用",
  conflicted: "存在冲突",
  failed: "应用失败",
  skipped: "已跳过"
};

export function acceptanceDeliveryView(
  units: readonly DeliveryUnitView[],
  allowedActions: readonly AcceptanceDeliveryAction[]
) {
  const participatingUnits = units.filter((unit) => unit.required || unit.status !== "skipped");
  const status = aggregateDeliveryStatus(units);
  return {
    status,
    statusLabel: aggregateLabels[status],
    participatingCount: participatingUnits.length,
    appliedCount: participatingUnits.filter((unit) => unit.status === "applied").length,
    canAccept: allowedActions.some((action) => action.type === "accept_delivery"),
    retryUnitId: units.find((unit) =>
      unit.allowedActions?.some((action) => action.type === "retry_application"))?.id ?? null
  };
}

export function acceptanceCommentSubmission(comment: string) {
  const normalized = comment.trim();
  return normalized
    ? { ok: true as const, value: { comment: normalized } }
    : { ok: false as const, error: "请填写验收意见" };
}

export async function submitAcceptanceAction(options: {
  busy: MutableRefObject<boolean>;
  setBusy: (busy: boolean) => void;
  mutate: () => Promise<void>;
  onMutationSuccess: () => void;
  refresh: () => Promise<void>;
  onRefreshError: (error: unknown) => void;
  onConflict: (message: string) => void;
}) {
  if (options.busy.current) return false;
  options.busy.current = true;
  options.setBusy(true);
  try {
    await submitDeliveryMutation(
      options.mutate,
      options.onMutationSuccess,
      options.refresh,
      options.onRefreshError
    );
    return true;
  } catch (error) {
    if (isConflict(error)) {
      try {
        await options.refresh();
        options.onConflict("交付状态已变化，已刷新最新状态");
      } catch (refreshError) {
        options.onConflict("交付状态已变化，但刷新失败，请重新打开需求");
        options.onRefreshError(refreshError);
      }
      return false;
    }
    throw error;
  } finally {
    options.busy.current = false;
    options.setBusy(false);
  }
}

export function AcceptanceDeliveryPanel({ units, projects, allowedActions, onAccept, onRetry,
  onRefresh, onRefreshError, onLoadRuns }: {
  requirementId: string;
  units: readonly DeliveryUnitView[];
  projects: readonly DeliveryProjectView[];
  allowedActions: readonly AcceptanceDeliveryAction[];
  onAccept: (comment: string) => Promise<void>;
  onRetry: (unitId: string, reason: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshError: (error: unknown) => void;
  onLoadRuns: (unitId: string) => Promise<ApplicationRunsResponse>;
}) {
  const [comment, setComment] = useState("");
  const [validationError, setValidationError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [retryUnitId, setRetryUnitId] = useState<string | null>(null);
  const [runsByUnit, setRunsByUnit] = useState<Record<string, ApplicationRunsState>>({});
  const loadingRunIds = useRef(new Set<string>());
  const view = acceptanceDeliveryView(units, allowedActions);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));

  const runMutation = async (mutate: () => Promise<void>, onMutationSuccess: () => void) => {
    setActionError("");
    try {
      await submitAcceptanceAction({ busy: busyRef, setBusy, mutate, onMutationSuccess,
        refresh: onRefresh, onRefreshError,
        onConflict: setActionError });
    } catch (error) {
      setActionError(acceptanceErrorView(error));
    }
  };
  const submitAcceptance = async (event: FormEvent) => {
    event.preventDefault();
    const submission = acceptanceCommentSubmission(comment);
    if (!submission.ok) {
      setValidationError(submission.error);
      return;
    }
    setValidationError("");
    await runMutation(() => onAccept(submission.value.comment), () => setComment(""));
  };
  const submitRetry = async (reason: string) => {
    if (!retryUnitId) return;
    const unitId = retryUnitId;
    await runMutation(() => onRetry(unitId, reason), () => setRetryUnitId(null));
  };
  const toggleRuns = async (unitId: string, state: ApplicationRunsState) => {
    await toggleApplicationRuns(unitId, state, loadingRunIds.current, onLoadRuns,
      (state) => setRunsByUnit((states) => ({ ...states, [unitId]: state })));
  };

  return <section className="acceptance-delivery" aria-labelledby="acceptance-delivery-title">
    <div className="acceptance-delivery-head">
      <div><ClipboardCheck size={17}/><div><h3 id="acceptance-delivery-title">验收与应用</h3>
        <span>已应用 {view.appliedCount} / {view.participatingCount}</span></div></div>
      <span className={`acceptance-overall-status ${view.status}`}>
        {view.status === "completed" ? <CheckCircle2 size={14}/> : view.status === "blocked"
          ? <AlertTriangle size={14}/> : <FileClock size={14}/>} {view.statusLabel}
      </span>
    </div>
    <ul className="acceptance-unit-list">
      {units.map((unit) => {
        const project = projectById.get(unit.projectId);
        const runState = runsByUnit[unit.id] ?? { state: "idle" as const };
        const runsId = `application-runs-${unit.id}`;
        const canRetry = unit.allowedActions?.some((action) => action.type === "retry_application") ?? false;
        return <li className="acceptance-unit-row" data-acceptance-unit={unit.id} key={unit.id}>
          <div className="acceptance-unit-identity"><b>{project?.projectName ?? unit.projectId}</b>
            <small>{project?.projectVersionName ?? unit.projectVersionId}
              {project?.projectVersionBranch ? ` · ${project.projectVersionBranch}` : ""}</small></div>
          <span className="acceptance-unit-requirement">{unit.required ? "必需" : "可选"}</span>
          <span data-acceptance-field="evidence">证据 v{unit.evidenceVersion}</span>
          <span className={`acceptance-application-status ${unit.status}`} data-acceptance-field="status">
            {applicationLabels[unit.status]}</span>
          <div className="acceptance-unit-actions" data-acceptance-field="actions">
            <ApplicationRunsToggle id={runsId} state={runState}
              onToggle={() => toggleRuns(unit.id, runState)}/>
            {canRetry && <button type="button" className="secondary compact-action"
              onClick={() => { setActionError(""); setRetryUnitId(unit.id); }}>
              <RefreshCw size={14}/>重试应用
            </button>}
          </div>
          {runState.state !== "idle" && <ApplicationRunsView id={runsId} state={runState}/>}
        </li>;
      })}
    </ul>
    {view.canAccept && <form className="acceptance-form" onSubmit={submitAcceptance}>
      <label><span>验收意见</span><textarea aria-label="验收意见" required value={comment} disabled={busy}
        onChange={(event) => setComment(event.target.value)} placeholder="记录业务结果与证据核对结论"/></label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? <RefreshCw className="spin" size={15}/> : <ClipboardCheck size={15}/>}确认验收
      </button>
    </form>}
    {(validationError || actionError) && <p className="acceptance-action-error" role="alert">
      {validationError || actionError}</p>}
    {retryUnitId && <DeliveryActionDialog action={{ type: "retry_application", label: "重试应用",
      reasonRequired: true, unitId: retryUnitId }} busy={busy} error={actionError}
      onClose={() => { if (!busy) setRetryUnitId(null); }} onSubmit={submitRetry}/>}
  </section>;
}

export function ApplicationRunsToggle({ state, id, onToggle }: {
  state: ApplicationRunsState;
  id: string;
  onToggle: () => void;
}) {
  const loading = state.state === "loading";
  const expanded = state.state !== "idle";
  return <button type="button" className="secondary compact-action" aria-expanded={expanded}
    aria-controls={id} onClick={onToggle} disabled={loading}>
    {loading ? <RefreshCw className="spin" size={14}/> : expanded
      ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}<span>{loading ? "正在加载" : expanded
        ? "收起记录" : "应用记录"}</span>
  </button>;
}

export function ApplicationRunsView({ state, id }: { state: ApplicationRunsState; id?: string }) {
  if (state.state === "idle") return null;
  if (state.state === "loading") return <div className="application-runs-state" id={id} role="status">正在读取应用记录</div>;
  if (state.state === "error") return <div className="application-runs-state error" id={id} role="alert">{state.error}</div>;
  if (state.data.runs.length === 0 && state.data.retries.length === 0) {
    return <div className="application-runs-state" id={id}>暂无应用记录</div>;
  }
  return <div className="application-runs" id={id} aria-label="应用记录">
    {state.data.runs.map((run) => <article key={run.id}>
      <div className="application-run-head"><b>尝试 {run.automationAttempt}</b>
        <span>{run.status} · {run.resolutionStatus}</span></div>
      <RunValues label="提交" values={[run.sourceCommit, run.baseCommit, run.preApplyCommit]} compact/>
      <RunValues label="证据" values={[`v${run.evidenceVersion}`, run.evidenceHash]} compact/>
      {run.preflight?.checks?.map((check, index) => <p key={`${check.id ?? check.name ?? index}`}>
        <b>检查</b><span>{check.label ?? check.name ?? check.id ?? "检查"} · {
          check.ok ?? check.passed ? "通过" : check.code ?? "未通过"}</span></p>)}
      {run.commandResults?.map((command, index) => <p key={`${command.command ?? "command"}-${index}`}>
        <b>命令</b><span><code>{[command.command, ...(command.args ?? [])].filter(Boolean).join(" ")}</code>
          {typeof command.code === "number" ? ` · exit ${command.code}` : ""}
          {command.stdout ? ` · ${command.stdout}` : ""}{command.stderr ? ` · ${command.stderr}` : ""}</span></p>)}
      <RunValues label="冲突" values={run.conflictFiles}/>
      <RunValues label="错误" values={[run.error]}/>
      <RunValues label="时间" values={[run.createdAt, run.updatedAt, run.completedAt, run.resolvedAt]}/>
    </article>)}
    {state.data.retries.map((retry, index) => <article className="application-retry-audit" key={index}>
      <div className="application-run-head"><b>重试 {retry.attempt ?? index + 1}</b><span>{retry.createdAt}</span></div>
      <RunValues label="原因" values={[retry.reason]}/>
    </article>)}
  </div>;
}

function RunValues({ label, values, compact = false }: {
  label: string;
  values: Array<string | null | undefined> | undefined;
  compact?: boolean;
}) {
  const visible = values?.filter((value): value is string => Boolean(value)) ?? [];
  if (visible.length === 0) return null;
  return <p><b>{label}</b><span>{visible.map((value) => compact && value.length > 16
    ? <code key={value}>{value.slice(0, 12)}</code> : value).reduce<ReactNode[]>((items, value, index) =>
      [...items, ...(index ? [" · "] : []), value], [])}</span></p>;
}

function isConflict(error: unknown): error is { status: 409 } {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
