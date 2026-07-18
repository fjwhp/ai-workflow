import { describe, expect, it } from "vitest";
import { groupRequirements } from "./dashboard.js";

describe("groupRequirements", () => {
  it("puts workflow items into actionable queues", () => {
    const items = [
      { id: "1", status: "awaiting_approval" },
      { id: "2", status: "ai_ready" },
      { id: "3", status: "blocked" },
      { id: "4", status: "closed" }
    ] as any;
    const queues = groupRequirements(items);
    expect(queues.approvals).toHaveLength(1);
    expect(queues.ready).toHaveLength(1);
    expect(queues.blocked).toHaveLength(1);
    expect(queues.done).toHaveLength(1);
  });
});
