import type { WorkflowStage } from "@ai-workflow/shared";

const targetStages: Partial<Record<WorkflowStage, WorkflowStage>> = {
  code_review: "testing",
  testing: "acceptance"
};

export function buildHumanOverrideEligibility(input: { stage: string; status: string; artifact?: any }) {
  if (!(input.stage in targetStages)) return { allowed: false, reason: "当前阶段不支持人工例外通过" };
  if (input.status === "ai_running") return { allowed: false, reason: "AI 处理中，完成后才能人工审核通过" };
  if (!input.artifact) return { allowed: false, reason: "当前阶段尚无 AI 成果，不能人工审核通过" };
  return { allowed: true, reason: null };
}

export function buildHumanOverrideSnapshot(input: { stage: "code_review" | "testing"; comment: string; artifact: any; returnCount: number }) {
  const comment = input.comment.trim();
  if (!comment) throw new Error("COMMENT_REQUIRED");
  const content = input.artifact?.content ?? {};
  return {
    artifactId: input.artifact.id,
    comment,
    returnCount: input.returnCount,
    risks: Array.isArray(content.risks) ? [...content.risks] : [],
    openQuestions: Array.isArray(content.openQuestions) ? [...content.openQuestions] : [],
    targetStage: targetStages[input.stage]!
  };
}
