import { stageLabels, type WorkflowStage } from "@ai-workflow/shared";

export function humanOverrideView(stage: string, eligibility: any = {}) {
  const targetStage = eligibility.targetStage || (stage === "code_review" ? "testing" : stage === "testing" ? "acceptance" : null);
  const visible = Boolean(eligibility.visible && targetStage);
  return {
    visible,
    disabled: !eligibility.allowed,
    reason: eligibility.reason ?? null,
    targetLabel: targetStage ? stageLabels[targetStage as WorkflowStage] : ""
  };
}
