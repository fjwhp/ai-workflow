import { isRequirementAiStage, type Requirement } from "@ai-workflow/shared";

export type QueueFilter="approvals"|"ready"|"running"|"automation"|"blocked";
export type NavigationPage="dashboard"|"requirements"|"projects"|"settings";

export function filterRequirements(items:Requirement[],filter:QueueFilter|null){
  if(!filter)return items;
  if(filter==="approvals")return items.filter(item=>isRequirementAiStage(item.stage)&&item.status==="awaiting_approval");
  if(filter==="ready")return items.filter(item=>isRequirementAiStage(item.stage)&&item.status==="ai_ready");
  if(filter==="running")return items.filter(item=>isRequirementAiStage(item.stage)&&item.status==="ai_running");
  if(filter==="automation")return items.filter(item=>!isRequirementAiStage(item.stage)&&["ai_ready","ai_running","awaiting_approval"].includes(item.status));
  return items.filter(item=>["blocked","returned"].includes(item.status));
}

export function navigationTarget(page:NavigationPage,queueFilter:QueueFilter|null=null){return {page,selected:null,queueFilter}}
