import { isRequirementAiStage, type Requirement } from "@ai-workflow/shared";
export function groupRequirements(items: Requirement[]) {
  return {
    approvals: items.filter((x) => isRequirementAiStage(x.stage) && x.status === "awaiting_approval"),
    ready: items.filter((x) => isRequirementAiStage(x.stage) && x.status === "ai_ready"),
    running: items.filter((x) => isRequirementAiStage(x.stage) && x.status === "ai_running"),
    automation: items.filter((x) => !isRequirementAiStage(x.stage) && ["ai_ready", "ai_running", "awaiting_approval"].includes(x.status)),
    blocked: items.filter((x) => ["blocked", "returned"].includes(x.status)),
    done: items.filter((x) => ["completed", "closed"].includes(x.status))
  };
}
