import { describe, expect, it } from "vitest";
import { gateLabel, latestGateForStage } from "./gate-view.js";

describe("gate view helpers", () => {
  it("finds the latest AI gate record for a stage", () => {
    const approvals = [
      { id: "human", stage: "definition", actor_type: "human", created_at: "2026-01-03" },
      { id: "old", stage: "definition", actor_type: "ai_gate", created_at: "2026-01-01" },
      { id: "new", stage: "definition", actor_type: "ai_gate", created_at: "2026-01-02" }
    ];
    expect(latestGateForStage(approvals, "definition")?.id).toBe("new");
  });

  it("uses readable automatic decision labels", () => {
    expect(gateLabel("approve")).toBe("AI 自动通过");
    expect(gateLabel("return")).toBe("AI 自动打回");
    expect(gateLabel("review")).toBe("需要人工判断");
  });
});
