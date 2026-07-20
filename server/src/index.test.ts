import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./index.js";
import { WorkflowStore } from "./store.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("server entry point", () => {
  it("exports a testable startup function and only self-starts when executed directly", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("export interface StartupOptions");
    expect(source).toContain("export async function startServer");
    expect(source).toContain("isDirectExecution");
  });

  it("recovers expired jobs after existing recovery and starts only when explicitly enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-"));
    directories.push(directory);
    const { jobId } = await seedExpiredJob(directory);
    const events: string[] = [];
    let recoveredStatus: string | undefined;
    const cleanupVerification = vi.fn(async (options: { maxEntries?: number; maxScannedEntries?: number }) => {
      events.push("cleanup:verification");
      expect(options).toEqual({ maxEntries: 4, maxScannedEntries: 4096 });
      return {
        scanned: 5, scanTruncated: true, attempted: 4, removed: 3, failed: 1, remaining: 2,
        failures: [{ path: "/tmp/quarantine", error: "AUTOMATED_TEST_CLEANUP_FAILED" }]
      };
    });
    const cleanupReports: unknown[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false),
      start: vi.fn(() => { events.push("worker:start"); }),
      stop: vi.fn(async () => { events.push("worker:stop"); })
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0", AUTOMATION_WORKER_ENABLED: "true" },
      createStore: (databasePath) => observedStore(databasePath, events),
      cleanupVerificationQuarantines: cleanupVerification as any,
      reportVerificationCleanup: (result: unknown) => { cleanupReports.push(result); },
      createWorker: (input) => {
        events.push("worker:create");
        recoveredStatus = input.jobs.get(jobId)?.status;
        return worker;
      },
      buildApplication: async () => fakeApp(events),
      writeListening: () => {}
    });

    expect(recoveredStatus).toBe("pending");
    expect(events).toEqual([
      "recover:stage", "recover:knowledge", "recover:requirements", "recover:jobs",
      "cleanup:verification", "worker:create", "app:build", "app:onClose", "worker:start", "app:listen"
    ]);
    expect(cleanupVerification).toHaveBeenCalledOnce();
    expect(cleanupReports).toEqual([
      {
        scanned: 5, scanTruncated: true, attempted: 4, removed: 3, failed: 1, remaining: 2,
        failures: [{ path: "/tmp/quarantine", error: "AUTOMATED_TEST_CLEANUP_FAILED" }]
      }
    ]);
    await runtime.close();
    expect(events.slice(-3)).toEqual(["app:close", "worker:stop", "store:close"]);
  });

  it("builds but does not start the worker when enablement is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-disabled-"));
    directories.push(directory);
    const events: string[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(), stop: vi.fn(async () => {})
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" }, createWorker: () => worker,
      buildApplication: async () => fakeApp(events), writeListening: () => {}
    });

    expect(worker.start).not.toHaveBeenCalled();
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  it("keeps SQLite open after stop timeout and lets a later close retry the same worker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-stop-timeout-"));
    directories.push(directory);
    const events: string[] = [];
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(),
      stop: vi.fn()
        .mockRejectedValueOnce(new Error("AUTOMATION_WORKER_STOP_TIMEOUT"))
        .mockImplementationOnce(() => stopped)
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createStore: (databasePath) => observedStore(databasePath, events),
      createWorker: () => worker,
      buildApplication: async () => fakeApp(events),
      writeListening: () => {}
    });

    await expect(runtime.close()).rejects.toThrow("AUTOMATION_WORKER_STOP_TIMEOUT");
    expect(events).not.toContain("store:close");
    expect(() => runtime.store.listProjects()).not.toThrow();

    const retry = runtime.close();
    finishStop();
    await expect(retry).resolves.toBeUndefined();
    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === "store:close")).toHaveLength(1);
  });

  it("registers Store-backed quality handlers and preserves explicit handler overrides", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-handlers-"));
    directories.push(directory);
    const review = vi.fn(async () => ({} as any));
    const test = vi.fn(async () => ({} as any));
    const overrideTest = vi.fn(async () => {});
    let workerOptions: any;
    let serviceStore: WorkflowStore | undefined;
    const worker = {
      drainOnce: vi.fn(async () => false), start: vi.fn(), stop: vi.fn(async () => {})
    };

    const runtime = await startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createDeliveryService: (store) => { serviceStore = store; return { review, test }; },
      automationHandlers: { test: overrideTest },
      createWorker: (options) => { workerOptions = options; return worker; },
      buildApplication: async () => fakeApp([]),
      writeListening: () => {}
    });
    const reviewJob = {
      id: "review-job", ownerType: "delivery_unit", ownerId: "unit-1",
      evidenceVersion: 3, action: "review"
    } as any;

    expect(serviceStore).toBe(runtime.store);
    await workerOptions.handlers.review(reviewJob);
    await workerOptions.handlers.test({ ...reviewJob, id: "test-job", action: "test" });
    expect(review).toHaveBeenCalledWith("unit-1", 3, "review-job", undefined);
    expect(test).not.toHaveBeenCalled();
    expect(overrideTest).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("closes the worker and store when hook registration and app close both fail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-startup-failure-"));
    directories.push(directory);
    const events: string[] = [];
    const worker = {
      drainOnce: vi.fn(async () => false),
      start: vi.fn(),
      stop: vi.fn(async () => { events.push("worker:stop"); })
    };

    await expect(startServer({
      env: { DATA_DIR: directory, PORT: "0" },
      createStore: (databasePath) => observedStore(databasePath, events),
      createWorker: () => worker,
      buildApplication: async () => ({
        addHook() { throw new Error("hook registration failed"); },
        async listen() { return "http://127.0.0.1:12345"; },
        async close() { events.push("app:close"); throw new Error("app close failed"); }
      }),
      writeListening: () => {}
    })).rejects.toThrow("hook registration failed");

    expect(events.slice(-3)).toEqual(["app:close", "worker:stop", "store:close"]);
  });
});

async function seedExpiredJob(directory: string) {
  const databasePath = join(directory, "workflow.db");
  const store = new WorkflowStore(databasePath);
  const project = store.createProject({
    name: "Startup", repoPath: join(directory, "repo"), defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: join(directory, "worktree"), headCommit: "abc123"
  });
  const requirement = store.createRequirement({
    title: "Recover worker", businessProblem: "A process stopped during automation",
    expectedOutcome: "Startup recovers the lease", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  const queued = store.automationJobs.enqueue({
    ownerType: "requirement", ownerId: requirement.id, evidenceVersion: 1,
    action: "implement", payload: {}, maxAttempts: 3
  });
  store.automationJobs.leaseNext("old-worker", new Date(), 1);
  store.close();
  writeFileSync(`${databasePath}.schema-version`, "phase-2-evidence-tree-v8");
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { jobId: queued.id };
}

function observedStore(databasePath: string, events: string[]) {
  const store = new WorkflowStore(databasePath);
  for (const [method, event] of [
    ["interruptActiveStageRuns", "recover:stage"],
    ["interruptActiveProjectKnowledge", "recover:knowledge"],
    ["recoverInterruptedRequirements", "recover:requirements"]
  ] as const) {
    const original = store[method].bind(store);
    vi.spyOn(store, method).mockImplementation(() => { events.push(event); return original(); });
  }
  const recoverExpired = store.automationJobs.recoverExpired;
  vi.spyOn(store.automationJobs, "recoverExpired").mockImplementation((now) => {
    events.push("recover:jobs");
    return recoverExpired(now);
  });
  const close = store.close.bind(store);
  vi.spyOn(store, "close").mockImplementation(() => { events.push("store:close"); close(); });
  return store;
}

function fakeApp(events: string[]) {
  events.push("app:build");
  let onClose: (() => Promise<void> | void) | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    addHook(name: string, hook: () => Promise<void> | void) {
      expect(name).toBe("onClose");
      events.push("app:onClose");
      onClose = hook;
    },
    async listen() {
      events.push("app:listen");
      return "http://127.0.0.1:12345";
    },
    close() {
      if (!closePromise) {
        events.push("app:close");
        closePromise = Promise.resolve(onClose?.()).then(() => undefined);
      }
      return closePromise;
    }
  };
}
