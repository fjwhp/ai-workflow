import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectVersion, ProjectVersionValidation } from "@ai-workflow/shared";
import {
  CloseVersionDialog,
  VersionDialog,
  canSaveVersion,
  groupProjectVersions,
  mergeVersionSnapshot,
  projectVersionView,
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
    }));
    expect(markup).toContain("REQ-0001 正在等待本地提交或撤销");
    expect(markup).toContain("disabled=\"\"");
  });
});
