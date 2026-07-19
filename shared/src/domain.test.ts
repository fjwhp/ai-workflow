import { describe, expect, it } from "vitest";
import { canTransition, previousStage, returnStage, requirementInputSchema, stageLabels, statusLabels, workflowStages, workflowStatuses } from "./index.js";

describe("workflow transitions", () => {
  it("uses five non-overlapping workflow stages", () => {
    expect(workflowStages).toEqual([
      "definition", "solution_design", "implementation",
      "quality_verification", "acceptance_delivery"
    ]);
  });

  it("keeps requirement statuses limited to generic workflow states", () => {
    expect(workflowStatuses).toEqual([
      "ai_ready", "ai_running", "awaiting_approval", "returned",
      "blocked", "completed", "closed", "cancelled"
    ]);
  });

  it("requires a manual approval between an AI run and the next stage", () => {
    expect(canTransition("ai_running", "awaiting_approval")).toBe(true);
    expect(canTransition("ai_running", "ai_ready")).toBe(false);
    expect(canTransition("awaiting_approval", "ai_ready")).toBe(true);
  });

  it("does not allow a closed requirement to transition", () => {
    expect(canTransition("closed", "ai_ready")).toBe(false);
  });

  it("labels the five workflow stages", () => {
    expect(stageLabels).toEqual({
      definition: "需求定义",
      solution_design: "方案设计",
      implementation: "实现",
      quality_verification: "质量验证",
      acceptance_delivery: "验收交付"
    });
    expect(statusLabels.completed).toBe("已完成");
  });
});

describe("requirement input", () => {
  it("rejects an empty business problem", () => {
    const result = requirementInputSchema.safeParse({
      title: "订单备注规则统一",
      businessProblem: "",
      expectedOutcome: "三个入口行为一致",
      priority: "medium",
      primaryProjectVersionId: "version-1"
    });
    expect(result.success).toBe(false);
  });
});

describe("previousStage", () => {
  it("returns the immediately preceding workflow stage", () => {
    expect(previousStage("solution_design")).toBe("definition");
    expect(previousStage("implementation")).toBe("solution_design");
    expect(previousStage("acceptance_delivery")).toBe("quality_verification");
  });

  it("keeps definition at definition because it has no previous stage", () => {
    expect(previousStage("definition")).toBe("definition");
  });
});

describe("returnStage", () => {
  it.each([
    ["solution_design", "definition"],
    ["implementation", "solution_design"],
    ["quality_verification", "implementation"],
    ["acceptance_delivery", "quality_verification"]
  ] as const)("routes %s findings to %s", (stage, target) => {
    expect(returnStage(stage)).toBe(target);
  });

  it("keeps definition findings in definition", () => {
    expect(returnStage("definition")).toBe("definition");
  });
});
