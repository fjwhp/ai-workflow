import { describe, expect, it } from "vitest";
import { buildCodexArgs, closeCodexInput, parseCodexEventLine, summarizeCodexEvents, type CodexEvent } from "./codex-runner.js";

describe("Codex JSONL events", () => {
  it("parses thread and agent message events", () => {
    const events = [
      parseCodexEventLine('{"type":"thread.started","thread_id":"thread-1"}'),
      parseCodexEventLine('{"type":"item.completed","item":{"type":"agent_message","text":"完成修改"}}')
    ].filter((event): event is CodexEvent => event !== null);
    expect(summarizeCodexEvents(events).threadId).toBe("thread-1");
    expect(summarizeCodexEvents(events).lastMessage).toBe("完成修改");
  });

  it("ignores non-JSON diagnostic lines without losing later events", () => {
    expect(parseCodexEventLine("WARN plugin unavailable")).toBeNull();
  });

  it("configures the relay provider from the workflow environment", () => {
    const args = buildCodexArgs({ model: "gpt-5.5", baseUrl: "http://relay.example/v1", cwd: "/tmp/worktree", prompt: "implement" });
    expect(args).toContain('model_provider="workflow_relay"');
    expect(args).toContain('model_providers.workflow_relay.base_url="http://relay.example"');
    expect(args).toContain('model_providers.workflow_relay.env_key="OPENAI_API_KEY"');
  });

  it("closes child stdin so Codex does not wait for additional input", () => {
    let ended = false;
    closeCodexInput({ stdin: { end: () => { ended = true; } } } as any);
    expect(ended).toBe(true);
  });
});
