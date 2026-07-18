import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import {
  archiveErrorMessage,
  beginProjectDetails,
  canCloseDialog,
  filterProjects,
  initialSubmissionState,
  normalizeAllowedCommands,
  parseAllowedCommands,
  projectActions,
  projectHealth,
  projectFieldErrors,
  projectValidationLabel,
  mergeProjectDetails,
  nextFocusIndex,
  shouldStartSubmission,
  submissionReducer,
  validationAfterChange,
} from "./project-management.js";

describe("project management helpers", () => {
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

  it("maps structured project API errors to repository fields", () => {
    expect(projectFieldErrors(new ApiError("PROJECT_REPOSITORY_INVALID", "invalid", { defaultBranch: "missing" }, 400))).toEqual({ repoPath: "invalid", defaultBranch: "invalid", general: "" });
    expect(projectFieldErrors(new ApiError("PROJECT_REPO_PATH_EXISTS", "duplicate", null, 409))).toEqual({ repoPath: "duplicate", defaultBranch: "", general: "" });
    expect(projectFieldErrors(new ApiError("UNKNOWN", "unknown", null, 400))).toEqual({ repoPath: "", defaultBranch: "", general: "unknown" });
  });

  it("uses structured archive conflicts without localized message matching", () => {
    expect(archiveErrorMessage(new ApiError("PROJECT_IN_ACTIVE_DELIVERY", "localized text can change", null, 409), "Orders")).toBe("无法归档“Orders”：项目正在用于活动交付，请先完成或停止相关需求。");
    expect(archiveErrorMessage(new ApiError("UNKNOWN", "archive failed", null, 500), "Orders")).toBe("archive failed");
  });
});
