import { afterEach, describe, expect, it } from "vitest";
import { ExecutionRepository, type ExecutionInput } from "./execution-repository.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function fixture() {
  const store = new WorkflowStore(":memory:");
  stores.push(store);
  const project = store.createProject({
    name: "Execution repository",
    repoPath: "/tmp/execution-repository",
    defaultBranch: "main",
    allowedCommands: [],
    sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id,
    name: "v1",
    branch: "feature/v1",
    baseBranch: "main",
    worktreePath: "/tmp/execution-repository-v1",
    headCommit: "version-head"
  });
  const requirement = store.createRequirement({
    title: "Persist execution",
    businessProblem: "Execution evidence needs a focused owner",
    expectedOutcome: "Execution evidence remains readable",
    priority: "medium",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
  const unit = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["passes"] }], dependencies: [] }
  }).units[0]!;
  return {
    repository: new ExecutionRepository((store as any).db),
    project,
    version,
    requirement,
    unit
  };
}

describe("ExecutionRepository", () => {
  it("persists and maps delivery-owned executions and coding evidence", () => {
    const item = fixture();
    const input: ExecutionInput = {
      requirementId: item.requirement.id,
      deliveryUnitId: item.unit.id,
      evidenceVersion: 1,
      stage: "implementation",
      projectId: item.project.id,
      projectVersionId: item.version.id,
      branch: "ai/REQ-0001",
      worktreePath: "/tmp/execution-repository-run",
      baseCommit: "version-head",
      status: "completed",
      commands: [{ command: "npm", args: ["test"] }],
      diff: "diff"
    };

    const execution = item.repository.add(input);
    const evidence = item.repository.addCodingEvidence({
      executionId: execution.id,
      requirementId: item.requirement.id,
      deliveryUnitId: item.unit.id,
      evidenceVersion: 1,
      projectId: item.project.id,
      branch: input.branch,
      worktreePath: input.worktreePath,
      diffHash: "abc",
      diff: "diff",
      sourceRepoPath: "/tmp/execution-repository",
      gitCommonDir: "/tmp/execution-repository/.git",
      sourceHead: "version-head",
      manifestHash: "manifest-hash",
      manifest: { version: 1, entries: [] },
      changedFiles: [],
      originalChars: 4,
      truncated: false,
      files: ["src/index.ts"],
      additions: 1,
      deletions: 0,
      diagnostics: ""
    });

    expect(item.repository.listForRequirement(item.requirement.id)).toEqual([
      expect.objectContaining({
        id: execution.id,
        deliveryUnitId: item.unit.id,
        evidenceVersion: 1,
        commands: input.commands
      })
    ]);
    expect(item.repository.getLatestCodingEvidence(item.requirement.id)).toMatchObject({
      id: evidence.id,
      deliveryUnitId: item.unit.id,
      evidenceVersion: 1,
      sourceHead: "version-head",
      manifest: { version: 1, entries: [] },
      files: ["src/index.ts"],
      fileCount: 1
    });
  });
});
