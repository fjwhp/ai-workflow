import type { WorkflowStage } from "@ai-workflow/shared";
import { ensureProjectKnowledge, retrieveProjectKnowledge } from "./knowledge-service.js";
import { MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED, resolveSoleDeliveryProject } from "./requirement-projects.js";
import type { WorkflowStore } from "./store.js";

const PROJECT_CHAR_CAP = 20_000;
const AGGREGATE_CHAR_CAP = 60_000;
const ENTRY_CAP = 24;
const EXECUTION_STAGES = new Set<WorkflowStage>(["coding", "code_review", "testing", "acceptance", "integration"]);

export class ProjectContextError extends Error {
  constructor(public readonly code: string, public readonly projects: Array<{ projectId: string; name: string }> = []) {
    super(code);
  }
}

export interface ProjectContextBlock {
  projectId: string; name: string; role: string; usage: string; deliveryRequired: boolean;
  moduleMode: string; moduleIds: string[]; version: number; sourceHead: string; summary: string;
  entries: any[]; totalAvailable: number; totalChars: number; truncated: boolean; status: "ready";
}

export interface RequirementProjectContext { projects: ProjectContextBlock[]; totalChars: number; truncated: boolean }

export async function buildRequirementProjectContext(store: WorkflowStore, requirementId: string, stage: WorkflowStage): Promise<RequirementProjectContext> {
  const requirement: any = store.getRequirement(requirementId);
  if (!requirement) throw new ProjectContextError("REQUIREMENT_NOT_FOUND");
  const active = store.listRequirementProjects(requirementId);
  let associations = active;
  if (EXECUTION_STAGES.has(stage)) {
    let delivery;
    try { delivery = resolveSoleDeliveryProject(active); }
    catch { throw new ProjectContextError(MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED); }
    if (!delivery) throw new ProjectContextError("PROJECT_REQUIRED");
    associations = [delivery];
  }
  const nameOf = (association: typeof associations[number]) => association.projectName ?? store.getProject(association.projectId)?.name ?? association.projectId;
  const archived = associations.filter((item) => item.projectStatus === "archived");
  if (archived.length) throw new ProjectContextError("PROJECT_ARCHIVED", archived.map((item) => ({ projectId: item.projectId, name: nameOf(item) })));

  const unavailable: Array<{ projectId: string; name: string }> = [];
  const failed: Array<{ projectId: string; name: string }> = [];
  const ready = new Map<string, any>();
  for (const association of associations) {
    const project: any = store.getProject(association.projectId);
    const knowledge: any = store.getLatestProjectKnowledge(association.projectId);
    if (!knowledge || knowledge.status === "missing") {
      unavailable.push({ projectId: association.projectId, name: nameOf(association) });
      if (project) void ensureProjectKnowledge(store, project, "ai_run").catch(() => {});
    } else if (knowledge.status === "building") unavailable.push({ projectId: association.projectId, name: nameOf(association) });
    else if (knowledge.status === "failed" || knowledge.status === "canceled") failed.push({ projectId: association.projectId, name: nameOf(association) });
    else if (project) {
      try {
        const ensured = await ensureProjectKnowledge(store, project, "ai_run");
        if (ensured?.status === "ready") ready.set(association.projectId, ensured);
        else unavailable.push({ projectId: association.projectId, name: nameOf(association) });
      } catch { failed.push({ projectId: association.projectId, name: nameOf(association) }); }
    } else failed.push({ projectId: association.projectId, name: nameOf(association) });
  }
  if (failed.length) throw new ProjectContextError("PROJECT_KNOWLEDGE_UNAVAILABLE", failed);
  if (unavailable.length) throw new ProjectContextError("PROJECT_KNOWLEDGE_BUILDING", unavailable);

  const arrayOverhead = 2 + Math.max(0, associations.length - 1);
  const fairCap = Math.min(PROJECT_CHAR_CAP, Math.floor((AGGREGATE_CHAR_CAP - arrayOverhead) / Math.max(associations.length, 1)));
  const projects = associations.map((association) => {
    const knowledge: any = ready.get(association.projectId);
    const retrieved = retrieveProjectKnowledge(knowledge, requirement);
    return capBlock({
      projectId: association.projectId, name: nameOf(association), role: association.role, usage: association.usage,
      deliveryRequired: association.deliveryRequired, moduleMode: association.moduleMode, moduleIds: association.moduleIds,
      version: knowledge.version, sourceHead: knowledge.sourceHead, summary: retrieved.summary ?? "", entries: retrieved.entries,
      totalAvailable: retrieved.totalAvailable, totalChars: 0, truncated: retrieved.truncated, status: "ready" as const
    }, fairCap);
  });
  const totalChars = projects.reduce((sum, project) => sum + project.totalChars, 0);
  return { projects, totalChars, truncated: projects.some((project) => project.truncated) };
}

function capBlock(input: ProjectContextBlock, cap: number): ProjectContextBlock {
  let changed = input.truncated;
  const text = (value: unknown, limit: number) => {
    const original = typeof value === "string" ? value : String(value ?? "");
    if (original.length > limit) changed = true;
    return original.slice(0, limit);
  };
  const list = (values: unknown, count: number, length: number) => {
    const source = Array.isArray(values) ? values : [];
    if (source.length > count) changed = true;
    return source.slice(0, count).map((value) => text(value, length));
  };
  const block: ProjectContextBlock = {
    projectId: text(input.projectId, 256), name: text(input.name, 512), role: text(input.role, 64), usage: text(input.usage, 64),
    deliveryRequired: Boolean(input.deliveryRequired), moduleMode: text(input.moduleMode, 64), moduleIds: list(input.moduleIds, 64, 256),
    version: input.version, sourceHead: text(input.sourceHead, 256), summary: text(input.summary, 2_000), entries: [],
    totalAvailable: input.totalAvailable, totalChars: 0, truncated: false, status: "ready"
  };
  const candidates = input.entries.slice(0, ENTRY_CAP).map((entry) => ({
    path: text(entry?.path, 512), kind: text(entry?.kind, 64), title: text(entry?.title, 256),
    content: text(entry?.content, 4_000), tags: list(entry?.tags, 16, 128)
  }));
  if (input.entries.length > candidates.length) changed = true;
  block.truncated = changed;
  while (JSON.stringify(block).length > cap && block.moduleIds.length) { block.moduleIds.pop(); block.truncated = true; }
  while (JSON.stringify(block).length > cap && block.summary.length) { block.summary = block.summary.slice(0, Math.floor(block.summary.length / 2)); block.truncated = true; }
  while (JSON.stringify(block).length > cap && block.name.length > 1) { block.name = block.name.slice(0, Math.floor(block.name.length / 2)); block.truncated = true; }
  for (const candidate of candidates) {
    block.entries.push(candidate);
    if (JSON.stringify(block).length > cap) { block.entries.pop(); block.truncated = true; break; }
  }
  if (input.totalAvailable > block.entries.length || input.entries.length > block.entries.length) block.truncated = true;
  do { block.totalChars = JSON.stringify(block).length; } while (block.totalChars !== JSON.stringify(block).length);
  return block;
}
