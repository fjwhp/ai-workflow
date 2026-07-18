import { describe, expect, it } from "vitest";
import { canTransition, previousStage, returnStage, requirementInputSchema, stageLabels, statusLabels, workflowStages } from "./index.js";

describe("workflow transitions", () => {
  it("requires a manual approval between an AI run and the next stage", () => {
    expect(canTransition("ai_running", "awaiting_approval")).toBe(true);
    expect(canTransition("ai_running", "approved")).toBe(false);
    expect(canTransition("approved", "ai_ready")).toBe(true);
  });

  it("does not allow a closed requirement to transition", () => {
    expect(canTransition("closed", "draft")).toBe(false);
  });

  it("places local code integration after acceptance", () => {
    expect(workflowStages.at(-1)).toBe("integration");
    expect(stageLabels.integration).toBe("本地应用");
    expect(statusLabels.awaiting_merge).toBe("待应用");
    expect(statusLabels.merge_test_failed).toBe("应用后测试失败");
    expect(returnStage("integration")).toBe("acceptance");
  });
});

describe("requirement input", () => {
  it("rejects an empty business problem", () => {
    const result = requirementInputSchema.safeParse({
      title: "订单备注规则统一",
      businessProblem: "",
      expectedOutcome: "三个入口行为一致",
      priority: "medium"
    });
    expect(result.success).toBe(false);
  });
});

describe("previousStage", () => {
  it("returns the immediately preceding workflow stage", () => {
    expect(previousStage("prd")).toBe("intake");
    expect(previousStage("technical_design")).toBe("requirement_review");
    expect(previousStage("testing")).toBe("code_review");
  });

  it("keeps intake at intake because it has no previous stage", () => {
    expect(previousStage("intake")).toBe("intake");
  });
});

describe("returnStage", () => {
  it("routes failed testing back to coding so fixes are reviewed again", () => {
    expect(returnStage("testing")).toBe("coding");
  });

  it("routes other gates to their responsible prior stage", () => {
    expect(returnStage("code_review")).toBe("coding");
    expect(returnStage("technical_design")).toBe("requirement_review");
    expect(returnStage("acceptance")).toBe("testing");
  });
});
