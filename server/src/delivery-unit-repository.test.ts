import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore, type RequirementProjectSnapshot } from "./store.js";

const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function unit(projectId: string, moduleIds = [`src/${projectId}`]) {
  return { projectId, moduleIds, acceptanceCriteria: [`${projectId} acceptance passes`] };
}

function dependency(upstreamProjectId: string, downstreamProjectId: string) {
  return { upstreamProjectId, downstreamProjectId, releaseCondition: "automated_testing_passed" as const };
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "delivery-plan-repository-"));
  directories.push(directory);
  const path = join(directory, "workflow.db");
  const store = new WorkflowStore(path);
  stores.push(store);
  const database = new DatabaseSync(path);
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");

  const backend = store.createProject({
    name: "Backend", repoPath: join(directory, "backend"), defaultBranch: "main",
    allowedCommands: ["npm test"], sensitivePatterns: [".env*"]
  });
  const frontend = store.createProject({
    name: "Frontend", repoPath: join(directory, "frontend"), defaultBranch: "trunk",
    allowedCommands: ["npm run test:web"], sensitivePatterns: ["secrets/**"]
  });
  const context = store.createProject({
    name: "Context", repoPath: join(directory, "context"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const backendVersion = store.createProjectVersion({
    projectId: backend.id, name: "backend-v1", branch: "feature/backend", baseBranch: "main",
    worktreePath: join(directory, "backend-v1"), headCommit: "backend-head"
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "frontend-v1", branch: "feature/frontend", baseBranch: "trunk",
    worktreePath: join(directory, "frontend-v1"), headCommit: "frontend-head"
  });
  const requirement = store.createRequirement({
    title: "Coordinated delivery", businessProblem: "Both applications must change together",
    expectedOutcome: "Backend and frontend ship in dependency order", priority: "high",
    primaryProjectId: backend.id, primaryProjectVersionId: backendVersion.id
  });
  store.replaceRequirementProjects(requirement.id, [
    {
      projectId: backend.id, projectVersionId: backendVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    },
    {
      projectId: frontend.id, projectVersionId: frontendVersion.id, role: "collaborator", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1
    },
    {
      projectId: context.id, role: "collaborator", usage: "context",
      deliveryRequired: false, moduleMode: "auto", moduleIds: [], position: 2
    }
  ]);
  const snapshot = store.createRequirementProjectSnapshot(requirement.id);
  const backendKnowledge = store.beginProjectKnowledge(backend.id, "backend-head", "fixture");
  store.completeProjectKnowledge(backendKnowledge.id, {
    summary: "backend knowledge", entries: [{ path: "src/backend", kind: "module", title: "Backend", content: "", tags: [] }]
  });
  const frontendKnowledge = store.beginProjectKnowledge(frontend.id, "frontend-head", "fixture");
  store.completeProjectKnowledge(frontendKnowledge.id, {
    summary: "frontend knowledge", entries: [{ path: "src/frontend", kind: "module", title: "Frontend", content: "", tags: [] }]
  });

  const input = {
    requirementId: requirement.id,
    snapshot,
    plan: {
      units: [unit(backend.id), unit(frontend.id)],
      dependencies: [dependency(backend.id, frontend.id)]
    }
  };
  return {
    store, database, requirement, backend, frontend, context, backendVersion, frontendVersion,
    backendKnowledge, frontendKnowledge, snapshot, input
  };
}

function replaceSnapshotAssociations(
  fixture: ReturnType<typeof createFixture>,
  transform: (associations: RequirementProjectSnapshot["associations"]) => RequirementProjectSnapshot["associations"]
) {
  const associations = transform(structuredClone(fixture.snapshot.associations));
  fixture.database.prepare("UPDATE requirement_project_snapshots SET associations_json = ? WHERE id = ?")
    .run(JSON.stringify(associations), fixture.snapshot.id);
  return fixture.store.getRequirementProjectSnapshot(fixture.requirement.id)!;
}

function expectNoWrites(fixture: ReturnType<typeof createFixture>) {
  expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)).toEqual([]);
  expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)).toEqual([]);
  expect(fixture.database.prepare("SELECT * FROM delivery_unit_snapshots WHERE requirement_id = ?")
    .all(fixture.requirement.id)).toEqual([]);
}

describe("DeliveryUnitRepository", () => {
  it("persists a frozen delivery plan with stable positions and dependency-derived statuses", () => {
    const fixture = createFixture();

    const result = fixture.store.deliveryUnits.createPlan(fixture.input);

    expect(result.units.map((item) => [item.projectId, item.status])).toEqual([
      [fixture.backend.id, "ready"],
      [fixture.frontend.id, "waiting_dependency"]
    ]);
    expect(result.units.map((item) => item.position)).toEqual([0, 1]);
    expect(result.units.every((item) => item.required && item.phase === "implementation" && item.evidenceVersion === 1)).toBe(true);
    expect(result.units.map((item) => item.projectVersionId)).toEqual([
      fixture.backendVersion.id, fixture.frontendVersion.id
    ]);
    expect(result.units.every((item) => item.associationSnapshotId === fixture.snapshot.id)).toBe(true);
    expect(new Set(result.units.map((item) => item.createdAt))).toHaveLength(1);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toMatchObject({
      requirementId: fixture.requirement.id,
      upstreamUnitId: result.units[0]!.id,
      downstreamUnitId: result.units[1]!.id,
      releaseCondition: "automated_testing_passed",
      releasedByEvidenceVersion: null,
      releasedAt: null,
      createdAt: result.units[0]!.createdAt
    });
    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)).toEqual(result.units);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)).toEqual(result.dependencies);

    const snapshots = fixture.database.prepare(`SELECT * FROM delivery_unit_snapshots
      WHERE requirement_id = ? ORDER BY created_at, rowid`).all(fixture.requirement.id) as any[];
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      delivery_unit_id: result.units[0]!.id,
      project_id: fixture.backend.id,
      project_version_id: fixture.backendVersion.id,
      repo_path: fixture.backend.repoPath,
      branch: fixture.backendVersion.branch,
      base_branch: fixture.backendVersion.baseBranch,
      worktree_path: fixture.backendVersion.worktreePath,
      head_commit: fixture.backendVersion.headCommit,
      project_knowledge_version_id: fixture.backendKnowledge.id,
      module_ids_json: JSON.stringify([`src/${fixture.backend.id}`]),
      sensitive_patterns_json: JSON.stringify(fixture.backend.sensitivePatterns),
      allowed_commands_json: JSON.stringify(fixture.backend.allowedCommands)
    });
    expect(snapshots[1]).toMatchObject({
      delivery_unit_id: result.units[1]!.id,
      project_knowledge_version_id: fixture.frontendKnowledge.id,
      module_ids_json: JSON.stringify([`src/${fixture.frontend.id}`])
    });

    expect(() => fixture.store.deliveryUnits.createPlan(fixture.input)).toThrow("DELIVERY_PLAN_EXISTS");
    expect(fixture.store.deliveryUnits.listForRequirement(fixture.requirement.id)).toHaveLength(2);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)).toHaveLength(1);
  });

  it("rejects plan projects outside the frozen snapshot without writing", () => {
    const fixture = createFixture();
    const extra = fixture.store.createProject({
      name: "Extra", repoPath: join(directories.at(-1)!, "extra"), defaultBranch: "main",
      allowedCommands: [], sensitivePatterns: []
    });
    const input = {
      ...fixture.input,
      plan: { units: [unit(fixture.backend.id), unit(extra.id)], dependencies: [] }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_UNIT_PROJECT_SET_MISMATCH");
    expectNoWrites(fixture);
  });

  it("rejects a frozen version owned by another project without writing", () => {
    const fixture = createFixture();
    const snapshot = replaceSnapshotAssociations(fixture, (associations) => associations.map((association) =>
      association.projectId === fixture.frontend.id
        ? { ...association, projectVersionId: fixture.backendVersion.id }
        : association
    ));

    expect(() => fixture.store.deliveryUnits.createPlan({ ...fixture.input, snapshot }))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expectNoWrites(fixture);
  });

  it("rejects a delivery association without a frozen version without writing", () => {
    const fixture = createFixture();
    const snapshot = replaceSnapshotAssociations(fixture, (associations) => associations.map((association) =>
      association.projectId === fixture.frontend.id
        ? { ...association, projectVersionId: undefined }
        : association
    ));

    expect(() => fixture.store.deliveryUnits.createPlan({ ...fixture.input, snapshot }))
      .toThrow("REQUIREMENT_VERSION_REQUIRED");
    expectNoWrites(fixture);
  });

  it("rejects a delivery association that is not required without writing", () => {
    const fixture = createFixture();
    const snapshot = replaceSnapshotAssociations(fixture, (associations) => associations.map((association) =>
      association.projectId === fixture.frontend.id
        ? { ...association, deliveryRequired: false }
        : association
    ));

    expect(() => fixture.store.deliveryUnits.createPlan({ ...fixture.input, snapshot }))
      .toThrow("DELIVERY_ASSOCIATION_NOT_REQUIRED");
    expectNoWrites(fixture);
  });

  it("rejects a closed frozen project version without writing", () => {
    const fixture = createFixture();
    fixture.database.prepare("UPDATE project_versions SET status = 'closed' WHERE id = ?")
      .run(fixture.frontendVersion.id);

    expect(() => fixture.store.deliveryUnits.createPlan(fixture.input)).toThrow("PROJECT_VERSION_NOT_ACTIVE");
    expectNoWrites(fixture);
  });

  it("rejects an archived frozen project without writing", () => {
    const fixture = createFixture();
    fixture.database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(fixture.frontend.id);

    expect(() => fixture.store.deliveryUnits.createPlan(fixture.input)).toThrow("PROJECT_NOT_ACTIVE");
    expectNoWrites(fixture);
  });

  it("rejects using a context-only association as a delivery unit without writing", () => {
    const fixture = createFixture();
    const input = {
      ...fixture.input,
      plan: {
        units: [unit(fixture.backend.id), unit(fixture.frontend.id), unit(fixture.context.id)],
        dependencies: fixture.input.plan.dependencies
      }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_UNIT_CONTEXT_PROJECT");
    expectNoWrites(fixture);
  });

  it("rejects a cyclic graph without writing", () => {
    const fixture = createFixture();
    const input = {
      ...fixture.input,
      plan: {
        ...fixture.input.plan,
        dependencies: [
          dependency(fixture.backend.id, fixture.frontend.id),
          dependency(fixture.frontend.id, fixture.backend.id)
        ]
      }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_DEPENDENCY_CYCLE");
    expectNoWrites(fixture);
  });

  it.each([
    ["duplicate", "DELIVERY_DEPENDENCY_DUPLICATE_EDGE", (fixture: ReturnType<typeof createFixture>) => [
      dependency(fixture.backend.id, fixture.frontend.id),
      dependency(fixture.backend.id, fixture.frontend.id)
    ]],
    ["missing endpoint", "DELIVERY_DEPENDENCY_MISSING_ENDPOINT", (fixture: ReturnType<typeof createFixture>) => [
      dependency(fixture.backend.id, "missing-project")
    ]]
  ])("rejects a %s dependency without writing", (_case, error, makeDependencies) => {
    const fixture = createFixture();
    const input = {
      ...fixture.input,
      plan: { ...fixture.input.plan, dependencies: makeDependencies(fixture) }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow(error);
    expectNoWrites(fixture);
  });

  it("rejects a snapshot belonging to another requirement without writing", () => {
    const fixture = createFixture();
    const other = fixture.store.createRequirement({
      title: "Other requirement", businessProblem: "Must stay isolated",
      expectedOutcome: "Uses its own snapshot", priority: "low",
      primaryProjectId: fixture.backend.id, primaryProjectVersionId: fixture.backendVersion.id
    });
    const otherSnapshot = fixture.store.createRequirementProjectSnapshot(other.id);

    expect(() => fixture.store.deliveryUnits.createPlan({ ...fixture.input, snapshot: otherSnapshot }))
      .toThrow("REQUIREMENT_PROJECT_SNAPSHOT_MISMATCH");
    expectNoWrites(fixture);
  });

  it("rejects snapshot metadata that differs from the stored frozen row without writing", () => {
    const fixture = createFixture();
    const snapshot = { ...fixture.snapshot, version: fixture.snapshot.version + 1 };

    expect(() => fixture.store.deliveryUnits.createPlan({ ...fixture.input, snapshot }))
      .toThrow("REQUIREMENT_PROJECT_SNAPSHOT_MISMATCH");
    expectNoWrites(fixture);
  });

  it("rejects a duplicate delivery unit project without writing", () => {
    const fixture = createFixture();
    const input = {
      ...fixture.input,
      plan: {
        units: [unit(fixture.backend.id), unit(fixture.backend.id), unit(fixture.frontend.id)],
        dependencies: fixture.input.plan.dependencies
      }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_UNIT_DUPLICATE_PROJECT");
    expectNoWrites(fixture);
  });

  it("rejects a plan missing a required frozen delivery association without writing", () => {
    const fixture = createFixture();
    const input = {
      ...fixture.input,
      plan: { units: [unit(fixture.backend.id)], dependencies: [] }
    };

    expect(() => fixture.store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_UNIT_PROJECT_SET_MISMATCH");
    expectNoWrites(fixture);
  });
});
