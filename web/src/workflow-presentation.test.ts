import { describe, expect, it } from "vitest";
import { requirementStatusLabel } from "./workflow-presentation.js";

describe("requirement workflow presentation", () => {
  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)(
    "labels downstream %s work as active delivery instead of requirement AI work",
    (stage) => {
      expect(requirementStatusLabel(stage, "ai_ready")).toBe("交付进行中");
      expect(requirementStatusLabel(stage, "ai_running")).toBe("交付进行中");
      expect(requirementStatusLabel(stage, "awaiting_approval")).toBe("交付进行中");
    }
  );

  it("keeps requirement AI and terminal status labels unchanged", () => {
    expect(requirementStatusLabel("definition", "ai_ready")).toBe("AI 待启动");
    expect(requirementStatusLabel("solution_design", "awaiting_approval")).toBe("待人工审批");
    expect(requirementStatusLabel("implementation", "blocked")).toBe("已阻塞");
    expect(requirementStatusLabel("acceptance_delivery", "completed")).toBe("已完成");
  });
});
