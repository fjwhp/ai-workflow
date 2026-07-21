import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const directories: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture(required = false) {
  const directory = mkdtempSync(join(tmpdir(), "delivery-unit-routes-"));
  directories.push(directory);
  const store = new WorkflowStore(join(directory, "workflow.db"));
  stores.push(store);
  const project = store.createProject({ name: "Routes", repoPath: join(directory, "repo"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: [] });
  const version = store.createProjectVersion({ projectId: project.id, name: "v1", branch: "feature/routes",
    baseBranch: "main", worktreePath: join(directory, "worktree"), headCommit: "head" });
  const requirement = store.createRequirement({ title: "Routes", businessProblem: "Need controls",
    expectedOutcome: "Audited controls", priority: "medium", primaryProjectId: project.id,
    primaryProjectVersionId: version.id });
  store.replaceRequirementProjects(requirement.id, [{ projectId: project.id, projectVersionId: version.id,
    role: "primary", usage: "delivery", deliveryRequired: required, moduleMode: "all", moduleIds: [], position: 0 }]);
  const plan = store.deliveryUnits.createPlan({ requirementId: requirement.id,
    snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["done"] }], dependencies: [] } });
  return { store, requirement, unit: plan.units[0]! };
}

function completeImplementation(store: WorkflowStore, unitId: string) {
  const claim = store.deliveryExecutions.claimImplementation(unitId, "route-model");
  store.deliveryExecutions.completeImplementation(claim, {
    branch: `ai/${unitId}`, worktreePath: `/tmp/${unitId}`, baseCommit: "base", commands: [],
    diff: "route diff", diffHash: "route-hash", changedFiles: [], identity: {
      repositoryPath: `/tmp/source-${unitId}`, gitCommonDir: `/tmp/source-${unitId}/.git`,
      worktreePath: `/tmp/${unitId}`, branch: `ai/${unitId}`, headCommit: "base"
    }, manifest: { version: 1, entries: [] }, manifestHash: "route-manifest", originalChars: 10,
    truncated: false, files: [], additions: 1, deletions: 0, diagnostics: "", output: {}
  });
}

describe("delivery unit control routes", () => {
  it("tracks delivery generation changes and stops its watcher cleanly", async () => {
    const liveModule = await import("./delivery-live-events.js").catch(() => ({}));
    const deliveryEventGeneration = (liveModule as any).deliveryEventGeneration;
    const watchDeliveryEvents = (liveModule as any).watchDeliveryEvents;
    expect(deliveryEventGeneration).toBeTypeOf("function");
    expect(watchDeliveryEvents).toBeTypeOf("function");
    if (!deliveryEventGeneration || !watchDeliveryEvents) return;
    const { store, requirement, unit } = fixture();
    const db = (store as any).db;
    const initial = deliveryEventGeneration(db, requirement.id);
    db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(unit.id);
    const unitChanged = deliveryEventGeneration(db, requirement.id);
    expect(unitChanged).not.toBe(initial);
    store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: 1,
      action: "implement", payload: {}, maxAttempts: 3 });
    const jobChanged = deliveryEventGeneration(db, requirement.id);
    expect(jobChanged).not.toBe(unitChanged);
    store.deliveryCoordination.pauseAutomation({ requirementId: requirement.id, actor: "local-human",
      reason: "watch pause" });
    const pauseChanged = deliveryEventGeneration(db, requirement.id);
    expect(pauseChanged).not.toBe(jobChanged);

    let tick: (() => void) | undefined;
    let cleared = false;
    const events: string[] = [];
    const stop = watchDeliveryEvents({
      generation: () => deliveryEventGeneration(db, requirement.id),
      emit: (generation: string) => events.push(generation),
      setInterval: (callback: () => void) => { tick = callback; return 7; },
      clearInterval: (id: number) => { expect(id).toBe(7); cleared = true; }
    });
    expect(events).toEqual([pauseChanged]);
    db.prepare("UPDATE delivery_units SET status = 'ready' WHERE id = ?").run(unit.id);
    tick?.();
    expect(events).toHaveLength(2);
    tick?.();
    expect(events).toHaveLength(2);
    stop();
    expect(cleared).toBe(true);
    db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(unit.id);
    tick?.();
    expect(events).toHaveLength(2);
  });

  it("returns a stable not-found response for a missing delivery event stream", async () => {
    const { store } = fixture();
    const app = await buildApp(store);

    const response = await app.inject({ method: "GET", url: "/api/requirements/missing/delivery-events" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "REQUIREMENT_NOT_FOUND" });
    await app.close();
  });

  it("streams an initial delivery event and another event after state changes", async () => {
    const { store, requirement, unit } = fixture();
    const app = await buildApp(store);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${address}/api/requirements/${requirement.id}/delivery-events`, {
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      reader = response.body!.getReader();
      const first = await readDeliveryEvent(reader);
      expect(first).toContain("event: delivery-change");
      const firstGeneration = JSON.parse(first.match(/data: (.+)/)![1]!).generation;

      (store as any).db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(unit.id);
      const second = await readDeliveryEvent(reader);
      const secondGeneration = JSON.parse(second.match(/data: (.+)/)![1]!).generation;
      expect(secondGeneration).not.toBe(firstGeneration);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await app.close();
    }
  });

  it("registers pause and resume with bounded reasons and a server-side actor", async () => {
    const { store, requirement } = fixture();
    const app = await buildApp(store);
    expect((await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/automation/pause`,
      payload: { reason: " ", actor: "spoofed" } })).statusCode).toBe(400);
    const paused = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/automation/pause`,
      payload: { reason: "manual inspection", actor: "spoofed" } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: "paused", actor: "local-human" });
    const resumed = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/automation/resume`,
      payload: { reason: "inspection complete" } });
    expect(resumed.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/requirements/missing/automation/pause",
      payload: { reason: "missing" } })).statusCode).toBe(404);
    await app.close();
  });

  it("skips only optional non-running units and keeps an immutable reasoned audit", async () => {
    const optional = fixture(false);
    const optionalApp = await buildApp(optional.store);
    expect((await optionalApp.inject({ method: "POST", url: `/api/delivery-units/${optional.unit.id}/skip`,
      payload: { reason: "not needed for this release" } })).statusCode).toBe(200);
    expect(optional.store.deliveryUnits.get(optional.unit.id)).toMatchObject({ status: "skipped" });
    expect((optional.store as any).db.prepare(`SELECT actor, reason FROM delivery_unit_skips`).get()).toEqual({
      actor: "local-human", reason: "not needed for this release"
    });
    await optionalApp.close();

    const required = fixture(true);
    const requiredApp = await buildApp(required.store);
    expect((await requiredApp.inject({ method: "POST", url: `/api/delivery-units/${required.unit.id}/skip`,
      payload: { reason: "cannot skip" } })).statusCode).toBe(409);
    expect((await requiredApp.inject({ method: "POST", url: `/api/delivery-units/${required.unit.id}/skip`,
      payload: { reason: "" } })).statusCode).toBe(400);
    expect(() => (required.store as any).db.prepare(`INSERT INTO delivery_unit_skips
      (id, requirement_id, delivery_unit_id, evidence_version, actor, reason, created_at)
      VALUES ('forged-required-skip', ?, ?, 1, 'local-human', 'forged', ?)`)
      .run(required.requirement.id, required.unit.id, new Date().toISOString()))
      .toThrow("DELIVERY_UNIT_SKIP_OWNER_MISMATCH");
    await requiredApp.close();
  });

  it("uses stable validation and not-found errors for stale resolution and quality override", async () => {
    const { store, unit } = fixture();
    const app = await buildApp(store);
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${unit.id}/stale-resolution`,
      payload: { decision: "reuse", reason: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/delivery-units/missing/stale-resolution",
      payload: { decision: "rerun", reason: "changed" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${unit.id}/quality-override`,
      payload: { kind: "code_review", reason: "false positive", acceptedRisk: "bounded" } })).statusCode).toBe(409);
    await app.close();
  });

  it("routes a valid failed-evidence override through the authoritative coordinator", async () => {
    const { store, unit } = fixture(true);
    completeImplementation(store, unit.id);
    const review = store.deliveryQuality.claim(unit.id, 1, "code_review", "route-review");
    const testing = store.deliveryQuality.claim(unit.id, 1, "automated_testing", "route-test");
    if (review.status !== "running" || testing.status !== "running") throw new Error("expected claims");
    store.deliveryQuality.complete(review, { result: "failed", content: { finding: "known" } });
    store.deliveryQuality.complete(testing, { result: "passed", content: {} });
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/delivery-units/${unit.id}/quality-override`,
      payload: { kind: "code_review", reason: "verified false positive", acceptedRisk: "bounded risk",
        actor: "spoofed" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "code_review", actor: "local-human",
      reason: "verified false positive", acceptedRisk: "bounded risk" });
    expect(store.deliveryQuality.latest(unit.id, "code_review")).toMatchObject({ result: "failed" });
    await app.close();
  });

  it("returns a stable conflict without mutating state when overriding passed evidence", async () => {
    const { store, unit } = fixture(true);
    completeImplementation(store, unit.id);
    const review = store.deliveryQuality.claim(unit.id, 1, "code_review", "route-passed-review");
    if (review.status !== "running") throw new Error("expected running review");
    store.deliveryQuality.complete(review, { result: "passed", content: { summary: "approved" } });
    const before = store.deliveryUnits.get(unit.id);
    const releasedBefore = (store as any).db.prepare(`SELECT COUNT(*) AS count FROM delivery_dependencies
      WHERE upstream_unit_id = ? AND released_by_evidence_version IS NOT NULL`).get(unit.id);
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/delivery-units/${unit.id}/quality-override`,
      payload: { kind: "code_review", reason: "not applicable", acceptedRisk: "none" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "DELIVERY_QUALITY_OVERRIDE_EVIDENCE_NOT_FAILED" });
    expect(store.deliveryCoordination.listQualityOverrides(unit.id, 1)).toEqual([]);
    expect(store.deliveryUnits.get(unit.id)).toEqual(before);
    expect((store as any).db.prepare(`SELECT COUNT(*) AS count FROM delivery_dependencies
      WHERE upstream_unit_id = ? AND released_by_evidence_version IS NOT NULL`).get(unit.id)).toEqual(releasedBefore);
    await app.close();
  });

  it("rejects skipping an optional unit with a current running quality activity", async () => {
    const { store, unit } = fixture(false);
    completeImplementation(store, unit.id);
    const claim = store.deliveryQuality.claim(unit.id, 1, "code_review", "running-skip-review");
    if (claim.status !== "running") throw new Error("expected running claim");
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/delivery-units/${unit.id}/skip`,
      payload: { reason: "cannot skip active review" } });

    expect(response.statusCode).toBe(409);
    expect(store.deliveryUnits.get(unit.id)).not.toMatchObject({ status: "skipped" });
    await app.close();
  });
});

async function readDeliveryEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return Promise.race([
    (async () => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("DELIVERY_EVENT_STREAM_CLOSED");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer.slice(0, buffer.indexOf("\n\n"));
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DELIVERY_EVENT_TIMEOUT")), 3_000))
  ]);
}
