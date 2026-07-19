import React, { useEffect, useRef, useState } from "react";
import { FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import type { ProjectVersion, Requirement } from "@ai-workflow/shared";
import { AccessibleDialog } from "./accessible-dialog.js";
import { api, post } from "./api.js";

type Priority = "low" | "medium" | "high" | "urgent";
type ProjectChoice = { id: string; name: string; defaultBranch: string };

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
  return Boolean(form.title.trim() && form.businessProblem.trim() && form.expectedOutcome.trim() && form.primaryProjectId && form.primaryProjectVersionId);
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

export function newRequirementVersionView(projectId: string, versions: readonly ProjectVersion[], loading: boolean) {
  return { showCreateVersion: Boolean(projectId) && !loading && versions.length === 0, canSave: Boolean(projectId) && !loading && versions.length > 0 };
}

export function NewRequirement({ onClose, onCreated, onProjects, onCreateVersion }: {
  onClose: () => void;
  onCreated: (requirement: Requirement) => Promise<void>;
  onProjects: () => void;
  onCreateVersion: (projectId: string) => void;
}) {
  const [form, setForm] = useState<NewRequirementForm>(emptyForm);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const versionRequest = useRef(0);

  useEffect(() => {
    let live = true;
    api<ProjectChoice[]>("/projects?status=active").then((value) => {
      if (!live) return;
      setProjects(value);
      setForm((current) => selectRequirementProject(current, value[0]?.id || ""));
    }, (reason) => { if (live) setError(reason.message); }).finally(() => { if (live) setLoadingProjects(false); });
    return () => { live = false; versionRequest.current += 1; };
  }, []);

  useEffect(() => {
    const projectId = form.primaryProjectId;
    setVersions([]);
    if (!projectId) { setLoadingVersions(false); return; }
    const request = ++versionRequest.current;
    setLoadingVersions(true);
    setError("");
    api<ProjectVersion[]>(`/projects/${encodeURIComponent(projectId)}/versions?status=active`).then((value) => {
      if (request !== versionRequest.current) return;
      setVersions(value);
      setForm((current) => current.primaryProjectId === projectId ? { ...current, primaryProjectVersionId: "" } : current);
    }, (reason) => { if (request === versionRequest.current) setError(reason.message); }).finally(() => {
      if (request === versionRequest.current) setLoadingVersions(false);
    });
  }, [form.primaryProjectId]);

  const versionView = newRequirementVersionView(form.primaryProjectId, versions, loadingVersions);
  const change = <K extends keyof NewRequirementForm>(field: K, value: NewRequirementForm[K]) => setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !versionView.canSave || !canSaveNewRequirement(form)) return;
    setBusy(true); setError("");
    try { await onCreated(await post<Requirement>("/requirements", newRequirementPayload(form))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "创建需求失败"); setBusy(false); }
  };

  return <AccessibleDialog className="new-requirement-dialog" title="新建需求" subtitle="选择交付项目版本，保存后进入产品 AI 待启动状态" titleId="new-requirement-title" busy={busy} onClose={onClose}>
    {loadingProjects ? <div className="new-requirement-loading"><RefreshCw className="spin" size={18}/>正在读取使用中的项目</div> : !projects.length ? <div className="empty new-requirement-empty"><FolderGit2 size={30}/><b>需要先登记使用中的项目</b><span>每条需求必须有一个主项目，用于承载上下文和交付边界。</span><button type="button" className="primary" onClick={onProjects}>前往项目配置</button></div> : <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <Field label="主项目"><select required value={form.primaryProjectId} onChange={(event) => setForm((current) => selectRequirementProject(current, event.target.value))}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} · {project.defaultBranch}</option>)}</select></Field>
        {loadingVersions ? <div className="new-requirement-loading"><RefreshCw className="spin" size={16}/>正在读取项目版本</div> : versionView.showCreateVersion ? <div className="new-requirement-version-empty"><div><GitBranch size={18}/><span><b>该项目没有使用中的版本</b><small>创建版本后才能新建交付需求。</small></span></div><button type="button" className="primary" onClick={() => onCreateVersion(form.primaryProjectId)}>前往创建版本</button></div> : <Field label="交付版本"><select required value={form.primaryProjectVersionId} onChange={(event) => change("primaryProjectVersionId", event.target.value)}><option value="">选择版本</option>{versions.map((version) => <option value={version.id} key={version.id}>{version.name} · {version.branch}</option>)}</select></Field>}
        <Field label="需求标题"><input data-autofocus required value={form.title} onChange={(event) => change("title", event.target.value)} placeholder="例如：统一订单备注校验"/></Field>
        <Field label="业务背景与当前问题"><textarea required value={form.businessProblem} onChange={(event) => change("businessProblem", event.target.value)} placeholder="描述现状、用户和具体问题"/></Field>
        <Field label="期望业务结果"><textarea required value={form.expectedOutcome} onChange={(event) => change("expectedOutcome", event.target.value)} placeholder="描述可观察的结果"/></Field>
        <Field label="优先级"><select value={form.priority} onChange={(event) => change("priority", event.target.value as Priority)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option></select></Field>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !versionView.canSave || !canSaveNewRequirement(form)}>{busy && <RefreshCw className="spin" size={16}/>}保存需求</button></div>
    </form>}
  </AccessibleDialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}</label>; }
