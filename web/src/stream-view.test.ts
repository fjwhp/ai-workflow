import { describe, expect, it } from "vitest";
import { buildStreamEntries } from "./stream-view.js";

describe("inline stream view", () => {
  it("filters internal reasoning and merges consecutive model deltas", () => {
    const entries = buildStreamEntries([
      { sequence: 3, type: "output.delta", payload: { text: "世界" } },
      { sequence: 1, type: "run.started", payload: { model: "gpt-5.5" } },
      { sequence: 2, type: "output.delta", payload: { text: "你好" } },
      { sequence: 4, type: "codex.event", payload: { item: { type: "reasoning", text: "hidden chain" } } },
      { sequence: 3, type: "output.delta", payload: { text: "世界" } }
    ] as any);
    expect(entries.map((entry) => entry.kind)).toEqual(["status", "message"]);
    expect(entries[1]?.text).toBe("你好世界");
    expect(JSON.stringify(entries)).not.toContain("hidden chain");
  });

  it("normalizes visible Codex commands, file changes and agent messages", () => {
    const entries = buildStreamEntries([
      { sequence: 1, type: "codex.event", payload: { type: "item.completed", item: { type: "command_execution", command: "npm test", status: "completed", aggregated_output: "3 passed" } } },
      { sequence: 2, type: "codex.event", payload: { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/app.ts", kind: "update" }] } } },
      { sequence: 3, type: "codex.event", payload: { type: "item.completed", item: { type: "agent_message", text: "实现完成" } } }
    ] as any);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "command", title: "npm test", text: "3 passed" }),
      expect.objectContaining({ kind: "file", title: "文件修改", text: "src/app.ts · update" }),
      expect.objectContaining({ kind: "message", text: "实现完成" })
    ]);
  });

  it("shows gate and terminal results without exposing full context payloads", () => {
    const entries = buildStreamEntries([
      { sequence: 1, type: "context.prepared", payload: { requirement: { secret: "hidden" }, priorArtifacts: [1, 2] } },
      { sequence: 2, type: "gate.decided", payload: { decision: "auto_return", reasons: ["缺少测试"] } },
      { sequence: 3, type: "run.completed", payload: { completedAt: "now" } }
    ] as any);
    expect(entries[0]?.text).toContain("2");
    expect(JSON.stringify(entries)).not.toContain("secret");
    expect(entries.at(-1)).toMatchObject({ kind: "terminal", title: "执行完成" });
  });
});
