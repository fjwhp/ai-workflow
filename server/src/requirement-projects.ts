import {
  requirementProjectsInputSchema,
  type RequirementProject,
  type RequirementProjectInput
} from "@ai-workflow/shared";

export const MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED = "MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED";

export interface RequirementProjectValidationContext {
  projects: Array<{ id: string; status: string }>;
  modulesByProject?: Map<string, Iterable<string>>;
}

export function normalizeModuleId(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function moduleValidationError(code: string, index: number) {
  const error = new Error(code) as Error & { path: Array<string | number> };
  error.path = ["moduleIds", index];
  return error;
}

export function validateRequirementProjects(
  inputs: RequirementProjectInput[],
  context: RequirementProjectValidationContext
): RequirementProjectInput[] {
  const parsed = requirementProjectsInputSchema.parse(inputs);
  const projects = new Map(context.projects.map((project) => [project.id, project]));
  return parsed.map((item) => {
    if (projects.get(item.projectId)?.status !== "active") throw new Error("PROJECT_NOT_ACTIVE");
    if (item.moduleMode !== "selected") return item;
    const moduleIds = item.moduleIds.map(normalizeModuleId);
    const seen = new Set<string>();
    for (const [index, moduleId] of moduleIds.entries()) {
      if (!moduleId || moduleId.startsWith("/") || moduleId.split("/").some((part) => part === "." || part === "..")) {
        throw moduleValidationError("MODULE_ID_INVALID", index);
      }
      if (seen.has(moduleId)) throw moduleValidationError("DUPLICATE_MODULE_ID", index);
      seen.add(moduleId);
    }
    const indexed = context.modulesByProject?.get(item.projectId);
    if (!indexed) throw new Error("MODULE_INDEX_REQUIRED");
    const available = new Set(Array.from(indexed, normalizeModuleId));
    if (moduleIds.some((moduleId) => !available.has(moduleId))) throw new Error("MODULE_NOT_FOUND");
    return { ...item, moduleIds };
  });
}

export function resolveSoleDeliveryProject<T extends Pick<RequirementProject, "usage" | "status">>(items: T[]): T | null {
  const delivery = items.filter((item) => item.status === "active" && item.usage === "delivery");
  if (delivery.length > 1) throw new Error(MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED);
  return delivery[0] ?? null;
}

export function hasMaterialAssociationChange(before: Array<RequirementProjectInput & Record<string, unknown>>, after: Array<RequirementProjectInput & Record<string, unknown>>): boolean {
  const material = (items: RequirementProjectInput[]) => items.map((item) => ({
    projectId: item.projectId,
    role: item.role,
    usage: item.usage,
    deliveryRequired: item.deliveryRequired,
    moduleMode: item.moduleMode,
    moduleIds: item.moduleIds.map(normalizeModuleId).sort()
  })).sort((left, right) => left.projectId.localeCompare(right.projectId));
  return JSON.stringify(material(before)) !== JSON.stringify(material(after));
}
