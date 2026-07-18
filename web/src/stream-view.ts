import type { StageRunEvent } from "./run-observability.js";

export type StreamEntry = { id: string; sequence: number; kind: "status" | "message" | "command" | "file" | "diagnostic" | "gate" | "terminal"; title: string; text: string; createdAt?: string; state?: string };

export function buildStreamEntries(input: StageRunEvent[]): StreamEntry[] {
  const events = [...new Map(input.map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const entries: StreamEntry[] = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === "output.delta") {
      const text = typeof payload === "string" ? payload : String(payload.text ?? "");
      if (!text) continue;
      const previous = entries.at(-1);
      if (previous?.kind === "message" && previous.state === "streaming") { previous.text += text; previous.sequence = event.sequence; previous.id = `message-${event.sequence}`; }
      else entries.push(entry(event, "message", "AI 输出", text, "streaming"));
      continue;
    }
    if (event.type === "codex.event") {
      const item = payload.item ?? payload.payload?.item;
      if (!item || item.type === "reasoning") continue;
      if (item.type === "command_execution") entries.push(entry(event, "command", item.command || "执行命令", item.aggregated_output || item.output || item.status || "", item.status));
      else if (item.type === "file_change") { const changes = item.changes || []; entries.push(entry(event, "file", "文件修改", changes.map((change: any) => `${change.path || change.file || "文件"} · ${change.kind || change.type || "修改"}`).join("\n") || item.text || "文件已修改")); }
      else if (item.type === "agent_message") entries.push(entry(event, "message", "AI 消息", item.text || ""));
      continue;
    }
    if (event.type === "run.started") entries.push(entry(event, "status", "开始执行", payload.model ? `模型 ${payload.model}` : "AI 已启动"));
    else if (event.type === "context.prepared") { const count = Array.isArray(payload.priorArtifacts) ? payload.priorArtifacts.length : Number(payload.artifactCount || 0); entries.push(entry(event, "status", "上下文已准备", `已加载 ${count} 份历史产物`)); }
    else if (event.type === "request.sent") entries.push(entry(event, "status", "请求已发送", payload.model ? `模型 ${payload.model}` : "等待模型响应"));
    else if (event.type === "diagnostic") entries.push(entry(event, "diagnostic", "诊断", visibleText(payload)));
    else if (event.type === "file.changed") entries.push(entry(event, "file", "文件修改", visibleText(payload)));
    else if (event.type === "gate.decided") entries.push(entry(event, "gate", gateTitle(payload.decision), (payload.reasons || []).join("；")));
    else if (event.type === "run.completed") entries.push(entry(event, "terminal", "执行完成", "AI 处理已完成", "completed"));
    else if (event.type === "run.failed") entries.push(entry(event, "terminal", "执行失败", visibleText(payload), "failed"));
    else if (event.type === "run.interrupted") entries.push(entry(event, "terminal", "执行中断", visibleText(payload), "interrupted"));
  }
  return entries;
}

function entry(event: StageRunEvent, kind: StreamEntry["kind"], title: string, text: string, state?: string): StreamEntry { return { id: `${kind}-${event.sequence}`, sequence: event.sequence, kind, title, text, createdAt: event.createdAt, state }; }
function visibleText(payload: any) { return typeof payload === "string" ? payload : String(payload.text ?? payload.error ?? payload.message ?? ""); }
function gateTitle(decision: string) { return decision === "auto_approve" ? "AI 自动通过" : decision === "auto_return" ? "AI 自动打回" : "需要人工判断"; }
