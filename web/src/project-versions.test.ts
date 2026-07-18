import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectVersion, ProjectVersionValidation } from "@ai-workflow/shared";
import { ApiError } from "./api.js";
import {
  CloseVersionDialog,
  VersionDialog,
  beginVersionRefresh,
  canSaveVersion,
  closePreflightFromError,
  closePreflightFromRecheck,
  closeAuthorityAfterFailure,
  groupProjectVersions,
  mergeVersionSnapshot,
  mergeVersionRefresh,
  loadCloseAuthority,
  projectVersionView,
  projectVersionErrorMessage,
  recordVersionValidation,
  updateVersionField,
  versionModeLabel,
  type VersionFormState,
} from "./project-versions.js";

const version = (overrides: Partial<ProjectVersion> = {}): ProjectVersion => ({
  id: "version-1",
  projectId: "project-1",
  name: "2.2.1",
  branch: "feature/2.2.1",
  baseBranch: "main",
  worktreePath: "/repo/.worktrees/version-1",
  status: "active",
  headCommit: "1234567890abcdef",
  createdAt: "2026-07-18T10:00:00.000Z",
  updatedAt: "2026-07-18T10:00:00.000Z",
  ...overrides,
});

const form = (overrides: Partial<VersionFormState["values"]> = {}): VersionFormState => ({
  values: {
    name: "2.2.2",
    branch: "feature/2.2.2",
    baseBranch: "main",
    reuseExistingWorktree: false,
    ...overrides,
  },
  busy: null,
});

const validation = (mode: ProjectVersionValidation["mode"] = "create_branch"): ProjectVersionValidation => ({
  valid: true,
  mode,
  branch: "feature/2.2.2",
  baseBranch: "main",
  headCommit: "abcdef1234567890",
});

describe("project version view model", () => {
  it("groups active and closed versions without losing their order", () => {
    const closed = version({ id: "closed", name: "1.0.0", status: "closed" });
    const active = version({ id: "active", name: "2.0.0" });

    expect(groupProjectVersions([closed, active])).toEqual({ active: [active], closed: [closed] });
  });

  it("uses explicit Chinese labels for every create mode", () => {
    expect(versionModeLabel("create_branch")).toBe("创建新分支和独立 worktree");
    expect(versionModeLabel("attach_branch")).toBe("挂载已有分支到独立 worktree");
    expect(versionModeLabel("reuse_worktree")).toBe("复用已有 worktree");
  });

  it.each([
    ["PROJECT_VERSION_BRANCH_IN_USE", "分支已被其他 worktree 使用"],
    ["PROJECT_VERSION_GIT_UNAVAILABLE", "Git 当前不可用，请检查仓库后重试"],
    ["PROJECT_VERSION_MODE_MISMATCH", "版本分支或 worktree 状态已变化，请重新验证"],
    ["PROJECT_VERSION_NOT_ACTIVE", "版本已关闭，不能再执行维护操作"],
    ["PROJECT_VERSION_WORKTREE_DIRTY", "worktree 仍有未提交改动，无法关闭"],
    ["PROJECT_VERSION_WORKTREE_INVALID", "worktree 状态异常，请先重新检查"],
    ["PROJECT_VERSION_APPLICATION_BUSY", "版本正在处理其他需求，请稍后重试"],
    ["PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS", "版本仍关联进行中的需求"],
    ["PROJECT_VERSION_CLOSE_BLOCKED", "版本仍在等待本地提交或撤销"],
    ["PROJECT_VERSION_NOT_FOUND", "项目版本不存在或已被删除"],
    ["PROJECT_NOT_FOUND", "项目不存在或已被删除"],
    ["PROJECT_VERSION_NAME_EXISTS", "版本名称已存在"],
    ["PROJECT_VERSION_BRANCH_EXISTS", "版本分支已被占用"],
    ["PROJECT_VERSION_BRANCH_INVALID", "分支名称无效"],
    ["PROJECT_VERSION_BASE_BRANCH_INVALID", "基础分支名称无效"],
    ["PROJECT_VERSION_BASE_BRANCH_NOT_FOUND", "基础分支不存在"],
    ["PROJECT_ARCHIVED", "项目已归档，不能修改版本"],
    ["PROJECT_NOT_ACTIVE", "项目已归档，不能修改版本"],
    ["PROJECT_VERSION_APPLICATION_MISMATCH", "本地应用状态与版本不一致，请重新检查"],
    ["PROJECT_VERSION_ID_INVALID", "项目版本标识无效"],
    ["PROJECT_VERSION_OPERATION_FAILED", "版本操作失败，请重新检查后重试"],
    ["PROJECT_VERSION_PATH_ESCAPE", "worktree 路径超出受管理目录"],
    ["PROJECT_VERSION_PATH_IN_USE", "worktree 路径已被占用"],
    ["PROJECT_VERSION_PERSISTENCE_FAILED", "版本记录保存失败，已回滚 Git 改动"],
    ["PROJECT_VERSION_REPOSITORY_INVALID", "项目仓库无法用于版本管理"],
    ["PROJECT_VERSION_REUSE_NOT_CONFIRMED", "复用已有 worktree 前需要明确确认"],
    ["PROJECT_VERSION_WORKTREE_CREATE_FAILED", "创建版本 worktree 失败"],
    ["PROJECT_VERSION_WORKTREE_EXISTS", "worktree 已被其他版本占用"],
    ["PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH", "worktree 仓库身份与项目不一致"],
    ["PROJECT_VERSION_WORKTREE_MISMATCH", "worktree 与版本分支不一致"],
    ["PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED", "worktree 创建后的状态检查失败"],
    ["VALIDATION_ERROR", "版本输入无效，请检查后重试"],
  ])("maps %s to a stable user-facing message", (code, expected) => {
    const message = projectVersionErrorMessage(new ApiError(code, code, null, 409), "版本操作失败");
    expect(message).toBe(expected);
    expect(message).not.toContain("PROJECT_");
  });

  it("uses the operation fallback for an unknown internal project version code", () => {
    expect(projectVersionErrorMessage(new ApiError("PROJECT_VERSION_NEW_FAILURE", "PROJECT_VERSION_NEW_FAILURE"), "版本操作失败"))
      .toBe("版本操作失败");
  });

  it("invalidates validation when branch identity changes", () => {
    const validated = recordVersionValidation(form(), validation());
    expect(canSaveVersion(validated)).toBe(true);
    expect(canSaveVersion(updateVersionField(validated, "branch", "feature/2.2.3"))).toBe(false);
    expect(canSaveVersion(updateVersionField(validated, "baseBranch", "develop"))).toBe(false);
    expect(canSaveVersion(updateVersionField(validated, "name", "2.2.3"))).toBe(false);
  });

  it("requires explicit reuse confirmation for an existing worktree", () => {
    const inspected = recordVersionValidation(form(), validation("reuse_worktree"));
    expect(canSaveVersion(inspected)).toBe(false);
    expect(canSaveVersion(updateVersionField(inspected, "reuseExistingWorktree", true))).toBe(true);
  });

  it("shows the pending requirement and blocks closing", () => {
    const queue = [{ requirementId: "REQ-0001", code: "REQ-0001", title: "结算", status: "awaiting_merge", updatedAt: "2026-07-18T10:00:00.000Z", owner: true, position: 1 }];
    expect(projectVersionView(version({ pendingRequirementId: "REQ-0001" }), queue)).toMatchObject({
      canClose: false,
      closeReason: "REQ-0001 正在等待本地提交或撤销",
      pendingOwner: "REQ-0001",
      queueLength: 1,
      waitingCount: 0,
    });
  });

  it("makes active versions read-only when their project is archived", () => {
    expect((projectVersionView as any)(version(), [], [], "archived")).toMatchObject({
      canMaintain: false,
      canClose: false,
      maintenanceReason: "项目已归档，版本仅供查看",
      closeReason: "项目已归档，版本仅供查看",
    });
  });

  it("does not allow closing before an authoritative preflight is ready", () => {
    expect((projectVersionView as any)(version(), [], [], "active", { status: "checking", blocker: "正在刷新版本关闭条件" })).toMatchObject({
      canClose: false,
      closeReason: "正在刷新版本关闭条件",
    });
    expect((projectVersionView as any)(version(), [], [], "active", { status: "blocked", blocker: "worktree 仍有未提交改动，无法关闭" })).toMatchObject({
      canClose: false,
      closeReason: "worktree 仍有未提交改动，无法关闭",
    });
  });

  it("derives authoritative close readiness from recheck results", () => {
    expect(closePreflightFromRecheck({ version: version(), inspection: { valid: true, clean: true, headCommit: "head", status: "ok" } })).toEqual({ status: "ready", blocker: "" });
    expect(closePreflightFromRecheck({ version: version(), inspection: { valid: true, clean: false, headCommit: "head", status: "dirty" } })).toEqual({ status: "blocked", blocker: "worktree 仍有未提交改动，无法关闭" });
    expect(closePreflightFromRecheck({ status: "pending" })).toEqual({ status: "blocked", blocker: "版本仍在等待本地提交或撤销" });
    expect(closePreflightFromRecheck({ status: "committed", commit: "head" })).toEqual({ status: "ready", blocker: "" });
    expect(closePreflightFromRecheck({ status: "ambiguous", currentHead: "head" })).toEqual({ status: "blocked", blocker: "本地应用状态需要人工处理，无法关闭版本" });
  });

  it("turns invalid recheck errors into close blockers", () => {
    expect(closePreflightFromError(new ApiError("PROJECT_VERSION_WORKTREE_INVALID", "PROJECT_VERSION_WORKTREE_INVALID"))).toEqual({
      status: "blocked",
      blocker: "worktree 状态异常，请先重新检查",
    });
  });

  it("refreshes version, requirements, and queue before allowing close", async () => {
    const latest = version({ pendingRequirementId: "r-owner" });
    const authority = await loadCloseAuthority("project-1", version(), { requirements: [], queue: [] }, {
      recheck: async () => ({ status: "pending" }),
      listVersions: async () => [latest],
      loadSnapshot: async () => ({
        requirements: [{ id: "r-new", code: "REQ-NEW", stage: "coding", status: "ai_running" }],
        queue: [{ requirementId: "r-owner", code: "REQ-OWNER", title: "Owner", status: "awaiting_local_resolution", updatedAt: "1", owner: true, position: 1 }],
      }),
    });
    expect(authority.version).toBe(latest);
    expect(projectVersionView(authority.version, authority.snapshot.queue, authority.snapshot.requirements, "active", authority.preflight)).toMatchObject({
      canClose: false,
      pendingOwner: "REQ-OWNER",
      activeRequirementCount: 1,
      closeReason: "REQ-OWNER 正在等待本地提交或撤销",
    });
  });

  it("preserves the previous close display when any authority refresh step fails", async () => {
    const previous = { requirements: [{ id: "old", stage: "testing", status: "completed" }], queue: [] };
    const currentVersion = version();
    const authority = await loadCloseAuthority("project-1", currentVersion, previous, {
      recheck: async () => ({ version: currentVersion, inspection: { valid: true, clean: true } }),
      listVersions: async () => [version({ headCommit: "new-head" })],
      loadSnapshot: async () => { throw new Error("queue unavailable"); },
    });
    expect(authority.version).toBe(currentVersion);
    expect(authority.snapshot).toBe(previous);
    expect(authority.preflight).toMatchObject({ status: "blocked" });
    expect(authority.preflight.blocker).toContain("无法确认版本当前状态");
  });

  it("requires a fresh preflight after a close conflict without permanently caching it", async () => {
    const authority = { version: version(), snapshot: { requirements: [], queue: [] }, preflight: { status: "ready", blocker: "" } as const, error: "" };
    const failed = closeAuthorityAfterFailure(authority, new ApiError("PROJECT_VERSION_WORKTREE_DIRTY", "PROJECT_VERSION_WORKTREE_DIRTY"));
    expect(failed).toMatchObject({
      preflight: { status: "blocked", blocker: "worktree 仍有未提交改动，无法关闭" },
      error: "worktree 仍有未提交改动，无法关闭",
    });
    const refreshed = await loadCloseAuthority("project-1", failed.version, failed.snapshot, {
      recheck: async () => ({ version: failed.version, inspection: { valid: true, clean: true } }),
      listVersions: async () => [failed.version],
      loadSnapshot: async () => ({ requirements: [], queue: [] }),
    });
    expect(refreshed.preflight).toEqual({ status: "ready", blocker: "" });
  });

  it("blocks closing while active requirements remain and counts requirement stages", () => {
    const requirements = [
      { id: "r1", code: "REQ-1", stage: "coding", status: "ai_running" },
      { id: "r2", code: "REQ-2", stage: "coding", status: "completed" },
      { id: "r3", code: "REQ-3", stage: "integration", status: "closed" },
    ];
    expect(projectVersionView(version(), [], requirements)).toMatchObject({
      canClose: false,
      closeReason: "REQ-1 等 1 个需求仍在进行中",
      requirementCount: 3,
      activeRequirementCount: 1,
      stageCounts: { coding: 2, integration: 1 },
    });
  });

  it("counts only waiters behind the queue owner", () => {
    const queue = [
      { requirementId: "r1", code: "REQ-1", title: "Owner", status: "awaiting_merge", updatedAt: "1", owner: true, position: 1 },
      { requirementId: "r2", code: "REQ-2", title: "Waiter", status: "awaiting_merge", updatedAt: "2", owner: false, position: 2 },
    ];
    expect(projectVersionView(version({ pendingRequirementId: "r1" }), queue)).toMatchObject({ pendingOwner: "REQ-1", queueLength: 2, waitingCount: 1 });
  });

  it("retains the last successful snapshot across transient refresh failures", () => {
    const successful = mergeVersionSnapshot(undefined, { status: "fulfilled", value: {
      requirements: [{ id: "r1", stage: "integration", status: "awaiting_merge" }],
      queue: [{ requirementId: "r1", code: "REQ-1", title: "Owner", status: "awaiting_merge", updatedAt: "1", owner: true, position: 1 }],
    } });
    const failed = mergeVersionSnapshot(successful, { status: "rejected", reason: "temporary unavailable" });
    expect(failed).toMatchObject({ requirements: [{ id: "r1" }], queue: [{ requirementId: "r1" }], error: "temporary unavailable" });
    expect(mergeVersionSnapshot(failed, { status: "fulfilled", value: { requirements: [], queue: [] } })).toEqual({ requirements: [], queue: [] });
  });

  it("rejects an old poll response after a manual refresh has started", () => {
    const initial = { generation: 1, versions: [version({ id: "old" })], snapshots: {} };
    const manual = beginVersionRefresh(initial, 2);
    const stalePoll = mergeVersionRefresh(manual, 1, { versions: [version({ id: "stale" })], snapshots: {} });
    expect(stalePoll).toBe(manual);
    expect(mergeVersionRefresh(manual, 2, { versions: [version({ id: "fresh" })], snapshots: {} }).versions[0]?.id).toBe("fresh");
  });
});

describe("project version dialogs", () => {
  it("renders validation mode and keeps save disabled until validation succeeds", () => {
    const markup = renderToStaticMarkup(React.createElement(VersionDialog, {
      project: { id: "project-1", name: "Orders", defaultBranch: "main" },
      onClose: () => undefined,
      onSaved: async () => undefined,
    }));
    expect(markup).toContain("创建项目版本");
    expect(markup).toContain("验证版本");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders a close blocker inside the application dialog", () => {
    const markup = renderToStaticMarkup(React.createElement(CloseVersionDialog, {
      version: version({ pendingRequirementId: "REQ-0001" }),
      view: projectVersionView(version({ pendingRequirementId: "REQ-0001" }), []),
      busy: false,
      error: "",
      onCancel: () => undefined,
      onClose: async () => undefined,
      onRefresh: async () => undefined,
    }));
    expect(markup).toContain("REQ-0001 正在等待本地提交或撤销");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("重新检查关闭条件");
  });
});
