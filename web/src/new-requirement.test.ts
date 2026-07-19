import { describe, expect, it } from "vitest";
import {
  canSaveNewRequirement,
  newRequirementPayload,
  newRequirementVersionView,
  selectRequirementProject,
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
    expect(newRequirementVersionView("api", [], false)).toEqual({
      showCreateVersion: true,
      canSave: false
    });
    expect(newRequirementVersionView("", [], false).showCreateVersion).toBe(false);
  });

  it("requires both project and version before saving", () => {
    expect(canSaveNewRequirement(complete)).toBe(true);
    expect(canSaveNewRequirement({ ...complete, primaryProjectVersionId: "" })).toBe(false);
  });

  it("submits only the accepted fields and never an editable requirement code", () => {
    expect(newRequirementPayload({ ...complete, code: "REQ-MANUAL" } as NewRequirementForm & { code: string })).toEqual(complete);
  });
});
