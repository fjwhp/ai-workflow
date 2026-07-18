import type { WorkflowStore } from "./store.js";
import { extractKnowledgeCandidates } from "./project-memory.js";

export function refreshRequirementKnowledge(store:WorkflowStore,requirementId:string){
  const requirement:any=store.getRequirement(requirementId);if(!requirement?.projectId)return [];
  const candidates=extractKnowledgeCandidates({projectId:requirement.projectId,requirement,artifacts:store.listArtifacts(requirementId),approvals:store.listApprovals(requirementId)});
  return store.replaceKnowledgeCandidates(requirementId,requirement.projectId,candidates);
}

export function publishRequirementKnowledge(store:WorkflowStore,requirementId:string){refreshRequirementKnowledge(store,requirementId);return store.publishKnowledgeCandidates(requirementId)}
