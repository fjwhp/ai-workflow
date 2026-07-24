import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import {
  archiveErrorMessage,
  addBusyOperation,
  beginProjectDetails,
  buildProjectMutationPayload,
  canCloseDialog,
  filterProjects,
  initialSubmissionState,
  normalizeAllowedCommands,
  parseAllowedCommands,
  projectActions,
  projectHealth,
  projectFieldErrors,
  projectValidationLabel,
  ProjectBand,
  mergeProjectDetails,
  nextFocusIndex,
  shouldStartSubmission,
  isOperationBusy,
  removeBusyOperation,
  submissionReducer,
  validationAfterChange,
} from "./project-management.js";

describe("project management helpers", () => {
  it("mounts version management below a project's knowledge and memory area", () => {
    const markup = renderToStaticMarkup(React.createElement(ProjectBand, {
      project: { id: "p1", name: "Orders", repoPath: "/repo", defaultBranch: "main", category: null, technology: [], status: "active" },
      knowledge: null,
      memory: null,
      detailErrors: null,
      rebuildBusy: false,
      archiveBusy: false,
      onEdit: () => undefined,
      onValidate: () => undefined,
      onRebuild: () => undefined,
      onArchive: () => undefined,
    }));
    expect(markup).toContain("项目持续记忆");
    expect(markup).toContain("项目版本");
  });

  it("exposes maintenance actions only for active projects", () => {
    expect(projectActions("active")).toEqual(["edit", "validate", "rebuild", "archive"]);
    expect(projectActions("archived")).toEqual(["view"]);
  });

  it("summarizes a valid Node pnpm repository inspection", () => {
    expect(projectValidationLabel({ valid: true, technology: ["node", "fastify"], packageManager: "pnpm" })).toBe("验证通过 · Node.js / Fastify · pnpm");
  });

  it("parses line-based allowed commands without shell interpretation", () => {
    expect(parseAllowedCommands("pnpm test\nnpm run lint\n")).toEqual({
      commands: [{ command: "pnpm", argsPrefix: ["test"] }, { command: "npm", argsPrefix: ["run", "lint"] }],
      error: "",
    });
    expect(parseAllowedCommands("pnpm test && rm -rf / ").error).toContain("不支持");
    expect(normalizeAllowedCommands([{ command: "pnpm", argsPrefix: ["test"] }])).toBe("pnpm test");
  });

  it("filters active and archived projects and retains both counts", () => {
    const projects = [{ id: "a", status: "active" }, { id: "b", status: "archived" }, { id: "c", status: "active" }] as const;
    expect(filterProjects(projects, "active")).toEqual({ list: [projects[0], projects[2]], active: 2, archived: 1, total: 3 });
    expect(filterProjects(projects, "archived").list).toEqual([projects[1]]);
  });

  it("invalidates validation only when repository identity changes", () => {
    const validation = { repoPath: "/repo", defaultBranch: "main", result: { valid: true } };
    expect(validationAfterChange(validation, "name", "Renamed")).toBe(validation);
    expect(validationAfterChange(validation, "category", "backend")).toBe(validation);
    expect(validationAfterChange(validation, "repoPath", "/other")).toBeNull();
    expect(validationAfterChange(validation, "defaultBranch", "dev")).toBeNull();
  });

  it("labels archived and unhealthy projects", () => {
    expect(projectHealth({ status: "archived" })).toEqual({ label: "已归档", tone: "archived" });
    expect(projectHealth({ status: "active" }, { status: "failed" })).toEqual({ label: "知识构建失败", tone: "failed" });
    expect(projectHealth({ status: "active" }, { status: "ready" })).toEqual({ label: "运行正常", tone: "ready" });
  });

  it("preserves form values after an API submission failure", () => {
    const form = { name: "Orders", repoPath: "/repo" };
    const busy = submissionReducer(initialSubmissionState(form), { type: "submit" });
    expect(submissionReducer(busy, { type: "failure", error: "重复仓库" })).toEqual({ form, submitting: false, error: "重复仓库" });
  });

  it("does not let edits clear an in-flight submission", () => {
    const busy = submissionReducer(initialSubmissionState({ name: "Orders" }), { type: "submit" });
    const changed = submissionReducer(busy, { type: "change", form: { name: "Renamed" } });
    expect(changed).toMatchObject({ form: { name: "Renamed" }, submitting: true });
    expect(shouldStartSubmission(changed)).toBe(false);
  });

  it("merges independent detail results and rejects stale generations", () => {
    const state = beginProjectDetails({ generation: 0, knowledge: { old: {}, p1: { status: "stale" } }, memory: { old: {}, p1: { total: 9 } }, errors: {} }, 2, ["p1"]);
    expect(state).toEqual({ generation: 2, knowledge: {}, memory: {}, errors: {} });
    const knowledge = mergeProjectDetails(state, 2, "p1", "knowledge", { status: "fulfilled", value: { status: "ready" } });
    const partial = mergeProjectDetails(knowledge, 2, "p1", "memory", { status: "rejected", reason: "memory unavailable" });
    expect(partial.knowledge.p1).toEqual({ status: "ready" });
    expect(partial.memory.p1).toBeUndefined();
    expect(partial.errors.p1).toEqual({ memory: "memory unavailable" });
    expect(mergeProjectDetails(partial, 1, "p1", "knowledge", { status: "fulfilled", value: { status: "stale" } })).toBe(partial);
  });

  it("cycles dialog focus and blocks Escape while busy", () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(canCloseDialog("Escape", false)).toBe(true);
    expect(canCloseDialog("Escape", true)).toBe(false);
    expect(canCloseDialog("Enter", false)).toBe(false);
  });

  it("isolates concurrent project operations and rejects duplicates", () => {
    const a = addBusyOperation(new Set<string>(), "rebuild", "a");
    expect(a.started).toBe(true);
    const duplicate = addBusyOperation(a.busy, "rebuild", "a");
    expect(duplicate.started).toBe(false);
    const b = addBusyOperation(duplicate.busy, "archive", "b");
    expect(isOperationBusy(b.busy, "rebuild", "a")).toBe(true);
    expect(isOperationBusy(b.busy, "archive", "b")).toBe(true);
    const afterA = removeBusyOperation(b.busy, "rebuild", "a");
    expect(isOperationBusy(afterA, "rebuild", "a")).toBe(false);
    expect(isOperationBusy(afterA, "archive", "b")).toBe(true);
  });

  it("retains building knowledge through a transient poll failure then clears the error", () => {
    const initial = { generation: 3, knowledge: { p1: { status: "building", version: 2 } }, memory: {}, errors: {} };
    const failed = mergeProjectDetails(initial, 3, "p1", "knowledge", { status: "rejected", reason: "temporary" }, { retainRejected: true });
    expect(failed.knowledge.p1).toEqual({ status: "building", version: 2 });
    expect(failed.errors.p1).toEqual({ knowledge: "temporary" });
    const recovered = mergeProjectDetails(failed, 3, "p1", "knowledge", { status: "fulfilled", value: { status: "ready", version: 2 } }, { retainRejected: true });
    expect(recovered.knowledge.p1.status).toBe("ready");
    expect(recovered.errors.p1).toBeUndefined();
  });

  it("maps structured project API errors to repository fields", () => {
    expect(projectFieldErrors(new ApiError("PROJECT_REPOSITORY_INVALID", "invalid", { defaultBranch: "missing" }, 400))).toEqual({ repoPath: "invalid", defaultBranch: "invalid", general: "" });
    expect(projectFieldErrors(new ApiError("PROJECT_REPO_PATH_EXISTS", "duplicate", null, 409))).toEqual({ repoPath: "duplicate", defaultBranch: "", general: "" });
    expect(projectFieldErrors(new ApiError("UNKNOWN", "unknown", null, 400))).toEqual({ repoPath: "", defaultBranch: "", general: "unknown" });
  });

  it("uses structured archive conflicts without localized message matching", () => {
    expect(archiveErrorMessage(new ApiError("PROJECT_IN_ACTIVE_DELIVERY", "localized text can change", null, 409), "Orders")).toBe("无法归档“Orders”：项目正在用于活动交付，请先完成或停止相关需求。");
    expect(archiveErrorMessage(new ApiError("UNKNOWN", "archive failed", null, 500), "Orders")).toBe("archive failed");
  });

  it("omits an unset category when creating and includes validated identity", () => {
    const form = { name: " Orders ", repoPath: "/typed", defaultBranch: " main ", category: "", allowedCommands: "pnpm test", sensitivePatterns: ".env" };
    const validation = { repoPath: "/typed", defaultBranch: " main ", result: { repoPath: "/canonical" } } as any;
    expect(buildProjectMutationPayload(form, [{ command: "pnpm", argsPrefix: ["test"] }], validation)).toEqual({ name: "Orders", repoPath: "/canonical", defaultBranch: "main", allowedCommands: [{ command: "pnpm", argsPrefix: ["test"] }], sensitivePatterns: [".env"] });
  });

  it("sends an explicit category when creating", () => {
    const form = { name: "Web", repoPath: "/repo", defaultBranch: "main", category: "frontend", allowedCommands: "", sensitivePatterns: "" };
    expect(buildProjectMutationPayload(form, [], { repoPath: "/repo", defaultBranch: "main", result: { repoPath: "/repo" } } as any)).toMatchObject({ category: "frontend", repoPath: "/repo", defaultBranch: "main" });
  });

  it("clears category on update while omitting unchanged repository identity", () => {
    const form = { name: "API", repoPath: "/repo", defaultBranch: "main", category: "", allowedCommands: "", sensitivePatterns: "" };
    const existing = { repoPath: "/repo", defaultBranch: "main" } as any;
    expect(buildProjectMutationPayload(form, [], { repoPath: "/repo", defaultBranch: "main", result: { repoPath: "/repo" } } as any, existing)).toEqual({ name: "API", category: null, allowedCommands: [], sensitivePatterns: [] });
  });

  it("includes only changed repository identity fields on update", () => {
    const form = { name: "API", repoPath: "/new", defaultBranch: "dev", category: "backend", allowedCommands: "", sensitivePatterns: "" };
    const payload = buildProjectMutationPayload(form, [], { repoPath: "/new", defaultBranch: "dev", result: { repoPath: "/canonical-new" } } as any, { repoPath: "/old", defaultBranch: "main" } as any);
    expect(payload).toMatchObject({ repoPath: "/canonical-new", defaultBranch: "dev", category: "backend" });
  });
});
