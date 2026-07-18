import type { WorkflowStage } from "@ai-workflow/shared";

export function latestGateForStage(approvals: any[] = [], stage: WorkflowStage) {
  return approvals.filter((item) => item.stage === stage && item.actor_type === "ai_gate")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

export function gateLabel(decision: string) {
  return ({ approve: "AI 自动通过", return: "AI 自动打回", review: "需要人工判断" } as Record<string, string>)[decision] || "AI 门禁决定";
}

export function gateReasons(gate: any): string[] {
  if (Array.isArray(gate?.reasons)) return gate.reasons;
  try { return JSON.parse(gate?.reasons_json || "[]"); } catch { return gate?.comment ? [gate.comment] : []; }
}
