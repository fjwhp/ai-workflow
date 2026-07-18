import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Archive, CheckCircle2, Eye, FolderGit2, Pencil, Plus, RefreshCw, RotateCw, X } from "lucide-react";
import { ApiError, api, patch, post } from "./api.js";
import { projectKnowledgeView } from "./project-knowledge-view.js";
import { AccessibleDialog } from "./accessible-dialog.js";

type ProjectStatus = "active" | "archived";
type ProjectAction = "edit" | "validate" | "rebuild" | "archive" | "view";
type AllowedCommand = { command: string; argsPrefix: string[] };
type Project = { id: string; name: string; repoPath: string; defaultBranch: string; category: string | null; technology?: string[]; packageManager?: string | null; modules?: unknown[]; status: ProjectStatus; allowedCommands?: AllowedCommand[]; sensitivePatterns?: string[] };
type Inspection = { valid: boolean; repoPath: string; defaultBranch: string; category: string; technology: string[]; packageManager: string | null; modules: { id: string; name: string; path: string }[]; warnings: string[] };
type Validation = { repoPath: string; defaultBranch: string; result: Inspection };
type Form = { name: string; repoPath: string; defaultBranch: string; category: string; allowedCommands: string; sensitivePatterns: string };

export function projectActions(status: ProjectStatus): ProjectAction[] { return status === "active" ? ["edit", "validate", "rebuild", "archive"] : ["view"]; }
export function projectValidationLabel(value: Pick<Inspection, "valid" | "technology" | "packageManager">) {
  if (!value.valid) return "验证未通过";
  const technologies = value.technology.map(item => ({ node: "Node.js", fastify: "Fastify", react: "React", typescript: "TypeScript", java: "Java", spring: "Spring" }[item.toLowerCase()] || item));
  return `验证通过${technologies.length ? ` · ${technologies.join(" / ")}` : ""}${value.packageManager ? ` · ${value.packageManager}` : ""}`;
}
export function normalizeAllowedCommands(commands: AllowedCommand[] = []) { return commands.map(item => [item.command, ...(item.argsPrefix || [])].join(" ")).join("\n"); }
export function parseAllowedCommands(value: string): { commands: AllowedCommand[]; error: string } {
  const commands: AllowedCommand[] = [];
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue;
    if (/[;&|`$<>\\"']/.test(line)) return { commands: [], error: `第 ${index + 1} 行包含不支持的 shell 符号` };
    const [command, ...argsPrefix] = line.split(/\s+/);
    if (!/^[\w./:+-]+$/.test(command)) return { commands: [], error: `第 ${index + 1} 行命令格式无效` };
    commands.push({ command, argsPrefix });
  }
  return { commands, error: "" };
}
export function filterProjects<T extends { status: ProjectStatus }>(projects: readonly T[], status: ProjectStatus) {
  const active = projects.filter(item => item.status === "active").length, archived = projects.length - active;
  return { list: projects.filter(item => item.status === status), active, archived, total: projects.length };
}
export function validationAfterChange<T>(validation: T | null, field: string, _value: string): T | null { return field === "repoPath" || field === "defaultBranch" ? null : validation; }
export function projectHealth(project: { status: ProjectStatus }, knowledge?: { status?: string } | null) {
  if (project.status === "archived") return { label: "已归档", tone: "archived" };
  if (knowledge?.status === "failed") return { label: "知识构建失败", tone: "failed" };
  if (knowledge?.status === "stale") return { label: "知识待更新", tone: "stale" };
  if (knowledge?.status === "building") return { label: "知识生成中", tone: "building" };
  return { label: "运行正常", tone: "ready" };
}
export type ProjectFieldErrors = { repoPath: string; defaultBranch: string; general: string };
export function projectFieldErrors(error: unknown): ProjectFieldErrors {
  const empty = { repoPath: "", defaultBranch: "", general: "" };
  if (!(error instanceof ApiError)) return { ...empty, general: error instanceof Error ? error.message : "请求失败" };
  if (error.code === "PROJECT_REPOSITORY_INVALID") return { repoPath: error.message, defaultBranch: error.message, general: "" };
  if (error.code === "PROJECT_REPO_PATH_EXISTS") return { repoPath: error.message, defaultBranch: "", general: "" };
  return { ...empty, general: error.message };
}
export function archiveErrorMessage(error: unknown, projectName: string) {
  return error instanceof ApiError && error.code === "PROJECT_IN_ACTIVE_DELIVERY" ? `无法归档“${projectName}”：项目正在用于活动交付，请先完成或停止相关需求。` : error instanceof Error ? error.message : "归档项目失败";
}
export type SubmissionState<T> = { form: T; submitting: boolean; error: string };
export function initialSubmissionState<T>(form: T): SubmissionState<T> { return { form, submitting: false, error: "" }; }
export function submissionReducer<T>(state: SubmissionState<T>, action: { type: "change"; form: T } | { type: "submit" } | { type: "failure"; error: string }): SubmissionState<T> {
  if (action.type === "change") return { form: action.form, submitting: state.submitting, error: "" };
  if (action.type === "submit") return { ...state, submitting: true, error: "" };
  return { ...state, submitting: false, error: action.error };
}
export function shouldStartSubmission(state: { submitting: boolean }) { return !state.submitting; }
type DetailResource = "knowledge" | "memory";
type DetailResult = { status: "fulfilled"; value: any } | { status: "rejected"; reason: string };
export type ProjectDetailsState = { generation: number; knowledge: Record<string, any>; memory: Record<string, any>; errors: Record<string, Partial<Record<DetailResource, string>>> };
export function beginProjectDetails(_state: ProjectDetailsState, generation: number, _projectIds: string[]): ProjectDetailsState {
  return { generation, knowledge: {}, memory: {}, errors: {} };
}
export function mergeProjectDetails(state: ProjectDetailsState, generation: number, projectId: string, resource: DetailResource, result: DetailResult, options: { retainRejected?: boolean } = {}): ProjectDetailsState {
  if (generation !== state.generation) return state;
  const values = { ...state[resource] }, errors = { ...state.errors }, projectErrors = { ...(errors[projectId] || {}) };
  if (result.status === "fulfilled") { values[projectId] = result.value; delete projectErrors[resource]; }
  else { if (!options.retainRejected) delete values[projectId]; projectErrors[resource] = result.reason; }
  if (Object.keys(projectErrors).length) errors[projectId] = projectErrors; else delete errors[projectId];
  return { ...state, [resource]: values, errors };
}
type ProjectOperation = "rebuild" | "archive";
const operationKey = (operation: ProjectOperation, projectId: string) => `${operation}:${projectId}`;
export function isOperationBusy(busy: ReadonlySet<string>, operation: ProjectOperation, projectId: string) { return busy.has(operationKey(operation, projectId)); }
export function addBusyOperation(busy: ReadonlySet<string>, operation: ProjectOperation, projectId: string) { const key = operationKey(operation, projectId); if (busy.has(key)) return { busy, started: false }; const next = new Set(busy); next.add(key); return { busy: next, started: true }; }
export function removeBusyOperation(busy: ReadonlySet<string>, operation: ProjectOperation, projectId: string) { const next = new Set(busy); next.delete(operationKey(operation, projectId)); return next; }
export function nextFocusIndex(current: number, count: number, backwards: boolean) { if (count <= 0) return -1; return (current + (backwards ? -1 : 1) + count) % count; }
export function canCloseDialog(key: string, busy: boolean) { return key === "Escape" && !busy; }

const emptyForm: Form = { name: "", repoPath: "", defaultBranch: "main", category: "", allowedCommands: "", sensitivePatterns: ".env\n*.pem\n*.key" };
const layerLabels: Record<string, string> = { source_fact: "源码事实", project_rule: "项目规则", decision: "决策", requirement_experience: "需求经验" };

export function ProjectManagement() {
  const [projects, setProjects] = useState<Project[]>([]), [filter, setFilter] = useState<ProjectStatus>("active"), [editor, setEditor] = useState<Project | "new" | null>(null), [validateOnOpen, setValidateOnOpen] = useState(false), [archiveTarget, setArchiveTarget] = useState<Project | null>(null), [archiveError, setArchiveError] = useState("");
  const [details, setDetails] = useState<ProjectDetailsState>({ generation: 0, knowledge: {}, memory: {}, errors: {} }), [busyOperations, setBusyOperations] = useState<ReadonlySet<string>>(new Set()), [error, setError] = useState("");
  const projectRequestGeneration = useRef(0), detailGeneration = useRef(0), busyOperationsRef = useRef<ReadonlySet<string>>(new Set());
  const startOperation = (operation: ProjectOperation, projectId: string) => { const result = addBusyOperation(busyOperationsRef.current, operation, projectId); if (!result.started) return false; busyOperationsRef.current = result.busy; setBusyOperations(result.busy); return true; };
  const finishOperation = (operation: ProjectOperation, projectId: string) => { const next = removeBusyOperation(busyOperationsRef.current, operation, projectId); busyOperationsRef.current = next; setBusyOperations(next); };
  const loadProjects = useCallback(async () => { const generation = ++projectRequestGeneration.current, value = await api<Project[]>("/projects?status=all"); if (generation === projectRequestGeneration.current) setProjects(value); }, []);
  useEffect(() => { loadProjects().catch(e => setError(e.message)); return () => { projectRequestGeneration.current += 1; }; }, [loadProjects]);
  useEffect(() => { let active = true; const generation = ++detailGeneration.current, ids = projects.map(project => project.id); setDetails(current => beginProjectDetails(current, generation, ids)); for (const project of projects) for (const resource of ["knowledge", "memory"] as const) api(`/projects/${project.id}/${resource}`).then(value => { if (active) setDetails(current => mergeProjectDetails(current, generation, project.id, resource, { status: "fulfilled", value })); }, reason => { if (active) setDetails(current => mergeProjectDetails(current, generation, project.id, resource, { status: "rejected", reason: reason instanceof Error ? reason.message : "读取失败" })); }); return () => { active = false; }; }, [projects, filter]);
  const buildingIds = useMemo(() => projects.filter(project => details.knowledge[project.id]?.status === "building").map(project => project.id), [projects, details.knowledge]);
  useEffect(() => { if (!buildingIds.length) return; let active = true, timer = 0; const generation = details.generation; const poll = async () => { const results = await Promise.all(buildingIds.map(async id => { try { return [id, { status: "fulfilled", value: await api(`/projects/${id}/knowledge`) } as DetailResult] as const; } catch (reason) { return [id, { status: "rejected", reason: reason instanceof Error ? reason.message : "读取失败" } as DetailResult] as const; } })); if (!active) return; setDetails(current => results.reduce((next, [id, result]) => mergeProjectDetails(next, generation, id, "knowledge", result, { retainRejected: true }), current)); if (active) timer = window.setTimeout(poll, 1500); }; timer = window.setTimeout(poll, 1500); return () => { active = false; window.clearTimeout(timer); }; }, [details.generation, buildingIds.join(",")]);
  const view = filterProjects(projects, filter);
  const rebuild = async (project: Project) => { if (!startOperation("rebuild", project.id)) return; setError(""); try { await post(`/projects/${project.id}/knowledge/rebuild`, {}); setDetails(current => mergeProjectDetails(current, current.generation, project.id, "knowledge", { status: "fulfilled", value: { ...current.knowledge[project.id], status: "building" } })); } catch (e: any) { setError(e.message); } finally { finishOperation("rebuild", project.id); } };
  const requestArchive = (project: Project) => { setArchiveError(""); setArchiveTarget(project); };
  const archive = async () => { if (!archiveTarget || !startOperation("archive", archiveTarget.id)) return; const target = archiveTarget; setArchiveError(""); try { await post(`/projects/${target.id}/archive`, {}); setArchiveTarget(null); await loadProjects(); } catch (e: unknown) { setArchiveError(archiveErrorMessage(e, target.name)); } finally { finishOperation("archive", target.id); } };
  return <div className="content project-management"><section className="section"><div className="section-head project-page-head"><div><h2>本地项目</h2><p>维护仓库验证、执行边界与项目知识</p></div><div className="project-head-actions"><button className="secondary" onClick={() => loadProjects().catch(e => setError(e.message))}><RefreshCw size={16}/>重新加载</button><button className="primary" onClick={() => { setValidateOnOpen(false); setEditor("new"); }}><Plus size={16}/>新建项目</button></div></div>
    {error && <div className="project-error" role="alert">{error}<button title="关闭错误" aria-label="关闭错误" onClick={() => setError("")}><X size={15}/></button></div>}
    <div className="project-filter"><div className="segments" aria-label="项目状态筛选">{(["active", "archived"] as const).map(status => <button key={status} className={filter === status ? "selected" : ""} onClick={() => setFilter(status)}>{status === "active" ? "使用中" : "已归档"}<b>{view[status]}</b></button>)}</div><span>共 {view.total} 个项目</span></div>
    <div className="project-list">{view.list.length ? view.list.map(project => <ProjectBand key={project.id} project={project} knowledge={details.knowledge[project.id]} memory={details.memory[project.id]} detailErrors={details.errors[project.id]} rebuildBusy={isOperationBusy(busyOperations, "rebuild", project.id)} archiveBusy={isOperationBusy(busyOperations, "archive", project.id)} onEdit={() => { setValidateOnOpen(false); setEditor(project); }} onValidate={() => { setValidateOnOpen(true); setEditor(project); }} onRebuild={() => rebuild(project)} onArchive={() => requestArchive(project)}/>) : <div className="empty"><FolderGit2 size={25}/><b>{filter === "active" ? "还没有使用中的项目" : "还没有归档项目"}</b><span>{filter === "active" ? "新建项目并验证本地 Git 仓库" : "归档项目会显示在这里"}</span></div>}</div>
  </section>{editor && <ProjectEditor project={editor === "new" ? null : editor} readOnly={editor !== "new" && editor.status === "archived"} validateOnOpen={validateOnOpen} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await loadProjects(); }}/>} {archiveTarget && <ArchiveDialog project={archiveTarget} busy={isOperationBusy(busyOperations, "archive", archiveTarget.id)} error={archiveError} onCancel={() => { if (!isOperationBusy(busyOperationsRef.current, "archive", archiveTarget.id)) setArchiveTarget(null); }} onArchive={archive}/>}</div>;
}

function ProjectBand({ project, knowledge, memory, detailErrors, rebuildBusy, archiveBusy, onEdit, onValidate, onRebuild, onArchive }: any) {
  const view = projectKnowledgeView(knowledge), health = projectHealth(project, knowledge), actions = projectActions(project.status);
  const tech = (project.technology || []).join(" / ") || "待检测";
  return <article className="project-band"><div className="project-band-main"><FolderGit2 className="project-icon"/><div className="project-identity"><div><h3>{project.name}</h3><span className={`project-health ${health.tone}`}>{health.label}</span></div><code title={project.repoPath}>{project.repoPath}</code><small>{project.category || "未分类"} · {project.defaultBranch}</small></div><div className="project-facts"><span>技术栈<b>{tech}</b></span><span>模块<b>{view.moduleCount}</b></span><span>知识状态<b>{view.label} · {view.version}</b></span></div><div className="project-actions">
    {actions.includes("edit") && <IconButton title="编辑项目" onClick={onEdit}><Pencil/></IconButton>}{actions.includes("validate") && <IconButton title="验证仓库" onClick={onValidate}><CheckCircle2/></IconButton>}{actions.includes("rebuild") && <IconButton title="重建知识库" disabled={rebuildBusy || archiveBusy || !view.canRebuild} onClick={onRebuild}><RotateCw className={knowledge?.status === "building" ? "spin" : ""}/></IconButton>}{actions.includes("archive") && <IconButton title="归档项目" disabled={archiveBusy || rebuildBusy} onClick={onArchive}><Archive/></IconButton>}{actions.includes("view") && <IconButton title="查看项目" onClick={onEdit}><Eye/></IconButton>}
  </div></div><div className="knowledge-meta"><span>版本 <b>{view.version}</b></span><span>源码 HEAD <code>{String(view.head).slice(0, 12)}</code></span><span>知识条目 <b>{view.entryCount}</b></span><span>知识模块 <b>{view.moduleCount}</b></span></div>{(view.error || detailErrors?.knowledge) && <p className="project-inline-error" role="alert">{view.error || `知识状态读取失败：${detailErrors.knowledge}`}</p>}{detailErrors?.memory && <p className="project-inline-error" role="alert">持续记忆读取失败：{detailErrors.memory}</p>}<details className="project-memory"><summary><b>项目持续记忆</b><span>{memory?.total || 0} 条正式知识</span></summary><div className="memory-layers">{Object.entries(memory?.layers || {}).map(([layer, count]: any) => <span key={layer}>{layerLabels[layer] || layer}<b>{count}</b></span>)}</div>{(memory?.records || []).slice(0, 20).map((record: any) => <article key={record.id}><div><b>{record.title}</b><span>{layerLabels[record.layer] || record.layer} · v{record.version}</span></div><p>{String(record.content || "").slice(0, 1200)}</p><small>{record.sourceStage} · {record.riskLevel === "high" ? "高风险" : "已验证"}</small></article>)}</details></article>;
}

function ArchiveDialog({ project, busy, error, onCancel, onArchive }: { project: Project; busy: boolean; error: string; onCancel: () => void; onArchive: () => void }) {
  return <AccessibleDialog className="archive-dialog" role="alertdialog" title={`归档项目“${project.name}”`} subtitle="归档后，该项目将不再出现在新需求的项目选择中；已有交付历史和知识记录仍会保留。" titleId="archive-project-title" descriptionId="archive-project-description" busy={busy} onClose={onCancel}>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" data-autofocus disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary danger-action" disabled={busy} onClick={onArchive}>{busy ? <RefreshCw className="spin" size={16}/> : <Archive size={16}/>}确认归档</button></div></AccessibleDialog>;
}

function IconButton({ title, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="icon-btn" title={title} aria-label={title} {...props}>{React.isValidElement(children) ? React.cloneElement(children as React.ReactElement<any>, { size: 16 }) : children}</button>; }

function ProjectEditor({ project, readOnly, validateOnOpen, onClose, onSaved }: { project: Project | null; readOnly: boolean; validateOnOpen: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const source: Form = project ? { name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch, category: project.category || "", allowedCommands: normalizeAllowedCommands(project.allowedCommands), sensitivePatterns: (project.sensitivePatterns || []).join("\n") } : emptyForm;
  const [state, dispatch] = useReducer(submissionReducer<Form>, initialSubmissionState(source)), [validation, setValidation] = useState<Validation | null>(project && !readOnly ? { repoPath: project.repoPath, defaultBranch: project.defaultBranch, result: { valid: true, repoPath: project.repoPath, defaultBranch: project.defaultBranch, category: project.category || "other", technology: project.technology || [], packageManager: project.packageManager || null, modules: [], warnings: [] } } : null), [validating, setValidating] = useState(false), [errors, setErrors] = useState<ProjectFieldErrors>({ repoPath: "", defaultBranch: "", general: "" }), submittingRef = useRef(false), initialValidationStarted = useRef(false);
  const change = (field: keyof Form, value: string) => { dispatch({ type: "change", form: { ...state.form, [field]: value } }); setValidation(current => validationAfterChange(current, field, value)); setErrors(current => ({ ...current, [field]: "", general: "" })); };
  const validate = async () => { const snapshot = { ...state.form }; setValidating(true); setErrors({ repoPath: "", defaultBranch: "", general: "" }); try { const result = await post<Inspection>("/projects/validate", { repoPath: snapshot.repoPath, defaultBranch: snapshot.defaultBranch }); setValidation({ repoPath: snapshot.repoPath, defaultBranch: snapshot.defaultBranch, result }); } catch (e: unknown) { setValidation(null); setErrors(projectFieldErrors(e)); } finally { setValidating(false); } };
  useEffect(() => { if (validateOnOpen && !readOnly && !initialValidationStarted.current) { initialValidationStarted.current = true; void validate(); } }, [validateOnOpen, readOnly]);
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (!shouldStartSubmission(state) || submittingRef.current) return; const snapshot = { ...state.form }, parsed = parseAllowedCommands(snapshot.allowedCommands); if (parsed.error) { setErrors({ repoPath: "", defaultBranch: "", general: parsed.error }); return; } if (!validation || validation.repoPath !== snapshot.repoPath || validation.defaultBranch !== snapshot.defaultBranch) { setErrors({ repoPath: "", defaultBranch: "", general: "请先验证当前仓库路径和默认分支" }); return; } submittingRef.current = true; dispatch({ type: "submit" }); try { const body: Record<string, unknown> = { name: snapshot.name.trim(), category: snapshot.category || null, allowedCommands: parsed.commands, sensitivePatterns: snapshot.sensitivePatterns.split(/\r?\n/).map(item => item.trim()).filter(Boolean) }; if (!project || snapshot.repoPath !== project.repoPath) body.repoPath = validation.result.repoPath; if (!project || snapshot.defaultBranch !== project.defaultBranch) body.defaultBranch = snapshot.defaultBranch.trim(); if (project) await patch(`/projects/${project.id}`, body); else await post("/projects", body); await onSaved(); } catch (e: unknown) { submittingRef.current = false; const next = projectFieldErrors(e); setErrors(next); dispatch({ type: "failure", error: next.general }); } };
  const busy = validating || state.submitting;
  return <AccessibleDialog className="project-editor" title={readOnly ? "项目详情" : project ? "编辑项目" : "新建项目"} subtitle={readOnly ? "归档项目为只读，历史和知识记录仍会保留" : "验证仓库后才能保存路径和分支配置"} titleId="project-editor-title" busy={busy} onClose={onClose}><form onSubmit={save}><fieldset disabled={readOnly || busy}>
    <div className="project-form-grid"><Field label="项目名称"><input required data-autofocus value={state.form.name} onChange={e => change("name", e.target.value)}/></Field><Field label="项目分类"><select value={state.form.category} onChange={e => change("category", e.target.value)}><option value="">未设置（使用检测结果）</option><option value="frontend">前端</option><option value="backend">后端</option><option value="fullstack">全栈</option><option value="library">类库</option><option value="other">其他</option></select></Field></div>
    <Field label="仓库路径" error={errors.repoPath}><input required aria-invalid={Boolean(errors.repoPath)} value={state.form.repoPath} onChange={e => change("repoPath", e.target.value)} placeholder="/absolute/path/to/repository"/></Field><div className="project-branch-row"><Field label="默认分支" error={errors.defaultBranch}><input required aria-invalid={Boolean(errors.defaultBranch)} value={state.form.defaultBranch} onChange={e => change("defaultBranch", e.target.value)}/></Field>{!readOnly && <button type="button" className="secondary" disabled={!state.form.repoPath.trim() || !state.form.defaultBranch.trim()} onClick={validate}>{validating ? <RefreshCw className="spin" size={16}/> : <CheckCircle2 size={16}/>}验证仓库</button>}</div>
    {validation && <div className="validation-result"><b>{projectValidationLabel(validation.result)}</b><span>规范路径：{validation.result.repoPath}</span><span>分类：{validation.result.category} · 模块：{validation.result.modules.length}</span>{validation.result.warnings?.map((warning, index) => <small key={index}>{warning}</small>)}</div>}
    <Field label="允许命令（每行一条命令及参数）"><textarea value={state.form.allowedCommands} onChange={e => change("allowedCommands", e.target.value)} placeholder={"pnpm test\npnpm run lint"}/></Field><Field label="敏感文件模式（每行一条）"><textarea value={state.form.sensitivePatterns} onChange={e => change("sensitivePatterns", e.target.value)} placeholder={".env\n*.pem\n*.key"}/></Field></fieldset>
    {(errors.general || state.error) && <p className="form-error" role="alert">{errors.general || state.error}</p>}<div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{readOnly ? "关闭" : "取消"}</button>{!readOnly && <button className="primary" disabled={busy || !validation}>{state.submitting && <RefreshCw className="spin" size={16}/>}保存项目</button>}</div>
  </form></AccessibleDialog>;
}
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}{error && <small className="field-error" role="alert">{error}</small>}</label>; }
