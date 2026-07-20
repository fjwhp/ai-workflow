import { describe, expect, it } from "vitest";
import { groupRequirements } from "./dashboard.js";

describe("groupRequirements", () => {
  it("separates requirement AI work from downstream automation", () => {
    const items = [
      { id: "1", stage: "definition", status: "awaiting_approval" },
      { id: "2", stage: "solution_design", status: "ai_ready" },
      { id: "3", stage: "solution_design", status: "ai_running" },
      { id: "4", stage: "implementation", status: "ai_ready" },
      { id: "5", stage: "quality_verification", status: "ai_running" },
      { id: "6", stage: "acceptance_delivery", status: "awaiting_approval" },
      { id: "7", stage: "implementation", status: "blocked" },
      { id: "8", stage: "acceptance_delivery", status: "closed" }
    ] as any;
    const queues = groupRequirements(items);
    expect(queues.approvals.map((item) => item.id)).toEqual(["1"]);
    expect(queues.ready.map((item) => item.id)).toEqual(["2"]);
    expect(queues.running.map((item) => item.id)).toEqual(["3"]);
    expect(queues.automation.map((item) => item.id)).toEqual(["4", "5", "6"]);
    expect(queues.blocked.map((item) => item.id)).toEqual(["7"]);
    expect(queues.done.map((item) => item.id)).toEqual(["8"]);
  });
});
