import { describe, expect, it } from "vitest";
import { displayRunEvents, eventLabel, isTerminalRun, latestRunForStage, mergeRunEvents } from "./run-observability.js";

describe("run observability helpers", () => {
  it("selects the latest run for the viewed stage", () => {
    const runs = [
      { id: "old", stage: "definition", createdAt: "2026-01-01" },
      { id: "implementation", stage: "implementation", createdAt: "2026-01-03" },
      { id: "new", stage: "definition", createdAt: "2026-01-02" }
    ] as any;
    expect(latestRunForStage(runs, "definition")?.id).toBe("new");
  });

  it("merges replayed and live events by sequence", () => {
    const first = [{ sequence: 1, type: "run.started" }, { sequence: 2, type: "output.delta" }] as any;
    const next = [{ sequence: 2, type: "output.delta" }, { sequence: 3, type: "run.completed" }] as any;
    expect(mergeRunEvents(first, next).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("recognizes terminal states and readable labels", () => {
    expect(isTerminalRun("completed")).toBe(true);
    expect(isTerminalRun("running")).toBe(false);
    expect(eventLabel("file.changed")).toBe("文件修改");
  });

  it("displays execution events newest first without mutating storage order", () => {
    const events = [{ sequence: 1 }, { sequence: 3 }, { sequence: 2 }] as any;
    expect(displayRunEvents(events).map((event) => event.sequence)).toEqual([3, 2, 1]);
    expect(events.map((event: any) => event.sequence)).toEqual([1, 3, 2]);
  });
});
