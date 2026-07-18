import { describe, expect, it } from "vitest";
import { evaluateGate, defaultGateConfig } from "./gate.js";

const pass = { conclusion: "pass", confidence: 0.9, openQuestions: [], risks: [], findings: [] };

describe("evaluateGate", () => {
  it("automatically approves a clear low-risk artifact", () => {
    expect(evaluateGate("prd", pass, defaultGateConfig).decision).toBe("auto_approve");
  });
  it("lets PRD continue with ordinary questions but escalates blocking decisions",()=>{
    expect(evaluateGate("prd",{...pass,openQuestions:["按钮文案待验证"],blockingQuestions:[]},defaultGateConfig).decision).toBe("auto_approve");
    expect(evaluateGate("prd",{...pass,blockingQuestions:[{question:"删除是否可恢复"}]},defaultGateConfig).decision).toBe("human_review");
    expect(evaluateGate("requirement_review",{...pass,openQuestions:["范围是什么"]},defaultGateConfig).decision).toBe("human_review");
  });

  it("automatically returns explicit returns and S0 findings", () => {
    expect(evaluateGate("prd", { ...pass, conclusion: "return" }, defaultGateConfig).decision).toBe("auto_return");
    expect(evaluateGate("testing", { ...pass, findings: [{ severity: "S0" }] }, defaultGateConfig).decision).toBe("auto_return");
  });

  it.each([
    [{ ...pass, confidence: 0.7 }, "置信度"],
    [{ ...pass, conclusion: "conditional" }, "条件通过"],
    [{ ...pass, findings: [{ severity: "S1" }] }, "S1"],
    [{ ...pass, risks: ["兼容风险"] }, "风险"],
    [{ ...pass, openQuestions: ["范围是什么"] }, "待确认"]
  ])("requires a human for ambiguous evidence", (artifact, reason) => {
    const result = evaluateGate("requirement_review", artifact, defaultGateConfig);
    expect(result.decision).toBe("human_review");
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it("always requires humans for coding and acceptance", () => {
    expect(evaluateGate("coding", pass, defaultGateConfig).decision).toBe("human_review");
    expect(evaluateGate("acceptance", pass, defaultGateConfig).decision).toBe("human_review");
  });

  it("requires humans when automation is disabled", () => {
    expect(evaluateGate("prd", pass, { ...defaultGateConfig, autoTransitionEnabled: false }).decision).toBe("human_review");
  });
});
