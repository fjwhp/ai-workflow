import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliveryExecutionSuccess } from "./delivery-execution-repository.js";
import { writeDatabaseVersionMarker } from "./database-reset.js";
import { currentSchemaVersion } from "./schema-version.js";
import { WorkflowStore } from "./store.js";

export interface DeliveryPilotFixture {
  dataDir: string;
  databasePath: string;
  requirementId: string;
  backendUnitId: string;
  frontendUnitId: string;
}

export async function seedDeliveryPilot(inputDataDir: string): Promise<DeliveryPilotFixture> {
  if (typeof inputDataDir !== "string" || inputDataDir.trim() === "") {
    throw new Error("PILOT_DATA_DIR_REQUIRED");
  }
  const dataDir = resolve(inputDataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = resolve(dataDir, "workflow.db");
  if ([databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}.schema-version`]
    .some((path) => existsSync(path))) {
    throw new Error("PILOT_DATABASE_EXISTS");
  }
  if (readdirSync(dataDir).length > 0) throw new Error("PILOT_DATA_DIR_NOT_EMPTY");

  const repositoriesDir = resolve(dataDir, "pilot-repositories");
  const backendRepo = resolve(repositoriesDir, "backend");
  const frontendRepo = resolve(repositoriesDir, "frontend");
  const backendWorktree = resolve(repositoriesDir, "backend-worktree");
  const frontendWorktree = resolve(repositoriesDir, "frontend-worktree");
  for (const path of [backendRepo, frontendRepo, backendWorktree, frontendWorktree]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  const store = new WorkflowStore(databasePath);
  let fixture: Omit<DeliveryPilotFixture, "dataDir" | "databasePath">;
  try {
    const backend = store.createProject({
      name: "Pilot Backend", repoPath: backendRepo, defaultBranch: "main",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
    });
    const frontend = store.createProject({
      name: "Pilot Frontend", repoPath: frontendRepo, defaultBranch: "main",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
    });
    const backendVersion = store.createProjectVersion({
      projectId: backend.id, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "main",
      worktreePath: backendWorktree, headCommit: "pilot-backend-base"
    });
    const frontendVersion = store.createProjectVersion({
      projectId: frontend.id, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "main",
      worktreePath: frontendWorktree, headCommit: "pilot-frontend-base"
    });
    const requirement = store.createRequirement({
      title: "Pilot: backend and frontend delivery",
      businessProblem: "Verify dependency release, evidence invalidation, pause, and recovery actions",
      expectedOutcome: "Operators can inspect one auditable multi-project delivery flow",
      priority: "high", primaryProjectId: backend.id, primaryProjectVersionId: backendVersion.id
    });
    store.replaceRequirementProjects(requirement.id, [
      { projectId: backend.id, projectVersionId: backendVersion.id, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 },
      { projectId: frontend.id, projectVersionId: frontendVersion.id, role: "collaborator", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 }
    ]);
    const snapshot = store.createRequirementProjectSnapshot(requirement.id);
    const plan = store.deliveryUnits.createPlan({
      requirementId: requirement.id, snapshot,
      plan: {
        units: [
          { projectId: backend.id, moduleIds: ["api"], acceptanceCriteria: ["Backend contract is verified"] },
          { projectId: frontend.id, moduleIds: ["web"], acceptanceCriteria: ["Frontend consumes the current contract"] }
        ],
        dependencies: [{ upstreamProjectId: backend.id, downstreamProjectId: frontend.id,
          releaseCondition: "automated_testing_passed" }]
      }
    });
    const backendUnit = plan.units.find((unit) => unit.projectId === backend.id)!;
    const frontendUnit = plan.units.find((unit) => unit.projectId === frontend.id)!;

    store.deliveryCoordination.completeContractEvidence({
      unitId: backendUnit.id, version: 1, contractHash: "pilot-contract-v1",
      content: { endpoint: "GET /pilot/v1/items" }, actor: "local-pilot"
    });
    completeImplementation(store, backendUnit.id, backendRepo, backendWorktree, backendVersion.branch,
      backendVersion.headCommit, "backend-v1");
    completeQuality(store, backendUnit.id, "code_review", "pilot-backend-review");
    completeQuality(store, backendUnit.id, "automated_testing", "pilot-backend-test");
    completeImplementation(store, frontendUnit.id, frontendRepo, frontendWorktree, frontendVersion.branch,
      frontendVersion.headCommit, "frontend-v1");
    store.deliveryCoordination.completeContractEvidence({
      unitId: backendUnit.id, version: 2, contractHash: "pilot-contract-v2",
      content: { endpoint: "GET /pilot/v2/items" }, actor: "local-pilot"
    });
    store.deliveryCoordination.pauseAutomation({
      requirementId: requirement.id, actor: "local-pilot",
      reason: "Pilot pause exposes stale evidence and server-owned recovery actions"
    });
    fixture = {
      requirementId: requirement.id,
      backendUnitId: backendUnit.id,
      frontendUnitId: frontendUnit.id
    };
  } finally {
    store.close();
  }
  await writeDatabaseVersionMarker(databasePath, currentSchemaVersion);
  return { dataDir, databasePath, ...fixture };
}

function completeImplementation(
  store: WorkflowStore,
  unitId: string,
  repositoryPath: string,
  worktreePath: string,
  branch: string,
  headCommit: string,
  fingerprint: string
) {
  const claim = store.deliveryExecutions.claimImplementation(unitId, "pilot-fixture");
  const result: DeliveryExecutionSuccess = {
    branch, worktreePath, baseCommit: headCommit, commands: [],
    diff: `diff --git a/${fingerprint}.txt b/${fingerprint}.txt\n+pilot fixture\n`,
    diffHash: `pilot-diff-${fingerprint}`,
    changedFiles: [],
    identity: {
      repositoryPath, gitCommonDir: resolve(repositoryPath, ".git"), worktreePath, branch, headCommit
    },
    manifest: { version: 1, entries: [] }, manifestHash: `pilot-manifest-${fingerprint}`,
    originalChars: 64, truncated: false, files: [`${fingerprint}.txt`],
    additions: 1, deletions: 0, diagnostics: "", output: { fixture: fingerprint }
  };
  store.deliveryExecutions.completeImplementation(claim, result);
}

function completeQuality(
  store: WorkflowStore,
  unitId: string,
  kind: "code_review" | "automated_testing",
  claimToken: string
) {
  const unit = store.deliveryUnits.get(unitId)!;
  const claim = store.deliveryQuality.claim(unitId, unit.evidenceVersion, kind, claimToken);
  if (claim.status !== "running") throw new Error("PILOT_QUALITY_CLAIM_FAILED");
  store.deliveryQuality.complete(claim, {
    result: "passed", content: { summary: `${kind} passed in the local pilot` },
    commandResults: kind === "automated_testing" ? [{ command: "npm test", exitCode: 0 }] : [],
    acceptanceTrace: kind === "automated_testing"
      ? [{ criterion: "Backend contract is verified", passed: true }] : []
  });
}

function isDirectExecution() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  const fixture = await seedDeliveryPilot(process.env.PILOT_DATA_DIR ?? "");
  process.stdout.write(`FLOWGATE_PILOT_READY ${JSON.stringify(fixture)}\n`);
}
