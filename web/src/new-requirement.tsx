import React, { useEffect, useRef, useState } from "react";
import { FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { requirementInputSchema, type ProjectVersion, type Requirement } from "@ai-workflow/shared";
import { AccessibleDialog } from "./accessible-dialog.js";
import { ApiError, api, post } from "./api.js";

type Priority = "low" | "medium" | "high" | "urgent";
type ProjectChoice = { id: string; name: string; defaultBranch: string };
export type Loadable<T> = { status: "loading" } | { status: "error"; error: string } | { status: "loaded"; value: T };
const readableLoadError = (reason: unknown, fallback: string) => reason instanceof Error && !/^[A-Z][A-Z0-9_]+$/.test(reason.message) ? reason.message : fallback;

export type NewRequirementForm = {
  title: string;
  businessProblem: string;
  expectedOutcome: string;
  priority: Priority;
  primaryProjectId: string;
  primaryProjectVersionId: string;
};

const emptyForm: NewRequirementForm = {
  title: "", businessProblem: "", expectedOutcome: "", priority: "medium",
  primaryProjectId: "", primaryProjectVersionId: ""
};

export function selectRequirementProject<T extends Pick<NewRequirementForm, "primaryProjectId" | "primaryProjectVersionId">>(form: T, projectId: string): T {
  return { ...form, primaryProjectId: projectId, primaryProjectVersionId: "" };
}

export function canSaveNewRequirement(form: NewRequirementForm) {
  return validateNewRequirement(form).valid;
}

export function newRequirementPayload(form: NewRequirementForm) {
  return {
    title: form.title,
    businessProblem: form.businessProblem,
    expectedOutcome: form.expectedOutcome,
    priority: form.priority,
    primaryProjectId: form.primaryProjectId,
    primaryProjectVersionId: form.primaryProjectVersionId
  };
}

type NewRequirementFieldErrors = Partial<Record<keyof NewRequirementForm, string>>;
const fieldMessages: Record<keyof NewRequirementForm, string> = {
  title: "需求标题至少填写 2 个字符",
  businessProblem: "业务背景与当前问题至少填写 10 个字符",
  expectedOutcome: "期望业务结果至少填写 4 个字符",
  priority: "请选择有效优先级",
  primaryProjectId: "请选择主项目",
  primaryProjectVersionId: "请选择交付版本"
};

function issuesToFieldErrors(issues: unknown): NewRequirementFieldErrors {
  const fields: NewRequirementFieldErrors = {};
  if (!Array.isArray(issues)) return fields;
  for (const issue of issues) {
    const field = (issue as any)?.path?.[0] as keyof NewRequirementForm | undefined;
    if (field && field in fieldMessages && !fields[field]) fields[field] = fieldMessages[field];
  }
  return fields;
}

export function validateNewRequirement(form: NewRequirementForm) {
  const parsed = requirementInputSchema.safeParse(newRequirementPayload(form));
  return parsed.success
    ? { valid: true as const, fields: {} as NewRequirementFieldErrors, value: parsed.data }
    : { valid: false as const, fields: issuesToFieldErrors(parsed.error.issues), value: null };
}

export function newRequirementApiErrors(error: unknown) {
  if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
    return { fields: issuesToFieldErrors((error.details as any)?.issues), summary: "请检查需求信息后重试" };
  }
  const message = error instanceof Error && !/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "创建需求失败，请稍后重试";
  return { fields: {} as NewRequirementFieldErrors, summary: message };
}

export function newRequirementProjectsView(state: Loadable<readonly ProjectChoice[]>) {
  return {
    loading: state.status === "loading",
    error: state.status === "error" ? state.error : "",
    showRetry: state.status === "error",
    showEmpty: state.status === "loaded" && state.value.length === 0
  };
}

export function newRequirementVersionView(projectId: string, state: Loadable<readonly ProjectVersion[]>) {
  const versions = state.status === "loaded" ? state.value : [];
  return {
    loading: state.status === "loading",
    error: state.status === "error" ? state.error : "",
    showRetry: state.status === "error",
    showCreateVersion: Boolean(projectId) && state.status === "loaded" && versions.length === 0,
    canSave: Boolean(projectId) && state.status === "loaded" && versions.length > 0
  };
}

export function NewRequirement({ onClose, onCreated, onProjects, onCreateVersion }: {
  onClose: () => void;
  onCreated: (requirement: Requirement) => Promise<void>;
  onProjects: () => void;
  onCreateVersion: (projectId: string) => void;
}) {
  const [form, setForm] = useState<NewRequirementForm>(emptyForm);
  const [projectResource, setProjectResource] = useState<Loadable<ProjectChoice[]>>({ status: "loading" });
  const [versionResource, setVersionResource] = useState<Loadable<ProjectVersion[]>>({ status: "loaded", value: [] });
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<NewRequirementFieldErrors>({});
  const versionRequest = useRef(0);

  const loadProjects = () => {
    setProjectResource({ status: "loading" });
    api<ProjectChoice[]>("/projects?status=active").then((value) => {
      setProjectResource({ status: "loaded", value });
      setForm((current) => selectRequirementProject(current, value[0]?.id || ""));
    }, (reason) => setProjectResource({ status: "error", error: readableLoadError(reason, "项目读取失败，请重试") }));
  };
  useEffect(() => {
    loadProjects();
    return () => { versionRequest.current += 1; };
  }, []);

  const loadVersions = (projectId: string) => {
    if (!projectId) { setVersionResource({ status: "loaded", value: [] }); return; }
    const request = ++versionRequest.current;
    setVersionResource({ status: "loading" });
    api<ProjectVersion[]>(`/projects/${encodeURIComponent(projectId)}/versions?status=active`).then((value) => {
      if (request !== versionRequest.current) return;
      setVersionResource({ status: "loaded", value });
      setForm((current) => current.primaryProjectId === projectId ? { ...current, primaryProjectVersionId: "" } : current);
    }, (reason) => { if (request === versionRequest.current) setVersionResource({ status: "error", error: readableLoadError(reason, "版本读取失败，请重试") }); });
  };
  useEffect(() => {
    loadVersions(form.primaryProjectId);
    return () => { versionRequest.current += 1; };
  }, [form.primaryProjectId]);

  const projects = projectResource.status === "loaded" ? projectResource.value : [], versions = versionResource.status === "loaded" ? versionResource.value : [];
  const projectView = newRequirementProjectsView(projectResource), versionView = newRequirementVersionView(form.primaryProjectId, versionResource);
  const change = <K extends keyof NewRequirementForm>(field: K, value: NewRequirementForm[K]) => { setForm((current) => ({ ...current, [field]: value })); setFieldErrors((current) => ({ ...current, [field]: undefined })); setSubmitError(""); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !versionView.canSave) return;
    const validation = validateNewRequirement(form);
    if (!validation.valid) { setFieldErrors(validation.fields); setSubmitError("请检查需求信息后重试"); return; }
    setBusy(true); setSubmitError("");
    setFieldErrors({});
    try { await onCreated(await post<Requirement>("/requirements", validation.value)); }
    catch (reason) { const mapped = newRequirementApiErrors(reason); setFieldErrors(mapped.fields); setSubmitError(mapped.summary); setBusy(false); }
  };

  return <AccessibleDialog className="new-requirement-dialog" title="新建需求" subtitle="选择交付项目版本，保存后进入产品 AI 待启动状态" titleId="new-requirement-title" busy={busy} onClose={onClose}>
    {projectView.loading ? <div className="new-requirement-loading"><RefreshCw className="spin" size={18}/>正在读取使用中的项目</div> : projectView.showRetry ? <LoadError message={projectView.error} onRetry={loadProjects}/> : projectView.showEmpty ? <div className="empty new-requirement-empty"><FolderGit2 size={30}/><b>需要先登记使用中的项目</b><span>每条需求必须有一个主项目，用于承载上下文和交付边界。</span><button type="button" className="primary" onClick={onProjects}>前往项目配置</button></div> : <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <Field label="主项目" error={fieldErrors.primaryProjectId}><select required aria-invalid={Boolean(fieldErrors.primaryProjectId)} value={form.primaryProjectId} onChange={(event) => { setForm((current) => selectRequirementProject(current, event.target.value)); setFieldErrors((current) => ({ ...current, primaryProjectId: undefined, primaryProjectVersionId: undefined })); }}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} · {project.defaultBranch}</option>)}</select></Field>
        {versionView.loading ? <div className="new-requirement-loading"><RefreshCw className="spin" size={16}/>正在读取项目版本</div> : versionView.showRetry ? <LoadError message={versionView.error} onRetry={() => loadVersions(form.primaryProjectId)}/> : versionView.showCreateVersion ? <div className="new-requirement-version-empty"><div><GitBranch size={18}/><span><b>该项目没有使用中的版本</b><small>创建版本后才能新建交付需求。</small></span></div><button type="button" className="primary" onClick={() => onCreateVersion(form.primaryProjectId)}>前往创建版本</button></div> : <Field label="交付版本" error={fieldErrors.primaryProjectVersionId}><select required aria-invalid={Boolean(fieldErrors.primaryProjectVersionId)} value={form.primaryProjectVersionId} onChange={(event) => change("primaryProjectVersionId", event.target.value)}><option value="">选择版本</option>{versions.map((version) => <option value={version.id} key={version.id}>{version.name} · {version.branch}</option>)}</select></Field>}
        <Field label="需求标题" error={fieldErrors.title}><input data-autofocus required aria-invalid={Boolean(fieldErrors.title)} value={form.title} onChange={(event) => change("title", event.target.value)} placeholder="例如：统一订单备注校验"/></Field>
        <Field label="业务背景与当前问题" error={fieldErrors.businessProblem}><textarea required aria-invalid={Boolean(fieldErrors.businessProblem)} value={form.businessProblem} onChange={(event) => change("businessProblem", event.target.value)} placeholder="描述现状、用户和具体问题"/></Field>
        <Field label="期望业务结果" error={fieldErrors.expectedOutcome}><textarea required aria-invalid={Boolean(fieldErrors.expectedOutcome)} value={form.expectedOutcome} onChange={(event) => change("expectedOutcome", event.target.value)} placeholder="描述可观察的结果"/></Field>
        <Field label="优先级" error={fieldErrors.priority}><select aria-invalid={Boolean(fieldErrors.priority)} value={form.priority} onChange={(event) => change("priority", event.target.value as Priority)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option></select></Field>
      </fieldset>
      {submitError && <p className="form-error" role="alert">{submitError}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !versionView.canSave || !form.primaryProjectId || !form.primaryProjectVersionId}>{busy && <RefreshCw className="spin" size={16}/>}保存需求</button></div>
    </form>}
  </AccessibleDialog>;
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}{error&&<small className="field-error" role="alert">{error}</small>}</label>; }
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="new-requirement-load-error" role="alert"><span>{message}</span><button type="button" className="secondary" onClick={onRetry}><RefreshCw size={15}/>重试</button></div>; }
