import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectVersion, ProjectVersionValidation } from "@ai-workflow/shared";
import { Archive, CheckCircle2, GitBranch, Plus, RefreshCw } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.js";
import { ApiError, api, post } from "./api.js";

export type VersionFormState = {
  values: { name: string; branch: string; baseBranch: string; reuseExistingWorktree: boolean };
  validation?: ProjectVersionValidation;
  validatedIdentity?: string;
  busy: "validate" | "save" | null;
  error?: string;
};

export type VersionApplicationQueueEntry = {
  requirementId: string;
  code: string;
  title: string;
  status: string;
  updatedAt: string;
  owner: boolean;
  position: number;
};

export type VersionRequirement = {
  id: string;
  code?: string;
  title?: string;
  stage: string;
  status: string;
};

export type VersionSnapshot = {
  requirements: VersionRequirement[];
  queue: VersionApplicationQueueEntry[];
  error?: string;
};

export type VersionRefreshState = {
  generation: number;
  versions: ProjectVersion[];
  snapshots: Record<string, VersionSnapshot>;
};

export function beginVersionRefresh(state: VersionRefreshState, _generation: number): VersionRefreshState {
  return { ...state, generation: _generation };
}

export function mergeVersionRefresh(state: VersionRefreshState, _generation: number, value: Omit<VersionRefreshState, "generation">): VersionRefreshState {
  return state.generation === _generation ? { generation: _generation, ...value } : state;
}

type SnapshotResult =
  | { status: "fulfilled"; value: Pick<VersionSnapshot, "requirements" | "queue"> }
  | { status: "rejected"; reason: string };

export type ProjectVersionView = {
  canMaintain: boolean;
  maintenanceReason: string;
  canClose: boolean;
  closeReason: string;
  pendingOwner: string;
  queueLength: number;
  waitingCount: number;
  requirementCount: number;
  activeRequirementCount: number;
  stageCounts: Record<string, number>;
};

export type ClosePreflight = {
  status: "checking" | "ready" | "blocked";
  blocker: string;
};

export function closePreflightFromRecheck(result: unknown): ClosePreflight {
  const value = result as { inspection?: { valid?: boolean; clean?: boolean }; status?: string } | null;
  if (value?.inspection) {
    if (!value.inspection.valid) return { status: "blocked", blocker: "worktree 状态异常，请先重新检查" };
    return value.inspection.clean
      ? { status: "ready", blocker: "" }
      : { status: "blocked", blocker: "worktree 仍有未提交改动，无法关闭" };
  }
  if (value?.status === "committed" || value?.status === "reverted") return { status: "ready", blocker: "" };
  if (value?.status === "pending") return { status: "blocked", blocker: "版本仍在等待本地提交或撤销" };
  if (value?.status === "ambiguous") return { status: "blocked", blocker: "本地应用状态需要人工处理，无法关闭版本" };
  return { status: "blocked", blocker: "无法确认版本当前状态，请重新检查" };
}

export function closePreflightFromError(error: unknown): ClosePreflight {
  return { status: "blocked", blocker: projectVersionErrorMessage(error, "无法确认版本当前状态，请重新检查") };
}

export type CloseAuthority = {
  version: ProjectVersion;
  snapshot: Pick<VersionSnapshot, "requirements" | "queue">;
  preflight: ClosePreflight;
  error: string;
};

type CloseAuthorityDependencies = {
  recheck: (versionId: string) => Promise<unknown>;
  listVersions: (projectId: string) => Promise<ProjectVersion[]>;
  loadSnapshot: (versionId: string) => Promise<Pick<VersionSnapshot, "requirements" | "queue">>;
};

export async function loadCloseAuthority(projectId: string, version: ProjectVersion, snapshot: Pick<VersionSnapshot, "requirements" | "queue">, dependencies: CloseAuthorityDependencies): Promise<CloseAuthority> {
  let preflight: ClosePreflight;
  let stableError = "";
  let requestFailure = "";
  try {
    preflight = closePreflightFromRecheck(await dependencies.recheck(version.id));
  } catch (error) {
    preflight = closePreflightFromError(error);
    if (error instanceof ApiError) stableError = preflight.blocker;
    else requestFailure = error instanceof Error ? error.message : "重新检查失败";
  }
  const [versionsResult, snapshotResult] = await Promise.allSettled([
    dependencies.listVersions(projectId),
    dependencies.loadSnapshot(version.id),
  ]);
  if (requestFailure || versionsResult.status === "rejected" || snapshotResult.status === "rejected") {
    const reason = requestFailure ||
      (versionsResult.status === "rejected" ? versionsResult.reason : snapshotResult.status === "rejected" ? snapshotResult.reason : "");
    const detail = reason instanceof Error ? reason.message : String(reason || "刷新失败");
    const blocker = `无法确认版本当前状态，请重新检查${detail ? `：${detail}` : ""}`;
    return { version, snapshot, preflight: { status: "blocked", blocker }, error: blocker };
  }
  const latest = versionsResult.value.find((item) => item.id === version.id);
  if (!latest) {
    const blocker = "项目版本不存在或已被删除";
    return { version, snapshot, preflight: { status: "blocked", blocker }, error: blocker };
  }
  return { version: latest, snapshot: snapshotResult.value, preflight, error: stableError };
}

export function closeAuthorityAfterFailure(authority: CloseAuthority, error: unknown): CloseAuthority {
  const message = projectVersionErrorMessage(error, "关闭版本失败，请重新检查关闭条件");
  return { ...authority, preflight: { status: "blocked", blocker: message }, error: message };
}

type VersionProject = {
  id: string;
  name: string;
  defaultBranch: string;
  status?: "active" | "archived";
};

const terminalRequirementStatuses = new Set(["completed", "closed", "cancelled"]);
const stageLabels: Record<string, string> = {
  discovery: "发现",
  product: "产品",
  design: "设计",
  coding: "编码",
  code_review: "评审",
  testing: "测试",
  acceptance: "验收",
  integration: "集成",
};

function versionIdentity(values: VersionFormState["values"]) {
  return JSON.stringify([values.name.trim(), values.branch.trim(), values.baseBranch.trim()]);
}

export function groupProjectVersions(versions: readonly ProjectVersion[]) {
  return {
    active: versions.filter((version) => version.status === "active"),
    closed: versions.filter((version) => version.status === "closed"),
  };
}

export function versionModeLabel(mode: ProjectVersionValidation["mode"]) {
  return ({
    create_branch: "创建新分支和独立 worktree",
    attach_branch: "挂载已有分支到独立 worktree",
    reuse_worktree: "复用已有 worktree",
  } as const)[mode || "create_branch"];
}

export function recordVersionValidation(state: VersionFormState, validation: ProjectVersionValidation): VersionFormState {
  return { ...state, validation, validatedIdentity: versionIdentity(state.values), busy: null, error: validation.valid ? undefined : validation.error };
}

export function updateVersionField<K extends keyof VersionFormState["values"]>(state: VersionFormState, field: K, value: VersionFormState["values"][K]): VersionFormState {
  const values = { ...state.values, [field]: value };
  const identityChanged = versionIdentity(values) !== state.validatedIdentity;
  return {
    ...state,
    values,
    validation: identityChanged ? undefined : state.validation,
    validatedIdentity: identityChanged ? undefined : state.validatedIdentity,
    error: undefined,
  };
}

export function canSaveVersion(state: VersionFormState) {
  const { name, branch, baseBranch, reuseExistingWorktree } = state.values;
  return state.busy === null && Boolean(
    name.trim() && branch.trim() && baseBranch.trim() &&
    state.validation?.valid && state.validation.mode &&
    state.validatedIdentity === versionIdentity(state.values) &&
    (state.validation.mode !== "reuse_worktree" || reuseExistingWorktree)
  );
}

export function projectVersionView(
  version: ProjectVersion,
  queue: readonly VersionApplicationQueueEntry[],
  requirements: readonly VersionRequirement[] = [],
  projectStatus: VersionProject["status"] = "active",
  preflight?: ClosePreflight,
): ProjectVersionView {
  const owner = queue.find((entry) => entry.owner || entry.requirementId === version.pendingRequirementId);
  const activeRequirements = requirements.filter((requirement) => !terminalRequirementStatuses.has(requirement.status));
  const stageCounts = requirements.reduce<Record<string, number>>((counts, requirement) => {
    counts[requirement.stage] = (counts[requirement.stage] || 0) + 1;
    return counts;
  }, {});
  const pendingOwner = owner?.code || owner?.requirementId || version.pendingRequirementId || "";
  const maintenanceReason = projectStatus === "archived" ? "项目已归档，版本仅供查看" : "";
  const closeReason = maintenanceReason || (pendingOwner
    ? `${pendingOwner} 正在等待本地提交或撤销`
    : activeRequirements.length
      ? `${activeRequirements[0]?.code || activeRequirements[0]?.id} 等 ${activeRequirements.length} 个需求仍在进行中`
      : preflight?.status !== "ready" ? preflight?.blocker || "" : "");
  return {
    canMaintain: version.status === "active" && !maintenanceReason,
    maintenanceReason,
    canClose: version.status === "active" && !closeReason,
    closeReason: version.status === "closed" ? "版本已关闭" : closeReason,
    pendingOwner,
    queueLength: queue.length,
    waitingCount: queue.filter((entry) => !entry.owner).length,
    requirementCount: requirements.length,
    activeRequirementCount: activeRequirements.length,
    stageCounts,
  };
}

export function mergeVersionSnapshot(current: VersionSnapshot | undefined, result: SnapshotResult): VersionSnapshot {
  if (result.status === "fulfilled") return { requirements: result.value.requirements, queue: result.value.queue };
  return { requirements: current?.requirements || [], queue: current?.queue || [], error: result.reason };
}

export function projectVersionErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : fallback;
  const labels: Record<string, string> = {
    VALIDATION_ERROR: "版本输入无效，请检查后重试",
    PROJECT_ARCHIVED: "项目已归档，不能修改版本",
    PROJECT_NOT_ACTIVE: "项目已归档，不能修改版本",
    PROJECT_NOT_FOUND: "项目不存在或已被删除",
    PROJECT_VERSION_APPLICATION_BUSY: "版本正在处理其他需求，请稍后重试",
    PROJECT_VERSION_APPLICATION_MISMATCH: "本地应用状态与版本不一致，请重新检查",
    PROJECT_VERSION_BASE_BRANCH_INVALID: "基础分支名称无效",
    PROJECT_VERSION_BASE_BRANCH_NOT_FOUND: "基础分支不存在",
    PROJECT_VERSION_BRANCH_IN_USE: "分支已被其他 worktree 使用",
    PROJECT_VERSION_NAME_EXISTS: "版本名称已存在",
    PROJECT_VERSION_BRANCH_EXISTS: "版本分支已被占用",
    PROJECT_VERSION_BRANCH_INVALID: "分支名称无效",
    PROJECT_VERSION_CLOSE_BLOCKED: "版本仍在等待本地提交或撤销",
    PROJECT_VERSION_GIT_UNAVAILABLE: "Git 当前不可用，请检查仓库后重试",
    PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS: "版本仍关联进行中的需求",
    PROJECT_VERSION_ID_INVALID: "项目版本标识无效",
    PROJECT_VERSION_MODE_MISMATCH: "版本分支或 worktree 状态已变化，请重新验证",
    PROJECT_VERSION_NOT_ACTIVE: "版本已关闭，不能再执行维护操作",
    PROJECT_VERSION_NOT_FOUND: "项目版本不存在或已被删除",
    PROJECT_VERSION_OPERATION_FAILED: "版本操作失败，请重新检查后重试",
    PROJECT_VERSION_PATH_ESCAPE: "worktree 路径超出受管理目录",
    PROJECT_VERSION_PATH_IN_USE: "worktree 路径已被占用",
    PROJECT_VERSION_PERSISTENCE_FAILED: "版本记录保存失败，已回滚 Git 改动",
    PROJECT_VERSION_REPOSITORY_INVALID: "项目仓库无法用于版本管理",
    PROJECT_VERSION_REUSE_NOT_CONFIRMED: "复用已有 worktree 前需要明确确认",
    PROJECT_VERSION_WORKTREE_CREATE_FAILED: "创建版本 worktree 失败",
    PROJECT_VERSION_WORKTREE_DIRTY: "worktree 仍有未提交改动，无法关闭",
    PROJECT_VERSION_WORKTREE_EXISTS: "worktree 已被其他版本占用",
    PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH: "worktree 仓库身份与项目不一致",
    PROJECT_VERSION_WORKTREE_INVALID: "worktree 状态异常，请先重新检查",
    PROJECT_VERSION_WORKTREE_MISMATCH: "worktree 与版本分支不一致",
    PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED: "worktree 创建后的状态检查失败",
  };
  return labels[error.code] || (/^[A-Z][A-Z0-9_]+$/.test(error.message) ? fallback : error.message) || fallback;
}

function versionPayload(values: VersionFormState["values"]) {
  return {
    name: values.name.trim(),
    branch: values.branch.trim(),
    baseBranch: values.baseBranch.trim(),
    reuseExistingWorktree: values.reuseExistingWorktree,
  };
}

export function VersionDialog({ project, onClose, onSaved }: { project: VersionProject; onClose: () => void; onSaved: () => Promise<void> }) {
  const [state, setState] = useState<VersionFormState>({
    values: { name: "", branch: "", baseBranch: project.defaultBranch, reuseExistingWorktree: false },
    busy: null,
  });
  const busyRef = useRef(false);
  const change = <K extends keyof VersionFormState["values"]>(field: K, value: VersionFormState["values"][K]) => {
    setState((current) => updateVersionField(current, field, value));
  };
  const validate = async () => {
    if (busyRef.current) return;
    const snapshot = state.values;
    busyRef.current = true;
    setState((current) => ({ ...current, busy: "validate", error: undefined }));
    try {
      const result = await post<ProjectVersionValidation>(`/projects/${project.id}/versions/validate`, versionPayload(snapshot));
      setState((current) => versionIdentity(current.values) === versionIdentity(snapshot)
        ? recordVersionValidation({ ...current, busy: null }, result)
        : { ...current, busy: null });
    } catch (error) {
      setState((current) => ({ ...current, busy: null, validation: undefined, validatedIdentity: undefined, error: projectVersionErrorMessage(error, "版本验证失败") }));
    } finally {
      busyRef.current = false;
    }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !canSaveVersion(state)) return;
    const snapshot = state.values;
    busyRef.current = true;
    setState((current) => ({ ...current, busy: "save", error: undefined }));
    try {
      await post<ProjectVersion>(`/projects/${project.id}/versions`, versionPayload(snapshot));
      await onSaved();
    } catch (error) {
      setState((current) => ({ ...current, busy: null, error: projectVersionErrorMessage(error, "创建版本失败") }));
      busyRef.current = false;
    }
  };
  const busy = state.busy !== null;
  return <AccessibleDialog className="version-dialog" title="创建项目版本" subtitle={`为“${project.name}”创建受管理的本地分支与 worktree`} titleId={`create-version-${project.id}`} descriptionId={`create-version-description-${project.id}`} busy={busy} onClose={onClose}>
    <form onSubmit={save}><fieldset disabled={busy}>
      <div className="version-form-grid"><Field label="版本名称"><input data-autofocus required value={state.values.name} onChange={(event) => change("name", event.target.value)} placeholder="2.2.2" /></Field><Field label="版本分支"><input required value={state.values.branch} onChange={(event) => change("branch", event.target.value)} placeholder="feature/2.2.2" /></Field></div>
      <div className="version-base-row"><Field label="基础分支"><input required value={state.values.baseBranch} onChange={(event) => change("baseBranch", event.target.value)} /></Field><button type="button" className="secondary" disabled={!state.values.name.trim() || !state.values.branch.trim() || !state.values.baseBranch.trim()} onClick={validate}>{state.busy === "validate" ? <RefreshCw className="spin" size={16} /> : <CheckCircle2 size={16} />}验证版本</button></div>
      {state.validation && <div className={`version-validation ${state.validation.valid ? "valid" : "invalid"}`}><b>{state.validation.valid && state.validation.mode ? versionModeLabel(state.validation.mode) : "验证未通过"}</b>{state.validation.headCommit && <span>起始 HEAD <code>{state.validation.headCommit.slice(0, 12)}</code></span>}{state.validation.existingWorktreePath && <code>{state.validation.existingWorktreePath}</code>}{state.validation.error && <small>{state.validation.error}</small>}</div>}
      {state.validation?.mode === "reuse_worktree" && <label className="version-reuse"><input type="checkbox" checked={state.values.reuseExistingWorktree} onChange={(event) => change("reuseExistingWorktree", event.target.checked)} /><span>确认复用上述已有 worktree</span></label>}
    </fieldset>
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={!canSaveVersion(state)}>{state.busy === "save" && <RefreshCw className="spin" size={16} />}创建版本</button></div></form>
  </AccessibleDialog>;
}

export function CloseVersionDialog({ version, view, busy, error, onCancel, onClose, onRefresh }: { version: ProjectVersion; view: ProjectVersionView; busy: boolean; error: string; onCancel: () => void; onClose: () => Promise<void>; onRefresh: () => Promise<void> }) {
  return <AccessibleDialog className="close-version-dialog" role="alertdialog" title={`关闭版本“${version.name}”`} subtitle="关闭后保留分支、worktree 与需求历史，但不能再用于新的本地应用。" titleId={`close-version-${version.id}`} descriptionId={`close-version-description-${version.id}`} busy={busy} onClose={onCancel}>
    <div className="version-close-context"><span>分支 <code>{version.branch}</code></span><span>worktree <code>{version.worktreePath}</code></span></div>
    {view.closeReason && <p className="version-close-blocker" role="alert">{view.closeReason}</p>}
    {error && error !== view.closeReason && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" data-autofocus disabled={busy} onClick={onCancel}>取消</button>{!view.canClose && <button type="button" className="secondary" disabled={busy} onClick={() => void onRefresh()}><RefreshCw className={busy ? "spin" : ""} size={16} />重新检查关闭条件</button>}<button type="button" className="primary danger-action" disabled={busy || !view.canClose} onClick={() => void onClose()}>{busy ? <RefreshCw className="spin" size={16} /> : <Archive size={16} />}确认关闭</button></div>
  </AccessibleDialog>;
}

async function fetchVersionSnapshot(versionId: string): Promise<Pick<VersionSnapshot, "requirements" | "queue">> {
  const [requirements, queue] = await Promise.all([
    api<VersionRequirement[]>(`/project-versions/${versionId}/requirements`),
    api<VersionApplicationQueueEntry[]>(`/project-versions/${versionId}/application-queue`),
  ]);
  return { requirements, queue };
}

export function ProjectVersions({ project }: { project: VersionProject }) {
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState<VersionRefreshState>({ generation: 0, versions: [], snapshots: {} });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [closeAuthority, setCloseAuthority] = useState<CloseAuthority | null>(null);
  const [busyOperations, setBusyOperations] = useState<ReadonlySet<string>>(new Set());
  const activeRef = useRef(true);
  const loadGeneration = useRef(0);
  const busyRef = useRef<ReadonlySet<string>>(new Set());
  const versions = refresh.versions, snapshots = refresh.snapshots;

  useEffect(() => () => { activeRef.current = false; loadGeneration.current += 1; }, []);

  const setOperation = (operation: "recheck" | "preflight" | "close", versionId: string, busy: boolean) => {
    const key = `${operation}:${versionId}`;
    const next = new Set(busyRef.current);
    if (busy) next.add(key); else next.delete(key);
    busyRef.current = next;
    setBusyOperations(next);
  };

  const load = useCallback(async (showLoading = true) => {
    const generation = ++loadGeneration.current;
    setRefresh((current) => beginVersionRefresh(current, generation));
    if (showLoading) setLoading(true);
    setError("");
    try {
      const nextVersions = await api<ProjectVersion[]>(`/projects/${project.id}/versions?status=all`);
      const results = await Promise.all(nextVersions.map(async (version) => {
        try { return [version.id, { status: "fulfilled", value: await fetchVersionSnapshot(version.id) } as SnapshotResult] as const; }
        catch (reason) { return [version.id, { status: "rejected", reason: reason instanceof Error ? reason.message : "版本详情读取失败" } as SnapshotResult] as const; }
      }));
      if (!activeRef.current || generation !== loadGeneration.current) return;
      setRefresh((current) => mergeVersionRefresh(current, generation, {
        versions: nextVersions,
        snapshots: results.reduce<Record<string, VersionSnapshot>>((next, [id, result]) => {
          next[id] = mergeVersionSnapshot(current.snapshots[id], result);
          return next;
        }, {}),
      }));
      setLoaded(true);
    } catch (reason) {
      if (activeRef.current && generation === loadGeneration.current) setError(projectVersionErrorMessage(reason, "项目版本读取失败"));
    } finally {
      if (activeRef.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [project.id]);

  const pendingIds = useMemo(() => versions.filter((version) => version.pendingRequirementId || version.pendingIntegrationRunId).map((version) => version.id), [versions]);
  useEffect(() => {
    if (!expanded || !pendingIds.length) return;
    let current = true;
    let timer = 0;
    const poll = async () => {
      if (busyRef.current.size) {
        if (current) timer = window.setTimeout(poll, 1500);
        return;
      }
      const generation = ++loadGeneration.current;
      setRefresh((state) => beginVersionRefresh(state, generation));
      const results = await Promise.all(pendingIds.map(async (id) => {
        try { return [id, { status: "fulfilled", value: await fetchVersionSnapshot(id) } as SnapshotResult] as const; }
        catch (reason) { return [id, { status: "rejected", reason: reason instanceof Error ? reason.message : "版本状态刷新失败" } as SnapshotResult] as const; }
      }));
      if (!current || !activeRef.current) return;
      let refreshed: ProjectVersion[] | null = null;
      try {
        refreshed = await api<ProjectVersion[]>(`/projects/${project.id}/versions?status=all`);
      } catch {
        // Detail snapshots remain usable while a project-level poll briefly fails.
      }
      if (current && activeRef.current) setRefresh((state) => mergeVersionRefresh(state, generation, {
        versions: refreshed || state.versions,
        snapshots: results.reduce((next, [id, result]) => ({ ...next, [id]: mergeVersionSnapshot(next[id], result) }), state.snapshots),
      }));
      if (current) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { current = false; window.clearTimeout(timer); };
  }, [expanded, pendingIds.join(","), project.id]);

  const grouped = groupProjectVersions(versions);
  const authorityDependencies: CloseAuthorityDependencies = {
    recheck: (versionId) => post(`/project-versions/${versionId}/recheck`, {}),
    listVersions: (projectId) => api<ProjectVersion[]>(`/projects/${projectId}/versions?status=all`),
    loadSnapshot: fetchVersionSnapshot,
  };
  const mergeAuthority = (generation: number, authority: CloseAuthority) => {
    if (!activeRef.current || generation !== loadGeneration.current) return;
    setRefresh((state) => mergeVersionRefresh(state, generation, {
      versions: state.versions.map((item) => item.id === authority.version.id ? authority.version : item),
      snapshots: { ...state.snapshots, [authority.version.id]: authority.snapshot },
    }));
    setCloseAuthority(authority);
  };
  const prepareClose = async (version: ProjectVersion) => {
    const key = `preflight:${version.id}`;
    if (busyRef.current.has(key) || busyRef.current.has(`close:${version.id}`)) return;
    setOperation("preflight", version.id, true);
    setCloseAuthority((current) => current?.version.id === version.id
      ? { ...current, preflight: { status: "checking", blocker: "正在刷新版本关闭条件" }, error: "" }
      : current);
    const generation = ++loadGeneration.current;
    setRefresh((current) => beginVersionRefresh(current, generation));
    try {
      const authority = await loadCloseAuthority(project.id, version, snapshots[version.id] || { requirements: [], queue: [] }, authorityDependencies);
      mergeAuthority(generation, authority);
    } finally {
      setOperation("preflight", version.id, false);
    }
  };
  const recheck = async (version: ProjectVersion) => {
    const key = `recheck:${version.id}`;
    if (busyRef.current.has(key)) return;
    setOperation("recheck", version.id, true);
    setError("");
    try { await post(`/project-versions/${version.id}/recheck`, {}); await load(false); }
    catch (reason) { setError(projectVersionErrorMessage(reason, "版本重新检查失败")); }
    finally { setOperation("recheck", version.id, false); }
  };
  const close = async () => {
    if (!closeAuthority) return;
    const authorityBeforeClose = closeAuthority;
    const target = authorityBeforeClose.version;
    const key = `close:${target.id}`;
    if (busyRef.current.has(key)) return;
    setOperation("close", target.id, true);
    setCloseAuthority((current) => current ? { ...current, error: "" } : current);
    try { await post(`/project-versions/${target.id}/close`, {}); setCloseAuthority(null); await load(false); }
    catch (reason) {
      const generation = ++loadGeneration.current;
      setRefresh((current) => beginVersionRefresh(current, generation));
      const refreshed = await loadCloseAuthority(project.id, target, authorityBeforeClose.snapshot, {
        ...authorityDependencies,
        recheck: async () => { throw reason; },
      });
      mergeAuthority(generation, closeAuthorityAfterFailure(refreshed, reason));
    }
    finally { setOperation("close", target.id, false); }
  };

  return <>
    <details className="project-versions" onToggle={(event) => {
      const open = event.currentTarget.open;
      setExpanded(open);
      if (open && !loaded && !loading) void load();
    }}>
      <summary><span><GitBranch size={15} /><b>项目版本</b></span><span>{loaded ? `${grouped.active.length} 个使用中 · ${grouped.closed.length} 个已关闭` : "展开读取版本"}</span></summary>
      <div className="version-section-head"><span>{loading ? "正在读取项目版本" : `共 ${versions.length} 个版本`}</span>{project.status !== "archived" && <button type="button" className="secondary" onClick={() => setCreatorOpen(true)}><Plus size={15} />创建版本</button>}</div>
      {error && <p className="project-inline-error version-error" role="alert">{error}</p>}
      {!loading && loaded && versions.length === 0 && <div className="version-empty">还没有项目版本</div>}
      <VersionGroup title="使用中" projectStatus={project.status} versions={grouped.active} snapshots={snapshots} busyOperations={busyOperations} onRecheck={recheck} onClose={(version) => void prepareClose(version)} />
      <VersionGroup title="已关闭" projectStatus={project.status} versions={grouped.closed} snapshots={snapshots} busyOperations={busyOperations} onRecheck={recheck} onClose={(version) => void prepareClose(version)} />
    </details>
    {creatorOpen && <VersionDialog project={project} onClose={() => setCreatorOpen(false)} onSaved={async () => { setCreatorOpen(false); await load(false); }} />}
    {closeAuthority && <CloseVersionDialog version={closeAuthority.version} view={projectVersionView(closeAuthority.version, closeAuthority.snapshot.queue, closeAuthority.snapshot.requirements, project.status, closeAuthority.preflight)} busy={busyOperations.has(`preflight:${closeAuthority.version.id}`) || busyOperations.has(`close:${closeAuthority.version.id}`)} error={closeAuthority.error} onCancel={() => { if (!busyRef.current.has(`preflight:${closeAuthority.version.id}`) && !busyRef.current.has(`close:${closeAuthority.version.id}`)) setCloseAuthority(null); }} onClose={close} onRefresh={() => prepareClose(closeAuthority.version)} />}
  </>;
}

function VersionGroup({ title, projectStatus, versions, snapshots, busyOperations, onRecheck, onClose }: { title: string; projectStatus: VersionProject["status"]; versions: ProjectVersion[]; snapshots: Record<string, VersionSnapshot>; busyOperations: ReadonlySet<string>; onRecheck: (version: ProjectVersion) => Promise<void>; onClose: (version: ProjectVersion) => void }) {
  if (!versions.length) return null;
  return <section className="version-group"><h4>{title}<b>{versions.length}</b></h4>{versions.map((version) => {
    const snapshot = snapshots[version.id] || { requirements: [], queue: [] };
    const view = projectVersionView(version, snapshot.queue, snapshot.requirements, projectStatus);
    return <article className="version-row" key={version.id}>
      <div className="version-identity"><div><b>{version.name}</b><span className={`version-status ${version.status}`}>{version.status === "active" ? "使用中" : "已关闭"}</span></div><code>{version.branch}</code><small>基础分支 {version.baseBranch}</small></div>
      <div className="version-metadata"><span>HEAD <code>{version.headCommit.slice(0, 12)}</code></span><span>worktree <code>{version.worktreePath}</code></span><div className="version-stage-counts">{Object.entries(view.stageCounts).map(([stage, count]) => <span key={stage}>{stageLabels[stage] || stage} <b>{count}</b></span>)}{!view.requirementCount && <span>暂无需求</span>}</div>{view.pendingOwner && <span className="version-pending">待本地处理 <b>{view.pendingOwner}</b></span>}<span>应用队列 <b>{view.queueLength}</b>{view.waitingCount ? ` · 等待 ${view.waitingCount}` : ""}</span>{snapshot.error && <small className="version-snapshot-error">刷新失败：{snapshot.error}</small>}</div>
      {view.canMaintain && <div className="version-actions"><button type="button" className="icon-btn" title="重新检查版本" aria-label="重新检查版本" disabled={busyOperations.has(`recheck:${version.id}`) || busyOperations.has(`preflight:${version.id}`) || busyOperations.has(`close:${version.id}`)} onClick={() => void onRecheck(version)}><RefreshCw className={busyOperations.has(`recheck:${version.id}`) ? "spin" : ""} size={16} /></button><button type="button" className="icon-btn" title={view.closeReason || "关闭版本"} aria-label="关闭版本" disabled={busyOperations.has(`recheck:${version.id}`) || busyOperations.has(`preflight:${version.id}`) || busyOperations.has(`close:${version.id}`)} onClick={() => onClose(version)}>{busyOperations.has(`preflight:${version.id}`) ? <RefreshCw className="spin" size={16} /> : <Archive size={16} />}</button></div>}
      {view.closeReason && version.status === "active" && <small className="version-row-blocker">{view.closeReason}</small>}
    </article>;
  })}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}
