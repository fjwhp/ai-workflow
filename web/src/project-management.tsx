import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Archive, CheckCircle2, Eye, FolderGit2, Pencil, Plus, RefreshCw, RotateCw, X } from "lucide-react";
import { ApiError, api, patch, post } from "./api.js";
import { projectKnowledgeView } from "./project-knowledge-view.js";

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
  if (action.type === "change") return { form: action.form, submitting: false, error: "" };
  if (action.type === "submit") return { ...state, submitting: true, error: "" };
  return { ...state, submitting: false, error: action.error };
}

const emptyForm: Form = { name: "", repoPath: "", defaultBranch: "main", category: "", allowedCommands: "", sensitivePatterns: ".env\n*.pem\n*.key" };
const layerLabels: Record<string, string> = { source_fact: "源码事实", project_rule: "项目规则", decision: "决策", requirement_experience: "需求经验" };

export function ProjectManagement() {
  const [projects, setProjects] = useState<Project[]>([]), [filter, setFilter] = useState<ProjectStatus>("active"), [editor, setEditor] = useState<Project | "new" | null>(null), [archiveTarget, setArchiveTarget] = useState<Project | null>(null), [archiveError, setArchiveError] = useState("");
  const [knowledge, setKnowledge] = useState<Record<string, any>>({}), [memory, setMemory] = useState<Record<string, any>>({}), [inspections, setInspections] = useState<Record<string, Inspection | null>>({}), [busyId, setBusyId] = useState(""), [error, setError] = useState("");
  const loadProjects = useCallback(async () => setProjects(await api<Project[]>("/projects?status=all")), []);
  const loadDetails = useCallback(async (items: Project[]) => {
    const pairs = await Promise.all(items.map(async project => [project.id, await api(`/projects/${project.id}/knowledge`), await api(`/projects/${project.id}/memory`), await post<Inspection>("/projects/validate", { repoPath: project.repoPath, defaultBranch: project.defaultBranch }).catch(() => null)] as const));
    setKnowledge(Object.fromEntries(pairs.map(([id, value]) => [id, value]))); setMemory(Object.fromEntries(pairs.map(([id, , value]) => [id, value]))); setInspections(Object.fromEntries(pairs.map(([id, , , value]) => [id, value])));
  }, []);
  useEffect(() => { loadProjects().catch(e => setError(e.message)); }, [loadProjects]);
  useEffect(() => { if (projects.length) loadDetails(projects).catch(e => setError(e.message)); }, [projects, loadDetails]);
  const buildingIds = useMemo(() => projects.filter(project => knowledge[project.id]?.status === "building").map(project => project.id), [projects, knowledge]);
  useEffect(() => { if (!buildingIds.length) return; let active = true; const poll = async () => { const values = await Promise.all(buildingIds.map(async id => [id, await api(`/projects/${id}/knowledge`)] as const)); if (active) setKnowledge(current => ({ ...current, ...Object.fromEntries(values) })); }; const timer = window.setInterval(() => poll().catch(e => setError(e.message)), 1500); return () => { active = false; window.clearInterval(timer); }; }, [buildingIds.join(",")]);
  const view = filterProjects(projects, filter);
  const rebuild = async (project: Project) => { setBusyId(project.id); setError(""); try { await post(`/projects/${project.id}/knowledge/rebuild`, {}); setKnowledge(current => ({ ...current, [project.id]: { ...current[project.id], status: "building" } })); } catch (e: any) { setError(e.message); } finally { setBusyId(""); } };
  const requestArchive = (project: Project) => { setArchiveError(""); setArchiveTarget(project); };
  const archive = async () => { if (!archiveTarget) return; setBusyId(archiveTarget.id); setArchiveError(""); try { await post(`/projects/${archiveTarget.id}/archive`, {}); setArchiveTarget(null); await loadProjects(); } catch (e: unknown) { setArchiveError(archiveErrorMessage(e, archiveTarget.name)); } finally { setBusyId(""); } };
  return <div className="content project-management"><section className="section"><div className="section-head project-page-head"><div><h2>本地项目</h2><p>维护仓库验证、执行边界与项目知识</p></div><button className="primary" onClick={() => setEditor("new")}><Plus size={16}/>新建项目</button></div>
    {error && <div className="project-error" role="alert">{error}<button title="关闭错误" aria-label="关闭错误" onClick={() => setError("")}><X size={15}/></button></div>}
    <div className="project-filter"><div className="segments" aria-label="项目状态筛选">{(["active", "archived"] as const).map(status => <button key={status} className={filter === status ? "selected" : ""} onClick={() => setFilter(status)}>{status === "active" ? "使用中" : "已归档"}<b>{view[status]}</b></button>)}</div><span>共 {view.total} 个项目</span></div>
    <div className="project-list">{view.list.length ? view.list.map(project => <ProjectBand key={project.id} project={project} inspection={inspections[project.id]} knowledge={knowledge[project.id]} memory={memory[project.id]} busy={busyId === project.id} onEdit={() => setEditor(project)} onRebuild={() => rebuild(project)} onArchive={() => requestArchive(project)}/>) : <div className="empty"><FolderGit2 size={25}/><b>{filter === "active" ? "还没有使用中的项目" : "还没有归档项目"}</b><span>{filter === "active" ? "新建项目并验证本地 Git 仓库" : "归档项目会显示在这里"}</span></div>}</div>
  </section>{editor && <ProjectEditor project={editor === "new" ? null : editor} readOnly={editor !== "new" && editor.status === "archived"} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await loadProjects(); }}/>} {archiveTarget && <ArchiveDialog project={archiveTarget} busy={busyId === archiveTarget.id} error={archiveError} onCancel={() => { if (!busyId) setArchiveTarget(null); }} onArchive={archive}/>}</div>;
}

function ProjectBand({ project, inspection, knowledge, memory, busy, onEdit, onRebuild, onArchive }: any) {
  const view = projectKnowledgeView(knowledge), health = projectHealth(project, knowledge), actions = projectActions(project.status);
  const tech = (inspection?.technology || project.technology || []).join(" / ") || "待检测", modules = inspection?.modules?.length ?? view.moduleCount;
  return <article className="project-band"><div className="project-band-main"><FolderGit2 className="project-icon"/><div className="project-identity"><div><h3>{project.name}</h3><span className={`project-health ${health.tone}`}>{health.label}</span></div><code title={project.repoPath}>{project.repoPath}</code><small>{project.category || "未分类"} · {project.defaultBranch}</small></div><div className="project-facts"><span>技术栈<b>{tech}</b></span><span>包管理<b>{inspection?.packageManager || "未检测"}</b></span><span>模块<b>{modules}</b></span><span>知识状态<b>{view.label} · {view.version}</b></span></div><div className="project-actions">
    {actions.includes("edit") && <IconButton title="编辑项目" onClick={onEdit}><Pencil/></IconButton>}{actions.includes("validate") && <IconButton title="验证仓库" onClick={onEdit}><CheckCircle2/></IconButton>}{actions.includes("rebuild") && <IconButton title="重建知识库" disabled={busy || !view.canRebuild} onClick={onRebuild}><RotateCw className={knowledge?.status === "building" ? "spin" : ""}/></IconButton>}{actions.includes("archive") && <IconButton title="归档项目" disabled={busy} onClick={onArchive}><Archive/></IconButton>}{actions.includes("view") && <IconButton title="查看项目" onClick={onEdit}><Eye/></IconButton>}
  </div></div><div className="knowledge-meta"><span>版本 <b>{view.version}</b></span><span>源码 HEAD <code>{String(view.head).slice(0, 12)}</code></span><span>知识条目 <b>{view.entryCount}</b></span><span>知识模块 <b>{view.moduleCount}</b></span></div>{view.error && <p className="project-inline-error" role="alert">{view.error}</p>}<details className="project-memory"><summary><b>项目持续记忆</b><span>{memory?.total || 0} 条正式知识</span></summary><div className="memory-layers">{Object.entries(memory?.layers || {}).map(([layer, count]: any) => <span key={layer}>{layerLabels[layer] || layer}<b>{count}</b></span>)}</div>{(memory?.records || []).slice(0, 20).map((record: any) => <article key={record.id}><div><b>{record.title}</b><span>{layerLabels[record.layer] || record.layer} · v{record.version}</span></div><p>{String(record.content || "").slice(0, 1200)}</p><small>{record.sourceStage} · {record.riskLevel === "high" ? "高风险" : "已验证"}</small></article>)}</details></article>;
}

function ArchiveDialog({ project, busy, error, onCancel, onArchive }: { project: Project; busy: boolean; error: string; onCancel: () => void; onArchive: () => void }) {
  return <div className="modal-backdrop"><div className="modal archive-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-project-title" aria-describedby="archive-project-description"><div className="modal-head"><div><h2 id="archive-project-title">归档项目“{project.name}”</h2><p id="archive-project-description">归档后，该项目将不再出现在新需求的项目选择中；已有交付历史和知识记录仍会保留。</p></div><IconButton title="关闭归档确认" disabled={busy} onClick={onCancel}><X/></IconButton></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary danger-action" disabled={busy} onClick={onArchive}>{busy ? <RefreshCw className="spin" size={16}/> : <Archive size={16}/>}确认归档</button></div></div></div>;
}

function IconButton({ title, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="icon-btn" title={title} aria-label={title} {...props}>{React.isValidElement(children) ? React.cloneElement(children as React.ReactElement<any>, { size: 16 }) : children}</button>; }

function ProjectEditor({ project, readOnly, onClose, onSaved }: { project: Project | null; readOnly: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const source: Form = project ? { name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch, category: project.category || "", allowedCommands: normalizeAllowedCommands(project.allowedCommands), sensitivePatterns: (project.sensitivePatterns || []).join("\n") } : emptyForm;
  const [state, dispatch] = useReducer(submissionReducer<Form>, initialSubmissionState(source)), [validation, setValidation] = useState<Validation | null>(project && !readOnly ? { repoPath: project.repoPath, defaultBranch: project.defaultBranch, result: { valid: true, repoPath: project.repoPath, defaultBranch: project.defaultBranch, category: project.category || "other", technology: project.technology || [], packageManager: project.packageManager || null, modules: [], warnings: [] } } : null), [validating, setValidating] = useState(false), [errors, setErrors] = useState<ProjectFieldErrors>({ repoPath: "", defaultBranch: "", general: "" });
  const change = (field: keyof Form, value: string) => { dispatch({ type: "change", form: { ...state.form, [field]: value } }); setValidation(current => validationAfterChange(current, field, value)); setErrors(current => ({ ...current, [field]: "", general: "" })); };
  const validate = async () => { setValidating(true); setErrors({ repoPath: "", defaultBranch: "", general: "" }); try { const result = await post<Inspection>("/projects/validate", { repoPath: state.form.repoPath, defaultBranch: state.form.defaultBranch }); setValidation({ repoPath: state.form.repoPath, defaultBranch: state.form.defaultBranch, result }); } catch (e: unknown) { setValidation(null); setErrors(projectFieldErrors(e)); } finally { setValidating(false); } };
  const save = async (event: React.FormEvent) => { event.preventDefault(); const parsed = parseAllowedCommands(state.form.allowedCommands); if (parsed.error) { setErrors({ repoPath: "", defaultBranch: "", general: parsed.error }); return; } if (!validation || validation.repoPath !== state.form.repoPath || validation.defaultBranch !== state.form.defaultBranch) { setErrors({ repoPath: "", defaultBranch: "", general: "请先验证当前仓库路径和默认分支" }); return; } dispatch({ type: "submit" }); try { const body: Record<string, unknown> = { name: state.form.name.trim(), category: state.form.category || null, allowedCommands: parsed.commands, sensitivePatterns: state.form.sensitivePatterns.split(/\r?\n/).map(item => item.trim()).filter(Boolean) }; if (!project || state.form.repoPath !== project.repoPath) body.repoPath = validation.result.repoPath; if (!project || state.form.defaultBranch !== project.defaultBranch) body.defaultBranch = state.form.defaultBranch.trim(); if (project) await patch(`/projects/${project.id}`, body); else await post("/projects", body); await onSaved(); } catch (e: unknown) { const next = projectFieldErrors(e); setErrors(next); dispatch({ type: "failure", error: next.general }); } };
  return <div className="modal-backdrop"><div className="modal project-editor" role="dialog" aria-modal="true" aria-labelledby="project-editor-title"><div className="modal-head"><div><h2 id="project-editor-title">{readOnly ? "项目详情" : project ? "编辑项目" : "新建项目"}</h2><p>{readOnly ? "归档项目为只读，历史和知识记录仍会保留" : "验证仓库后才能保存路径和分支配置"}</p></div><IconButton title="关闭" onClick={onClose}><X/></IconButton></div><form onSubmit={save}>
    <div className="project-form-grid"><Field label="项目名称"><input required disabled={readOnly} value={state.form.name} onChange={e => change("name", e.target.value)}/></Field><Field label="项目分类"><select disabled={readOnly} value={state.form.category} onChange={e => change("category", e.target.value)}><option value="">未设置（使用检测结果）</option><option value="frontend">前端</option><option value="backend">后端</option><option value="fullstack">全栈</option><option value="library">类库</option><option value="other">其他</option></select></Field></div>
    <Field label="仓库路径" error={errors.repoPath}><input required disabled={readOnly} aria-invalid={Boolean(errors.repoPath)} value={state.form.repoPath} onChange={e => change("repoPath", e.target.value)} placeholder="/absolute/path/to/repository"/></Field><div className="project-branch-row"><Field label="默认分支" error={errors.defaultBranch}><input required disabled={readOnly} aria-invalid={Boolean(errors.defaultBranch)} value={state.form.defaultBranch} onChange={e => change("defaultBranch", e.target.value)}/></Field>{!readOnly && <button type="button" className="secondary" disabled={validating || !state.form.repoPath.trim() || !state.form.defaultBranch.trim()} onClick={validate}>{validating ? <RefreshCw className="spin" size={16}/> : <CheckCircle2 size={16}/>}验证仓库</button>}</div>
    {validation && <div className="validation-result"><b>{projectValidationLabel(validation.result)}</b><span>规范路径：{validation.result.repoPath}</span><span>分类：{validation.result.category} · 模块：{validation.result.modules.length}</span>{validation.result.warnings?.map((warning, index) => <small key={index}>{warning}</small>)}</div>}
    <Field label="允许命令（每行一条命令及参数）"><textarea disabled={readOnly} value={state.form.allowedCommands} onChange={e => change("allowedCommands", e.target.value)} placeholder={"pnpm test\npnpm run lint"}/></Field><Field label="敏感文件模式（每行一条）"><textarea disabled={readOnly} value={state.form.sensitivePatterns} onChange={e => change("sensitivePatterns", e.target.value)} placeholder={".env\n*.pem\n*.key"}/></Field>
    {(errors.general || state.error) && <p className="form-error" role="alert">{errors.general || state.error}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{readOnly ? "关闭" : "取消"}</button>{!readOnly && <button className="primary" disabled={state.submitting || validating || !validation}>{state.submitting && <RefreshCw className="spin" size={16}/>}保存项目</button>}</div>
  </form></div></div>;
}
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}{error && <small className="field-error" role="alert">{error}</small>}</label>; }
