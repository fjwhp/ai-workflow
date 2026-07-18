import type { Requirement } from "@ai-workflow/shared";
export function groupRequirements(items: Requirement[]) {
  return {
    approvals: items.filter((x) => x.status === "awaiting_approval"),
    ready: items.filter((x) => x.status === "ai_ready"),
    running: items.filter((x) => x.status === "ai_running"),
    blocked: items.filter((x) => ["blocked", "returned"].includes(x.status)),
    done: items.filter((x) => ["completed", "closed"].includes(x.status))
  };
}
