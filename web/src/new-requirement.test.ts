import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import {
  canSaveNewRequirement,
  newRequirementPayload,
  newRequirementProjectsView,
  newRequirementApiErrors,
  newRequirementVersionView,
  selectRequirementProject,
  validateNewRequirement,
  type NewRequirementForm
} from "./new-requirement.js";

const complete: NewRequirementForm = {
  title: "统一订单备注校验",
  businessProblem: "订单备注目前缺少统一的业务校验规则",
  expectedOutcome: "所有入口使用一致规则",
  priority: "medium",
  primaryProjectId: "api",
  primaryProjectVersionId: "v-api"
};

describe("new requirement state", () => {
  it("clears a selected version when the project changes", () => {
    expect(selectRequirementProject(complete, "web")).toMatchObject({
      primaryProjectId: "web",
      primaryProjectVersionId: ""
    });
  });

  it("guides the user to create a version when the selected project has none", () => {
    expect(newRequirementVersionView("api", { status: "loaded", value: [] })).toMatchObject({
      showCreateVersion: true,
      canSave: false
    });
    expect(newRequirementVersionView("", { status: "loaded", value: [] }).showCreateVersion).toBe(false);
  });

  it("shows retry instead of empty-state actions when project or version loading fails", () => {
    expect(newRequirementProjectsView({ status: "error", error: "项目服务不可用" })).toEqual({ loading: false, error: "项目服务不可用", showRetry: true, showEmpty: false });
    expect(newRequirementVersionView("api", { status: "error", error: "版本服务不可用" })).toMatchObject({ error: "版本服务不可用", showRetry: true, showCreateVersion: false, canSave: false });
  });

  it("shows the normal empty state only after a failed request retries successfully", () => {
    const failed = newRequirementVersionView("api", { status: "error", error: "offline" });
    const retried = newRequirementVersionView("api", { status: "loaded", value: [] });
    expect(failed.showCreateVersion).toBe(false);
    expect(retried).toMatchObject({ error: "", showRetry: false, showCreateVersion: true });
  });

  it("requires both project and version before saving", () => {
    expect(canSaveNewRequirement(complete)).toBe(true);
    expect(canSaveNewRequirement({ ...complete, primaryProjectVersionId: "" })).toBe(false);
  });

  it("uses the shared requirement schema at every text length boundary", () => {
    expect(validateNewRequirement({ ...complete, title: "单" }).fields.title).toContain("2");
    expect(validateNewRequirement({ ...complete, title: "两个" }).fields.title).toBeUndefined();
    expect(validateNewRequirement({ ...complete, businessProblem: "123456789" }).fields.businessProblem).toContain("10");
    expect(validateNewRequirement({ ...complete, businessProblem: "1234567890" }).fields.businessProblem).toBeUndefined();
    expect(validateNewRequirement({ ...complete, expectedOutcome: "123" }).fields.expectedOutcome).toContain("4");
    expect(validateNewRequirement({ ...complete, expectedOutcome: "1234" }).fields.expectedOutcome).toBeUndefined();
  });

  it("maps server validation issues to readable fields and a Chinese summary", () => {
    const mapped = newRequirementApiErrors(new ApiError("VALIDATION_ERROR", "VALIDATION_ERROR", { issues: [
      { path: ["title"], message: "String must contain at least 2 character(s)" },
      { path: ["businessProblem"], message: "String must contain at least 10 character(s)" }
    ] }, 400));
    expect(mapped.fields).toMatchObject({ title: "需求标题至少填写 2 个字符", businessProblem: "业务背景与当前问题至少填写 10 个字符" });
    expect(mapped.summary).toBe("请检查需求信息后重试");
    expect(JSON.stringify(mapped)).not.toContain("VALIDATION_ERROR");
  });

  it("submits only the accepted fields and never an editable requirement code", () => {
    expect(newRequirementPayload({ ...complete, code: "REQ-MANUAL" } as NewRequirementForm & { code: string })).toEqual(complete);
  });
});
