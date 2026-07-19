import { useEffect, useReducer, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, Code2, FileText, Play, RefreshCw, ShieldCheck, TestTube2 } from "lucide-react";
import { stageLabels, statusLabels, workflowStages, type Requirement, type WorkflowStage, type WorkflowStatus } from "@ai-workflow/shared";
import { api, post } from "./api.js";
import { DeliveryMatrix, type DeliveryDependencyView, type DeliveryUnitView } from "./delivery-matrix.js";
import { gateLabel, gateReasons, latestGateForStage } from "./gate-view.js";
import { InlineRunStream } from "./inline-run-stream.js";
import { productArtifactView } from "./product-artifact-view.js";
import { isRequirementDeliveryPlanFrozen, PlannedDelivery, RequirementProjectSummary, type Association } from "./requirement-projects.js";
import { groupReworkItems } from "./rework-view.js";
import { latestRunForStage, type StageRun } from "./run-observability.js";
import { initialVersionApplicationRequestState, requirementApplicationContext, versionApplicationRequestReducer, versionApplicationView } from "./version-application-view.js";
import { workflowSteps } from "./workflow-view.js";

export type ApplicationStatus = "awaiting_merge" | "awaiting_local_resolution" | "manual_resolution_required" | "merge_test_failed";
export type DetailStatus = WorkflowStatus | ApplicationStatus;
export type Detail = Omit<Requirement, "status"> & {
  status: DetailStatus;
  projectId?: string;
  projectName?: string;
  primaryProjectId?: string;
  primaryProjectName?: string;
  projects?: Association[];
  projectSnapshot?: any;
  deliveryUnits?: DeliveryUnitView[];
  deliveryDependencies?: DeliveryDependencyView[];
  version?: number;
  clarifications?: string;
  artifacts: any[];
  approvals: any[];
  executions?: any[];
  revisions?: any[];
  runs?: StageRun[];
  codingEvidence?: any;
  reworkContext?: any;
  integrationRun?: any;
  knowledgeChanges?: any;
};

type RequirementDetailProps = {
  item: Detail;
  onRun: () => void;
  onViewRun: (run: StageRun) => void;
  onEdit: () => void;
  onApprove: () => void;
  onIntegrate: () => void;
  onRefresh: () => Promise<void>;
  onManageProjects: () => void;
};

const applicationStatusLabels: Record<ApplicationStatus, string> = {
  awaiting_merge: "待应用",
  awaiting_local_resolution: "等待本地处理",
  manual_resolution_required: "需要人工处理",
  merge_test_failed: "应用后测试失败"
};

export function Status({ status }: { status: DetailStatus }) {
  return <span className={`status ${status}`}>{status in applicationStatusLabels
    ? applicationStatusLabels[status as ApplicationStatus]
    : statusLabels[status as WorkflowStatus]}</span>;
}

export function priority(value: string) {
  return ({ low: "低", medium: "中", high: "高", urgent: "紧急" } as Record<string, string>)[value] || value;
}

export function RequirementDetail({ item, onRun, onViewRun, onEdit, onApprove, onIntegrate, onRefresh, onManageProjects }: RequirementDetailProps) {
  const [viewStage, setViewStage] = useState<WorkflowStage>(item.stage);
  useEffect(() => setViewStage(item.stage), [item.id, item.stage]);
  const latest = item.artifacts.find((artifact: any) => artifact.stage === viewStage);
  const stageRun = latestRunForStage(item.runs, viewStage);
  const gate = latestGateForStage(item.approvals, viewStage);
  const needsRequirementCorrection = item.status === "returned";
  const isCurrentView = viewStage === item.stage;
  const aiStage = item.stage === "definition" || item.stage === "solution_design";
  const canRun = isCurrentView && aiStage && item.status === "ai_ready";
  const canApprove = isCurrentView && aiStage && item.status === "awaiting_approval";
  const projects = item.projects || [];
  const deliveryPlanFrozen = isRequirementDeliveryPlanFrozen(item.projectSnapshot, item.deliveryUnits);
  const steps = workflowSteps();
  const showsDeliveryMatrix = ["implementation", "quality_verification", "acceptance_delivery"].includes(viewStage);

  return <div className="content detail">
    <div className="timeline">{workflowStages.map((stage, index) => <button type="button" onClick={() => setViewStage(stage)} className={`step ${stage === item.stage ? "current" : workflowStages.indexOf(item.stage) > index ? "done" : ""} ${stage === viewStage ? "selected" : ""}`} key={stage}><span>{workflowStages.indexOf(item.stage) > index ? <Check size={14}/> : index + 1}</span><small>{steps[index]}</small></button>)}</div>
    <div className="detail-grid"><section className="section"><div className="section-head"><div><h2>{stageLabels[viewStage]}</h2><p>当前需求版本 v{item.version || 1} · {isCurrentView ? "当前阶段成果与人工门禁" : "历史阶段产物"}</p></div>{isCurrentView && item.status === "ai_running" && stageRun ? <button className="run-status-button" onClick={() => onViewRun(stageRun)} title="查看 AI 执行详情"><Status status={item.status}/></button> : isCurrentView ? <Status status={item.status}/> : <span className="status">历史</span>}</div>
      <PlannedDelivery items={projects} stage={viewStage}/>
      {showsDeliveryMatrix && <DeliveryMatrix units={item.deliveryUnits || []} dependencies={item.deliveryDependencies || []} projects={projects.map((project) => ({ ...project, projectName: project.projectName || project.projectId }))}/>}
      {viewStage === "acceptance_delivery" ? <IntegrationPanel item={item} current={isCurrentView} onIntegrate={onIntegrate} onRefresh={onRefresh}/> : isCurrentView && item.status === "ai_running" && stageRun ? <InlineRunStream initialRun={stageRun} onOpenDetails={() => onViewRun(stageRun)} onTerminal={onRefresh}/> : <>{isCurrentView && item.reworkContext?.targetStage === viewStage && <ReworkPanel context={item.reworkContext}/>} {gate && <GateNotice gate={gate}/>} {item.codingEvidence && ["implementation", "quality_verification", "acceptance_delivery"].includes(viewStage) && <CodingEvidence evidence={item.codingEvidence}/>} {latest ? <Artifact artifact={latest}/> : <div className="empty compact"><Bot size={30}/><b>{isCurrentView ? "等待阶段结果" : "该阶段暂无产物"}</b><span>{isCurrentView ? "当前阶段尚无成果" : "返回当前节点继续处理"}</span></div>}{viewStage === "implementation" && item.executions?.[0] && <ExecutionResult execution={item.executions[0]}/>}</>}
    </section><aside className="action-panel"><h3>{isCurrentView ? "下一步" : "阶段记录"}</h3><p>{isCurrentView ? (item.status === "awaiting_approval" ? "检查 AI 结论、风险和证据后作出决定。" : "确认上下文后手动启动本阶段 AI。") : `正在查看${stageLabels[viewStage]}的历史产物，不会改变当前流程。`}</p>
      {stageRun && <button className="secondary wide view-run" onClick={() => onViewRun(stageRun)}><RefreshCw size={16}/>查看{stageRun.status === "running" ? "实时执行" : "执行记录"}</button>}{canApprove ? <button className="primary wide" onClick={onApprove}><ShieldCheck size={17}/>人工审批</button> : isCurrentView && needsRequirementCorrection ? <button className="primary wide" onClick={onEdit}><FileText size={17}/>纠正需求</button> : canRun ? <button className="primary wide" onClick={onRun}><Play size={17}/>启动 AI</button> : null}
      <RequirementProjectSummary items={projects} snapshot={item.projectSnapshot} frozen={deliveryPlanFrozen} onManage={onManageProjects}/><KnowledgeChanges changes={item.knowledgeChanges}/><dl><div><dt>优先级</dt><dd>{priority(item.priority)}</dd></div><div><dt>产物版本</dt><dd>{item.artifacts.length}</dd></div></dl></aside></div>
  </div>;
}

function KnowledgeChanges({ changes }: any) { if (!changes) return null; const labels: any = { candidate: "候选", published: "已发布", review: "待人工", conflict: "冲突" }; return <details className="knowledge-changes"><summary><span>知识变更</span><b>{changes.candidates?.length || 0}</b></summary><div className="knowledge-change-counts"><span>发布 {changes.publishedCount || 0}</span><span>待审 {changes.reviewCount || 0}</span><span>冲突 {changes.conflictCount || 0}</span></div>{changes.candidates?.slice(0, 12).map((entry: any) => <article key={entry.id || entry.subjectKey}><b>{entry.title}</b><span>{labels[entry.status] || entry.status} · {stageLabels[entry.sourceStage as WorkflowStage] || entry.sourceStage}</span><small>{entry.content}</small></article>)}</details>; }
function Artifact({ artifact }: any) { const content = artifact.content || {}; return <div className="artifact"><div className="artifact-top"><div><span className="eyebrow">AI 结论 · v{artifact.version}</span><h3>{artifact.title}</h3></div>{typeof content.confidence === "number" && <div className="confidence"><strong>{Math.round(content.confidence * 100)}%</strong><span>置信度</span></div>}</div><p className="summary">{content.summary || "成果已生成，可展开结构化内容检查。"}</p><div className="artifact-metrics"><span><AlertTriangle size={15}/>{content.risks?.length || 0} 项风险</span><span><Code2 size={15}/>{content.findings?.length || 0} 项发现</span><span><FileText size={15}/>证据已记录</span></div>{artifact.stage === "definition" && <ProductArtifactDetails content={content}/>}</div>; }
function ProductArtifactDetails({ content }: any) { const view = productArtifactView(content); return <div className="product-artifact-details">{view.goal && <section><b>真实业务目标</b><p>{view.goal}</p></section>}<section><b>AI 自主补全</b>{view.decisions.length ? <ul>{view.decisions.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.rationale}</span>{entry.evidence.length > 0 && <small>{entry.evidence.join(" · ")}</small>}</li>)}</ul> : <p>本次没有额外产品决策</p>}</section><section><b>依据</b>{view.evidence.length ? <ul>{view.evidence.map((entry: any) => <li key={`${entry.source}-${entry.fact}`}><strong>{entry.fact}</strong><small>{entry.source}</small></li>)}</ul> : <p>未记录项目依据</p>}</section><section><b>采用的假设</b>{view.assumptions.length ? <ul>{view.assumptions.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.rationale}</span><small>验证：{entry.validation || "后续评审"}</small></li>)}</ul> : <p>没有需要跟踪的假设</p>}</section><section className={view.blockers.length ? "blocking" : "clear"}><b>需要人工决定</b>{view.blockers.length ? <ul>{view.blockers.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.impact}</span><small>{entry.options.join(" / ")}</small></li>)}</ul> : <p>没有需要人工补充的阻塞问题</p>}</section></div>; }
function GateNotice({ gate }: any) { const reasons = gateReasons(gate); return <div className={`gate-notice ${gate.decision}`}><div><b>{gateLabel(gate.decision)}</b><span>AI 自动门禁</span></div>{reasons.length > 0 && <ul>{reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul>}</div>; }
function CodingEvidence({ evidence }: any) { const labels: any = { valid: "有效", stale: "已过期", unverifiable: "无法验证", truncated: "已截断", missing: "缺失" }; return <div className={`coding-evidence ${evidence.status}`}><div className="evidence-head"><div><span className="eyebrow">编码证据</span><h3>{labels[evidence.status] || "已记录"}</h3></div><code>{String(evidence.diffHash).slice(0, 12)}</code></div><div className="evidence-meta"><span>{evidence.fileCount} 个文件</span><span>+{evidence.additions} / -{evidence.deletions}</span><span>{evidence.branch}</span></div><small>Execution {evidence.executionId}</small><details><summary>查看证据 Git diff</summary><pre>{evidence.diff || "没有文件差异"}</pre></details></div>; }
function ReworkPanel({ context }: any) { const groups = groupReworkItems(context.items); return <div className="rework-panel"><div className="rework-head"><div><span className="eyebrow">为什么被打回</span><h3>{stageLabels[context.sourceStage as WorkflowStage]} → {stageLabels[context.targetStage as WorkflowStage]}</h3></div><span>{context.actorType === "ai_gate" ? "AI 自动门禁" : "人工审批"} · {new Date(context.decisionAt).toLocaleString()}</span></div>{context.unstructured && <p className="rework-warning">缺少结构化评审结果，以下内容来自审批意见。</p>}{groups.map(group => <details className={`rework-group ${group.severity}`} open={group.severity === "S0" || group.severity === "S1"} key={group.severity}><summary><b>{group.severity}</b><span>{group.items.length} 项本轮返工需处理</span></summary>{group.items.map((entry: any) => <article key={entry.id}><h4>{entry.title}</h4>{entry.evidence && <p><b>证据</b>{entry.evidence}</p>}{entry.impact && <p><b>影响</b>{entry.impact}</p>}{entry.recommendation && <p><b>建议</b>{entry.recommendation}</p>}</article>)}</details>)}{context.risks?.length > 0 && <details className="rework-extra"><summary>其他风险（{context.risks.length}）</summary><ul>{context.risks.map((risk: string) => <li key={risk}>{risk}</li>)}</ul></details>}{context.openQuestions?.length > 0 && <details className="rework-extra"><summary>待确认问题（{context.openQuestions.length}）</summary><ul>{context.openQuestions.map((question: string) => <li key={question}>{question}</li>)}</ul></details>}</div>; }

function ExecutionResult({ execution }: any) { const visibleEvents = (execution.events || []).filter((event: any) => event.type === "item.completed"); return <div className="execution-result"><div className="execution-head"><div><span className="eyebrow">独立 Codex 编码会话</span><h3>{execution.branch}</h3></div><StatusPill ok={execution.status === "completed"} text={execution.status === "completed" ? "执行完成" : "需要检查"}/></div>{execution.codexThreadId && <div className="codex-session"><span>会话 ID</span><code>{execution.codexThreadId}</code><small>继续执行：codex resume {execution.codexThreadId}</small></div>}<p className="execution-path">{execution.worktreePath}</p>{visibleEvents.length > 0 && <div className="event-list">{visibleEvents.map((event: any, index: number) => <div key={`${event.item?.id || index}`}><b>{eventLabel(event.item?.type)}</b><span>{event.item?.text || event.item?.command || event.item?.status || "已完成"}</span></div>)}</div>} {execution.commands?.length > 0 && <div className="command-list">{execution.commands.map((command: any, index: number) => <div key={index}><code>{command.command} {command.args.join(" ")}</code><b className={command.code === 0 ? "ok" : "failed"}>exit {command.code}</b></div>)}</div>}<details><summary>查看 Git diff</summary><pre>{execution.diff || "没有文件差异"}</pre></details></div>; }
function StatusPill({ ok, text }: { ok: boolean; text: string }) { return <span className={`status ${ok ? "ai_ready" : "returned"}`}>{text}</span>; }
function eventLabel(type: string | undefined) { return ({ agent_message: "Codex 总结", command_execution: "命令", file_change: "文件修改", reasoning: "分析" } as Record<string, string>)[type || ""] || type || "事件"; }

function IntegrationPanel({ item, current, onIntegrate, onRefresh }: { item: Detail; current: boolean; onIntegrate: () => void; onRefresh: () => Promise<void> }) {
  const target = requirementApplicationContext(item).target as Association | null;
  if (target) return <VersionIntegrationPanel item={item} target={target} current={current} onIntegrate={onIntegrate} onRefresh={onRefresh}/>;
  return <div className="integration-panel"><div className="integration-head"><div><span className="eyebrow">本地改动应用</span><h3>缺少冻结的交付版本</h3></div><span className="status blocked">已阻塞</span></div><p className="integration-error">当前需求的项目快照没有可用于本地应用的交付版本。</p></div>;
}

function VersionIntegrationPanel({ item, target, current, onIntegrate, onRefresh }: { item: Detail; target: Association; current: boolean; onIntegrate: () => void; onRefresh: () => Promise<void> }) {
  const identity = `${item.id}:${target.projectVersionId}:${item.status}`;
  const [request, dispatchRequest] = useReducer(versionApplicationRequestReducer, initialVersionApplicationRequestState);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const load = async () => {
    requestController.current?.abort();
    const controller = new AbortController(), generation = ++requestGeneration.current;
    requestController.current = controller;
    dispatchRequest({ type: "start", generation, identity });
    const patchRequest = (patch: any) => { if (requestGeneration.current === generation) dispatchRequest({ type: "patch", generation, identity, patch }); };
    try {
      const next = await api<any[]>(`/project-versions/${target.projectVersionId}/application-queue`, { signal: controller.signal });
      patchRequest({ queue: next });
      const position = next.find(entry => entry.requirementId === item.id)?.position || 0;
      if (current && item.status === "awaiting_merge" && position <= 1) {
        const response = await fetch(`/api/requirements/${item.id}/integration-check`, { signal: controller.signal }), data = await response.json();
        patchRequest({ check: data, ...(!response.ok ? { error: data.message || "预检未通过" } : {}) });
      }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) patchRequest({ error: reason instanceof Error ? reason.message : "版本应用状态读取失败" });
    } finally { patchRequest({ loading: false }); }
  };
  useEffect(() => { void load(); return () => { requestController.current?.abort(); requestGeneration.current += 1; }; }, [identity, current]);
  const visibleRequest = request.identity === identity ? request : { ...initialVersionApplicationRequestState, identity, loading: true };
  const queue = visibleRequest.queue, check = visibleRequest.check, loading = visibleRequest.loading || operationBusy, error = visibleRequest.error;
  const entry = queue.find(value => value.requirementId === item.id), owner = queue.find(value => value.owner);
  const view = versionApplicationView({ status: item.status, queuePosition: entry?.position, pendingOwner: owner?.code, preflightAllowed: check?.allowed, runStatus: item.integrationRun?.status });
  const verificationPlan = check?.plannedCommands?.length ? check : item.integrationRun?.preflight;
  const rerun = async () => { setOperationBusy(true); try { await post(`/requirements/${item.id}/integration-test`, {}); await onRefresh(); } catch (reason) { dispatchRequest({ type: "patch", generation: request.generation, identity, patch: { error: reason instanceof Error ? reason.message : "重新运行测试失败" } }); } finally { setOperationBusy(false); } };
  const recheck = async () => { setOperationBusy(true); try { await post(`/project-versions/${target.projectVersionId}/recheck`, {}); await onRefresh(); } catch (reason) { dispatchRequest({ type: "patch", generation: request.generation, identity, patch: { error: reason instanceof Error ? reason.message : "重新检测失败" } }); } finally { setOperationBusy(false); } };
  const disabledReasons = [...(entry?.position > 1 ? [`前面还有 ${entry.position - 1} 条需求等待应用`] : []), ...(check?.checks || []).filter((value: any) => !value.ok).map((value: any) => `${value.label}${value.detail ? `：${value.detail}` : ""}`), ...(!check && item.status === "awaiting_merge" && (!entry || entry.position <= 1) ? ["请先完成应用预检"] : [])];
  return <div className="integration-panel version-application"><div className="integration-head"><div><span className="eyebrow">版本工作区应用</span><h3>{!current && !item.integrationRun ? "尚未进入" : view.label}</h3></div>{current ? <Status status={item.status}/> : <span className="status">历史阶段</span>}</div>
    <div className="version-application-meta"><div><span>冻结目标版本</span><b>{target.projectVersionName || target.projectVersionId}</b><code>{target.projectVersionBranch || item.integrationRun?.targetBranch || "-"}</code></div><div><span>版本 worktree</span><code>{target.projectVersionWorktreePath || "-"}</code><small>冻结 HEAD {target.projectVersionHead?.slice(0, 12) || "-"}</small></div><div><span>需求源分支</span><code>{item.codingEvidence?.branch || item.integrationRun?.sourceBranch || `ai/${item.code}`}</code><small>{item.codingEvidence?.worktreePath || item.integrationRun?.worktreePath || "-"}</small></div><div><span>编码基线</span><code>{item.codingEvidence?.baseCommit || item.executions?.[0]?.baseCommit || "-"}</code><small>{view.queueLabel}</small></div></div>
    {(owner || entry) && <div className="version-queue-state"><span>{owner ? `待本地处理：${owner.code}` : "版本当前没有本地处理占用"}</span><b>{entry ? view.queueLabel : "不在当前应用队列"}</b></div>}
    <div className="no-push"><ShieldCheck size={17}/><span>改动保留为版本 worktree 的本地未提交变更，不会 commit，不会 push</span></div>
    {verificationPlan?.plannedCommands?.length > 0 && <div className="verification-plan"><div><b>应用后测试</b><span>{verificationPlan.changedModules?.join("、") || "项目根目录"}</span></div>{verificationPlan.plannedCommands.map((command: any, index: number) => <code key={index}>{command.command} {(command.argsPrefix || []).join(" ")}</code>)}</div>}
    {check?.checks?.length > 0 && <div className="integration-checks">{check.checks.map((value: any) => <div className={value.ok ? "ok" : "failed"} key={value.id}><b>{value.ok ? "通过" : "未通过"}</b><span>{value.label}<small>{value.detail}</small></span></div>)}</div>}
    {error && <p className="integration-error" role="alert">{error}</p>}{item.integrationRun && <IntegrationRunResult run={item.integrationRun}/>}
    {current && (view.showPreflight || view.showApply || view.showRerunTests || view.showRecheck) && <div className="integration-actions">{view.showPreflight && <button className="secondary" onClick={load} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16}/>重新检查</button>}{view.showApply && <button className="primary" onClick={onIntegrate} disabled={!view.canApply || loading} title={disabledReasons.join("；")}><Check size={16}/>应用到版本工作区</button>}{view.showRerunTests && <button className="primary" onClick={rerun} disabled={loading}><TestTube2 size={16}/>重新运行应用后测试</button>}{view.showRecheck && <button className="primary" onClick={recheck} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16}/>重新检测本地处理结果</button>}</div>}
    {current && view.showApply && !view.canApply && disabledReasons.length > 0 && <ul className="integration-disabled-reasons">{disabledReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
  </div>;
}

function IntegrationRunResult({ run }: any) { const worktreeMode = ["worktree", "version_worktree"].includes(run.preflight?.applicationMode), conflictFiles = run.preflight?.conflictFiles || []; return <div className={`integration-result ${run.status}`}><b>最近本地应用：{run.status}</b>{run.sourceCommit && <p>源 worktree 提交 <code>{run.sourceCommit}</code></p>}{(run.preApplyHead || run.targetCommit) && <p>应用前版本提交 <code>{run.preApplyHead || run.targetCommit}</code></p>}{run.status === "conflict" && <div className="integration-conflicts"><b>与目标分支存在冲突，目标工作树已恢复</b>{conflictFiles.length > 0 && <ul>{conflictFiles.map((file: string) => <li key={file}><code>{file}</code></li>)}</ul>}</div>}{worktreeMode && run.status !== "conflict" && <p>改动保留在版本 worktree。检查后由你手动提交或撤销。</p>}{run.error && <details><summary>查看 Git 错误</summary><pre>{run.error}</pre></details>}{run.commandResults?.map((result: any, index: number) => <details key={index}><summary><code>{result.command} {(result.args || []).join(" ")}</code> · exit {result.code}</summary><pre>{result.stdout || result.stderr || "没有输出"}</pre></details>)}</div>; }
