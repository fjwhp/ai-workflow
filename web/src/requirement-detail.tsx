import { useEffect, useRef, useState, type ComponentProps } from "react";
import { AlertTriangle, Bot, Check, Code2, FileText, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { stageLabels, workflowStages, type Requirement, type WorkflowStage, type WorkflowStatus } from "@ai-workflow/shared";
import { DeliveryMatrix, type DeliveryDependencyView, type DeliveryMatrixActionRequest, type DeliveryUnitView } from "./delivery-matrix.js";
import { gateLabel, gateReasons, latestGateForStage } from "./gate-view.js";
import { InlineRunStream } from "./inline-run-stream.js";
import { productArtifactView } from "./product-artifact-view.js";
import { isRequirementDeliveryPlanFrozen, PlannedDelivery, RequirementProjectSummary, type Association } from "./requirement-projects.js";
import { groupReworkItems } from "./rework-view.js";
import { latestRunForStage, type StageRun } from "./run-observability.js";
import { workflowSteps } from "./workflow-view.js";
import { requirementStatusLabel } from "./workflow-presentation.js";
import { subscribeDeliveryLiveRefresh } from "./delivery-live-refresh.js";

export type Detail = Requirement & {
  projectId?: string;
  projectName?: string;
  primaryProjectId?: string;
  primaryProjectName?: string;
  projects?: Association[];
  projectSnapshot?: any;
  deliveryUnits?: DeliveryUnitView[];
  deliveryDependencies?: DeliveryDependencyView[];
  automation?: ComponentProps<typeof DeliveryMatrix>["automation"];
  version?: number;
  clarifications?: string;
  artifacts: any[];
  approvals: any[];
  revisions?: any[];
  runs?: StageRun[];
  reworkContext?: any;
  knowledgeChanges?: any;
};

type RequirementDetailProps = {
  item: Detail;
  onRun: () => void;
  onViewRun: (run: StageRun) => void;
  onEdit: () => void;
  onApprove: () => void;
  onRefresh: () => Promise<void>;
  onManageProjects: () => void;
  onDeliveryAction?: (request: DeliveryMatrixActionRequest) => Promise<void>;
  onDeliveryRefreshError?: (error: unknown) => void;
};

export function Status({ stage, status }: { stage: WorkflowStage; status: WorkflowStatus }) {
  return <span className={`status ${status}`}>{requirementStatusLabel(stage, status)}</span>;
}

export function priority(value: string) {
  return ({ low: "低", medium: "中", high: "高", urgent: "紧急" } as Record<string, string>)[value] || value;
}

export function RequirementDetail({ item, onRun, onViewRun, onEdit, onApprove, onRefresh, onManageProjects,
  onDeliveryAction, onDeliveryRefreshError }: RequirementDetailProps) {
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
  const hasLiveDelivery = ["implementation", "quality_verification", "acceptance_delivery"].includes(item.stage)
    && (item.deliveryUnits || []).some((unit) =>
      unit.status !== "applied" && unit.status !== "skipped");
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => {
    if (!hasLiveDelivery) return;
    return subscribeDeliveryLiveRefresh({ requirementId: item.id, refresh: () => refreshRef.current() });
  }, [hasLiveDelivery, item.id]);

  return <div className="content detail">
    <div className="timeline">{workflowStages.map((stage, index) => <button type="button" onClick={() => setViewStage(stage)} className={`step ${stage === item.stage ? "current" : workflowStages.indexOf(item.stage) > index ? "done" : ""} ${stage === viewStage ? "selected" : ""}`} key={stage}><span>{workflowStages.indexOf(item.stage) > index ? <Check size={14}/> : index + 1}</span><small>{steps[index]}</small></button>)}</div>
    <div className="detail-grid"><section className="section"><div className="section-head"><div><h2>{stageLabels[viewStage]}</h2><p>当前需求版本 v{item.version || 1} · {isCurrentView ? (aiStage ? "当前阶段成果与人工门禁" : "项目交付进度") : "历史阶段产物"}</p></div>{isCurrentView && aiStage && item.status === "ai_running" && stageRun ? <button className="run-status-button" onClick={() => onViewRun(stageRun)} title="查看 AI 执行详情"><Status stage={item.stage} status={item.status}/></button> : isCurrentView ? <Status stage={item.stage} status={item.status}/> : <span className="status">历史</span>}</div>
      <PlannedDelivery items={projects} stage={viewStage}/>
      {showsDeliveryMatrix && <DeliveryMatrix
        units={item.deliveryUnits || []}
        dependencies={item.deliveryDependencies || []}
        projects={projects.map((project) => ({ ...project, projectName: project.projectName || project.projectId }))}
        automation={item.automation}
        onAction={isCurrentView ? onDeliveryAction : undefined}
        onActionRefresh={onRefresh}
        onActionRefreshError={onDeliveryRefreshError}/>}
      {isCurrentView && aiStage && item.status === "ai_running" && stageRun ? <InlineRunStream initialRun={stageRun} onOpenDetails={() => onViewRun(stageRun)} onTerminal={onRefresh}/> : <>{isCurrentView && item.reworkContext?.targetStage === viewStage && <ReworkPanel context={item.reworkContext}/>} {gate && <GateNotice gate={gate}/>} {latest ? <Artifact artifact={latest}/> : <div className="empty compact"><Bot size={30}/><b>{isCurrentView ? "等待阶段结果" : "该阶段暂无产物"}</b><span>{isCurrentView ? "当前阶段尚无成果" : "返回当前节点继续处理"}</span></div>}</>}
    </section><aside className="action-panel"><h3>{isCurrentView ? "下一步" : "阶段记录"}</h3><p>{isCurrentView ? (!aiStage ? (item.automation?.status === "paused" ? "交付自动化已暂停。" : "交付自动化正在运行。") : item.status === "awaiting_approval" ? "检查 AI 结论、风险和证据后作出决定。" : "确认上下文后手动启动本阶段 AI。") : `正在查看${stageLabels[viewStage]}的历史产物，不会改变当前流程。`}</p>
      {aiStage && stageRun && <button className="secondary wide view-run" onClick={() => onViewRun(stageRun)}><RefreshCw size={16}/>查看{stageRun.status === "running" ? "实时执行" : "执行记录"}</button>}{canApprove ? <button className="primary wide" onClick={onApprove}><ShieldCheck size={17}/>人工审批</button> : isCurrentView && aiStage && needsRequirementCorrection ? <button className="primary wide" onClick={onEdit}><FileText size={17}/>纠正需求</button> : canRun ? <button className="primary wide" onClick={onRun}><Play size={17}/>启动 AI</button> : null}
      <RequirementProjectSummary items={projects} snapshot={item.projectSnapshot} frozen={deliveryPlanFrozen} onManage={onManageProjects}/><KnowledgeChanges changes={item.knowledgeChanges}/><dl><div><dt>优先级</dt><dd>{priority(item.priority)}</dd></div><div><dt>产物版本</dt><dd>{item.artifacts.length}</dd></div></dl></aside></div>
  </div>;
}

function KnowledgeChanges({ changes }: any) { if (!changes) return null; const labels: any = { candidate: "候选", published: "已发布", review: "待人工", conflict: "冲突" }; return <details className="knowledge-changes"><summary><span>知识变更</span><b>{changes.candidates?.length || 0}</b></summary><div className="knowledge-change-counts"><span>发布 {changes.publishedCount || 0}</span><span>待审 {changes.reviewCount || 0}</span><span>冲突 {changes.conflictCount || 0}</span></div>{changes.candidates?.slice(0, 12).map((entry: any) => <article key={entry.id || entry.subjectKey}><b>{entry.title}</b><span>{labels[entry.status] || entry.status} · {stageLabels[entry.sourceStage as WorkflowStage] || entry.sourceStage}</span><small>{entry.content}</small></article>)}</details>; }
function Artifact({ artifact }: any) { const content = artifact.content || {}; return <div className="artifact"><div className="artifact-top"><div><span className="eyebrow">AI 结论 · v{artifact.version}</span><h3>{artifact.title}</h3></div>{typeof content.confidence === "number" && <div className="confidence"><strong>{Math.round(content.confidence * 100)}%</strong><span>置信度</span></div>}</div><p className="summary">{content.summary || "成果已生成，可展开结构化内容检查。"}</p><div className="artifact-metrics"><span><AlertTriangle size={15}/>{content.risks?.length || 0} 项风险</span><span><Code2 size={15}/>{content.findings?.length || 0} 项发现</span><span><FileText size={15}/>证据已记录</span></div>{artifact.stage === "definition" && <ProductArtifactDetails content={content}/>}</div>; }
function ProductArtifactDetails({ content }: any) { const view = productArtifactView(content); return <div className="product-artifact-details">{view.goal && <section><b>真实业务目标</b><p>{view.goal}</p></section>}<section><b>AI 自主补全</b>{view.decisions.length ? <ul>{view.decisions.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.rationale}</span>{entry.evidence.length > 0 && <small>{entry.evidence.join(" · ")}</small>}</li>)}</ul> : <p>本次没有额外产品决策</p>}</section><section><b>依据</b>{view.evidence.length ? <ul>{view.evidence.map((entry: any) => <li key={`${entry.source}-${entry.fact}`}><strong>{entry.fact}</strong><small>{entry.source}</small></li>)}</ul> : <p>未记录项目依据</p>}</section><section><b>采用的假设</b>{view.assumptions.length ? <ul>{view.assumptions.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.rationale}</span><small>验证：{entry.validation || "后续评审"}</small></li>)}</ul> : <p>没有需要跟踪的假设</p>}</section><section className={view.blockers.length ? "blocking" : "clear"}><b>需要人工决定</b>{view.blockers.length ? <ul>{view.blockers.map((entry: any) => <li key={entry.title}><strong>{entry.title}</strong><span>{entry.impact}</span><small>{entry.options.join(" / ")}</small></li>)}</ul> : <p>没有需要人工补充的阻塞问题</p>}</section></div>; }
function GateNotice({ gate }: any) { const reasons = gateReasons(gate); return <div className={`gate-notice ${gate.decision}`}><div><b>{gateLabel(gate.decision)}</b><span>AI 自动门禁</span></div>{reasons.length > 0 && <ul>{reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul>}</div>; }
function ReworkPanel({ context }: any) { const groups = groupReworkItems(context.items); return <div className="rework-panel"><div className="rework-head"><div><span className="eyebrow">为什么被打回</span><h3>{stageLabels[context.sourceStage as WorkflowStage]} → {stageLabels[context.targetStage as WorkflowStage]}</h3></div><span>{context.actorType === "ai_gate" ? "AI 自动门禁" : "人工审批"} · {new Date(context.decisionAt).toLocaleString()}</span></div>{context.unstructured && <p className="rework-warning">缺少结构化评审结果，以下内容来自审批意见。</p>}{groups.map(group => <details className={`rework-group ${group.severity}`} open={group.severity === "S0" || group.severity === "S1"} key={group.severity}><summary><b>{group.severity}</b><span>{group.items.length} 项本轮返工需处理</span></summary>{group.items.map((entry: any) => <article key={entry.id}><h4>{entry.title}</h4>{entry.evidence && <p><b>证据</b>{entry.evidence}</p>}{entry.impact && <p><b>影响</b>{entry.impact}</p>}{entry.recommendation && <p><b>建议</b>{entry.recommendation}</p>}</article>)}</details>)}{context.risks?.length > 0 && <details className="rework-extra"><summary>其他风险（{context.risks.length}）</summary><ul>{context.risks.map((risk: string) => <li key={risk}>{risk}</li>)}</ul></details>}{context.openQuestions?.length > 0 && <details className="rework-extra"><summary>待确认问题（{context.openQuestions.length}）</summary><ul>{context.openQuestions.map((question: string) => <li key={question}>{question}</li>)}</ul></details>}</div>; }
