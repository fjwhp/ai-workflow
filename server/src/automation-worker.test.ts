import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationAction } from "@ai-workflow/shared";
import type { AutomationJobInput } from "./automation-job-repository.js";
import {
  createAutomationWorker,
  retryable,
  type AutomationWorkerEvent
} from "./automation-worker.js";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(action: AutomationAction = "implement", maxAttempts = 3) {
  const store = new WorkflowStore(":memory:");
  stores.push(store);
  const project = store.createProject({
    name: "Worker", repoPath: `/tmp/automation-worker-${stores.length}`, defaultBranch: "main",
    allowedCommands: [], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: `/tmp/automation-worker-worktree-${stores.length}`, headCommit: "abc123"
  });
  const requirement = store.createRequirement({
    title: "Run automation", businessProblem: "Queued work needs execution",
    expectedOutcome: "The worker settles it", priority: "high",
    primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  const input: AutomationJobInput = {
    ownerType: "requirement", ownerId: requirement.id, evidenceVersion: 1,
    action, payload: { command: "npm test" }, maxAttempts
  };
  const job = store.automationJobs.enqueue(input);
  return { store, job };
}

describe("automation worker handler lifecycle", () => {
  it.each(["", "   ", "lowercase", "AUTOMATION\0BAD"])("rejects an unsafe retryable code %j", (code) => {
    expect(() => retryable(code)).toThrow("AUTOMATION_WORKER_ERROR_CODE_INVALID");
  });

  it("dispatches the leased job to its action handler and completes it", async () => {
    const { store, job } = createFixture("review");
    const review = vi.fn(async () => {});
    const worker = createAutomationWorker({
      jobs: store.automationJobs, handlers: { review }, workerId: "worker-a"
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, action: "review" }),
      { signal: expect.any(AbortSignal) }
    );
    expect(store.automationJobs.get(job.id)).toMatchObject({ status: "completed", attempt: 1 });
    await expect(worker.drainOnce()).resolves.toBe(false);
  });

  it("returns typed retryable failures to pending without advancing the owner", async () => {
    const { store, job } = createFixture("implement");
    const worker = createAutomationWorker({
      jobs: store.automationJobs,
      handlers: { implement: async () => { throw retryable("AUTOMATION_DEPENDENCY_BUSY"); } },
      workerId: "worker-a"
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)).toMatchObject({
      status: "pending", attempt: 1, lastError: "AUTOMATION_DEPENDENCY_BUSY",
      leaseOwner: null, leaseExpiresAt: null
    });
  });

  it("classifies unknown errors as retryable until the repository attempt cap", async () => {
    const { store, job } = createFixture("test", 1);
    const worker = createAutomationWorker({
      jobs: store.automationJobs,
      handlers: { test: async () => { throw new Error("unexpected outage"); } },
      workerId: "worker-a"
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)).toMatchObject({
      status: "failed", attempt: 1, lastError: "unexpected outage"
    });
  });

  it("classifies validation and configuration errors as terminal", async () => {
    const { store, job } = createFixture("test");
    const worker = createAutomationWorker({
      jobs: store.automationJobs,
      handlers: { test: async () => { throw new Error("AUTOMATION_INPUT_INVALID"); } },
      workerId: "worker-a"
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)).toMatchObject({
      status: "failed", attempt: 1, lastError: "AUTOMATION_INPUT_INVALID"
    });
  });

  it("terminally settles and reports a missing action handler", async () => {
    const { store, job } = createFixture("apply");
    const events: AutomationWorkerEvent[] = [];
    const worker = createAutomationWorker({
      jobs: store.automationJobs, handlers: {}, workerId: "worker-a",
      onEvent: (event) => events.push(event)
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)).toMatchObject({
      status: "failed", attempt: 1, lastError: "AUTOMATION_HANDLER_MISSING:apply"
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "handler_missing", jobId: job.id, action: "apply"
    }));
  });

  it("contains and reports a missing-handler settlement exception for lease recovery", async () => {
    const { store, job } = createFixture("apply");
    const events: AutomationWorkerEvent[] = [];
    const worker = createAutomationWorker({
      jobs: {
        ...store.automationJobs,
        fail: () => { throw new Error("database unavailable"); }
      },
      handlers: {}, workerId: "worker-a", onEvent: (event) => events.push(event)
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)?.status).toBe("leased");
    expect(events).toContainEqual(expect.objectContaining({
      type: "settle_error", jobId: job.id, settlement: "fail",
      error: expect.objectContaining({ message: "database unavailable" })
    }));
  });
});

describe("automation worker lease ownership", () => {
  it("renews a long-running handler lease and clears the heartbeat after completion", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const { store, job } = createFixture("implement");
    const handler = deferred();
    const renew = vi.fn(store.automationJobs.renew);
    const setTimer = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const clearTimer = vi.fn((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, renew }, handlers: { implement: () => handler.promise },
      workerId: "worker-a", leaseMs: 300, pollMs: 50,
      timers: { setTimeout: setTimer, clearTimeout: clearTimer }
    });

    const drain = worker.drainOnce();
    const leased = store.automationJobs.get(job.id)!;
    const originalExpiry = leased.leaseExpiresAt;
    await vi.advanceTimersByTimeAsync(100);

    expect(renew).toHaveBeenCalledWith(job.id, "worker-a", leased.claimToken, new Date(), 300);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(store.automationJobs.get(job.id)!.leaseExpiresAt! > originalExpiry!).toBe(true);
    handler.resolve();
    await expect(drain).resolves.toBe(true);
    expect(store.automationJobs.get(job.id)?.status).toBe("completed");
    expect(clearTimer).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not settle after a heartbeat reports ownership loss", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const { store, job } = createFixture("review");
    const handler = deferred();
    const complete = vi.fn(store.automationJobs.complete);
    const fail = vi.fn(store.automationJobs.fail);
    const events: AutomationWorkerEvent[] = [];
    let signal: AbortSignal | undefined;
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, renew: () => false, complete, fail },
      handlers: { review: (_job, context) => { signal = context.signal; return handler.promise; } },
      workerId: "worker-a", leaseMs: 300,
      onEvent: (event) => events.push(event)
    });

    const drain = worker.drainOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
    handler.resolve();
    await expect(drain).resolves.toBe(true);

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(store.automationJobs.get(job.id)?.status).toBe("leased");
    expect(events).toContainEqual(expect.objectContaining({ type: "heartbeat_lost", jobId: job.id }));
  });

  it("aborts the handler and reports the renewal error when a heartbeat throws", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const { store, job } = createFixture("review");
    const handler = deferred();
    const renewalError = new Error("database unavailable");
    const events: AutomationWorkerEvent[] = [];
    let signal: AbortSignal | undefined;
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, renew: () => { throw renewalError; } },
      handlers: { review: (_job, context) => { signal = context.signal; return handler.promise; } },
      workerId: "worker-a", leaseMs: 300, onEvent: (event) => events.push(event)
    });

    const drain = worker.drainOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
    handler.resolve();
    await expect(drain).resolves.toBe(true);
    expect(events).toContainEqual({ type: "heartbeat_lost", jobId: job.id, error: renewalError });
    expect(store.automationJobs.get(job.id)).toMatchObject({ status: "leased", leaseOwner: "worker-a" });
  });

  it("aborts the old handler before another worker recovers and starts the same job", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const { store, job } = createFixture("implement");
    const order: string[] = [];
    const first = createAutomationWorker({
      jobs: { ...store.automationJobs, renew: () => false },
      handlers: { implement: async (_job, context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => {
          order.push("old-aborted"); resolve();
        }, { once: true }));
      } },
      workerId: "worker-a", leaseMs: 300
    });

    const firstDrain = first.drainOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(firstDrain).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    const second = createAutomationWorker({ jobs: store.automationJobs,
      handlers: { implement: async () => { order.push("retry-started"); } },
      workerId: "worker-b", leaseMs: 300 });
    await expect(second.drainOnce()).resolves.toBe(true);

    expect(order).toEqual(["old-aborted", "retry-started"]);
    expect(store.automationJobs.get(job.id)).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("reports a rejected completion without trying a second settlement", async () => {
    const { store, job } = createFixture("apply");
    const complete = vi.fn(() => false);
    const fail = vi.fn(store.automationJobs.fail);
    const events: AutomationWorkerEvent[] = [];
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, complete, fail }, handlers: { apply: async () => {} },
      workerId: "worker-a", onEvent: (event) => events.push(event)
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
    expect(store.automationJobs.get(job.id)?.status).toBe("leased");
    expect(events).toContainEqual({ type: "settle_rejected", jobId: job.id, settlement: "complete" });
  });

  it("reports a completion exception without misclassifying it as a handler failure", async () => {
    const { store, job } = createFixture("apply");
    const fail = vi.fn(store.automationJobs.fail);
    const events: AutomationWorkerEvent[] = [];
    const worker = createAutomationWorker({
      jobs: {
        ...store.automationJobs, fail,
        complete: () => { throw new Error("completion write failed"); }
      },
      handlers: { apply: async () => {} }, workerId: "worker-a",
      onEvent: (event) => events.push(event)
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(fail).not.toHaveBeenCalled();
    expect(store.automationJobs.get(job.id)?.status).toBe("leased");
    expect(events).toContainEqual(expect.objectContaining({
      type: "settle_error", jobId: job.id, settlement: "complete",
      error: expect.objectContaining({ message: "completion write failed" })
    }));
  });

  it("reports a failure settlement exception and leaves the lease for recovery", async () => {
    const { store, job } = createFixture("test");
    const events: AutomationWorkerEvent[] = [];
    const worker = createAutomationWorker({
      jobs: {
        ...store.automationJobs,
        fail: () => { throw new Error("failure write failed"); }
      },
      handlers: { test: async () => { throw retryable("AUTOMATION_TEST_BUSY"); } },
      workerId: "worker-a", onEvent: (event) => events.push(event)
    });

    await expect(worker.drainOnce()).resolves.toBe(true);

    expect(store.automationJobs.get(job.id)?.status).toBe("leased");
    expect(events).toContainEqual(expect.objectContaining({
      type: "settle_error", jobId: job.id, settlement: "fail",
      error: expect.objectContaining({ message: "failure write failed" })
    }));
  });

  it("shares one in-flight drain across concurrent callers", async () => {
    const { store, job } = createFixture("implement");
    const handler = deferred();
    const implement = vi.fn(() => handler.promise);
    const worker = createAutomationWorker({
      jobs: store.automationJobs, handlers: { implement }, workerId: "worker-a"
    });

    const first = worker.drainOnce();
    const second = worker.drainOnce();

    expect(second).toBe(first);
    expect(implement).toHaveBeenCalledOnce();
    handler.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(store.automationJobs.get(job.id)?.attempt).toBe(1);
  });
});

describe("automation worker polling lifecycle", () => {
  it("aborts the active handler and waits for its settlement before stopping", async () => {
    const { store, job } = createFixture("review");
    let receivedSignal: AbortSignal | undefined;
    const review = vi.fn(async (_job: unknown, context: { signal: AbortSignal }) => {
      receivedSignal = context.signal;
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(retryable("AUTOMATION_HANDLER_ABORTED")), {
          once: true
        });
      });
    });
    const worker = createAutomationWorker({
      jobs: store.automationJobs, handlers: { review }, workerId: "worker-a"
    });

    const drain = worker.drainOnce();
    await Promise.resolve();
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(drain).resolves.toBe(true);

    expect(receivedSignal?.aborted).toBe(true);
    expect(store.automationJobs.get(job.id)).toMatchObject({
      status: "pending", attempt: 1, lastError: "AUTOMATION_HANDLER_ABORTED"
    });
  });

  it("bounds stop for an abort-ignoring handler and lets a later stop await the same drain", async () => {
    vi.useFakeTimers();
    const { store, job } = createFixture("test");
    const handler = deferred();
    const complete = vi.fn(store.automationJobs.complete);
    let receivedSignal: AbortSignal | undefined;
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, complete },
      handlers: { test: async (_job, context) => { receivedSignal = context.signal; await handler.promise; } },
      workerId: "worker-a", stopTimeoutMs: 100
    });

    const drain = worker.drainOnce();
    const firstStop = worker.stop().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await vi.advanceTimersByTimeAsync(100);
    const firstOutcome = await Promise.race([
      firstStop,
      Promise.resolve({ status: "pending" as const })
    ]);
    handler.resolve();
    await expect(drain).resolves.toBe(true);
    await expect(worker.stop()).resolves.toBeUndefined();

    expect(firstOutcome).toEqual({
      status: "rejected",
      error: expect.objectContaining({ message: "AUTOMATION_WORKER_STOP_TIMEOUT" })
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(store.automationJobs.get(job.id)).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("polls at the configured interval without overlapping drains or busy-looping when empty", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const store = new WorkflowStore(":memory:");
    stores.push(store);
    const leaseNext = vi.fn(store.automationJobs.leaseNext);
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, leaseNext }, handlers: {}, workerId: "worker-a", pollMs: 50
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(leaseNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(leaseNext).toHaveBeenCalledTimes(2);

    await worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(leaseNext).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains polling errors and reports them before the next bounded attempt", async () => {
    vi.useFakeTimers();
    const store = new WorkflowStore(":memory:");
    stores.push(store);
    const events: AutomationWorkerEvent[] = [];
    const leaseNext = vi.fn(() => { throw new Error("database unavailable"); });
    const worker = createAutomationWorker({
      jobs: { ...store.automationJobs, leaseNext }, handlers: {}, workerId: "worker-a", pollMs: 25,
      onEvent: (event) => events.push(event)
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "drain_error" }));
    expect(leaseNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(leaseNext).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("stops idempotently, waits for the current handler, and cannot restart", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T08:00:00.000Z") });
    const { store, job } = createFixture("implement");
    const handler = deferred();
    const worker = createAutomationWorker({
      jobs: store.automationJobs, handlers: { implement: () => handler.promise },
      workerId: "worker-a", pollMs: 50
    });

    worker.start();
    const firstStop = worker.stop();
    const secondStop = worker.stop();
    let stopped = false;
    void firstStop.then(() => { stopped = true; });
    await Promise.resolve();

    expect(secondStop).toBe(firstStop);
    expect(stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    handler.resolve();
    await expect(firstStop).resolves.toBeUndefined();
    expect(store.automationJobs.get(job.id)?.status).toBe("completed");
    await expect(worker.drainOnce()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => worker.start()).toThrow("AUTOMATION_WORKER_STOPPED");
  });

  it.each([
    ["unsafe worker", { workerId: "worker:unsafe" }],
    ["empty worker", { workerId: "" }],
    ["zero lease", { leaseMs: 0 }],
    ["fractional lease", { leaseMs: 1.5 }],
    ["excessive lease", { leaseMs: 86_400_001 }],
    ["zero poll", { pollMs: 0 }],
    ["fractional poll", { pollMs: 1.5 }],
    ["excessive poll", { pollMs: 86_400_001 }],
    ["zero stop timeout", { stopTimeoutMs: 0 }],
    ["fractional stop timeout", { stopTimeoutMs: 1.5 }],
    ["excessive stop timeout", { stopTimeoutMs: 86_400_001 }]
  ])("rejects %s at construction", (_label, invalid) => {
    const store = new WorkflowStore(":memory:");
    stores.push(store);
    expect(() => createAutomationWorker({
      jobs: store.automationJobs, handlers: {}, ...invalid
    })).toThrow(/AUTOMATION_WORKER_/);
  });
});
