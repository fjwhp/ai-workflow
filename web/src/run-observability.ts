import type { WorkflowStage } from "@ai-workflow/shared";

export type StageRunEvent = { id?: string; sequence: number; type: string; payload?: any; createdAt?: string };
export type StageRun = { id: string; stage: WorkflowStage; status: string; model?: string; input?: any; output?: any; error?: string; createdAt: string; completedAt?: string; events?: StageRunEvent[] };

export function latestRunForStage(runs: StageRun[] = [], stage: WorkflowStage) {
  return runs.filter((run) => run.stage === stage).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function mergeRunEvents(current: StageRunEvent[], incoming: StageRunEvent[]) {
  return [...new Map([...current, ...incoming].map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
}

export function displayRunEvents(events: StageRunEvent[]) {
  return [...events].sort((a, b) => b.sequence - a.sequence);
}

export function isTerminalRun(status: string) { return ["completed", "failed", "interrupted"].includes(status); }

export function eventLabel(type: string) {
  return ({ "run.started": "开始执行", "context.prepared": "上下文已准备", "request.sent": "已发送请求", "output.delta": "模型输出", "result.parsed": "结果已解析", "gate.decided": "门禁判断", "codex.event": "Codex 事件", "diagnostic": "诊断", "file.changed": "文件修改", "run.completed": "执行完成", "run.failed": "执行失败", "run.interrupted": "执行中断" } as Record<string, string>)[type] || type;
}
