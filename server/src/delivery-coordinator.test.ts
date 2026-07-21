import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";
import type { DeliveryQualityKind, DeliveryQualityResult } from "./delivery-quality-repository.js";
import type { DeliveryExecutionSuccess } from "./delivery-execution-repository.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function createFixture(edges: Array<[number, number]> = [[0, 1]], required: boolean[] = [true, true]) {
  const directory = mkdtempSync(join(tmpdir(), "delivery-coordinator-"));
  directories.push(directory);
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  stores.push(store);
  const count = Math.max(required.length, ...edges.flat().map((position) => position + 1));
  const projects = Array.from({ length: count }, (_, position) => store.createProject({
    name: `Project ${position}`, repoPath: join(directory, `project-${position}`), defaultBranch: "main",
    allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
  }));
  const versions = projects.map((project, position) => store.createProjectVersion({
    projectId: project.id, name: "v1", branch: `feature/${position}`, baseBranch: "main",
    worktreePath: join(directory, `worktree-${position}`), headCommit: `head-${position}`
  }));
  const requirement = store.createRequirement({
    title: "Coordinate quality", businessProblem: "Dependencies need exact release",
    expectedOutcome: "Each downstream implementation starts once", priority: "high",
    primaryProjectId: projects[0]!.id, primaryProjectVersionId: versions[0]!.id
  });
  store.replaceRequirementProjects(requirement.id, projects.map((project, position) => ({
    projectId: project.id, projectVersionId: versions[position]!.id,
    role: position === 0 ? "primary" as const : "collaborator" as const,
    usage: "delivery" as const, deliveryRequired: required[position] ?? true,
    moduleMode: "all" as const, moduleIds: [], position
  })));
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id, snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: {
      units: projects.map((project, position) => ({
        projectId: project.id, moduleIds: [`src/p${position}`], acceptanceCriteria: [`p${position} passes`]
      })),
      dependencies: edges.map(([upstream, downstream]) => ({
        upstreamProjectId: projects[upstream]!.id, downstreamProjectId: projects[downstream]!.id,
        releaseCondition: "automated_testing_passed" as const
      }))
    }
  });
  for (const unit of plan.units.filter((item) => item.status === "ready")) completeImplementation(store, unit.id);
  return { store, requirement, units: plan.units, databasePath, database: (store as any).db };
}

function completeImplementation(store: WorkflowStore, unitId: string) {
  const claim = store.deliveryExecutions.claimImplementation(unitId, "test-model");
  store.deliveryExecutions.completeImplementation(claim, implementationCompletion(unitId, claim.deliveryUnit.evidenceVersion));
}

function implementationCompletion(unitId: string, evidenceVersion: number): DeliveryExecutionSuccess {
  return {
    branch: `ai/${unitId}`, worktreePath: `/tmp/${unitId}`, baseCommit: "base",
    commands: [], diff: `diff-${unitId}-v${evidenceVersion}`, diffHash: `hash-${unitId}-v${evidenceVersion}`,
    changedFiles: [], identity: {
      repositoryPath: `/tmp/source-${unitId}`, gitCommonDir: `/tmp/source-${unitId}/.git`,
      worktreePath: `/tmp/${unitId}`, branch: `ai/${unitId}`, headCommit: "base"
    }, manifest: { version: 1, entries: [] }, manifestHash: `manifest-${unitId}-v${evidenceVersion}`,
    originalChars: 4, truncated: false, files: [], additions: 1, deletions: 0,
    diagnostics: "", output: {}
  };
}

function settle(
  store: WorkflowStore,
  unitId: string,
  kind: DeliveryQualityKind,
  result: DeliveryQualityResult,
  token = `${kind}-${unitId}`
) {
  const evidenceVersion = store.deliveryUnits.get(unitId)!.evidenceVersion;
  const claim = store.deliveryQuality.claim(unitId, evidenceVersion, kind, `${token}-v${evidenceVersion}`);
  if (claim.status !== "running") throw new Error("expected running claim");
  return store.deliveryQuality.complete(claim, { result, content: { result } });
}

function units(store: WorkflowStore, requirementId: string) {
  return store.deliveryUnits.listForRequirement(requirementId);
}

function raceWorker() {
  const worker = new Worker(new URL("./delivery-coordinator-race-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"]
  });
  workers.push(worker);
  return worker;
}

function invalidationRaceWorker() {
  const worker = new Worker(new URL("./delivery-invalidation-race-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"]
  });
  workers.push(worker);
  return worker;
}

function invalidationRaceRound(worker: Worker, iteration: number, message: Record<string, unknown>) {
  let readyResolve!: (value: { threadId: number }) => void;
  let resultResolve!: (value: { threadId: number; ok: boolean; error?: string; value?: any }) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<{ threadId: number }>((resolve, rejectPromise) => {
    readyResolve = resolve; reject = rejectPromise;
  });
  const result = new Promise<{ threadId: number; ok: boolean; error?: string; value?: any }>((resolve) => { resultResolve = resolve; });
  const onError = (error: Error) => reject(error);
  const onMessage = (response: any) => {
    if (response.iteration !== iteration) return;
    if (response.type === "ready") readyResolve(response);
    if (response.type === "result") {
      worker.off("message", onMessage); worker.off("error", onError); resultResolve(response);
    }
  };
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.postMessage({ type: "prepare", iteration, ...message });
  return { ready, result };
}

function raceRound(worker: Worker, iteration: number, message: Record<string, unknown>) {
  let readyResolve!: (value: { threadId: number }) => void;
  let readyReject!: (error: Error) => void;
  let resultResolve!: (value: { threadId: number; startedAt: string; finishedAt: string; evidenceId: string }) => void;
  let resultReject!: (error: Error) => void;
  const ready = new Promise<{ threadId: number }>((resolve, rejectPromise) => {
    readyResolve = resolve; readyReject = rejectPromise;
  });
  const result = new Promise<{ threadId: number; startedAt: string; finishedAt: string; evidenceId: string }>(
    (resolve, rejectPromise) => { resultResolve = resolve; resultReject = rejectPromise; }
  );
  const cleanup = () => { worker.off("message", onMessage); worker.off("error", onError); };
  const onError = (error: Error) => { cleanup(); readyReject(error); resultReject(error); };
  const onMessage = (response: any) => {
    if (response.iteration !== iteration) return;
    if (response.type === "ready") readyResolve(response);
    if (response.type === "result") { cleanup(); resultResolve(response); }
    if (response.type === "error") onError(new Error(response.error));
  };
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.postMessage({ type: "prepare", iteration, ...message });
  return { ready, result };
}

function staleFixture(required: boolean[] = [true, true]) {
  const fixture = createFixture([[0, 1]], required);
  const [source, downstream] = fixture.units;
  settle(fixture.store, source!.id, "code_review", "passed");
  settle(fixture.store, source!.id, "automated_testing", "passed");
  completeImplementation(fixture.store, downstream!.id);
  const database = (fixture.store as any).db;
  database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
    WHERE id = ?`).run(source!.id);
  completeImplementation(fixture.store, source!.id);
  settle(fixture.store, source!.id, "code_review", "passed", "source-v2-review");
  settle(fixture.store, source!.id, "automated_testing", "passed", "source-v2-test");
  return { ...fixture, source: source!, downstream: downstream!, database };
}

function staleFixtureForFailure() {
  const fixture = createFixture([[0, 1]], [true, true]);
  const [source, downstream] = fixture.units;
  settle(fixture.store, source!.id, "code_review", "passed");
  settle(fixture.store, source!.id, "automated_testing", "passed");
  completeImplementation(fixture.store, downstream!.id);
  const database = (fixture.store as any).db;
  database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
    WHERE id = ?`).run(source!.id);
  return { ...fixture, source: source!, downstream: downstream!, database };
}

function advanceImplementation(store: WorkflowStore, unitId: string, evidenceVersion: number) {
  (store as any).db.prepare(`UPDATE delivery_units
    SET phase = 'implementation', status = 'ready', evidence_version = ? WHERE id = ?`)
    .run(evidenceVersion, unitId);
  completeImplementation(store, unitId);
}

describe("DeliveryCoordinator", () => {
  it("preserves every fan-in upstream change as an independently auditable active invalidation", () => {
    const fixture = createFixture([[0, 2], [1, 2]], [true, true, true]);
    const [first, second, target] = fixture.units;
    for (const source of [first!, second!]) {
      settle(fixture.store, source.id, "code_review", "passed");
      settle(fixture.store, source.id, "automated_testing", "passed");
    }
    completeImplementation(fixture.store, target!.id);

    advanceImplementation(fixture.store, first!.id, 2);
    advanceImplementation(fixture.store, second!.id, 2);

    const database = (fixture.store as any).db;
    const active = database.prepare(`SELECT source_unit_id, source_new_evidence_version
      FROM delivery_evidence_invalidations WHERE target_unit_id = ? ORDER BY source_unit_id`).all(target!.id);
    expect(active).toEqual([
      { source_unit_id: [first!.id, second!.id].sort()[0], source_new_evidence_version: 2 },
      { source_unit_id: [first!.id, second!.id].sort()[1], source_new_evidence_version: 2 }
    ]);
    expect(fixture.store.deliveryUnits.get(target!.id)).toMatchObject({ status: "potentially_stale" });
  });

  it("aggregates consecutive v2 and v3 invalidations from one upstream into one reuse decision", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, target] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, target!.id);
    advanceImplementation(fixture.store, source!.id, 2);
    advanceImplementation(fixture.store, source!.id, 3);
    settle(fixture.store, source!.id, "code_review", "passed", "source-v3-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "source-v3-test");

    const decision = (fixture.store.deliveryCoordination as any).resolveStale({
      unitId: target!.id, decision: "reuse", reason: "reviewed both upstream revisions", actor: "local-human"
    });

    expect(decision).toMatchObject({ decision: "reuse", targetEvidenceVersion: 1 });
    expect(decision.sources.map((item: any) => item.sourceNewEvidenceVersion)).toEqual([2, 3]);
    expect((fixture.store as any).db.prepare(`SELECT COUNT(*) AS count FROM delivery_stale_decision_sources
      WHERE decision_id = ?`).get(decision.id)).toEqual({ count: 2 });
    expect(fixture.store.deliveryUnits.get(target!.id)).not.toMatchObject({ status: "potentially_stale" });
  });

  it("covers every fan-in invalidation with immutable source snapshots and replays the aggregate decision", () => {
    const fixture = createFixture([[0, 2], [1, 2]], [true, true, true]);
    const [first, second, target] = fixture.units;
    for (const source of [first!, second!]) {
      settle(fixture.store, source.id, "code_review", "passed");
      settle(fixture.store, source.id, "automated_testing", "passed");
    }
    completeImplementation(fixture.store, target!.id);
    advanceImplementation(fixture.store, first!.id, 2);
    advanceImplementation(fixture.store, second!.id, 2);
    for (const source of [first!, second!]) {
      settle(fixture.store, source.id, "code_review", "passed", `fan-in-review-${source.id}`);
      settle(fixture.store, source.id, "automated_testing", "passed", `fan-in-test-${source.id}`);
    }
    const input = { unitId: target!.id, decision: "reuse" as const,
      reason: "both upstream changes reviewed", actor: "local-human" };

    const firstDecision = fixture.store.deliveryCoordination.resolveStale(input);
    const replay = fixture.store.deliveryCoordination.resolveStale(input);

    expect(replay).toEqual(firstDecision);
    expect(firstDecision.sources).toHaveLength(2);
    expect(firstDecision.sources.map((source) => source.sourceUnitId).sort())
      .toEqual([first!.id, second!.id].sort());
    expect(firstDecision.sources.every((source) => source.sourceCurrentEvidenceVersion === 2)).toBe(true);
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_stale_decision_sources
      WHERE decision_id = ?`).get(firstDecision.id)).toEqual({ count: 2 });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations invalidation
      WHERE target_unit_id = ? AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
        WHERE source.invalidation_id = invalidation.id)`).get(target!.id)).toEqual({ count: 0 });
    expect(() => fixture.database.prepare(`UPDATE delivery_stale_decision_sources
      SET source_current_evidence_version = 99 WHERE decision_id = ?`).run(firstDecision.id))
      .toThrow("DELIVERY_STALE_DECISION_SOURCE_IMMUTABLE");
  });

  it("prevents a target from recovering while any active invalidation fact remains uncovered", () => {
    const fixture = staleFixture();

    expect(() => fixture.database.prepare(`UPDATE delivery_units SET status = 'awaiting_gate'
      WHERE id = ? AND status = 'potentially_stale'`).run(fixture.downstream.id))
      .toThrow("DELIVERY_STALE_ACTIVE_FACTS_REMAIN");
    expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).toMatchObject({ status: "potentially_stale" });
  });

  it("preserves audited optional skip as a terminal path from potentially stale", () => {
    const fixture = createFixture([[0, 1]], [true, false]);
    const [source, optional] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, optional!.id);
    advanceImplementation(fixture.store, source!.id, 2);

    const skipped = fixture.store.deliveryCoordination.skipOptional({ unitId: optional!.id,
      actor: "local-human", reason: "optional delivery no longer required" });

    expect(skipped).toMatchObject({ deliveryUnitId: optional!.id, evidenceVersion: 1 });
    expect(fixture.store.deliveryUnits.get(optional!.id)).toMatchObject({ status: "skipped" });
  });

  it("immutably links an optional skip to every active invalidation fact", () => {
    const fixture = createFixture([[0, 2], [1, 2]], [true, true, false]);
    const [first, second, optional] = fixture.units;
    for (const source of [first!, second!]) {
      settle(fixture.store, source.id, "code_review", "passed");
      settle(fixture.store, source.id, "automated_testing", "passed");
    }
    completeImplementation(fixture.store, optional!.id);
    advanceImplementation(fixture.store, first!.id, 2);
    advanceImplementation(fixture.store, second!.id, 2);

    const skipped = fixture.store.deliveryCoordination.skipOptional({ unitId: optional!.id,
      actor: "local-human", reason: "optional delivery removed" });

    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_unit_skip_sources
      WHERE skip_id = ?`).get(skipped.id)).toEqual({ count: 2 });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations invalidation
      WHERE target_unit_id = ?
        AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
          WHERE source.invalidation_id = invalidation.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_unit_skip_sources source
          WHERE source.invalidation_id = invalidation.id)`).get(optional!.id)).toEqual({ count: 0 });
    expect(() => fixture.database.prepare(`DELETE FROM delivery_unit_skip_sources WHERE skip_id = ?`).run(skipped.id))
      .toThrow("DELIVERY_UNIT_SKIP_SOURCE_IMMUTABLE");
  });

  it("keeps an optional skip terminal across later upstream revisions and idempotent retries", () => {
    const fixture = createFixture([[0, 1]], [true, false]);
    const [source, optional] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, optional!.id);
    advanceImplementation(fixture.store, source!.id, 2);
    const input = { unitId: optional!.id, actor: "local-human", reason: "optional delivery removed" };
    const first = fixture.store.deliveryCoordination.skipOptional(input);

    advanceImplementation(fixture.store, source!.id, 3);
    advanceImplementation(fixture.store, source!.id, 4);
    const beforeReplay = fixture.store.deliveryUnits.get(optional!.id);
    const replay = fixture.store.deliveryCoordination.skipOptional(input);

    expect(replay).toEqual(first);
    expect(fixture.store.deliveryUnits.get(optional!.id)).toEqual(beforeReplay);
    expect(beforeReplay).toMatchObject({ status: "skipped", evidenceVersion: 1 });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations
      WHERE target_unit_id = ?`).get(optional!.id)).toEqual({ count: 1 });
    expect(() => fixture.store.deliveryCoordination.skipOptional({ ...input, reason: "different" }))
      .toThrow("DELIVERY_UNIT_SKIP_CONFLICT");
  });

  it("never invalidates an applied descendant after later upstream evidence", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, applied] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, applied!.id);
    settle(fixture.store, applied!.id, "code_review", "passed");
    settle(fixture.store, applied!.id, "automated_testing", "passed");
    fixture.database.prepare(`UPDATE delivery_units SET status = 'applied', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), applied!.id);

    advanceImplementation(fixture.store, source!.id, 2);

    expect(fixture.store.deliveryUnits.get(applied!.id)).toMatchObject({
      phase: "acceptance_delivery", status: "applied", evidenceVersion: 1
    });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations
      WHERE target_unit_id = ?`).get(applied!.id)).toEqual({ count: 0 });
  });

  it("preserves applied when reusing a legacy active invalidation", () => {
    const fixture = createFixture([], [true, true]);
    const [source, applied] = fixture.units;
    settle(fixture.store, applied!.id, "code_review", "passed");
    settle(fixture.store, applied!.id, "automated_testing", "passed");
    fixture.database.prepare(`UPDATE delivery_units SET status = 'applied', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), applied!.id);
    fixture.database.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
      WHERE owner_id = ? AND status = 'pending'`).run(new Date().toISOString(), applied!.id);
    advanceImplementation(fixture.store, source!.id, 2);
    const sourceEvidence = fixture.database.prepare(`SELECT id, evidence_version, diff_hash FROM coding_evidence
      WHERE delivery_unit_id = ? ORDER BY evidence_version`).all(source!.id) as Array<{
        id: string; evidence_version: number; diff_hash: string;
      }>;
    const now = new Date().toISOString();
    fixture.database.prepare(`INSERT INTO delivery_dependencies
      (id, requirement_id, upstream_unit_id, downstream_unit_id, release_condition,
       released_by_evidence_version, released_at, created_at)
      VALUES ('legacy-applied-edge', ?, ?, ?, 'automated_testing_passed', 2, ?, ?)`)
      .run(fixture.requirement.id, source!.id, applied!.id, now, now);
    fixture.database.prepare(`INSERT INTO delivery_evidence_invalidations
      (id, requirement_id, source_unit_id, source_kind,
       source_old_evidence_id, source_old_evidence_version, source_old_evidence_hash,
       source_new_evidence_id, source_new_evidence_version, source_new_evidence_hash,
       target_unit_id, target_evidence_version, prior_phase, prior_status, earliest_invalid_phase,
       cause, actor, created_at)
      VALUES ('legacy-applied-invalidation', ?, ?, 'implementation', ?, 1, ?, ?, 2, ?, ?, 1,
       'acceptance_delivery', 'applied', 'implementation', 'legacy invalidation', 'automation', ?)`)
      .run(fixture.requirement.id, source!.id, sourceEvidence[0]!.id, sourceEvidence[0]!.diff_hash,
        sourceEvidence[1]!.id, sourceEvidence[1]!.diff_hash, applied!.id, now);
    fixture.database.prepare(`UPDATE delivery_units SET status = 'potentially_stale' WHERE id = ?`).run(applied!.id);

    fixture.store.deliveryCoordination.resolveStale({ unitId: applied!.id, decision: "reuse",
      actor: "local-human", reason: "legacy application remains terminal" });

    expect(fixture.store.deliveryUnits.get(applied!.id)).toMatchObject({
      phase: "acceptance_delivery", status: "applied", evidenceVersion: 1
    });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE owner_id = ? AND status = 'pending'`).get(applied!.id)).toEqual({ count: 0 });
  });

  it("treats applied as a propagation barrier without clearing its released graph effect", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, applied, downstream] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, applied!.id);
    settle(fixture.store, applied!.id, "code_review", "passed");
    settle(fixture.store, applied!.id, "automated_testing", "passed");
    fixture.database.prepare(`UPDATE delivery_units SET status = 'applied', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), applied!.id);
    fixture.database.prepare(`UPDATE automation_jobs SET status = 'canceled', updated_at = ?
      WHERE owner_id = ? AND status = 'pending'`).run(new Date().toISOString(), applied!.id);

    advanceImplementation(fixture.store, source!.id, 2);
    settle(fixture.store, source!.id, "code_review", "passed", "applied-barrier-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "applied-barrier-test");

    expect(fixture.store.deliveryUnits.get(applied!.id)).toMatchObject({ status: "applied" });
    expect(fixture.store.deliveryUnits.get(downstream!.id)).toMatchObject({ status: "ready" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)
      .find((edge) => edge.upstreamUnitId === applied!.id)).toMatchObject({ releasedByEvidenceVersion: 1 });
    expect(fixture.store.automationJobs.byDedupe(`implement:${downstream!.id}:v1`)).toMatchObject({ status: "pending" });
  });

  it("treats skipped as a propagation barrier while preserving its previously released graph effect", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, false, true]);
    const [source, skipped, downstream] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, skipped!.id);
    settle(fixture.store, skipped!.id, "code_review", "passed");
    settle(fixture.store, skipped!.id, "automated_testing", "passed");
    fixture.store.deliveryCoordination.skipOptional({ unitId: skipped!.id,
      actor: "local-human", reason: "terminal optional delivery" });

    advanceImplementation(fixture.store, source!.id, 2);
    settle(fixture.store, source!.id, "code_review", "passed", "skipped-barrier-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "skipped-barrier-test");

    expect(fixture.store.deliveryUnits.get(skipped!.id)).toMatchObject({ status: "skipped" });
    expect(fixture.store.deliveryUnits.get(downstream!.id)).toMatchObject({ status: "ready" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)
      .find((edge) => edge.upstreamUnitId === skipped!.id)).toMatchObject({ releasedByEvidenceVersion: 1 });
    expect(fixture.store.automationJobs.byDedupe(`implement:${downstream!.id}:v1`)).toMatchObject({ status: "pending" });
  });

  it("still revokes outgoing releases for a nonterminal invalidated descendant", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, middle] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, middle!.id);
    settle(fixture.store, middle!.id, "code_review", "passed");
    settle(fixture.store, middle!.id, "automated_testing", "passed");

    advanceImplementation(fixture.store, source!.id, 2);

    expect(fixture.store.deliveryUnits.get(middle!.id)).toMatchObject({ status: "potentially_stale" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)
      .find((edge) => edge.upstreamUnitId === middle!.id)).toMatchObject({ releasedByEvidenceVersion: null });
  });

  it("rolls skip audit, source coverage, and unit state back when source-link persistence fails", () => {
    const fixture = staleFixture([true, false]);
    fixture.database.exec(`CREATE TRIGGER fail_skip_source_insert BEFORE INSERT ON delivery_unit_skip_sources
      BEGIN SELECT RAISE(ABORT, 'INJECTED_SKIP_SOURCE_FAILURE'); END;`);

    expect(() => fixture.store.deliveryCoordination.skipOptional({ unitId: fixture.downstream.id,
      actor: "local-human", reason: "rollback skip" })).toThrow("INJECTED_SKIP_SOURCE_FAILURE");

    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_unit_skips
      WHERE delivery_unit_id = ?`).get(fixture.downstream.id)).toEqual({ count: 0 });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_unit_skip_sources`).get()).toEqual({ count: 0 });
    expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).toMatchObject({ status: "potentially_stale" });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations invalidation
      WHERE target_unit_id = ?
        AND NOT EXISTS (SELECT 1 FROM delivery_stale_decision_sources source
          WHERE source.invalidation_id = invalidation.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_unit_skip_sources source
          WHERE source.invalidation_id = invalidation.id)`).get(fixture.downstream.id)).toEqual({ count: 1 });
  });

  it("reruns once while resolving every active source fact", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, target] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, target!.id);
    advanceImplementation(fixture.store, source!.id, 2);
    advanceImplementation(fixture.store, source!.id, 3);
    settle(fixture.store, source!.id, "code_review", "passed", "rerun-source-v3-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "rerun-source-v3-test");

    const decision = fixture.store.deliveryCoordination.resolveStale({ unitId: target!.id, decision: "rerun",
      reason: "implementation must follow current upstream", actor: "local-human" });

    expect(decision).toMatchObject({ decision: "rerun", resultingEvidenceVersion: 2 });
    expect(decision.sources).toHaveLength(2);
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE owner_id = ? AND evidence_version = 2 AND action = 'implement'`).get(target!.id)).toEqual({ count: 1 });
  });

  it("serializes aggregate stale-resolution replay on two connections", { timeout: 30_000 }, async () => {
    const firstWorker = invalidationRaceWorker();
    const secondWorker = invalidationRaceWorker();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const fixture = staleFixture();
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
      const operation = { kind: "stale_resolution", input: { unitId: fixture.downstream.id,
        decision: "rerun", reason: `concurrent replay ${iteration}`, actor: "local-human" } };
      const first = invalidationRaceRound(firstWorker, iteration, {
        databasePath: fixture.databasePath, barrier, operation
      });
      await first.ready;
      const second = invalidationRaceRound(secondWorker, iteration, {
        databasePath: fixture.databasePath, barrier, operation
      });
      await second.ready;
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1, 2);
      const results = await Promise.all([first.result, second.result]);

      expect(results.every((result) => result.ok)).toBe(true);
      expect(new Set(results.map((result) => result.value.id)).size).toBe(1);
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_stale_decisions
        WHERE delivery_unit_id = ?`).get(fixture.downstream.id)).toEqual({ count: 1 });
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
        WHERE owner_id = ? AND evidence_version = 2 AND action = 'implement'`)
        .get(fixture.downstream.id)).toEqual({ count: 1 });
    }
  });

  it("serializes optional skip against stale resolution with one fact owner", { timeout: 30_000 }, async () => {
    const skipWorker = invalidationRaceWorker();
    const resolutionWorker = invalidationRaceWorker();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const fixture = staleFixture([true, false]);
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
      const skip = invalidationRaceRound(skipWorker, iteration, { databasePath: fixture.databasePath, barrier,
        operation: { kind: "skip", input: { unitId: fixture.downstream.id,
          actor: "local-human", reason: `skip race ${iteration}` } } });
      await skip.ready;
      const resolution = invalidationRaceRound(resolutionWorker, iteration, {
        databasePath: fixture.databasePath, barrier, operation: { kind: "stale_resolution", input: {
          unitId: fixture.downstream.id, decision: "reuse",
          actor: "local-human", reason: `resolution race ${iteration}`
        } }
      });
      await resolution.ready;
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1, 2);
      const [skipResult, resolutionResult] = await Promise.all([skip.result, resolution.result]);

      expect(skipResult.ok).toBe(true);
      expect([true, false]).toContain(resolutionResult.ok);
      expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).toMatchObject({ status: "skipped" });
      const ownership = fixture.database.prepare(`SELECT
          (SELECT COUNT(*) FROM delivery_stale_decision_sources source
            WHERE source.invalidation_id = invalidation.id) AS decision_count,
          (SELECT COUNT(*) FROM delivery_unit_skip_sources source
            WHERE source.invalidation_id = invalidation.id) AS skip_count
        FROM delivery_evidence_invalidations invalidation WHERE target_unit_id = ?`)
        .get(fixture.downstream.id) as { decision_count: number; skip_count: number };
      expect(ownership.decision_count + ownership.skip_count).toBe(1);
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_unit_skips
        WHERE delivery_unit_id = ?`).get(fixture.downstream.id)).toEqual({ count: 1 });
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
        WHERE owner_id = ? AND status = 'pending'`).get(fixture.downstream.id)).toEqual({ count: 0 });
    }
  });

  it("persists contract evidence through an authoritative transaction and invalidates descendants", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, target] = fixture.units;
    const completeContract = (fixture.store.deliveryCoordination as any).completeContractEvidence;
    const first = completeContract({ unitId: source!.id, version: 1, contractHash: "contract-v1",
      content: { endpoints: ["GET /v1/orders"] }, actor: "solution-design" });
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, target!.id);

    const second = completeContract({ unitId: source!.id, version: 2, contractHash: "contract-v2",
      content: { endpoints: ["GET /v2/orders"] }, actor: "solution-design" });

    expect(first).toMatchObject({ version: 1, contractHash: "contract-v1" });
    expect(second).toMatchObject({ version: 2, contractHash: "contract-v2" });
    expect(fixture.store.deliveryUnits.get(target!.id)).toMatchObject({ status: "potentially_stale" });
    expect(fixture.database.prepare(`SELECT source_kind, source_old_evidence_version, source_new_evidence_version
      FROM delivery_evidence_invalidations WHERE target_unit_id = ?`).get(target!.id)).toEqual({
      source_kind: "contract", source_old_evidence_version: 1, source_new_evidence_version: 2
    });
    expect(() => fixture.database.prepare(`UPDATE delivery_contract_evidence SET contract_hash = 'rewrite'`).run())
      .toThrow("DELIVERY_CONTRACT_EVIDENCE_IMMUTABLE");
  });

  it("preserves source releases for contract-only fan-out while reuse and rerun both continue", () => {
    const fixture = createFixture([[0, 1], [0, 2]], [true, true, true]);
    const [source, reused, rerun] = fixture.units;
    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 1,
      contractHash: "contract-v1", content: {}, actor: "solution-design" });
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, reused!.id);
    completeImplementation(fixture.store, rerun!.id);

    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 2,
      contractHash: "contract-v2", content: {}, actor: "solution-design" });

    expect(fixture.store.deliveryUnits.get(source!.id)).toMatchObject({
      status: "ready_for_acceptance", evidenceVersion: 1
    });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)
      .filter((edge) => edge.upstreamUnitId === source!.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ downstreamUnitId: reused!.id, releasedByEvidenceVersion: 1 }),
        expect.objectContaining({ downstreamUnitId: rerun!.id, releasedByEvidenceVersion: 1 })
      ]));

    fixture.store.deliveryCoordination.resolveStale({ unitId: reused!.id, decision: "reuse",
      actor: "local-human", reason: "contract remains compatible" });
    fixture.store.deliveryCoordination.resolveStale({ unitId: rerun!.id, decision: "rerun",
      actor: "local-human", reason: "contract requires implementation" });

    expect(fixture.store.deliveryUnits.get(reused!.id)).toMatchObject({ status: "awaiting_gate", evidenceVersion: 1 });
    expect(fixture.store.automationJobs.byDedupe(`review:${reused!.id}:v1`)).toMatchObject({ status: "pending" });
    expect(fixture.store.deliveryUnits.get(rerun!.id)).toMatchObject({ status: "ready", evidenceVersion: 2 });
    expect(fixture.store.automationJobs.byDedupe(`implement:${rerun!.id}:v2`)).toMatchObject({ status: "pending" });
  });

  it("preserves a released contract dependency while paused and defers reused actions until resume", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, target] = fixture.units;
    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 1,
      contractHash: "contract-v1", content: {}, actor: "solution-design" });
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, target!.id);
    fixture.store.deliveryCoordination.pauseAutomation({ requirementId: fixture.requirement.id,
      actor: "local-human", reason: "hold contract decisions" });

    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 2,
      contractHash: "contract-v2", content: {}, actor: "solution-design" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0])
      .toMatchObject({ releasedByEvidenceVersion: 1 });
    fixture.store.deliveryCoordination.resolveStale({ unitId: target!.id, decision: "reuse",
      actor: "local-human", reason: "paused compatible contract" });

    expect(fixture.store.deliveryUnits.get(target!.id)).toMatchObject({ status: "awaiting_gate" });
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE owner_id = ? AND status = 'pending'`).get(target!.id)).toEqual({ count: 0 });
    fixture.store.deliveryCoordination.resumeAutomation({ requirementId: fixture.requirement.id,
      actor: "local-human", reason: "continue contract work" });
    expect(fixture.store.automationJobs.byDedupe(`review:${target!.id}:v1`)).toMatchObject({ status: "pending" });
    expect(fixture.store.automationJobs.byDedupe(`test:${target!.id}:v1`)).toMatchObject({ status: "pending" });
  });

  it("keeps the source release but revokes a nonterminal descendant release on contract change", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, middle] = fixture.units;
    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 1,
      contractHash: "contract-v1", content: {}, actor: "solution-design" });
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, middle!.id);
    settle(fixture.store, middle!.id, "code_review", "passed");
    settle(fixture.store, middle!.id, "automated_testing", "passed");

    fixture.store.deliveryCoordination.completeContractEvidence({ unitId: source!.id, version: 2,
      contractHash: "contract-v2", content: {}, actor: "solution-design" });

    const edges = fixture.store.deliveryUnits.listDependencies(fixture.requirement.id);
    expect(edges.find((edge) => edge.upstreamUnitId === source!.id))
      .toMatchObject({ releasedByEvidenceVersion: 1 });
    expect(edges.find((edge) => edge.upstreamUnitId === middle!.id))
      .toMatchObject({ releasedByEvidenceVersion: null });
  });

  it("rolls contract evidence and descendant invalidation back in one transaction", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, target] = fixture.units;
    const completeContract = (fixture.store.deliveryCoordination as any).completeContractEvidence;
    completeContract({ unitId: source!.id, version: 1, contractHash: "contract-v1", content: {}, actor: "design" });
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, target!.id);
    settle(fixture.store, target!.id, "code_review", "passed");
    settle(fixture.store, target!.id, "automated_testing", "passed");
    fixture.database.exec(`CREATE TRIGGER fail_contract_invalidation BEFORE INSERT ON delivery_evidence_invalidations
      BEGIN SELECT RAISE(ABORT, 'INJECTED_CONTRACT_INVALIDATION_FAILURE'); END;`);

    expect(() => completeContract({ unitId: source!.id, version: 2, contractHash: "contract-v2",
      content: {}, actor: "design" })).toThrow("INJECTED_CONTRACT_INVALIDATION_FAILURE");

    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_contract_evidence
      WHERE delivery_unit_id = ?`).get(source!.id)).toEqual({ count: 1 });
    expect(fixture.store.deliveryUnits.get(target!.id)).not.toMatchObject({ status: "potentially_stale" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ upstreamUnitId: source!.id, releasedByEvidenceVersion: 1 }),
        expect.objectContaining({ upstreamUnitId: target!.id, releasedByEvidenceVersion: 1 })
      ]));
  });

  it("uses sequential contract CAS with idempotent replay and conflict detection", () => {
    const fixture = createFixture([], [true]);
    const unit = fixture.units[0]!;
    const input = { unitId: unit.id, version: 1, contractHash: "contract-v1",
      content: { endpoints: ["GET /v1/orders"] }, actor: "solution-design" };

    const first = fixture.store.deliveryCoordination.completeContractEvidence(input);
    expect(fixture.store.deliveryCoordination.completeContractEvidence(input)).toEqual(first);
    expect(() => fixture.store.deliveryCoordination.completeContractEvidence({ ...input, contractHash: "changed" }))
      .toThrow("DELIVERY_CONTRACT_EVIDENCE_CONFLICT");
    expect(() => fixture.store.deliveryCoordination.completeContractEvidence({ ...input, version: 3,
      contractHash: "contract-v3" })).toThrow("DELIVERY_CONTRACT_EVIDENCE_SEQUENCE_INVALID");
    expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM delivery_contract_evidence
      WHERE delivery_unit_id = ?`).get(unit.id)).toEqual({ count: 1 });
  });

  it("rejects coding evidence ids for a contract invalidation at the database boundary", () => {
    const fixture = staleFixture();

    expect(() => fixture.database.prepare(`INSERT INTO delivery_evidence_invalidations
      (id, requirement_id, source_unit_id, source_kind,
       source_old_evidence_id, source_old_evidence_version, source_old_evidence_hash,
       source_new_evidence_id, source_new_evidence_version, source_new_evidence_hash,
       target_unit_id, target_evidence_version, prior_phase, prior_status, earliest_invalid_phase,
       cause, actor, created_at)
      SELECT 'forged-contract', requirement_id, source_unit_id, 'contract',
       source_old_evidence_id, source_old_evidence_version, source_old_evidence_hash,
       source_new_evidence_id, source_new_evidence_version, source_new_evidence_hash,
       target_unit_id, target_evidence_version, prior_phase, prior_status, earliest_invalid_phase,
       cause, actor, created_at FROM delivery_evidence_invalidations LIMIT 1`).run())
      .toThrow("DELIVERY_EVIDENCE_INVALIDATION_OWNER_MISMATCH");
  });

  it("restores missing quality jobs exactly once when reusing awaiting-gate evidence", () => {
    const fixture = staleFixture();

    (fixture.store.deliveryCoordination as any).resolveStale({ unitId: fixture.downstream.id,
      decision: "reuse", reason: "quality work remains valid", actor: "local-human" });

    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.downstream.id}:v1`)).toMatchObject({ status: "pending" });
    expect(fixture.store.automationJobs.byDedupe(`test:${fixture.downstream.id}:v1`)).toMatchObject({ status: "pending" });
    expect((fixture.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE owner_id = ? AND evidence_version = 1 AND status = 'pending'`).get(fixture.downstream.id))
      .toEqual({ count: 2 });
  });

  it("never restores an ownerless running status and re-enqueues implementation when reusable", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, target] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    fixture.store.deliveryExecutions.claimImplementation(target!.id, "running-model");
    advanceImplementation(fixture.store, source!.id, 2);
    const now = new Date().toISOString();
    const database = (fixture.store as any).db;
    database.prepare(`UPDATE executions SET status = 'failed', error = 'interrupted', completed_at = ?
      WHERE delivery_unit_id = ? AND evidence_version = 1`).run(now, target!.id);
    database.prepare(`UPDATE stage_runs SET status = 'interrupted', error = 'interrupted', completed_at = ?
      WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = 1`).run(now, target!.id);
    settle(fixture.store, source!.id, "code_review", "passed", "running-source-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "running-source-test");

    (fixture.store.deliveryCoordination as any).resolveStale({ unitId: target!.id,
      decision: "reuse", reason: "discard interrupted attempt", actor: "local-human" });

    expect(fixture.store.deliveryUnits.get(target!.id)).toMatchObject({ phase: "implementation", status: "ready" });
    expect(fixture.store.automationJobs.byDedupe(`implement:${target!.id}:v1`)).toMatchObject({ status: "pending" });
  });

  it("defers reusable actions while paused and uses the same recompute on resume", () => {
    const fixture = staleFixture();
    fixture.store.deliveryCoordination.pauseAutomation({ requirementId: fixture.requirement.id,
      actor: "local-human", reason: "inspect stale evidence" });

    fixture.store.deliveryCoordination.resolveStale({ unitId: fixture.downstream.id,
      decision: "reuse", reason: "quality work remains valid", actor: "local-human" });

    expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).toMatchObject({
      phase: "quality_verification", status: "awaiting_gate"
    });
    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.downstream.id}:v1`)).toMatchObject({ status: "canceled" });
    fixture.store.deliveryCoordination.resumeAutomation({ requirementId: fixture.requirement.id,
      actor: "local-human", reason: "continue current actions" });
    expect(fixture.store.automationJobs.byDedupe(`review:${fixture.downstream.id}:v1`)).toMatchObject({ status: "pending" });
    expect(fixture.store.automationJobs.byDedupe(`test:${fixture.downstream.id}:v1`)).toMatchObject({ status: "pending" });
  });
  it("invalidates every started transitive descendant in the implementation completion transaction", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, middle, leaf] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, middle!.id);
    settle(fixture.store, middle!.id, "code_review", "passed");
    settle(fixture.store, middle!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, leaf!.id);
    const database = (fixture.store as any).db;
    database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
      WHERE id = ?`).run(source!.id);

    completeImplementation(fixture.store, source!.id);

    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "awaiting_gate", "potentially_stale", "potentially_stale"
    ]);
    expect(database.prepare(`SELECT source_unit_id, source_old_evidence_version, source_new_evidence_version,
        target_unit_id, target_evidence_version, prior_phase, prior_status, earliest_invalid_phase
      FROM delivery_evidence_invalidations ORDER BY target_unit_id`).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_unit_id: source!.id, source_old_evidence_version: 1,
        source_new_evidence_version: 2, target_unit_id: middle!.id, target_evidence_version: 1,
        prior_phase: "acceptance_delivery", prior_status: "ready_for_acceptance",
        earliest_invalid_phase: "implementation" }),
      expect.objectContaining({ target_unit_id: leaf!.id, target_evidence_version: 1,
        prior_phase: "implementation", prior_status: "awaiting_gate" })
    ]));
    expect(database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE owner_id IN (?, ?) AND evidence_version = 1 AND status = 'pending'`).get(middle!.id, leaf!.id).count).toBe(0);
    expect(() => database.prepare(`UPDATE delivery_evidence_invalidations SET actor = 'rewrite'`).run())
      .toThrow("DELIVERY_EVIDENCE_INVALIDATION_IMMUTABLE");
  });

  it("returns not-started descendants to dependency waiting without creating stale evidence", () => {
    const fixture = createFixture([[0, 1]], [true, true]);
    const [source, downstream] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    const database = (fixture.store as any).db;
    database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
      WHERE id = ?`).run(source!.id);

    completeImplementation(fixture.store, source!.id);

    expect(units(fixture.store, fixture.requirement.id)[1]).toMatchObject({ status: "waiting_dependency" });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM delivery_evidence_invalidations
      WHERE target_unit_id = ?`).get(downstream!.id).count).toBe(0);
    expect(fixture.store.automationJobs.byDedupe(`implement:${downstream!.id}:v1`)).toMatchObject({ status: "canceled" });
  });

  it("reuses only an active current invalidation and records an immutable idempotent decision", () => {
    const fixture = staleFixture();
    const input = { unitId: fixture.downstream.id, decision: "reuse", reason: "contract remains compatible", actor: "local-human" };
    const first = (fixture.store.deliveryCoordination as any).resolveStale(input);
    const replays = Array.from({ length: 20 }, () =>
      (fixture.store.deliveryCoordination as any).resolveStale(input));

    expect(replays.every((replay) => replay.id === first.id)).toBe(true);
    expect(units(fixture.store, fixture.requirement.id)[1]).toMatchObject({
      phase: "quality_verification", status: "awaiting_gate", evidenceVersion: 1
    });
    expect(first).toMatchObject({ decision: "reuse", actor: "local-human", reason: "contract remains compatible",
      sourceOldEvidenceVersion: 1, sourceNewEvidenceVersion: 2, targetEvidenceVersion: 1 });
    expect(() => (fixture.store.deliveryCoordination as any).resolveStale({ ...input, reason: "different" }))
      .toThrow("DELIVERY_STALE_RESOLUTION_CONFLICT");
    expect(() => fixture.database.prepare(`DELETE FROM delivery_stale_decisions WHERE id = ?`).run(first.id))
      .toThrow("DELIVERY_STALE_DECISION_IMMUTABLE");
  });

  it("reruns from implementation with a new evidence version and one exact job", () => {
    const fixture = staleFixture();
    const decision = (fixture.store.deliveryCoordination as any).resolveStale({
      unitId: fixture.downstream.id, decision: "rerun", reason: "upstream API changed", actor: "local-human"
    });
    const replays = Array.from({ length: 20 }, () => (fixture.store.deliveryCoordination as any).resolveStale({
      unitId: fixture.downstream.id, decision: "rerun", reason: "upstream API changed", actor: "local-human"
    }));

    expect(decision).toMatchObject({ decision: "rerun", targetEvidenceVersion: 1, resultingEvidenceVersion: 2 });
    expect(replays.every((replay) => replay.id === decision.id)).toBe(true);
    expect(units(fixture.store, fixture.requirement.id)[1]).toMatchObject({
      phase: "implementation", status: "ready", evidenceVersion: 2
    });
    expect(fixture.store.automationJobs.byDedupe(`implement:${fixture.downstream.id}:v2`)).toMatchObject({
      action: "implement", status: "pending"
    });
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.downstream.id, 1)).not.toBeNull();
  });

  it("persists a pause, cancels pending jobs, and excludes later jobs from leases on another connection", () => {
    const fixture = createFixture([], [true]);
    const unit = fixture.units[0]!;
    const pause = (fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "investigating upstream change"
    });
    expect(pause).toMatchObject({ status: "paused", actor: "local-human", reason: "investigating upstream change" });
    expect(fixture.store.automationJobs.listPending()).toEqual([]);
    const second = new WorkflowStore(fixture.databasePath);
    stores.push(second);
    for (let iteration = 1; iteration <= 20; iteration += 1) {
      fixture.store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id,
        evidenceVersion: iteration, action: "implement", payload: {}, maxAttempts: 3 });
      expect(second.automationJobs.leaseNext(`paused-worker-${iteration}`, new Date(), 10_000)).toBeNull();
    }
    expect((fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "investigating upstream change"
    })).toEqual(pause);
    expect(() => (fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "different reason"
    })).toThrow("REQUIREMENT_AUTOMATION_STATE_CONFLICT");
    expect((fixture.store as any).db.prepare(`SELECT action FROM requirement_automation_audit
      WHERE requirement_id = ? ORDER BY created_at, rowid`).all(fixture.requirement.id)).toContainEqual({
      action: "pause_conflict"
    });
  });

  it("serializes pause against lease on independent connections across twenty races", { timeout: 30_000 }, async () => {
    const pauseWorker = invalidationRaceWorker();
    const leaseWorker = invalidationRaceWorker();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const fixture = createFixture([], [true]);
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
      const pause = invalidationRaceRound(pauseWorker, iteration, { databasePath: fixture.databasePath, barrier,
        operation: { kind: "pause", input: { requirementId: fixture.requirement.id,
          actor: "local-human", reason: `pause race ${iteration}` } } });
      await pause.ready;
      const lease = invalidationRaceRound(leaseWorker, iteration, { databasePath: fixture.databasePath, barrier,
        operation: { kind: "lease", workerId: `pause-race-${iteration}`,
          now: new Date().toISOString(), leaseMs: 10_000 } });
      await lease.ready;
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1, 2);
      const [pauseResult, leaseResult] = await Promise.all([pause.result, lease.result]);

      expect(pauseResult.ok).toBe(true);
      expect(leaseResult.ok).toBe(true);
      expect(fixture.store.automationJobs.listPending()).toEqual([]);
      if (leaseResult.value !== null) expect(leaseResult.value).toMatchObject({ status: "leased" });
      expect((fixture.store as any).db.prepare(`SELECT status FROM requirement_automation_state
        WHERE requirement_id = ?`).get(fixture.requirement.id)).toEqual({ status: "paused" });
    }
  });

  it("lets a leased quality mutation finish while paused without releasing or enqueueing downstream", () => {
    const fixture = createFixture();
    const [source, downstream] = fixture.units;
    const review = fixture.store.deliveryQuality.claim(source!.id, 1, "code_review", "paused-review");
    const testing = fixture.store.deliveryQuality.claim(source!.id, 1, "automated_testing", "paused-test");
    if (review.status !== "running" || testing.status !== "running") throw new Error("expected claims");
    (fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "hold releases"
    });

    fixture.store.deliveryQuality.complete(review, { result: "passed", content: {} });
    fixture.store.deliveryQuality.complete(testing, { result: "passed", content: {} });

    expect(fixture.store.deliveryQuality.latest(source!.id, "code_review")).toMatchObject({ result: "passed" });
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]).toMatchObject({
      releasedByEvidenceVersion: null, releasedAt: null
    });
    expect(fixture.store.automationJobs.byDedupe(`implement:${downstream!.id}:v1`)).toBeNull();
  });

  it("resumes by recomputing current gates and enqueues each valid action once", () => {
    const fixture = createFixture();
    const [source, downstream] = fixture.units;
    (fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "hold releases"
    });
    settle(fixture.store, source!.id, "code_review", "passed", "resume-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "resume-test");

    const input = { requirementId: fixture.requirement.id, actor: "local-human", reason: "checks complete" };
    const resumed = (fixture.store.deliveryCoordination as any).resumeAutomation(input);
    expect((fixture.store.deliveryCoordination as any).resumeAutomation(input)).toEqual(resumed);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]).toMatchObject({
      releasedByEvidenceVersion: 1
    });
    expect(fixture.store.automationJobs.byDedupe(`implement:${downstream!.id}:v1`)).toMatchObject({ status: "pending" });
    expect((fixture.store as any).db.prepare(`SELECT COUNT(*) AS count FROM automation_jobs
      WHERE dedupe_key = ?`).get(`implement:${downstream!.id}:v1`).count).toBe(1);
  });

  it("releases a not-started descendant when reused current evidence restores a passed middle unit", () => {
    const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
    const [source, middle, leaf] = fixture.units;
    settle(fixture.store, source!.id, "code_review", "passed");
    settle(fixture.store, source!.id, "automated_testing", "passed");
    completeImplementation(fixture.store, middle!.id);
    settle(fixture.store, middle!.id, "code_review", "passed");
    settle(fixture.store, middle!.id, "automated_testing", "passed");
    const database = (fixture.store as any).db;
    database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
      WHERE id = ?`).run(source!.id);
    completeImplementation(fixture.store, source!.id);
    settle(fixture.store, source!.id, "code_review", "passed", "reuse-chain-review");
    settle(fixture.store, source!.id, "automated_testing", "passed", "reuse-chain-test");

    (fixture.store.deliveryCoordination as any).resolveStale({
      unitId: middle!.id, decision: "reuse", reason: "compatible upstream", actor: "local-human"
    });

    expect(units(fixture.store, fixture.requirement.id)[2]).toMatchObject({ status: "ready" });
    expect(fixture.store.automationJobs.byDedupe(`implement:${leaf!.id}:v1`)).toMatchObject({ status: "pending" });
  });

  it("rolls implementation evidence and invalidation back together on an injected audit failure", () => {
    const fixture = staleFixtureForFailure();
    fixture.database.exec(`CREATE TRIGGER fail_invalidation_insert BEFORE INSERT ON delivery_evidence_invalidations
      BEGIN SELECT RAISE(ABORT, 'INJECTED_INVALIDATION_FAILURE'); END;`);

    expect(() => completeImplementation(fixture.store, fixture.source.id)).toThrow("INJECTED_INVALIDATION_FAILURE");

    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.source.id, 2)).toBeNull();
    expect(fixture.store.deliveryUnits.get(fixture.source.id)).toMatchObject({ status: "running", evidenceVersion: 2 });
    expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).not.toMatchObject({ status: "potentially_stale" });
  });

  it("fails closed and rolls back when a runtime dependency cycle reaches the changed source", () => {
    const fixture = staleFixtureForFailure();
    fixture.database.prepare(`INSERT INTO delivery_dependencies
      (id, requirement_id, upstream_unit_id, downstream_unit_id, release_condition,
       released_by_evidence_version, released_at, created_at)
      VALUES ('runtime-cycle', ?, ?, ?, 'automated_testing_passed', NULL, NULL, ?)`)
      .run(fixture.requirement.id, fixture.downstream.id, fixture.source.id, new Date().toISOString());

    expect(() => completeImplementation(fixture.store, fixture.source.id)).toThrow("DELIVERY_DEPENDENCY_CYCLE_RUNTIME");
    expect(fixture.store.deliveryExecutions.getCodingEvidence(fixture.source.id, 2)).toBeNull();
    expect(fixture.store.deliveryUnits.get(fixture.downstream.id)).not.toMatchObject({ status: "potentially_stale" });
  });

  it("keeps a requirement paused after reopening the database", () => {
    const fixture = createFixture([], [true]);
    (fixture.store.deliveryCoordination as any).pauseAutomation({
      requirementId: fixture.requirement.id, actor: "local-human", reason: "restart test"
    });
    const reopened = new WorkflowStore(fixture.databasePath);
    stores.push(reopened);
    reopened.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: fixture.units[0]!.id,
      evidenceVersion: 2, action: "implement", payload: {}, maxAttempts: 3 });
    expect(reopened.automationJobs.leaseNext("restart-worker", new Date(), 10_000)).toBeNull();
  });
  it.each([
    ["automated_testing", "code_review"],
    ["code_review", "automated_testing"]
  ] as const)("releases a dependency only after both gates pass (%s first)", (first, second) => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;

    settle(fixture.store, backend!.id, first, "passed");
    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "awaiting_gate", "waiting_dependency"
    ]);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]!.releasedByEvidenceVersion).toBeNull();

    settle(fixture.store, backend!.id, second, "passed");

    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "ready_for_acceptance", "ready"
    ]);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]).toMatchObject({
      upstreamUnitId: backend!.id, downstreamUnitId: frontend!.id, releasedByEvidenceVersion: 1
    });
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).toMatchObject({
      ownerId: frontend!.id, action: "implement", status: "pending"
    });
  });

  it.each([
    ["code_review", "returned"],
    ["automated_testing", "failed"]
  ] as const)("keeps an unoverridden %s failure authoritative", (failedKind, expectedStatus) => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const otherKind = failedKind === "code_review" ? "automated_testing" : "code_review";

    settle(fixture.store, backend!.id, failedKind, "failed");
    settle(fixture.store, backend!.id, otherKind, "passed");

    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      expectedStatus, "waiting_dependency"
    ]);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]!.releasedAt).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).toBeNull();
  });

  it("fails closed for stale evidence versions", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const stale = fixture.store.deliveryQuality.claim(backend!.id, 1, "code_review", "stale-review");
    if (stale.status !== "running") throw new Error("expected running claim");
    (fixture.store as any).db.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?").run(backend!.id);

    expect(() => fixture.store.deliveryQuality.complete(stale, { result: "passed", content: {} }))
      .toThrow("IMPLEMENTATION_EVIDENCE_NOT_FOUND");
    expect(fixture.store.deliveryQuality.latest(backend!.id, "code_review")).toBeNull();
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]!.releasedAt).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).toBeNull();

  });

  it("keeps duplicate callbacks idempotent and conflicting terminal callbacks fail closed", () => {
    const fixture = createFixture();
    const backend = fixture.units[0]!;
    const claim = fixture.store.deliveryQuality.claim(backend.id, 1, "code_review", "review-job");
    if (claim.status !== "running") throw new Error("expected running claim");
    const first = fixture.store.deliveryQuality.complete(claim, { result: "passed", content: { verdict: "pass" } });

    expect(fixture.store.deliveryQuality.claim(backend.id, 1, "code_review", "review-job"))
      .toMatchObject({ status: "completed", evidence: { id: first.id } });
    expect(() => fixture.store.deliveryQuality.complete(claim, { result: "failed", content: { verdict: "fail" } }))
      .toThrow();
    expect(() => fixture.store.deliveryQuality.claim(backend.id, 1, "code_review", "different-job"))
      .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    expect(fixture.store.deliveryQuality.latest(backend.id, "code_review")).toMatchObject({
      id: first.id, result: "passed"
    });
  });

  it("directly replays terminal evidence after release and after override without settling twice", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const review = fixture.store.deliveryQuality.claim(backend!.id, 1, "code_review", "replay-review");
    const testing = fixture.store.deliveryQuality.claim(backend!.id, 1, "automated_testing", "replay-test");
    if (review.status !== "running" || testing.status !== "running") throw new Error("expected running claims");
    const reviewCompletion = { result: "failed" as const, content: { summary: "known finding" } };
    const testCompletion = { result: "passed" as const, content: { summary: "passed" } };
    const failed = fixture.store.deliveryQuality.complete(review, reviewCompletion);
    const passed = fixture.store.deliveryQuality.complete(testing, testCompletion);
    const override = fixture.store.deliveryCoordination.overrideQuality({
      unitId: backend!.id, evidenceVersion: 1, kind: "code_review", actor: "release-manager",
      reason: "confirmed false positive", acceptedRisk: "bounded review risk"
    });

    expect(fixture.store.deliveryQuality.complete(review, reviewCompletion)).toEqual(failed);
    expect(fixture.store.deliveryQuality.complete(testing, testCompletion)).toEqual(passed);
    expect(fixture.store.deliveryCoordination.listQualityOverrides(backend!.id)).toEqual([override]);
    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "ready_for_acceptance", "ready"
    ]);
    expect((fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM delivery_dependencies WHERE upstream_unit_id = ? AND released_at IS NOT NULL"
    ).get(backend!.id).count).toBe(1);
    expect((fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM automation_jobs WHERE dedupe_key = ?"
    ).get(`implement:${frontend!.id}:v1`).count).toBe(1);
  });

  it("supports fan-out and fan-in while enqueuing ready units in stable position order", () => {
    const fixture = createFixture([[0, 2], [1, 2], [0, 3], [0, 4]], [true, false, true, false, true]);
    const [first, second, joined, independentA, independentB] = fixture.units;

    settle(fixture.store, first!.id, "code_review", "passed");
    settle(fixture.store, first!.id, "automated_testing", "passed");

    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "ready_for_acceptance", "awaiting_gate", "waiting_dependency", "ready", "ready"
    ]);
    expect(fixture.store.automationJobs.listPending().filter((job) => job.action === "implement")
      .map((job) => job.ownerId)).toEqual([independentA!.id, independentB!.id]);
    expect(fixture.store.automationJobs.byDedupe(`implement:${joined!.id}:v1`)).toBeNull();

    settle(fixture.store, second!.id, "automated_testing", "passed");
    settle(fixture.store, second!.id, "code_review", "passed");
    expect(units(fixture.store, fixture.requirement.id)[2]!.status).toBe("ready");
    expect(fixture.store.automationJobs.byDedupe(`implement:${joined!.id}:v1`)).not.toBeNull();
  });

  it("persists a current-version override without replacing failed evidence", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const failed = settle(fixture.store, backend!.id, "code_review", "failed");
    settle(fixture.store, backend!.id, "automated_testing", "passed");

    const override = fixture.store.deliveryCoordination.overrideQuality({
      unitId: backend!.id, evidenceVersion: 1, kind: "code_review", actor: "release-manager",
      reason: "Reviewed the known false positive", acceptedRisk: "Accept narrow static-analysis uncertainty"
    });

    expect(override).toMatchObject({
      deliveryUnitId: backend!.id, evidenceVersion: 1, kind: "code_review", actor: "release-manager",
      reason: "Reviewed the known false positive", acceptedRisk: "Accept narrow static-analysis uncertainty",
      qualityEvidenceId: failed.id
    });
    expect(override.evidenceIds).toEqual(expect.arrayContaining([failed.id]));
    expect(fixture.store.deliveryQuality.latest(backend!.id, "code_review")).toMatchObject({
      id: failed.id, result: "failed"
    });
    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "ready_for_acceptance", "ready"
    ]);
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).not.toBeNull();
    const database = (fixture.store as any).db;
    expect(() => database.prepare("UPDATE delivery_quality_overrides SET reason = 'rewritten' WHERE id = ?")
      .run(override.id)).toThrow("DELIVERY_QUALITY_OVERRIDE_IMMUTABLE");
    expect(() => database.prepare("DELETE FROM delivery_quality_overrides WHERE id = ?")
      .run(override.id)).toThrow("DELIVERY_QUALITY_OVERRIDE_IMMUTABLE");
    expect(() => database.prepare(`INSERT INTO delivery_quality_overrides
      (id, requirement_id, delivery_unit_id, evidence_version, kind, actor, reason, accepted_risk,
       coding_evidence_id, input_diff_hash, quality_evidence_id, evidence_ids_json, created_at)
      VALUES ('forged', ?, ?, 1, 'automated_testing', 'actor', 'reason', 'risk', ?, ?, ?, ?, ?)`)
      .run(override.requirementId, override.deliveryUnitId, override.codingEvidenceId,
        override.inputDiffHash, failed.id, JSON.stringify([failed.id]), new Date().toISOString()))
      .toThrow("DELIVERY_QUALITY_OVERRIDE_OWNER_MISMATCH");
  });

  it("rejects a new override for passed evidence in the application and database", () => {
    const fixture = createFixture();
    const backend = fixture.units[0]!;
    const passed = settle(fixture.store, backend.id, "code_review", "passed");
    const input = {
      unitId: backend.id, evidenceVersion: 1, kind: "code_review" as const,
      actor: "release-manager", reason: "not a failure", acceptedRisk: "no failed risk"
    };

    expect(() => fixture.store.deliveryCoordination.overrideQuality(input))
      .toThrow("DELIVERY_QUALITY_OVERRIDE_EVIDENCE_NOT_FAILED");
    const coding = fixture.store.deliveryExecutions.getCodingEvidence(backend.id, 1) as {
      id: string; diffHash: string;
    };
    expect(() => (fixture.store as any).db.prepare(`INSERT INTO delivery_quality_overrides
      (id, requirement_id, delivery_unit_id, evidence_version, kind, actor, reason, accepted_risk,
       coding_evidence_id, input_diff_hash, quality_evidence_id, evidence_ids_json, created_at)
      VALUES ('passed-override', ?, ?, 1, 'code_review', 'actor', 'reason', 'risk', ?, ?, ?, ?, ?)`)
      .run(passed.requirementId, backend.id, coding.id, coding.diffHash, passed.id,
        JSON.stringify([passed.id]), new Date().toISOString()))
      .toThrow("DELIVERY_QUALITY_OVERRIDE_OWNER_MISMATCH");
    expect(fixture.store.deliveryCoordination.listQualityOverrides(backend.id)).toEqual([]);
  });

  it("rejects a new override after acceptance readiness and dependency release", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const failed = settle(fixture.store, backend!.id, "code_review", "failed");
    const database = (fixture.store as any).db;
    const now = new Date().toISOString();
    database.prepare(`UPDATE delivery_units SET phase = 'acceptance_delivery', status = 'ready_for_acceptance'
      WHERE id = ?`).run(backend!.id);
    database.prepare(`UPDATE delivery_dependencies SET released_by_evidence_version = 1, released_at = ?
      WHERE upstream_unit_id = ?`).run(now, backend!.id);
    database.prepare("UPDATE delivery_units SET status = 'ready' WHERE id = ?").run(frontend!.id);
    fixture.store.automationJobs.enqueue({
      ownerType: "delivery_unit", ownerId: frontend!.id, evidenceVersion: 1,
      action: "implement", payload: {}, maxAttempts: 3
    });
    const input = {
      unitId: backend!.id, evidenceVersion: 1, kind: "code_review" as const,
      actor: "release-manager", reason: "too late", acceptedRisk: "already released"
    };

    expect(() => fixture.store.deliveryCoordination.overrideQuality(input))
      .toThrow("DELIVERY_QUALITY_OVERRIDE_NOT_ELIGIBLE");
    const coding = fixture.store.deliveryExecutions.getCodingEvidence(backend!.id, 1) as {
      id: string; diffHash: string;
    };
    expect(() => database.prepare(`INSERT INTO delivery_quality_overrides
      (id, requirement_id, delivery_unit_id, evidence_version, kind, actor, reason, accepted_risk,
       coding_evidence_id, input_diff_hash, quality_evidence_id, evidence_ids_json, created_at)
      VALUES ('late-override', ?, ?, 1, 'code_review', 'actor', 'reason', 'risk', ?, ?, ?, ?, ?)`)
      .run(failed.requirementId, backend!.id, coding.id, coding.diffHash, failed.id,
        JSON.stringify([failed.id]), now))
      .toThrow("DELIVERY_QUALITY_OVERRIDE_OWNER_MISMATCH");
    expect(fixture.store.deliveryCoordination.listQualityOverrides(backend!.id)).toEqual([]);
    expect(fixture.store.deliveryQuality.latest(backend!.id, "code_review")).toEqual(failed);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]).toMatchObject({
      releasedByEvidenceVersion: 1
    });
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).not.toBeNull();
  });

  it.each(["actor", "reason", "acceptedRisk"] as const)("rejects an override with empty %s", (field) => {
    const fixture = createFixture();
    const backend = fixture.units[0]!;
    settle(fixture.store, backend.id, "code_review", "failed");
    const input = {
      unitId: backend.id, evidenceVersion: 1, kind: "code_review" as const,
      actor: "release-manager", reason: "false positive", acceptedRisk: "known risk", [field]: " "
    };
    expect(() => fixture.store.deliveryCoordination.overrideQuality(input)).toThrow("DELIVERY_QUALITY_OVERRIDE_INVALID");
  });

  it("rejects stale overrides without touching current state", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    settle(fixture.store, backend!.id, "code_review", "failed");
    const input = {
      unitId: backend!.id, evidenceVersion: 2, kind: "code_review" as const,
      actor: "release-manager", reason: "false positive", acceptedRisk: "known risk"
    };

    expect(() => fixture.store.deliveryCoordination.overrideQuality(input))
      .toThrow("DELIVERY_QUALITY_CALLBACK_STALE");

    expect(fixture.store.deliveryCoordination.listQualityOverrides(backend!.id)).toEqual([]);
    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "returned", "waiting_dependency"
    ]);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]!.releasedAt).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).toBeNull();
  });

  it("serializes an override with the final quality callback and releases exactly once", async () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    const failed = settle(fixture.store, backend!.id, "code_review", "failed");
    const testing = fixture.store.deliveryQuality.claim(backend!.id, 1, "automated_testing", "test-final");
    if (testing.status !== "running") throw new Error("expected running claim");
    const overrideInput = {
      unitId: backend!.id, evidenceVersion: 1, kind: "code_review" as const,
      actor: "release-manager", reason: "confirmed false positive", acceptedRisk: "bounded review risk"
    };

    const [override] = await Promise.all([
      Promise.resolve().then(() => fixture.store.deliveryCoordination.overrideQuality(overrideInput)),
      Promise.resolve().then(() => fixture.store.deliveryQuality.complete(testing, { result: "passed", content: {} }))
    ]);
    expect(fixture.store.deliveryCoordination.overrideQuality(overrideInput).id).toBe(override.id);

    expect(fixture.store.deliveryQuality.latest(backend!.id, "code_review")).toMatchObject({
      id: failed.id, result: "failed"
    });
    expect((fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM delivery_quality_overrides WHERE delivery_unit_id = ?"
    ).get(backend!.id).count).toBe(1);
    expect((fixture.store as any).db.prepare(
      "SELECT COUNT(*) AS count FROM automation_jobs WHERE dedupe_key = ?"
    ).get(`implement:${frontend!.id}:v1`).count).toBe(1);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)).toEqual([
      expect.objectContaining({ releasedByEvidenceVersion: 1 })
    ]);
  });

  it("rolls evidence, gate, edge, and job writes back when downstream enqueue fails", () => {
    const fixture = createFixture();
    const [backend, frontend] = fixture.units;
    settle(fixture.store, backend!.id, "code_review", "passed");
    (fixture.store as any).db.exec(`CREATE TRIGGER fail_implement_enqueue BEFORE INSERT ON automation_jobs
      WHEN NEW.action = 'implement' BEGIN SELECT RAISE(ABORT, 'forced enqueue failure'); END;`);

    expect(() => settle(fixture.store, backend!.id, "automated_testing", "passed"))
      .toThrow("forced enqueue failure");

    expect(fixture.store.deliveryQuality.latest(backend!.id, "automated_testing")).toBeNull();
    expect(units(fixture.store, fixture.requirement.id).map((unit) => unit.status)).toEqual([
      "awaiting_gate", "waiting_dependency"
    ]);
    expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)[0]!.releasedAt).toBeNull();
    expect(fixture.store.automationJobs.byDedupe(`implement:${frontend!.id}:v1`)).toBeNull();
  });

  it("serializes upstream invalidation against downstream quality release across twenty two-connection races", { timeout: 30_000 }, async () => {
    const implementationWorker = invalidationRaceWorker();
    const qualityWorker = invalidationRaceWorker();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const fixture = createFixture([[0, 1], [1, 2]], [true, true, true]);
      const [source, middle, leaf] = fixture.units;
      settle(fixture.store, source!.id, "code_review", "passed");
      settle(fixture.store, source!.id, "automated_testing", "passed");
      completeImplementation(fixture.store, middle!.id);
      settle(fixture.store, middle!.id, "code_review", "passed", `race-review-${iteration}`);
      const finalQuality = fixture.store.deliveryQuality.claim(
        middle!.id, 1, "automated_testing", `race-testing-${iteration}`
      );
      if (finalQuality.status !== "running") throw new Error("expected running final quality");
      const database = (fixture.store as any).db;
      database.prepare(`UPDATE delivery_units SET phase = 'implementation', status = 'ready', evidence_version = 2
        WHERE id = ?`).run(source!.id);
      const implementation = fixture.store.deliveryExecutions.claimImplementation(source!.id, "test-model");
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
      const implementationRound = invalidationRaceRound(implementationWorker, iteration, {
        databasePath: fixture.databasePath, barrier,
        operation: { kind: "implementation", claim: implementation,
          completion: implementationCompletion(source!.id, 2) }
      });
      await implementationRound.ready;
      const qualityRound = invalidationRaceRound(qualityWorker, iteration, {
        databasePath: fixture.databasePath, barrier,
        operation: { kind: "quality", claim: finalQuality, completion: { result: "passed", content: {} } }
      });
      await qualityRound.ready;
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1, 2);
      const [implementationResult, qualityResult] = await Promise.all([
        implementationRound.result, qualityRound.result
      ]);

      expect(implementationResult.ok).toBe(true);
      if (!qualityResult.ok) expect([
        "DELIVERY_QUALITY_CALLBACK_STALE", "DELIVERY_UNIT_NOT_AWAITING_QUALITY"
      ]).toContain(qualityResult.error);
      expect(fixture.store.deliveryUnits.get(middle!.id)).toMatchObject({ status: "potentially_stale" });
      expect(fixture.store.deliveryUnits.get(leaf!.id)).toMatchObject({ status: "waiting_dependency" });
      expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)
        .find((edge) => edge.upstreamUnitId === middle!.id)).toMatchObject({ releasedByEvidenceVersion: null });
      const leafJob = fixture.store.automationJobs.byDedupe(`implement:${leaf!.id}:v1`);
      expect(leafJob === null || leafJob.status === "canceled").toBe(true);
    }
  });

  it("settles simultaneous final callbacks on independent SQLite connections across twenty races", { timeout: 30_000 }, async () => {
    const firstWorker = raceWorker();
    const secondWorker = raceWorker();
    const observedThreadIds = new Set<number>();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const fixture = createFixture();
      const [backend, frontend] = fixture.units;
      const review = fixture.store.deliveryQuality.claim(backend!.id, 1, "code_review", `review-${iteration}`);
      const testing = fixture.store.deliveryQuality.claim(backend!.id, 1, "automated_testing", `test-${iteration}`);
      if (review.status !== "running" || testing.status !== "running") throw new Error("expected running claims");

      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
      const reviewRound = raceRound(firstWorker, iteration, {
        databasePath: fixture.databasePath,
        claim: review, completion: { result: "passed", content: {} }, barrier
      });
      const reviewReady = await reviewRound.ready;
      const testingRound = raceRound(secondWorker, iteration, {
        databasePath: fixture.databasePath,
        claim: testing, completion: { result: "passed", content: {} }, barrier
      });
      const ready = [reviewReady, await testingRound.ready];
      expect(Atomics.load(new Int32Array(barrier), 0)).toBe(2);
      ready.forEach(({ threadId }) => observedThreadIds.add(threadId));
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1, 2);
      const results = await Promise.all([reviewRound.result, testingRound.result]);

      expect(new Set(results.map((result) => result.threadId)).size).toBe(2);
      expect(Atomics.load(new Int32Array(barrier), 2)).toBe(2);
      expect(results.reduce((latest, result) => {
        const started = BigInt(result.startedAt); return started > latest ? started : latest;
      }, 0n)).toBeLessThan(results.reduce((earliest, result) => {
        const finished = BigInt(result.finishedAt); return finished < earliest ? finished : earliest;
      }, BigInt("0xffffffffffffffff")));

      const reviewEvidence = fixture.store.deliveryQuality.latest(backend!.id, "code_review");
      const testingEvidence = fixture.store.deliveryQuality.latest(backend!.id, "automated_testing");
      expect(new Set(results.map((result) => result.evidenceId))).toEqual(
        new Set([reviewEvidence!.id, testingEvidence!.id])
      );
      expect([reviewEvidence!.result, testingEvidence!.result]).toEqual(["passed", "passed"]);
      expect(fixture.store.deliveryUnits.get(backend!.id)).toMatchObject({ status: "ready_for_acceptance" });

      expect(fixture.store.deliveryUnits.listDependencies(fixture.requirement.id)).toEqual([
        expect.objectContaining({ releasedByEvidenceVersion: 1 })
      ]);
      expect((fixture.store as any).db.prepare(
        "SELECT COUNT(*) AS count FROM automation_jobs WHERE dedupe_key = ?"
      ).get(`implement:${frontend!.id}:v1`).count).toBe(1);
    }
    expect(observedThreadIds.size).toBe(2);
  });
});
