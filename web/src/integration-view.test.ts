import { describe, expect, it } from "vitest";
import { integrationView } from "./integration-view";

describe("integration view", () => {
  it("keeps the local merge action visible and explains why it is disabled", () => {
    expect(integrationView("awaiting_merge", { allowed: true, checks: [{ ok: true }] }, null)).toMatchObject({
      showRecheck: true, showIntegrate: true, showRerun: false, canIntegrate: true, label: "待应用", disabledReasons: [],
      actionLabel: "应用到本地工作区",
      safetyLabel: "保留为本地未提交改动，不会 commit，不会 push"
    });
    expect(integrationView("awaiting_merge", { allowed: false, checks: [{ ok: false, label: "目标分支", detail: "当前分支不匹配" }] }, null)).toMatchObject({
      showIntegrate: true, canIntegrate: false, disabledReasons: ["目标分支：当前分支不匹配"]
    });
  });

  it("identifies protected targets and validates exact confirmation", () => {
    expect(integrationView("awaiting_merge", { allowed: true, checks: [] }, null, "prod", "")).toMatchObject({ protectedTarget: true, confirmationValid: false });
    expect(integrationView("awaiting_merge", { allowed: true, checks: [] }, null, "prod", "prod").confirmationValid).toBe(true);
    expect(integrationView("awaiting_merge", { allowed: true, checks: [] }, null, "feature/0710", "")).toMatchObject({ protectedTarget: false, confirmationValid: true });
  });

  it("offers test rerun without applying the worktree again after test failure", () => {
    expect(integrationView("merge_test_failed", null, { status: "test_failed" })).toMatchObject({ showRecheck:false,showIntegrate:false,showRerun:true,canRerunTests: true, label: "本地应用后测试失败" });
  });

  it.each([["conflict", "应用冲突"], ["completed", "已完成"]])("labels %s records", (status, label) => {
    expect(integrationView(status === "completed" ? "completed" : "awaiting_merge", null, { status }).label).toBe(label);
  });

  it("offers a retry action after conflict when commit evidence passes preflight", () => {
    expect(integrationView("awaiting_merge", { allowed: true, checks: [] }, { status: "conflict", sourceCommit: "abc123" })).toMatchObject({
      label: "应用冲突", actionLabel: "重新应用到本地", showRecheck:true,showIntegrate:true,showRerun:false,canIntegrate: true
    });
  });

  it("treats completed as a terminal success without disabled actions",()=>{
    expect(integrationView("completed",null,{status:"completed"})).toMatchObject({label:"已完成",showRecheck:false,showIntegrate:false,showRerun:false,canIntegrate:false,canRerunTests:false,disabledReasons:[]});
  });
});
