import { isRequirementAiStage, statusLabels, type WorkflowStage, type WorkflowStatus } from "@ai-workflow/shared";

const downstreamAutomationStatuses: readonly WorkflowStatus[] = ["ai_ready", "ai_running", "awaiting_approval"];

export function requirementStatusLabel(stage: WorkflowStage, status: WorkflowStatus): string {
  if (!isRequirementAiStage(stage) && downstreamAutomationStatuses.includes(status)) return "自动化待接管";
  return statusLabels[status];
}
