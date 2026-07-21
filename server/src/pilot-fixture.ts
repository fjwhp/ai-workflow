import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync
} from "node:fs";
import { basename, resolve } from "node:path";
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

export interface DeliveryPilotFixtureOptions {
  afterFirstMutation?: () => void;
  writeMarker?: typeof writeDatabaseVersionMarker;
  beforePublish?: () => void;
  publish?: (stagingDir: string, dataDir: string) => Promise<void> | void;
}

export async function seedDeliveryPilot(
  inputDataDir: string,
  options: DeliveryPilotFixtureOptions = {}
): Promise<DeliveryPilotFixture> {
  if (typeof inputDataDir !== "string" || inputDataDir.trim() === "") {
    throw new Error("PILOT_DATA_DIR_REQUIRED");
  }
  const dataDir = resolve(inputDataDir);
  const parentDir = resolve(dataDir, "..");
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  assertEmptyPilotTarget(dataDir, "PILOT_DATA_DIR_NOT_EMPTY");

  const stagingDir = resolve(parentDir, `.${basename(dataDir)}.pilot-staging-${randomUUID()}`);
  mkdirSync(stagingDir, { mode: 0o700 });
  let published = false;
  try {
    const staged = seedPilotStore(stagingDir, options);
    const stagedDatabasePath = resolve(stagingDir, "workflow.db");
    const markerPath = await (options.writeMarker ?? writeDatabaseVersionMarker)(
      stagedDatabasePath,
      currentSchemaVersion
    );
    fsyncPath(stagedDatabasePath);
    fsyncPath(markerPath);
    fsyncPath(stagingDir);

    options.beforePublish?.();
    try {
      assertEmptyPilotTarget(dataDir, "PILOT_PUBLISH_CONFLICT");
    } catch (error) {
      throw new Error("PILOT_PUBLISH_CONFLICT", { cause: error });
    }
    try {
      await (options.publish ?? defaultPublish)(stagingDir, dataDir);
    } catch (error) {
      if (pilotErrorCode(error) !== "PILOT_PUBLISH_INJECTED") {
        throw new Error("PILOT_PUBLISH_CONFLICT", { cause: error });
      }
      throw error;
    }
    published = true;
    try { fsyncPath(parentDir); } catch {}
    return {
      dataDir,
      databasePath: resolve(dataDir, "workflow.db"),
      ...staged
    };
  } finally {
    if (!published) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function seedPilotStore(
  stagingDir: string,
  options: DeliveryPilotFixtureOptions
): Omit<DeliveryPilotFixture, "dataDir" | "databasePath"> {
  const databasePath = resolve(stagingDir, "workflow.db");
  const repositoriesDir = resolve(stagingDir, "pilot-repositories");
  const backendRepo = resolve(repositoriesDir, "backend");
  const frontendRepo = resolve(repositoriesDir, "frontend");
  const backendWorktree = resolve(repositoriesDir, "backend-worktree");
  const frontendWorktree = resolve(repositoriesDir, "frontend-worktree");
  for (const path of [backendRepo, frontendRepo, backendWorktree, frontendWorktree]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  const store = new WorkflowStore(databasePath);
  try {
    const backend = store.createProject({
      name: "Pilot Backend", repoPath: backendRepo, defaultBranch: "main",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
    });
    options.afterFirstMutation?.();
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
    return {
      requirementId: requirement.id,
      backendUnitId: backendUnit.id,
      frontendUnitId: frontendUnit.id
    };
  } finally {
    store.close();
  }
}

function assertEmptyPilotTarget(dataDir: string, nonemptyCode: string) {
  if (!existsSync(dataDir)) return;
  const stat = lstatSync(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PILOT_DATA_DIR_INVALID");
  if (existsSync(resolve(dataDir, "workflow.db"))) throw new Error("PILOT_DATABASE_EXISTS");
  if (readdirSync(dataDir).length > 0) throw new Error(nonemptyCode);
}

function defaultPublish(stagingDir: string, dataDir: string) {
  renameSync(stagingDir, dataDir);
}

function fsyncPath(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
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

function pilotErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /^PILOT_[A-Z0-9_]+$/.test(message) ? message : "PILOT_SEED_FAILED";
}

function isDirectExecution() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  try {
    const fixture = await seedDeliveryPilot(process.env.PILOT_DATA_DIR ?? "");
    process.stdout.write(`FLOWGATE_PILOT_READY ${JSON.stringify(fixture)}\n`);
  } catch (error) {
    process.stderr.write(`FLOWGATE_PILOT_ERROR ${JSON.stringify({ code: pilotErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}
