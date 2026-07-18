import type { Requirement } from "@ai-workflow/shared";

export type QueueFilter="approvals"|"ready"|"running"|"blocked";
export type NavigationPage="dashboard"|"requirements"|"projects"|"settings";

export function filterRequirements(items:Requirement[],filter:QueueFilter|null){
  if(!filter)return items;
  if(filter==="approvals")return items.filter(item=>item.status==="awaiting_approval");
  if(filter==="ready")return items.filter(item=>item.status==="ai_ready");
  if(filter==="running")return items.filter(item=>item.status==="ai_running");
  return items.filter(item=>["blocked","returned"].includes(item.status));
}

export function navigationTarget(page:NavigationPage,queueFilter:QueueFilter|null=null){return {page,selected:null,queueFilter}}
