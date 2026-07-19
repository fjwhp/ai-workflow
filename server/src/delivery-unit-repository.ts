import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  deliveryReleaseConditions,
  deliveryUnitPhases,
  deliveryUnitStatuses,
  validateDeliveryGraph,
  type DeliveryDependencyInput
} from "@ai-workflow/shared";
import { normalizeModuleId } from "./requirement-projects.js";

export type DeliveryUnitPhase = typeof deliveryUnitPhases[number];
export type DeliveryUnitStatus = typeof deliveryUnitStatuses[number];
export type DeliveryReleaseCondition = typeof deliveryReleaseConditions[number];

export interface DeliveryPlanUnitInput {
  projectId: string;
  moduleIds: string[];
  acceptanceCriteria: string[];
}

export interface FrozenDeliveryAssociation {
  projectId: string;
  projectVersionId?: string;
  projectVersionBranch?: string;
  projectVersionWorktreePath?: string;
  projectVersionHead?: string;
  usage: "context" | "delivery";
  deliveryRequired: boolean;
  moduleMode: "auto" | "all" | "selected";
  moduleIds: string[];
}

export interface DeliveryAssociationSnapshotInput {
  id: string;
  requirementId: string;
  version?: number;
  associations: FrozenDeliveryAssociation[];
}

export interface CreateDeliveryPlanInput {
  requirementId: string;
  snapshot: DeliveryAssociationSnapshotInput;
  plan: {
    units: DeliveryPlanUnitInput[];
    dependencies: DeliveryDependencyInput[];
  };
}

export interface DeliveryUnit {
  id: string;
  requirementId: string;
  associationSnapshotId: string;
  projectId: string;
  projectVersionId: string;
  required: boolean;
  position: number;
  phase: DeliveryUnitPhase;
  status: DeliveryUnitStatus;
  evidenceVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DeliveryDependency {
  id: string;
  requirementId: string;
  upstreamUnitId: string;
  downstreamUnitId: string;
  releaseCondition: DeliveryReleaseCondition;
  releasedByEvidenceVersion: number | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface DeliveryPlanResult {
  units: DeliveryUnit[];
  dependencies: DeliveryDependency[];
}

export interface DeliveryUnitPersistence {
  createPlan(input: CreateDeliveryPlanInput): DeliveryPlanResult;
  listForRequirement(requirementId: string): DeliveryUnit[];
  listDependencies(requirementId: string): DeliveryDependency[];
}

interface SnapshotRow {
  id: string;
  requirement_id: string;
  version: number;
  associations_json: string;
  status: "active" | "superseded";
}

interface ProjectRow {
  id: string;
  repo_path: string;
  default_branch: string;
  allowed_commands: string;
  sensitive_patterns: string;
  status: string;
}

interface ProjectVersionRow {
  id: string;
  project_id: string;
  branch: string;
  base_branch: string;
  worktree_path: string;
  head_commit: string;
  status: string;
}

interface PreparedUnit {
  id: string;
  input: DeliveryPlanUnitInput;
  association: FrozenDeliveryAssociation;
  project: ProjectRow;
  version: ProjectVersionRow;
  knowledgeVersionId: string | null;
  required: boolean;
  status: "ready" | "waiting_dependency";
  position: number;
}

export class DeliveryUnitRepository implements DeliveryUnitPersistence {
  constructor(private readonly db: DatabaseSync) {}

  createPlan(input: CreateDeliveryPlanInput): DeliveryPlanResult {
    this.validateInputShape(input);
    if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(input.requirementId)) {
      throw new Error("REQUIREMENT_NOT_FOUND");
    }
    if (this.db.prepare("SELECT id FROM delivery_units WHERE requirement_id = ? LIMIT 1").get(input.requirementId)) {
      throw new Error("DELIVERY_PLAN_EXISTS");
    }

    const snapshotRow = this.db.prepare("SELECT * FROM requirement_project_snapshots WHERE id = ?")
      .get(input.snapshot.id) as SnapshotRow | undefined;
    if (!snapshotRow) throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_NOT_FOUND");
    if (snapshotRow.status !== "active") throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_NOT_ACTIVE");
    const storedAssociations = parseAssociations(snapshotRow.associations_json);
    if (
      snapshotRow.requirement_id !== input.requirementId
      || input.snapshot.requirementId !== input.requirementId
      || (input.snapshot.version !== undefined && input.snapshot.version !== snapshotRow.version)
      || canonicalJson(input.snapshot.associations) !== canonicalJson(storedAssociations)
    ) {
      throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_MISMATCH");
    }

    const deliveryAssociations = storedAssociations.filter((association) => association.usage === "delivery");
    const contextProjectIds = new Set(
      storedAssociations.filter((association) => association.usage === "context").map((association) => association.projectId)
    );
    const planProjectIds = input.plan.units.map((unit) => unit.projectId);
    const duplicateProjectId = planProjectIds.find((projectId, index) => planProjectIds.indexOf(projectId) !== index);
    if (duplicateProjectId) throw new Error("DELIVERY_UNIT_DUPLICATE_PROJECT");
    if (planProjectIds.some((projectId) => contextProjectIds.has(projectId))) {
      throw new Error("DELIVERY_UNIT_CONTEXT_PROJECT");
    }

    const associationByProject = new Map<string, FrozenDeliveryAssociation>();
    for (const association of deliveryAssociations) {
      if (!association.projectVersionId) throw new Error("REQUIREMENT_VERSION_REQUIRED");
      if (associationByProject.has(association.projectId)) throw new Error("DELIVERY_ASSOCIATION_DUPLICATE_PROJECT");
      associationByProject.set(association.projectId, association);
    }
    if (
      planProjectIds.length !== associationByProject.size
      || planProjectIds.some((projectId) => !associationByProject.has(projectId))
    ) {
      throw new Error("DELIVERY_UNIT_PROJECT_SET_MISMATCH");
    }

    validateDeliveryGraph(planProjectIds, input.plan.dependencies);
    const downstreamProjectIds = new Set(input.plan.dependencies.map((dependency) => dependency.downstreamProjectId));
    const preparedUnits = input.plan.units.map((unit, position): PreparedUnit => {
      const association = associationByProject.get(unit.projectId)!;
      const normalizedModuleIds = normalizeDeliveryUnitModuleIds(unit.moduleIds);
      if (association.moduleMode === "selected") {
        const frozenModuleIds = new Set(normalizeDeliveryUnitModuleIds(association.moduleIds));
        if (normalizedModuleIds.some((moduleId) => !frozenModuleIds.has(moduleId))) {
          throw new Error("DELIVERY_UNIT_MODULE_SCOPE_INVALID");
        }
      }
      const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(unit.projectId) as ProjectRow | undefined;
      if (!project || project.status !== "active") throw new Error("PROJECT_NOT_ACTIVE");
      const version = this.db.prepare("SELECT * FROM project_versions WHERE id = ?")
        .get(association.projectVersionId!) as ProjectVersionRow | undefined;
      if (!version || version.project_id !== unit.projectId) throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
      if (version.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
      const knowledge = this.db.prepare(`SELECT id FROM project_knowledge_versions
        WHERE project_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1`).get(unit.projectId) as { id: string } | undefined;
      return {
        id: randomUUID(), input: { ...unit, moduleIds: normalizedModuleIds }, association, project, version,
        knowledgeVersionId: knowledge?.id ?? null,
        required: association.deliveryRequired,
        status: downstreamProjectIds.has(unit.projectId) ? "waiting_dependency" : "ready",
        position
      };
    });

    const unitIdByProject = new Map(preparedUnits.map((unit) => [unit.input.projectId, unit.id]));
    const preparedDependencies = input.plan.dependencies.map((dependency) => ({
      id: randomUUID(),
      upstreamUnitId: unitIdByProject.get(dependency.upstreamProjectId)!,
      downstreamUnitId: unitIdByProject.get(dependency.downstreamProjectId)!,
      releaseCondition: dependency.releaseCondition
    }));
    const now = new Date().toISOString();

    const insertUnit = this.db.prepare(`INSERT INTO delivery_units
      (id, requirement_id, association_snapshot_id, project_id, project_version_id, required, position,
       phase, status, evidence_version, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'implementation', ?, 1, ?, ?, NULL)`);
    const insertSnapshot = this.db.prepare(`INSERT INTO delivery_unit_snapshots
      (id, delivery_unit_id, requirement_id, project_id, project_version_id, repo_path, branch,
       base_branch, worktree_path, head_commit, module_ids_json, sensitive_patterns_json,
       allowed_commands_json, project_knowledge_version_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertDependency = this.db.prepare(`INSERT INTO delivery_dependencies
      (id, requirement_id, upstream_unit_id, downstream_unit_id, release_condition,
       released_by_evidence_version, released_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`);

    for (const unit of preparedUnits) {
      insertUnit.run(
        unit.id, input.requirementId, input.snapshot.id, unit.input.projectId,
        unit.version.id, unit.required ? 1 : 0, unit.position, unit.status, now, now
      );
      insertSnapshot.run(
        randomUUID(), unit.id, input.requirementId, unit.input.projectId, unit.version.id,
        unit.project.repo_path,
        unit.association.projectVersionBranch ?? unit.version.branch,
        unit.version.base_branch,
        unit.association.projectVersionWorktreePath ?? unit.version.worktree_path,
        unit.association.projectVersionHead ?? unit.version.head_commit,
        JSON.stringify(unit.input.moduleIds), unit.project.sensitive_patterns,
        unit.project.allowed_commands, unit.knowledgeVersionId, now
      );
    }
    for (const dependency of preparedDependencies) {
      insertDependency.run(
        dependency.id, input.requirementId, dependency.upstreamUnitId,
        dependency.downstreamUnitId, dependency.releaseCondition, now
      );
    }

    return {
      units: this.listForRequirement(input.requirementId),
      dependencies: this.listDependencies(input.requirementId)
    };
  }

  listForRequirement(requirementId: string): DeliveryUnit[] {
    return (this.db.prepare("SELECT * FROM delivery_units WHERE requirement_id = ? ORDER BY position, created_at, rowid")
      .all(requirementId) as any[]).map(mapDeliveryUnit);
  }

  listDependencies(requirementId: string): DeliveryDependency[] {
    return (this.db.prepare("SELECT * FROM delivery_dependencies WHERE requirement_id = ? ORDER BY rowid")
      .all(requirementId) as any[]).map(mapDeliveryDependency);
  }

  private validateInputShape(input: CreateDeliveryPlanInput) {
    if (!input.requirementId?.trim()) throw new Error("REQUIREMENT_ID_REQUIRED");
    if (!input.snapshot?.id?.trim() || !input.snapshot.requirementId?.trim() || !Array.isArray(input.snapshot.associations)) {
      throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_INVALID");
    }
    if (!input.plan || !Array.isArray(input.plan.units) || input.plan.units.length === 0 || !Array.isArray(input.plan.dependencies)) {
      throw new Error("DELIVERY_PLAN_INVALID");
    }
    for (const unit of input.plan.units) {
      if (
        !unit.projectId?.trim()
        || !Array.isArray(unit.moduleIds)
        || unit.moduleIds.some((moduleId) => typeof moduleId !== "string" || !moduleId.trim())
        || new Set(unit.moduleIds).size !== unit.moduleIds.length
        || !Array.isArray(unit.acceptanceCriteria)
        || unit.acceptanceCriteria.length === 0
        || unit.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())
      ) throw new Error("DELIVERY_UNIT_INVALID");
    }
    for (const dependency of input.plan.dependencies) {
      if (
        !dependency.upstreamProjectId?.trim()
        || !dependency.downstreamProjectId?.trim()
        || !deliveryReleaseConditions.includes(dependency.releaseCondition)
      ) throw new Error("DELIVERY_DEPENDENCY_INVALID");
    }
  }
}

function parseAssociations(value: string): FrozenDeliveryAssociation[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_INVALID"); }
  if (!Array.isArray(parsed)) throw new Error("REQUIREMENT_PROJECT_SNAPSHOT_INVALID");
  return parsed as FrozenDeliveryAssociation[];
}

function normalizeDeliveryUnitModuleIds(moduleIds: string[]): string[] {
  const normalizedModuleIds = moduleIds.map(normalizeModuleId);
  const seen = new Set<string>();
  for (const moduleId of normalizedModuleIds) {
    const segments = moduleId.split("/");
    if (
      !moduleId
      || moduleId.startsWith("/")
      || /^[a-zA-Z]:\//.test(moduleId)
      || segments.some((segment) => segment === "." || segment === "..")
      || seen.has(moduleId)
    ) {
      throw new Error("DELIVERY_UNIT_MODULE_SCOPE_INVALID");
    }
    seen.add(moduleId);
  }
  return normalizedModuleIds;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)])
    );
  };
  return JSON.stringify(normalize(value));
}

function mapDeliveryUnit(row: any): DeliveryUnit {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    associationSnapshotId: row.association_snapshot_id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    required: Boolean(row.required),
    position: row.position,
    phase: row.phase,
    status: row.status,
    evidenceVersion: row.evidence_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function mapDeliveryDependency(row: any): DeliveryDependency {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    upstreamUnitId: row.upstream_unit_id,
    downstreamUnitId: row.downstream_unit_id,
    releaseCondition: row.release_condition,
    releasedByEvidenceVersion: row.released_by_evidence_version ?? null,
    releasedAt: row.released_at ?? null,
    createdAt: row.created_at
  };
}
