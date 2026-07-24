import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
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
  it("reads a transactional monotonic delivery generation with one bounded query", async () => {
    const liveModule = await import("./delivery-live-events.js").catch(() => ({}));
    const deliveryEventGeneration = (liveModule as any).deliveryEventGeneration;
    expect(deliveryEventGeneration).toBeTypeOf("function");
    if (!deliveryEventGeneration) return;
    let queryCount = 0;
    const fakeDb = {
      prepare: () => {
        queryCount += 1;
        return { get: () => ({ generation: 41 }), all: () => [] };
      }
    };
    expect(deliveryEventGeneration(fakeDb as any, "bounded-requirement")).toBe("41");
    expect(queryCount).toBe(1);

    const { store, requirement, unit } = fixture();
    const db = (store as any).db;
    const initial = deliveryEventGeneration(db, requirement.id);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(unit.id);
    const uncommitted = deliveryEventGeneration(db, requirement.id);
    expect(Number(uncommitted)).toBeGreaterThan(Number(initial));
    db.exec("ROLLBACK");
    expect(deliveryEventGeneration(db, requirement.id)).toBe(initial);

    db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(unit.id);
    const unitChanged = deliveryEventGeneration(db, requirement.id);
    expect(Number(unitChanged)).toBeGreaterThan(Number(initial));
    store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: 1,
      action: "implement", payload: {}, maxAttempts: 3 });
    const jobChanged = deliveryEventGeneration(db, requirement.id);
    expect(Number(jobChanged)).toBeGreaterThan(Number(unitChanged));
    store.deliveryCoordination.pauseAutomation({ requirementId: requirement.id, actor: "local-human",
      reason: "watch pause" });
    const pauseChanged = deliveryEventGeneration(db, requirement.id);
    expect(Number(pauseChanged)).toBeGreaterThan(Number(jobChanged));
  });

  it("shares one watcher per requirement and enforces subscriber quotas", async () => {
    const liveModule = await import("./delivery-live-events.js").catch(() => ({}));
    const DeliveryEventHub = (liveModule as any).DeliveryEventHub;
    expect(DeliveryEventHub).toBeTypeOf("function");
    if (!DeliveryEventHub) return;
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 1;
    let generation = 1;
    const hub = new DeliveryEventHub({
      generation: () => String(generation),
      setInterval: (callback: () => void) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearInterval: (id: number) => { cleared.push(id); timers.delete(id); },
      maxSubscribers: 3,
      maxSubscribersPerRequirement: 2
    });
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = hub.subscribe("r1", (value: string) => firstEvents.push(value));
    const second = hub.subscribe("r1", (value: string) => secondEvents.push(value));
    expect(first.initialGeneration).toBe("1");
    expect(second.initialGeneration).toBe("1");
    expect(timers.size).toBe(1);
    expect(() => hub.subscribe("r1", () => undefined)).toThrow("DELIVERY_EVENT_REQUIREMENT_LIMIT");
    const third = hub.subscribe("r2", () => undefined);
    expect(() => hub.subscribe("r3", () => undefined)).toThrow("DELIVERY_EVENT_GLOBAL_LIMIT");

    generation = 2;
    timers.values().next().value?.();
    expect(firstEvents).toEqual(["2"]);
    expect(secondEvents).toEqual(["2"]);
    first.close();
    expect(timers.size).toBe(2);
    second.close();
    expect(timers.size).toBe(1);
    third.close();
    expect(timers.size).toBe(0);
    expect(cleared).toHaveLength(2);
    hub.close();
  });

  it("coalesces delivery events while the response is backpressured and cleans up drain listeners", async () => {
    const liveModule = await import("./delivery-live-events.js").catch(() => ({}));
    const createDeliveryEventWriter = (liveModule as any).createDeliveryEventWriter;
    expect(createDeliveryEventWriter).toBeTypeOf("function");
    if (!createDeliveryEventWriter) return;
    class SlowResponse extends EventEmitter {
      writes: string[] = [];
      blocked = true;
      write(chunk: string) {
        this.writes.push(chunk);
        return !this.blocked;
      }
    }
    const response = new SlowResponse();
    const writer = createDeliveryEventWriter(response);
    writer.emit("1");
    writer.emit("2");
    writer.emit("3");
    expect(response.writes).toHaveLength(1);
    expect(response.listenerCount("drain")).toBe(1);
    response.blocked = false;
    response.emit("drain");
    expect(response.writes).toHaveLength(2);
    expect(response.writes[1]).toContain('"generation":"3"');
    expect(response.listenerCount("drain")).toBe(0);
    writer.close();
    writer.emit("4");
    expect(response.writes).toHaveLength(2);
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

  it("does not reflect an untrusted Origin on the delivery event stream", async () => {
    const { store, requirement } = fixture();
    const app = await buildApp(store);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/api/requirements/${requirement.id}/delivery-events`, {
        headers: { Origin: "https://evil.example" }, signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it("rejects a delivery event connection beyond the per-requirement quota", async () => {
    const { store, requirement } = fixture();
    const app = await buildApp(store);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controllers: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (let connection = 0; connection < 8; connection += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${address}/api/requirements/${requirement.id}/delivery-events`, {
          signal: controller.signal
        });
        expect(response.status).toBe(200);
        responses.push(response);
      }
      const rejected = await fetch(`${address}/api/requirements/${requirement.id}/delivery-events`);
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toEqual({ error: "DELIVERY_EVENT_REQUIREMENT_LIMIT" });
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(responses.map((response) => response.body?.cancel().catch(() => undefined)));
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
