import { describe, expect, it } from "vitest";
import { humanOverrideView } from "./human-override-view";

describe("human override view", () => {
  it.each([["code_review", "自动化测试"], ["testing", "运营验收"]])("is always visible for %s and identifies the next stage", (stage, targetLabel) => {
    expect(humanOverrideView(stage, { visible: true, allowed: true, targetStage: stage === "code_review" ? "testing" : "acceptance" })).toMatchObject({ visible: true, disabled: false, targetLabel });
  });

  it("keeps the entry visible and exposes the disabled reason", () => {
    expect(humanOverrideView("testing", { visible: true, allowed: false, reason: "AI 处理中" })).toEqual({ visible: true, disabled: true, reason: "AI 处理中", targetLabel: "运营验收" });
  });

  it("hides the entry outside the two controlled stages", () => {
    expect(humanOverrideView("coding", { visible: false, allowed: false })).toMatchObject({ visible: false });
  });
});
