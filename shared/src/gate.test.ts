import { describe, expect, it } from "vitest";
import { evaluateGate, defaultGateConfig } from "./gate.js";

const pass = { conclusion: "pass", confidence: 0.9, openQuestions: [], risks: [], findings: [] };

describe("evaluateGate", () => {
  it("automatically approves a clear low-risk artifact", () => {
    expect(evaluateGate("definition", pass, defaultGateConfig).decision).toBe("auto_approve");
  });

  it("lets definition continue with ordinary questions", () => {
    const artifact = { ...pass, openQuestions: ["按钮文案待验证"], blockingQuestions: [] };

    expect(evaluateGate("definition", artifact, defaultGateConfig).decision).toBe("auto_approve");
  });

  it("requires human review for blocking definition questions", () => {
    const artifact = { ...pass, blockingQuestions: [{ question: "删除是否可恢复" }] };
    const result = evaluateGate("definition", artifact, defaultGateConfig);

    expect(result.decision).toBe("human_review");
    expect(result.reasons.join(" ")).toContain("1 个高风险阻塞问题");
  });

  it("automatically returns explicit returns and S0 findings", () => {
    expect(evaluateGate("definition", { ...pass, conclusion: "return" }, defaultGateConfig).decision).toBe("auto_return");
    expect(evaluateGate("quality_verification", { ...pass, findings: [{ severity: "S0" }] }, defaultGateConfig).decision).toBe("auto_return");
  });

  it.each([
    [{ ...pass, confidence: 0.7 }, "置信度"],
    [{ ...pass, conclusion: "conditional" }, "条件通过"],
    [{ ...pass, findings: [{ severity: "S1" }] }, "S1"],
    [{ ...pass, risks: ["兼容风险"] }, "风险"],
    [{ ...pass, openQuestions: ["范围是什么"] }, "待确认"]
  ])("requires a human for ambiguous evidence", (artifact, reason) => {
    const result = evaluateGate("quality_verification", artifact, defaultGateConfig);
    expect(result.decision).toBe("human_review");
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it("keeps solution design human-only without making implementation mandatory", () => {
    expect(defaultGateConfig.mandatoryHumanStages).toEqual([]);
    expect(evaluateGate("implementation", pass, defaultGateConfig).decision).toBe("auto_approve");
    expect(evaluateGate("solution_design", pass, { ...defaultGateConfig, mandatoryHumanStages: [] }).decision).toBe("human_review");
  });

  it("requires humans when automation is disabled", () => {
    expect(evaluateGate("definition", pass, { ...defaultGateConfig, autoTransitionEnabled: false }).decision).toBe("human_review");
  });
});
