import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];

afterEach(() => stores.splice(0).forEach((store) => store.close()));

function acceptanceReadyFixture() {
  const store = new WorkflowStore(":memory:");
  stores.push(store);
  const project = store.createProject({
    name: "Detail acceptance",
    repoPath: `/tmp/detail-acceptance-${crypto.randomUUID()}`,
    defaultBranch: "main",
    allowedCommands: [],
    sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id,
    name: "v1",
    branch: "feature/detail",
    baseBranch: "main",
    worktreePath: `/tmp/detail-acceptance-worktree-${crypto.randomUUID()}`,
    headCommit: "fixture-head"
  });
  const requirement = store.createRequirement({
    title: "Detail action",
    businessProblem: "Clients must not infer aggregate eligibility",
    expectedOutcome: "The server owns allowed actions",
    priority: "high",
    primaryProjectId: project.id,
    primaryProjectVersionId: version.id
  });
  store.replaceRequirementProjects(requirement.id, [{
    projectId: project.id,
    projectVersionId: version.id,
    role: "primary",
    usage: "delivery",
    deliveryRequired: true,
    moduleMode: "all",
    moduleIds: [],
    position: 0
  }]);
  const unit = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["done"] }],
      dependencies: [] }
  }).units[0]!;
  const implementation = store.deliveryExecutions.claimImplementation(unit.id, "detail-test");
  store.deliveryExecutions.completeImplementation(implementation, {
    branch: version.branch,
    worktreePath: version.worktreePath,
    baseCommit: version.headCommit,
    commands: [],
    diff: "diff",
    diffHash: "diff-hash",
    changedFiles: [],
    identity: {
      repositoryPath: project.repoPath,
      gitCommonDir: `${project.repoPath}/.git`,
      worktreePath: version.worktreePath,
      branch: version.branch,
      headCommit: version.headCommit
    },
    manifest: { version: 1, entries: [] },
    manifestHash: "manifest-hash",
    originalChars: 4,
    truncated: false,
    files: [],
    additions: 1,
    deletions: 0,
    diagnostics: "",
    output: {}
  });
  for (const kind of ["code_review", "automated_testing"] as const) {
    const claim = store.deliveryQuality.claim(unit.id, 1, kind, `${kind}-detail`);
    if (claim.status !== "running") throw new Error("expected quality claim");
    store.deliveryQuality.complete(claim, { result: "passed", content: { result: "passed" } });
  }
  store.updateRequirementState(requirement.id, "implementation", "ai_ready");
  return { store, requirement, unit };
}

describe("DeliveryUnitDetailRepository acceptance actions", () => {
  it("owns aggregate acceptance eligibility and removes the action for stale or paused delivery", () => {
    const fixture = acceptanceReadyFixture();

    expect(fixture.store.deliveryUnitDetails.getForRequirement(fixture.requirement.id).allowedActions)
      .toEqual([{ type: "accept_delivery", commentRequired: true }]);

    (fixture.store as any).db.prepare("UPDATE delivery_units SET status = 'potentially_stale' WHERE id = ?")
      .run(fixture.unit.id);
    expect(fixture.store.deliveryUnitDetails.getForRequirement(fixture.requirement.id).allowedActions).toEqual([]);

    (fixture.store as any).db.prepare("UPDATE delivery_units SET status = 'ready_for_acceptance' WHERE id = ?")
      .run(fixture.unit.id);
    fixture.store.deliveryCoordination.pauseAutomation({
      requirementId: fixture.requirement.id,
      actor: "local-human",
      reason: "Pause acceptance"
    });
    const paused = fixture.store.deliveryUnitDetails.getForRequirement(fixture.requirement.id);
    expect(paused.allowedActions).toEqual([]);
    expect(paused.units[0]!.allowedActions).toEqual([]);
  });
});
