import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationJob } from "./automation-job-repository.js";
import {
  DeliveryApplicationService,
  type DeliveryApplicationContext
} from "./delivery-application-service.js";
import { preflightLocalIntegration } from "./integration.js";
import { getWorktreeSnapshot } from "./repository.js";
import { WorkflowStore } from "./store.js";

const exec = promisify(execFile);
const roots: string[] = [];
const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ProjectGitFixture = Awaited<ReturnType<typeof createProjectGitFixture>>;

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function head(worktree: string) {
  return git(worktree, "rev-parse", "HEAD");
}

async function status(worktree: string) {
  return (await exec("git", ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"])).stdout;
}

async function remoteRefs(project: ProjectGitFixture) {
  const [local, remote] = await Promise.all([
    git(project.repo, "for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"),
    git(project.remote, "for-each-ref", "--format=%(refname)")
  ]);
  return [local, remote].filter(Boolean);
}

async function repositoryState(project: ProjectGitFixture) {
  return {
    head: await head(project.versionWorktree),
    status: await status(project.versionWorktree),
    refs: await remoteRefs(project)
  };
}

async function expectRepositoryState(project: ProjectGitFixture, expected: Awaited<ReturnType<typeof repositoryState>>) {
  expect(await repositoryState(project)).toEqual(expected);
}

async function createProjectGitFixture(
  root: string,
  name: string,
  options: { targetConflict?: boolean; verificationFails?: boolean } = {}
) {
  const repo = join(root, name);
  const remote = join(root, `${name}-remote.git`);
  const versionWorktree = join(root, `${name}-version`);
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Flowgate Test");
  await git(repo, "remote", "add", "origin", remote);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "feature.ts"), "export const feature = 'base';\n");
  if (options.verificationFails) {
    await writeFile(join(repo, "package.json"), JSON.stringify({
      name: `${name}-fixture`, private: true, scripts: { test: "node -e \"process.exit(7)\"" }
    }, null, 2));
  }
  await git(repo, "add", "--all");
  await git(repo, "commit", "-m", "base");
  const baseHead = await head(repo);
  const targetBranch = "feature/2.2.1";
  await exec("git", ["-C", repo, "worktree", "add", "-b", targetBranch, versionWorktree, "main"]);
  if (options.targetConflict) {
    await writeFile(join(versionWorktree, "src", "feature.ts"), "export const feature = 'target';\n");
    await git(versionWorktree, "add", "--all");
    await git(versionWorktree, "commit", "-m", "target change");
  }
  return { repo, remote, versionWorktree, targetBranch, baseHead, targetHead: await head(versionWorktree) };
}

async function createFixture(options: {
  conflict?: boolean;
  verificationFails?: boolean;
  sensitiveValue?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "delivery-application-service-"));
  roots.push(root);
  const backendGit = await createProjectGitFixture(root, "backend");
  const frontendGit = await createProjectGitFixture(
    root,
    options.sensitiveValue ? `frontend-${options.sensitiveValue}` : "frontend",
    {
    targetConflict: options.conflict,
    verificationFails: options.verificationFails
    }
  );
  const databasePath = join(root, "workflow.db");
  const store = new WorkflowStore(databasePath);
  stores.push(store);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  databases.push(database);

  const backend = store.createProject({
    name: "Backend", repoPath: backendGit.repo, defaultBranch: "main",
    allowedCommands: [{ command: "git", argsPrefix: ["diff", "--cached", "--check"] }],
    sensitivePatterns: []
  });
  const frontend = store.createProject({
    name: "Frontend", repoPath: frontendGit.repo, defaultBranch: "main",
    allowedCommands: options.verificationFails
      ? [{ command: "npm", argsPrefix: ["test", "--silent"] }]
      : [{ command: "git", argsPrefix: ["diff", "--cached", "--check"] }],
    sensitivePatterns: options.sensitiveValue ? [options.sensitiveValue] : []
  });
  const backendVersion = store.createProjectVersion({
    projectId: backend.id, name: "2.2.1-backend", branch: backendGit.targetBranch, baseBranch: "main",
    worktreePath: backendGit.versionWorktree, headCommit: backendGit.targetHead
  });
  const frontendVersion = store.createProjectVersion({
    projectId: frontend.id, name: "2.2.1-frontend", branch: frontendGit.targetBranch, baseBranch: "main",
    worktreePath: frontendGit.versionWorktree, headCommit: frontendGit.targetHead
  });
  const requirement = store.createRequirement({
    title: "Apply frontend delivery", businessProblem: "The version needs verified local changes",
    expectedOutcome: "Changes are applied without a target commit", priority: "high",
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
    }
  ]);
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: {
      units: [
        { projectId: backend.id, moduleIds: ["src"], acceptanceCriteria: ["backend passes"] },
        { projectId: frontend.id, moduleIds: ["src"], acceptanceCriteria: ["frontend passes"] }
      ],
      dependencies: [{
        upstreamProjectId: backend.id, downstreamProjectId: frontend.id,
        releaseCondition: "automated_testing_passed"
      }]
    }
  });
  const contexts = new Map<string, DeliveryApplicationContext>();
  await prepareUnit(plan.units[0]!.id, backend, backendVersion, backendGit);
  await prepareUnit(plan.units[1]!.id, frontend, frontendVersion, frontendGit);

  async function prepareUnit(
    unitId: string,
    project: typeof backend,
    version: typeof backendVersion,
    projectGit: ProjectGitFixture
  ) {
    const sourceWorktree = resolve(
      projectGit.repo, "..", ".ai-workflow-worktrees", basename(projectGit.repo),
      "requirements", requirement.code
    );
    await mkdir(dirname(sourceWorktree), { recursive: true });
    const sourceBranch = `ai/${requirement.code}`;
    await exec("git", ["-C", projectGit.repo, "worktree", "add", "-b", sourceBranch, sourceWorktree, "main"]);
    await writeFile(join(sourceWorktree, "src", "feature.ts"), `export const feature = '${project.name}';\n`);
    const snapshot = await getWorktreeSnapshot(sourceWorktree);
    database.prepare(`UPDATE delivery_units
      SET phase = 'implementation', status = 'ready' WHERE id = ?`).run(unitId);
    const implementationClaim = store.deliveryExecutions.claimImplementation(unitId, "test-model");
    store.deliveryExecutions.completeImplementation(implementationClaim, {
      branch: sourceBranch, worktreePath: sourceWorktree, baseCommit: projectGit.baseHead,
      commands: [], diff: snapshot.diff, diffHash: snapshot.evidenceHash,
      changedFiles: snapshot.changedFiles, identity: snapshot.identity,
      manifestHash: snapshot.manifestHash, manifest: snapshot.manifest,
      originalChars: snapshot.diff.length, truncated: false, files: snapshot.files,
      additions: snapshot.additions, deletions: snapshot.deletions, diagnostics: "",
      output: { summary: "implemented" }
    });
    const codingEvidence = store.deliveryExecutions.getCodingEvidence(unitId, 1);
    if (!codingEvidence) throw new Error("expected coding evidence");
    for (const kind of ["code_review", "automated_testing"] as const) {
      const claim = store.deliveryQuality.claim(unitId, 1, kind);
      if (claim.status !== "running") throw new Error("expected quality claim");
      store.deliveryQuality.complete(claim, {
        result: "passed", content: { summary: `${kind} passed` },
        commandResults: kind === "automated_testing" ? [{ command: "tests", code: 0 }] : [],
        acceptanceTrace: kind === "automated_testing"
          ? [{ criterion: `${project.name.toLowerCase()} passes`, status: "passed" }]
          : []
      });
    }
    database.prepare(`UPDATE delivery_units
      SET phase = 'acceptance_delivery', status = 'ready_for_acceptance' WHERE id = ?`).run(unitId);
    contexts.set(unitId, {
      unit: store.deliveryUnits.get(unitId)!,
      project: { id: project.id, repoPath: project.repoPath },
      version: {
        id: version.id, projectId: project.id, branch: projectGit.targetBranch,
        worktreePath: version.worktreePath, status: "active", headCommit: projectGit.targetHead
      },
      snapshot: {
        repoPath: project.repoPath, targetBranch: projectGit.targetBranch,
        targetWorktreePath: version.worktreePath, targetHead: projectGit.targetHead,
        allowedCommands: project.allowedCommands as DeliveryApplicationContext["snapshot"]["allowedCommands"],
        sensitivePatterns: project.sensitivePatterns
      },
      codingEvidence: codingEvidence as DeliveryApplicationContext["codingEvidence"],
      qualityEvidence: {
        codeReview: store.deliveryQuality.latest(unitId, "code_review")!,
        automatedTesting: store.deliveryQuality.latest(unitId, "automated_testing")!
      }
    });
  }

  const service = new DeliveryApplicationService({
    applications: store.deliveryApplications,
    loadContext: async (unitId) => {
      const context = contexts.get(unitId);
      const unit = store.deliveryUnits.get(unitId);
      return context && unit ? { ...context, unit } : null;
    }
  });
  return {
    root, store, database, service, contexts, requirement,
    backend, frontend, backendVersion, frontendVersion,
    backendUnit: plan.units[0]!, frontendUnit: plan.units[1]!, backendGit, frontendGit
  };
}

function leaseApplication(
  store: WorkflowStore,
  unitId: string,
  workerId = "application-worker"
): AutomationJob {
  const queued = store.automationJobs.enqueue({
    ownerType: "delivery_unit", ownerId: unitId, evidenceVersion: 1,
    action: "apply", payload: {}, maxAttempts: 3
  });
  const leased = store.automationJobs.leaseNext(workerId, new Date(), 60_000);
  if (!leased || leased.id !== queued.id) throw new Error("expected application lease");
  return leased;
}

function applicationInput(lease: AutomationJob) {
  return { expectedEvidenceVersion: 1, claimToken: lease.claimToken };
}

function reviveApplicationJob(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  unitId: string,
  jobId: string
) {
  const now = new Date().toISOString();
  fixture.database.prepare(`UPDATE delivery_units
    SET status = 'ready_for_acceptance', completed_at = NULL, updated_at = ? WHERE id = ?`)
    .run(now, unitId);
  fixture.database.prepare(`UPDATE automation_jobs
    SET status = 'pending', attempt = 0, claim_token = id, lease_owner = NULL,
      lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`)
    .run(now, jobId);
}

function loseApplicationLeaseWithoutReconciliation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  jobId: string
) {
  fixture.database.prepare(`UPDATE automation_jobs
    SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ?`).run(new Date().toISOString(), jobId);
}

describe("DeliveryApplicationService", () => {
  it("rejects inherited automation fields before loading application context", async () => {
    let loaded = false;
    const service = new DeliveryApplicationService({
      applications: {} as never,
      loadContext: async () => { loaded = true; return null; }
    });
    const inherited = Object.create({ expectedEvidenceVersion: 1, claimToken: "inherited" });

    await expect(service.apply("unit-1", inherited))
      .rejects.toThrow("DELIVERY_APPLICATION_AUTOMATION_INPUT_INVALID");
    expect(loaded).toBe(false);
  });

  it("rejects a prototype-backed context before claim or Git mutation", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    fixture.contexts.set(
      fixture.frontendUnit.id,
      Object.create(context) as DeliveryApplicationContext
    );
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect(fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease)))
      .rejects.toThrow("DELIVERY_APPLICATION_CONTEXT_INVALID");
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)).toEqual([]);
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("applies verified evidence without committing or publishing the target", async () => {
    const fixture = await createFixture();
    const otherBefore = await repositoryState(fixture.backendGit);
    const preApplyHead = await head(fixture.frontendGit.versionWorktree);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("completed");
    expect(await head(fixture.frontendGit.versionWorktree)).toBe(preApplyHead);
    expect(await status(fixture.frontendGit.versionWorktree)).toContain("src/feature.ts");
    expect(await remoteRefs(fixture.frontendGit)).toEqual([]);
    expect(fixture.store.deliveryApplications.get(result.run.id)).toMatchObject({
      status: "applied", sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/)
    });
    expect(fixture.store.automationJobs.get(lease.id)?.status).toBe("completed");
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("returns only the sanitized persisted preflight", async () => {
    const sensitiveValue = "CUSTOM_SECRET_PATH";
    const fixture = await createFixture({ sensitiveValue });
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(sensitiveValue);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(result.preflight).toEqual(result.run.preflight);
    expect(result.run.preflight).toEqual(
      fixture.store.deliveryApplications.get(result.run.id)?.preflight
    );
  });

  it("rejects a dirty target without changing either repository", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.frontendGit.versionWorktree, "human.txt"), "keep\n");
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result).toMatchObject({ status: "failed", error: "APPLICATION_PREFLIGHT_FAILED" });
    expect(result.run).toMatchObject({ status: "failed", resolutionStatus: "pending" });
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("rejects a target from another repository without touching it", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    fixture.contexts.set(fixture.frontendUnit.id, {
      ...context,
      version: { ...context.version, worktreePath: fixture.backendGit.versionWorktree },
      snapshot: { ...context.snapshot, targetWorktreePath: fixture.backendGit.versionWorktree }
    });
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("failed");
    expect(result.preflight.checks.find((check) => check.id === "target_identity")?.ok).toBe(false);
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("rejects a wrong frozen target branch without touching either project", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    fixture.contexts.set(fixture.frontendUnit.id, {
      ...context,
      version: { ...context.version, branch: "feature/not-the-frozen-branch" },
      snapshot: { ...context.snapshot, targetBranch: "feature/not-the-frozen-branch" }
    });
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("failed");
    expect(result.preflight.checks.find((check) => check.id === "target_branch")?.ok).toBe(false);
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("rejects stale coding evidence before target mutation", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    await writeFile(join(context.codingEvidence.worktreePath, "stale.ts"), "stale\n");
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("failed");
    expect(result.preflight.checks.find((check) => check.id === "evidence_valid")?.ok).toBe(false);
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("rejects an occupied project version before Git mutation", async () => {
    const fixture = await createFixture();
    const occupiedRequirement = fixture.store.createRequirement({
      title: "Occupy the version", businessProblem: "Another local application is active",
      expectedOutcome: "Ownership is exclusive", priority: "medium",
      primaryProjectId: fixture.frontend.id, primaryProjectVersionId: fixture.frontendVersion.id
    });
    const occupiedUnit = fixture.store.deliveryUnits.createPlan({
      requirementId: occupiedRequirement.id,
      snapshot: fixture.store.createRequirementProjectSnapshot(occupiedRequirement.id),
      plan: { units: [{ projectId: fixture.frontend.id, moduleIds: [], acceptanceCriteria: ["passes"] }], dependencies: [] }
    }).units[0]!;
    fixture.database.prepare(`UPDATE delivery_units
      SET phase = 'acceptance_delivery', status = 'ready_for_acceptance' WHERE id = ?`).run(occupiedUnit.id);
    const occupiedLease = leaseApplication(fixture.store, occupiedUnit.id, "occupying-worker");
    fixture.store.deliveryApplications.claim(occupiedUnit.id, {
      expectedEvidenceVersion: 1, claimToken: occupiedLease.claimToken,
      baseCommit: fixture.frontendGit.baseHead, preApplyCommit: fixture.frontendGit.targetHead,
      evidenceHash: "occupied-evidence", preflight: { allowed: true }
    });
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect(fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease)))
      .rejects.toThrow("PROJECT_VERSION_APPLICATION_BUSY");
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("rolls a conflict back and settles only the requested unit", async () => {
    const fixture = await createFixture({ conflict: true });
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result.status).toBe("conflicted");
    expect(result.run).toMatchObject({ status: "conflicted", conflictFiles: ["src/feature.ts"] });
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("keeps uncommitted target changes and durable ownership when verification fails", async () => {
    const fixture = await createFixture({ verificationFails: true });
    const otherBefore = await repositoryState(fixture.backendGit);
    const preApplyHead = await head(fixture.frontendGit.versionWorktree);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    const result = await fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease));

    expect(result).toMatchObject({ status: "failed", error: "APPLICATION_VERIFICATION_FAILED" });
    expect(result.run).toMatchObject({ status: "failed", resolutionStatus: "pending" });
    expect(await head(fixture.frontendGit.versionWorktree)).toBe(preApplyHead);
    expect(await status(fixture.frontendGit.versionWorktree)).toContain("src/feature.ts");
    expect(await remoteRefs(fixture.frontendGit)).toEqual([]);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  }, 15_000);

  it("rejects stale or mismatched quality evidence before claiming the worktree", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    fixture.contexts.set(fixture.frontendUnit.id, {
      ...context,
      qualityEvidence: {
        ...context.qualityEvidence,
        automatedTesting: { ...context.qualityEvidence.automatedTesting, inputDiffHash: "stale" }
      }
    });
    const targetBefore = await repositoryState(fixture.frontendGit);
    const otherBefore = await repositoryState(fixture.backendGit);
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect(fixture.service.apply(fixture.frontendUnit.id, applicationInput(lease)))
      .rejects.toThrow("DELIVERY_APPLICATION_QUALITY_EVIDENCE_STALE");
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)).toEqual([]);
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    await expectRepositoryState(fixture.backendGit, otherBefore);
  });

  it("resumes a newer job lease from the write-once source commit", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    const firstLease = leaseApplication(fixture.store, fixture.frontendUnit.id, "first-worker");
    const frozenInput = {
      projectRepoPath: context.snapshot.repoPath,
      targetWorktreePath: context.snapshot.targetWorktreePath,
      targetBranch: context.snapshot.targetBranch,
      sourceWorktreePath: context.codingEvidence.worktreePath,
      sourceBranch: context.codingEvidence.branch,
      evidenceHash: context.codingEvidence.diffHash,
      sensitivePatterns: context.snapshot.sensitivePatterns,
      expectedTargetHead: context.version.headCommit,
      changedFiles: context.codingEvidence.files,
      fallbackCommands: context.snapshot.allowedCommands
    };
    const frozenPreflight = await preflightLocalIntegration(frozenInput);
    let firstClaim = fixture.store.deliveryApplications.claim(fixture.frontendUnit.id, {
      expectedEvidenceVersion: 1, claimToken: firstLease.claimToken,
      baseCommit: context.codingEvidence.sourceHead,
      preApplyCommit: context.version.headCommit,
      evidenceHash: context.codingEvidence.diffHash,
      preflight: frozenPreflight
    });
    await git(context.codingEvidence.worktreePath, "add", "--all");
    await git(context.codingEvidence.worktreePath, "commit", "-m", "prepared before crash");
    const sourceCommit = await head(context.codingEvidence.worktreePath);
    firstClaim = fixture.store.deliveryApplications.bindSourceCommit(firstClaim, sourceCommit);
    expect(fixture.store.automationJobs.fail(
      firstLease.id, "first-worker", firstLease.claimToken, "worker crashed", true
    )).toBe(true);
    const nextLease = fixture.store.automationJobs.leaseNext("retry-worker", new Date(), 60_000)!;
    const targetHead = await head(fixture.frontendGit.versionWorktree);

    const result = await fixture.service.apply(
      fixture.frontendUnit.id, applicationInput(nextLease)
    );

    expect(result.status).toBe("completed");
    expect(result.run).toMatchObject({
      id: firstClaim.id, sourceCommit, automationAttempt: 2,
      claimToken: nextLease.claimToken, status: "applied"
    });
    expect(await head(fixture.frontendGit.versionWorktree)).toBe(targetHead);
  });

  it("recovers a prepared source commit when the worker crashes before binding it", async () => {
    const fixture = await createFixture();
    let crashBeforeBind = true;
    const service = new DeliveryApplicationService({
      applications: {
        ...fixture.store.deliveryApplications,
        bindSourceCommit: (claim, sourceCommit) => {
          if (crashBeforeBind) throw new Error("SIMULATED_CRASH_BEFORE_BIND");
          return fixture.store.deliveryApplications.bindSourceCommit(claim, sourceCommit);
        }
      },
      loadContext: async (unitId) => {
        const context = fixture.contexts.get(unitId);
        const unit = fixture.store.deliveryUnits.get(unitId);
        return context && unit ? { ...context, unit } : null;
      }
    });
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    const firstLease = leaseApplication(fixture.store, fixture.frontendUnit.id, "first-worker");
    const targetBefore = await repositoryState(fixture.frontendGit);

    const interrupted = await service.apply(
      fixture.frontendUnit.id, applicationInput(firstLease)
    );
    const preparedCommit = await head(context.codingEvidence.worktreePath);
    expect(preparedCommit).not.toBe(context.codingEvidence.sourceHead);
    const firstRun = interrupted.run;
    expect(interrupted).toMatchObject({ status: "failed", sourceCommit: preparedCommit });
    expect(firstRun).toMatchObject({ status: "failed", sourceCommit: null });
    await expectRepositoryState(fixture.frontendGit, targetBefore);
    reviveApplicationJob(fixture, fixture.frontendUnit.id, firstLease.id);
    const nextLease = fixture.store.automationJobs.leaseNext("retry-worker", new Date(), 60_000)!;
    crashBeforeBind = false;

    const result = await service.apply(fixture.frontendUnit.id, applicationInput(nextLease));

    expect(result.status).toBe("completed");
    expect(result.sourceCommit).toBe(preparedCommit);
    expect(result.run).toMatchObject({
      sourceCommit: preparedCommit, automationAttempt: 1, status: "applied"
    });
    expect(result.run.id).not.toBe(firstRun.id);
  });

  it("does not mutate the target when the application lease is lost after source binding", async () => {
    const fixture = await createFixture();
    const targetBefore = await repositoryState(fixture.frontendGit);
    const persistence = fixture.store.deliveryApplications;
    const service = new DeliveryApplicationService({
      applications: {
        ...persistence,
        bindSourceCommit: (claim, sourceCommit) => {
          const bound = persistence.bindSourceCommit(claim, sourceCommit);
          loseApplicationLeaseWithoutReconciliation(fixture, claim.automationJobId);
          return bound;
        }
      },
      loadContext: async (unitId) => {
        const context = fixture.contexts.get(unitId);
        const unit = fixture.store.deliveryUnits.get(unitId);
        return context && unit ? { ...context, unit } : null;
      }
    });
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect(service.apply(fixture.frontendUnit.id, applicationInput(lease)))
      .rejects.toThrow("DELIVERY_APPLICATION_LEASE_STALE");

    await expectRepositoryState(fixture.frontendGit, targetBefore);
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)[0])
      .toMatchObject({ status: "applying", sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("does not settle after the lease is lost immediately after target mutation", async () => {
    const fixture = await createFixture();
    const persistence = fixture.store.deliveryApplications;
    let fences = 0;
    const applications = {
      ...persistence,
      assertClaim: (claim: Parameters<typeof persistence.complete>[0]) => {
        fences += 1;
        if (fences === 5) {
          loseApplicationLeaseWithoutReconciliation(fixture, claim.automationJobId);
        }
        return (persistence as any).assertClaim(claim);
      }
    };
    const service = new DeliveryApplicationService({
      applications: applications as typeof persistence,
      loadContext: async (unitId) => {
        const context = fixture.contexts.get(unitId);
        const unit = fixture.store.deliveryUnits.get(unitId);
        return context && unit ? { ...context, unit } : null;
      }
    });
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect(service.apply(fixture.frontendUnit.id, applicationInput(lease)))
      .rejects.toThrow("DELIVERY_APPLICATION_LEASE_STALE");

    expect(fences).toBe(6);
    expect(await status(fixture.frontendGit.versionWorktree)).toContain("src/feature.ts");
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)[0])
      .toMatchObject({ status: "applying" });
  });

  it("honors cancellation after source binding before target mutation", async () => {
    const fixture = await createFixture();
    const targetBefore = await repositoryState(fixture.frontendGit);
    const controller = new AbortController();
    const persistence = fixture.store.deliveryApplications;
    const service = new DeliveryApplicationService({
      applications: {
        ...persistence,
        bindSourceCommit: (claim, sourceCommit) => {
          const bound = persistence.bindSourceCommit(claim, sourceCommit);
          controller.abort();
          return bound;
        }
      },
      loadContext: async (unitId) => {
        const context = fixture.contexts.get(unitId);
        const unit = fixture.store.deliveryUnits.get(unitId);
        return context && unit ? { ...context, unit } : null;
      }
    });
    const lease = leaseApplication(fixture.store, fixture.frontendUnit.id);

    await expect((service.apply as any)(
      fixture.frontendUnit.id, applicationInput(lease), controller.signal
    )).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");

    await expectRepositoryState(fixture.frontendGit, targetBefore);
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)[0])
      .toMatchObject({ status: "applying" });
  });

  it("reuses a trusted source commit after a terminal conflict retry", async () => {
    const fixture = await createFixture({ conflict: true });
    const firstLease = leaseApplication(fixture.store, fixture.frontendUnit.id, "first-worker");
    const first = await fixture.service.apply(
      fixture.frontendUnit.id, applicationInput(firstLease)
    );
    expect(first.status).toBe("conflicted");
    reviveApplicationJob(fixture, fixture.frontendUnit.id, firstLease.id);
    const nextLease = fixture.store.automationJobs.leaseNext(
      "retry-worker", new Date(), 60_000
    )!;

    const retried = await fixture.service.apply(
      fixture.frontendUnit.id, applicationInput(nextLease)
    );

    expect(retried.status).toBe("conflicted");
    expect(retried.sourceCommit).toBe(first.sourceCommit);
    expect(retried.run).toMatchObject({ sourceCommit: first.sourceCommit, status: "conflicted" });
    expect(fixture.store.deliveryApplications.listForUnit(fixture.frontendUnit.id)).toHaveLength(2);
  });

  it("reuses a trusted source commit after a clean terminal failure retry", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts.get(fixture.frontendUnit.id)!;
    const firstLease = leaseApplication(fixture.store, fixture.frontendUnit.id, "first-worker");
    await git(context.codingEvidence.worktreePath, "add", "--all");
    await git(context.codingEvidence.worktreePath, "commit", "-m", "prepared before failure");
    const sourceCommit = await head(context.codingEvidence.worktreePath);
    const preflight = await preflightLocalIntegration({
      projectRepoPath: context.snapshot.repoPath,
      targetWorktreePath: context.snapshot.targetWorktreePath,
      targetBranch: context.snapshot.targetBranch,
      sourceWorktreePath: context.codingEvidence.worktreePath,
      sourceBranch: context.codingEvidence.branch,
      evidenceHash: context.codingEvidence.diffHash,
      sensitivePatterns: context.snapshot.sensitivePatterns,
      expectedTargetHead: context.version.headCommit,
      sourceCommit,
      changedFiles: context.codingEvidence.files,
      fallbackCommands: context.snapshot.allowedCommands
    });
    let firstClaim = fixture.store.deliveryApplications.claim(fixture.frontendUnit.id, {
      expectedEvidenceVersion: 1, claimToken: firstLease.claimToken,
      baseCommit: context.codingEvidence.sourceHead,
      preApplyCommit: context.version.headCommit,
      evidenceHash: context.codingEvidence.diffHash, preflight
    });
    firstClaim = fixture.store.deliveryApplications.bindSourceCommit(firstClaim, sourceCommit);
    fixture.store.deliveryApplications.complete(firstClaim, {
      status: "failed", worktreeState: "clean", error: "APPLICATION_RETRYABLE_FAILURE"
    });
    reviveApplicationJob(fixture, fixture.frontendUnit.id, firstLease.id);
    const nextLease = fixture.store.automationJobs.leaseNext(
      "retry-worker", new Date(), 60_000
    )!;

    const retried = await fixture.service.apply(
      fixture.frontendUnit.id, applicationInput(nextLease)
    );

    expect(retried.status).toBe("completed");
    expect(retried.sourceCommit).toBe(sourceCommit);
    expect(retried.run).toMatchObject({ sourceCommit, status: "applied" });
  });
});
