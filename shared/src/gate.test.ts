import { describe, expect, it } from "vitest";
import { configurableMandatoryHumanStages, evaluateGate, failClosedGateConfig, gateConfigSchema, parseGateConfig, defaultGateConfig } from "./gate.js";

const pass = { conclusion: "pass", confidence: 0.9, openQuestions: [], risks: [], findings: [] };

describe("evaluateGate", () => {
  it.each([
    null,
    {},
    { autoTransitionEnabled: "true", confidenceThreshold: 0.85, mandatoryHumanStages: [] },
    { autoTransitionEnabled: true, confidenceThreshold: Number.NaN, mandatoryHumanStages: [] },
    { autoTransitionEnabled: true, confidenceThreshold: "0.85", mandatoryHumanStages: [] },
    { autoTransitionEnabled: true, confidenceThreshold: -0.1, mandatoryHumanStages: [] },
    { autoTransitionEnabled: true, confidenceThreshold: 1.1, mandatoryHumanStages: [] },
    { autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: ["implementation"] },
    { autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: ["definition", "implementation"] },
    { autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: [], unexpected: true }
  ])("fails closed for invalid persisted gate config %#", (input) => {
    expect(gateConfigSchema.safeParse(input).success).toBe(false);
    const config = parseGateConfig(input);
    expect(config).toEqual(failClosedGateConfig);
    expect(evaluateGate("definition", { ...pass, confidence: 0.1 }, config).decision).toBe("human_review");
  });

  it("only exposes definition as a configurable mandatory stage", () => {
    expect(configurableMandatoryHumanStages).toEqual(["definition"]);
  });

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
    expect(evaluateGate("definition", { ...pass, findings: [{ severity: "S0" }] }, defaultGateConfig).decision).toBe("auto_return");
  });

  it.each([
    [{ ...pass, confidence: 0.7 }, "置信度"],
    [{ ...pass, conclusion: "conditional" }, "条件通过"],
    [{ ...pass, findings: [{ severity: "S1" }] }, "S1"],
    [{ ...pass, risks: ["兼容风险"] }, "风险"],
  ])("requires a human for ambiguous evidence", (artifact, reason) => {
    const result = evaluateGate("definition", artifact, defaultGateConfig);
    expect(result.decision).toBe("human_review");
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it("keeps solution design human-only without making it configurable", () => {
    expect(defaultGateConfig.mandatoryHumanStages).toEqual([]);
    expect(evaluateGate("solution_design", pass, { ...defaultGateConfig, mandatoryHumanStages: [] }).decision).toBe("human_review");
  });

  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)("rejects downstream %s gate evaluation", (stage) => {
    expect(() => evaluateGate(stage as any, pass, defaultGateConfig)).toThrow("REQUIREMENT_AI_STAGE_UNSUPPORTED");
  });

  it("requires humans when automation is disabled", () => {
    expect(evaluateGate("definition", pass, { ...defaultGateConfig, autoTransitionEnabled: false }).decision).toBe("human_review");
  });
});
