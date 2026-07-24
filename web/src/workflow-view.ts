import { stageLabels, workflowStages } from "@ai-workflow/shared";

export function workflowSteps(): string[] {
  return workflowStages.map((stage) => stageLabels[stage]);
}
