export const projectRoles = ["primary", "collaborator"] as const;
export const projectUsages = ["context", "delivery"] as const;
export const moduleModes = ["auto", "all", "selected"] as const;
export const requirementProjectStatuses = ["active", "archived"] as const;

export type ProjectRole = typeof projectRoles[number];
export type ProjectUsage = typeof projectUsages[number];
export type ModuleMode = typeof moduleModes[number];
export type RequirementProjectStatus = typeof requirementProjectStatuses[number];

export interface RequirementProject {
  id: string;
  requirementId: string;
  projectId: string;
  projectName?: string;
  role: ProjectRole;
  usage: ProjectUsage;
  deliveryRequired: boolean;
  moduleMode: ModuleMode;
  moduleIds: string[];
  position: number;
  status: RequirementProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export function selectPrimaryProject(items: RequirementProject[]): RequirementProject | undefined {
  return items.find((item) => item.status === "active" && item.role === "primary");
}

export function selectDeliveryProjects(items: RequirementProject[]): RequirementProject[] {
  return items
    .filter((item) => item.status === "active" && item.usage === "delivery")
    .sort((left, right) => left.position - right.position);
}
