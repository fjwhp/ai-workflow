import { describe, expect, it } from "vitest";
import { DetailRequestTracker } from "./detail-requests.js";

describe("DetailRequestTracker", () => {
  it("accepts only the latest request for the currently desired requirement", () => {
    const tracker = new DetailRequestTracker();
    const a = tracker.begin("a"), b = tracker.begin("b");
    expect(tracker.accept(a, "b")).toBe(false);
    expect(tracker.accept(b, "b")).toBe(true);
    expect(tracker.accept(b, "a")).toBe(false);
  });

  it("invalidates an old refresh when navigation changes the desired target", () => {
    const tracker = new DetailRequestTracker();
    const refreshA = tracker.begin("a");
    tracker.clear();
    expect(tracker.accept(refreshA, null)).toBe(false);
  });
});
