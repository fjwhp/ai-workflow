import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Bot, ChevronRight, CircleDot, ClipboardCheck, FileText, FolderGit2, LayoutDashboard, ListTodo, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCw, Settings, ShieldCheck, TestTube2, X } from "lucide-react";
import { returnStage, stageLabels, type GateConfig, type Requirement, type WorkflowStage, type WorkflowStatus } from "@ai-workflow/shared";
import { api, patch, post } from "./api.js";
import { groupRequirements } from "./dashboard.js";
import "./styles.css";
import "./associations.css";
import "./execution.css";
import "./run-observability.css";
import { displayRunEvents, eventLabel as runEventLabel, isTerminalRun, mergeRunEvents, type StageRun } from "./run-observability.js";
import { filterRequirements, navigationTarget, type QueueFilter } from "./navigation-view.js";
import { ProjectManagement } from "./project-management.js";
import { navigateToProjectVersionSection } from "./project-versions.js";
import { isRequirementDeliveryPlanFrozen, RequirementProjectsDialog } from "./requirement-projects.js";
import { DetailRequestTracker } from "./detail-requests.js";
import { NewRequirement } from "./new-requirement.js";
import { RequirementDetail, type Detail } from "./requirement-detail.js";
import { MandatoryHumanStageSettings } from "./gate-settings.js";
import { requirementStatusLabel } from "./workflow-presentation.js";
import { acceptanceDeliveryRequest, deliveryActionRequest } from "./delivery-unit-view.js";
import type { ApplicationRunsResponse } from "./acceptance-delivery-panel.js";

type Page = "dashboard" | "requirements" | "projects" | "settings";

function App() {
  const [items, setItems] = useState<Requirement[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [page, setPage] = useState<Page>("dashboard");
  const [modal, setModal] = useState<"new" | "edit" | "run" | "approve" | "associations" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runView, setRunView] = useState<StageRun | null>(null);
  const [queueFilter,setQueueFilter]=useState<QueueFilter|null>(null);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>localStorage.getItem("flowgate.sidebarCollapsed")==="1");
  const detailRequests=useRef(new DetailRequestTracker()),desiredRequirementId=useRef<string|null>(null);
  const queues = useMemo(() => groupRequirements(items), [items]);
  const visibleItems=useMemo(()=>filterRequirements(items,queueFilter),[items,queueFilter]);
  const loadDetail = async (id: string) => { const [detail, associations] = await Promise.all([api<Detail>(`/requirements/${id}`), api<any>(`/requirements/${id}/projects`)]); return { ...detail, projects: associations.projects, projectSnapshot: associations.snapshot }; };
  const refresh = async () => { const data = await api<Requirement[]>("/requirements"); setItems(data); const id=desiredRequirementId.current;if(id){const token=detailRequests.current.begin(id),detail=await loadDetail(id);if(detailRequests.current.accept(token,desiredRequirementId.current))setSelected(detail);} };
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  const open = async (item: Requirement) => { desiredRequirementId.current=item.id;const token=detailRequests.current.begin(item.id);setPage("requirements");const detail=await loadDetail(item.id);if(detailRequests.current.accept(token,desiredRequirementId.current))setSelected(detail); };
  const navigate=(next:Page,filter:QueueFilter|null=null)=>{const target=navigationTarget(next,filter);desiredRequirementId.current=null;detailRequests.current.clear();setPage(target.page);setSelected(null);setQueueFilter(target.queueFilter)};
  const selectQueue=(filter:QueueFilter)=>navigate("requirements",filter);
  const toggleSidebar=()=>setSidebarCollapsed(value=>{const next=!value;localStorage.setItem("flowgate.sidebarCollapsed",next?"1":"0");return next});

  return <div className={sidebarCollapsed?"app-shell sidebar-collapsed":"app-shell"}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><CircleDot size={20}/></div><div><strong>Flowgate</strong><small>AI 研发工作台</small></div><button className="sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed?"展开左侧菜单":"收起左侧菜单"} title={sidebarCollapsed?"展开左侧菜单":"收起左侧菜单"}>{sidebarCollapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button></div>
      <nav>
        <Nav icon={<LayoutDashboard/>} label="工作台" active={page === "dashboard"&&!selected} onClick={() => navigate("dashboard")}/>
        <Nav icon={<ListTodo/>} label="需求" active={page === "requirements"&&!selected} onClick={() => navigate("requirements")}/>
        <Nav icon={<FolderGit2/>} label="项目" active={page === "projects"} onClick={() => navigate("projects")}/>
      </nav>
      <div className="queue-nav"><span>我的工作</span>
        <Queue label="待人工审批" count={queues.approvals.length} active={queueFilter==="approvals"} onClick={()=>selectQueue("approvals")}/><Queue label="AI 待启动" count={queues.ready.length} active={queueFilter==="ready"} onClick={()=>selectQueue("ready")}/><Queue label="AI 执行中" count={queues.running.length} active={queueFilter==="running"} onClick={()=>selectQueue("running")}/><Queue label="交付自动化" count={queues.automation.length} active={queueFilter==="automation"} onClick={()=>selectQueue("automation")}/><Queue label="已阻塞" count={queues.blocked.length} active={queueFilter==="blocked"} onClick={()=>selectQueue("blocked")}/>
      </div>
      <button className="nav-bottom" title="设置" onClick={() => navigate("settings")}><Settings size={17}/><span>设置</span></button>
    </aside>
    <main>
      <header><div><h1>{selected ? selected.title : pageTitle(page)}</h1><p>{selected ? `${selected.code} · ${stageLabels[selected.stage]}` : pageSubtitle(page)}</p></div>
        <button className="primary" onClick={() => setModal("new")}><Plus size={17}/>新建需求</button></header>
      {error && <div className="alert"><AlertTriangle size={18}/>{error}<button onClick={() => setError("")}><X size={16}/></button></div>}
      {selected ? <RequirementDetail item={selected} onRun={() => setModal("run")} onViewRun={setRunView} onEdit={() => setModal("edit")} onApprove={() => setModal("approve")} onRefresh={refresh} onManageProjects={() => setModal("associations")} onDeliveryAction={async (request) => {
        const action = deliveryActionRequest(selected.id, request);
        await post(action.path, action.body);
      }} onAcceptDelivery={async (comment) => {
        const action = acceptanceDeliveryRequest(selected.id, { type: "accept_delivery", comment });
        await post(action.path, action.body);
      }} onApplicationRetry={async (unitId, reason) => {
        const action = acceptanceDeliveryRequest(selected.id, { type: "retry_application", unitId, reason });
        await post(action.path, action.body);
      }} onLoadApplicationRuns={(unitId) => api<ApplicationRunsResponse>(
        `/delivery-units/${unitId}/application-runs`
      )} onDeliveryRefreshError={() => setError("数据刷新失败，请重新打开需求")}/> :
       page === "projects" ? <ProjectManagement/> : page === "settings" ? <SettingsPage/> : <Dashboard items={visibleItems} queues={queues} queueFilter={queueFilter} onQueue={selectQueue} onClearFilter={()=>setQueueFilter(null)} onOpen={open}/>}
    </main>
    {modal === "new" && <NewRequirement
      onClose={() => setModal(null)}
      onProjects={() => { setModal(null); navigate("projects"); }}
      onCreateVersion={(projectId) => { setModal(null); navigate("projects"); navigateToProjectVersionSection(projectId); }}
      onCreated={async (created) => { setModal(null); await refresh(); await open(created); }}
    />}
    {modal === "edit" && selected && <EditRequirement
      item={selected}
      onClose={() => setModal(null)}
      onDone={async () => { setModal(null); await refresh(); }}
    />}
    {modal === "run" && selected && <RunModal item={selected} busy={busy} onClose={() => setModal(null)} onRun={async () => { setBusy(true); setError(""); try { const run=await post<StageRun>(`/requirements/${selected.id}/run`, { context: "使用当前已批准材料" }); setModal(null); setRunView(run); await refresh(); } catch(e:any){ setError(e.message); setModal(null); await refresh(); } finally { setBusy(false); } }}/>}
    {modal === "approve" && selected && <ApprovalModal item={selected} onClose={() => setModal(null)} onSubmit={async (body: Record<string, unknown>) => { await post(`/requirements/${selected.id}/approve`, body); setModal(null); await refresh(); }}/>}
    {modal === "associations" && selected && <RequirementProjectsDialog requirementId={selected.id} deliveryPlanFrozen={isRequirementDeliveryPlanFrozen(selected.projectSnapshot,selected.deliveryUnits)} onClose={() => setModal(null)} onSaved={refresh} onRefreshError={() => setError("数据已保存，但刷新失败，请重新打开需求")}/>}
    {runView && <RunDetailsModal initialRun={runView} onClose={() => setRunView(null)} onTerminal={refresh}/>}
  </div>;
}

function Nav({icon,label,active,onClick}:any){return <button className={active?"nav active":"nav"} title={label} aria-label={label} onClick={onClick}>{React.cloneElement(icon,{size:18})}<span>{label}</span></button>}
function Queue({label,count,active,onClick}:{label:string,count:number,active:boolean,onClick:()=>void}){return <button className={active?"queue active":"queue"} onClick={onClick}><span>{label}</span><b>{count}</b></button>}

export function Dashboard({items,queues,queueFilter,onQueue,onClearFilter,onOpen}:any){const filterLabels:any={approvals:"待人工审批",ready:"AI 待启动",running:"AI 执行中",automation:"交付自动化",blocked:"已阻塞"};return <div className="content"><section className="stats">
  <Stat label="待人工审批" value={queues.approvals.length} tone="amber" icon={<ClipboardCheck/>} active={queueFilter==="approvals"} onClick={()=>onQueue("approvals")}/><Stat label="AI 待启动" value={queues.ready.length} tone="green" icon={<Bot/>} active={queueFilter==="ready"} onClick={()=>onQueue("ready")}/><Stat label="AI 执行中" value={queues.running.length} tone="blue" icon={<RefreshCw/>} active={queueFilter==="running"} onClick={()=>onQueue("running")}/><Stat label="交付自动化" value={queues.automation.length} tone="blue" icon={<RefreshCw/>} active={queueFilter==="automation"} onClick={()=>onQueue("automation")}/><Stat label="已阻塞" value={queues.blocked.length} tone="red" icon={<AlertTriangle/>} active={queueFilter==="blocked"} onClick={()=>onQueue("blocked")}/>
  </section><section className="section"><div className="section-head"><div><h2>{queueFilter?filterLabels[queueFilter]:"近期需求"}</h2><p>{queueFilter?`筛选结果 ${items.length} 条`:"按更新时间查看当前工作流"}</p></div>{queueFilter&&<button className="secondary" onClick={onClearFilter}>清除筛选</button>}</div>
  <div className="table"><div className="table-row table-header"><span>需求</span><span>当前阶段</span><span>状态</span><span>优先级</span><span></span></div>
  {items.length ? items.map((r:Requirement)=><button className="table-row" key={r.id} onClick={()=>onOpen(r)}><span><b>{r.title}</b><small>{r.code}</small></span><span>{stageLabels[r.stage]}</span><span><Status stage={r.stage} status={r.status}/></span><span>{priority(r.priority)}</span><ChevronRight size={17}/></button>) : <Empty/>}</div></section></div>}
function Stat({label,value,tone,icon,active,onClick}:any){return <button className={active?"stat active":"stat"} onClick={onClick}><div className={`stat-icon ${tone}`}>{React.cloneElement(icon,{size:19})}</div><div><strong>{value}</strong><span>{label}</span></div></button>}
function Status({stage,status}:{stage:WorkflowStage,status:WorkflowStatus}){return <span className={`status ${status}`}>{requirementStatusLabel(stage,status)}</span>}
function Empty(){return <div className="empty"><FileText size={30}/><b>还没有需求</b><span>从新建需求开始第一条 AI 工作流</span></div>}

function EditRequirement({item,onClose,onDone}:{item:Detail,onClose:()=>void,onDone:()=>void}){const latest=item.artifacts[0]?.content;const [f,setF]=useState({title:item.title,businessProblem:item.businessProblem,expectedOutcome:item.expectedOutcome,priority:item.priority,clarifications:item.clarifications||"",changeSummary:"根据打回意见补充需求"});const [err,setErr]=useState("");return <Modal title="纠正需求" subtitle={`保存后生成 v${(item.version||1)+1}，旧版本和打回记录会保留`} onClose={onClose}>{latest?.openQuestions?.length>0&&<div className="clarification-questions"><b>AI 待确认问题</b><ul>{latest.openQuestions.slice(0,8).map((q:string)=><li key={q}>{q}</li>)}</ul></div>}<form onSubmit={async e=>{e.preventDefault();try{await patch(`/requirements/${item.id}`,f);onDone()}catch(x:any){setErr(x.message)}}}><Label text="需求标题"><input value={f.title} onChange={e=>setF({...f,title:e.target.value})}/></Label><Label text="业务背景与当前问题"><textarea value={f.businessProblem} onChange={e=>setF({...f,businessProblem:e.target.value})}/></Label><Label text="期望业务结果与验收规则"><textarea value={f.expectedOutcome} onChange={e=>setF({...f,expectedOutcome:e.target.value})}/></Label><Label text="针对打回问题的澄清"><textarea value={f.clarifications} onChange={e=>setF({...f,clarifications:e.target.value})} placeholder="逐条回答 AI 的待确认问题，并写清规则、范围、异常和兼容策略"/></Label><Label text="本次修改说明"><input value={f.changeSummary} onChange={e=>setF({...f,changeSummary:e.target.value})}/></Label><Label text="优先级"><select value={f.priority} onChange={e=>setF({...f,priority:e.target.value as Detail["priority"]})}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option></select></Label>{err&&<p className="form-error">{err}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存 v{(item.version||1)+1}</button></div></form></Modal>}

function RunModal({item,busy,onClose,onRun}:{item:Detail,busy:boolean,onClose:()=>void,onRun:()=>void}){return <Modal title={`启动 ${stageLabels[item.stage]} AI`} subtitle="确认后才会发送上下文并产生 API 调用" onClose={onClose}><div className="context-box"><div><b>模型</b><span>OPENAI_MODEL（服务端配置）</span></div><div><b>发送内容</b><span>需求字段、当前阶段、已批准产物</span></div><div><b>本地操作</b><span>不修改项目源码</span></div><div><b>不会执行</b><span>自动提交、合并、推送；读取 .env、密钥和 Git 内部文件</span></div></div><div className="notice"><ShieldCheck size={18}/><span>本次运行结果将保存为不可覆盖的新版本。</span></div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={onRun} disabled={busy}>{busy?<RefreshCw className="spin" size={17}/>:<Play size={17}/>}确认并运行</button></div></Modal>}

function ApprovalModal({item,onClose,onSubmit}:any){const [decision,setDecision]=useState("approve"),[comment,setComment]=useState("成果和证据已检查"),[condition,setCondition]=useState("");const target=stageLabels[returnStage(item.stage as WorkflowStage)];return <Modal title="人工审批" subtitle={`你的决定将进入永久审批记录；打回目标为${target}`} onClose={onClose}><div className="segments">{[["approve","批准"],["conditional","条件批准"],["return",`打回${target}`]].map(x=><button className={decision===x[0]?"selected":""} onClick={()=>setDecision(x[0])} key={x[0]}>{x[1]}</button>)}</div><Label text="审批意见"><textarea value={comment} onChange={e=>setComment(e.target.value)}/></Label>{decision==="conditional"&&<Label text="批准条件"><textarea value={condition} onChange={e=>setCondition(e.target.value)} placeholder="条件、负责人和截止时间"/></Label>}<div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={()=>onSubmit({decision,comment,condition:condition||undefined})}>提交决定</button></div></Modal>}

function SettingsPage(){const [config,setConfig]=useState<GateConfig|null>(null),[saving,setSaving]=useState(false),[saved,setSaved]=useState("");useEffect(()=>{api<GateConfig>("/settings/gates").then(setConfig)},[]);const save=async(next:GateConfig)=>{setConfig(next);setSaving(true);setSaved("");try{setConfig(await patch<GateConfig>("/settings/gates",next));setSaved("已保存")}finally{setSaving(false)}};return <div className="content"><section className="section settings"><h2>本机设置</h2><div className="setting-row"><Bot/><div><b>OpenAI API</b><span>密钥从 OPENAI_API_KEY 环境变量读取</span></div><span className="status ai_ready">服务端检查</span></div><div className="setting-row"><ShieldCheck/><div><b>隐私与执行</b><span>仅监听 127.0.0.1，命令清单外需确认</span></div></div><div className="setting-row"><TestTube2/><div><b>数据目录</b><span>SQLite、附件和运行日志保存在本机 data/</span></div></div></section><section className="section gate-settings"><div className="section-head"><div><h2>需求 AI 自动门禁</h2><p>需求定义可按风险自动推进；方案设计固定人工审批</p></div>{saved&&<span className="status ai_ready">{saved}</span>}</div>{config?<><label className="gate-setting-row"><div><b>自动流转</b><span>关闭后需求定义也等待人工审批</span></div><input type="checkbox" checked={config.autoTransitionEnabled} disabled={saving} onChange={e=>save({...config,autoTransitionEnabled:e.target.checked})}/></label><label className="gate-setting-row"><div><b>最低置信度</b><span>需求定义低于阈值时转人工审核</span></div><input aria-label="最低置信度" type="number" min="0" max="1" step="0.05" value={config.confidenceThreshold} disabled={saving} onChange={e=>setConfig({...config,confidenceThreshold:Number(e.target.value)})} onBlur={()=>save(config)}/></label><MandatoryHumanStageSettings stages={config.mandatoryHumanStages} disabled={saving} onChange={stages=>save({...config,mandatoryHumanStages:stages})}/></>:<div className="empty compact">正在读取门禁配置</div>}</section></div>}
function RunDetailsModal({initialRun,onClose,onTerminal}:{initialRun:StageRun,onClose:()=>void,onTerminal:()=>Promise<void>}){const [run,setRun]=useState(initialRun),[events,setEvents]=useState(initialRun.events||[]),[tab,setTab]=useState<"process"|"input"|"raw"|"result">("process"),[error,setError]=useState("");useEffect(()=>{let source:EventSource|undefined;let closed=false;api<StageRun>(`/runs/${initialRun.id}`).then(snapshot=>{if(closed)return;setRun(snapshot);setEvents(snapshot.events||[]);if(!isTerminalRun(snapshot.status)){const after=(snapshot.events||[]).at(-1)?.sequence||0;source=new EventSource(`/api/runs/${snapshot.id}/events?after=${after}`);source.addEventListener("run-event",(message)=>{const event=JSON.parse((message as MessageEvent).data);setEvents(current=>mergeRunEvents(current,[event]));if(["run.completed","run.failed","run.interrupted"].includes(event.type)){source?.close();api<StageRun>(`/runs/${snapshot.id}`).then(setRun);onTerminal().catch(()=>{})}});source.onerror=()=>setError("实时连接暂时中断，正在自动重连");}}).catch(e=>setError(e.message));return()=>{closed=true;source?.close()}},[initialRun.id]);const raw=events.filter(event=>event.type==="output.delta"||event.type==="codex.event"||event.type==="diagnostic").map(event=>event.payload?.text||event.payload).map(value=>typeof value==="string"?value:JSON.stringify(value,null,2)).join("");return <div className="modal-backdrop"><div className="modal run-modal"><div className="modal-head"><div><h2>{stageLabels[run.stage]} · 执行详情</h2><p>真实输入、处理事件与输出均保存在本机</p></div><button className="icon-btn" onClick={onClose} title="关闭"><X size={19}/></button></div><div className="run-meta"><span>状态 <b>{run.status}</b></span><span>模型 <b>{run.model||"-"}</b></span><span>开始 <b>{new Date(run.createdAt).toLocaleString()}</b></span><span>事件 <b>{events.length}</b></span></div><div className="run-tabs">{[["process","执行过程"],["input","输入上下文"],["raw","原始输出"],["result","最终结果"]].map(([key,label])=><button key={key} className={tab===key?"active":""} onClick={()=>setTab(key as any)}>{label}</button>)}</div><div className="run-panel">{error&&<div className="run-error">{error}</div>}{tab==="process"?(events.length?<div className="run-events">{displayRunEvents(events).map(event=><div className="run-event" key={event.sequence}><time>{event.createdAt?new Date(event.createdAt).toLocaleTimeString():`#${event.sequence}`}</time><b>{runEventLabel(event.type)}</b><pre>{JSON.stringify(event.payload,null,2)}</pre></div>)}</div>:<div className="run-empty">等待执行事件</div>):tab==="input"?<pre className="run-json">{JSON.stringify(run.input,null,2)}</pre>:tab==="raw"?<pre className="run-json">{raw||"尚未收到模型输出"}</pre>:<>{run.error&&<div className="run-error">{run.error}</div>}<pre className="run-json">{JSON.stringify(run.output,null,2)}</pre></>}</div></div></div>}
function Modal({title,subtitle,onClose,children}:any){return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-btn" onClick={onClose} title="关闭"><X size={19}/></button></div>{children}</div></div>}
function Label({text,children}:any){return <label><span>{text}</span>{children}</label>}
function priority(p:string){return ({low:"低",medium:"中",high:"高",urgent:"紧急"} as any)[p]||p}
function pageTitle(p:Page){return p==="dashboard"?"工作台":p==="projects"?"项目配置":p==="settings"?"设置":"全部需求"}
function pageSubtitle(p:Page){return p==="dashboard"?"聚焦需要你处理的工作":p==="projects"?"管理本地仓库与允许命令":p==="settings"?"模型、数据与安全配置":"查看所有研发工作流"}

createRoot(document.getElementById("root")!).render(<App/>);
