import { randomUUID } from "node:crypto";
import type { AutomationAction } from "@ai-workflow/shared";
import type { AutomationJob, AutomationJobPersistence } from "./automation-job-repository.js";
import { parseDeliveryApplicationJob } from "./delivery-coordinator.js";
import type { DeliveryApplicationService } from "./delivery-application-service.js";

export interface AutomationHandlerContext {
  signal: AbortSignal;
}

export type AutomationHandlers = Record<
  AutomationAction,
  (job: AutomationJob, context: AutomationHandlerContext) => Promise<void>
>;

export type AutomationWorkerEvent =
  | { type: "handler_missing"; jobId: string; action: AutomationAction }
  | { type: "settle_rejected"; jobId: string; settlement: "complete" | "fail" }
  | { type: "settle_error"; jobId: string; settlement: "complete" | "fail"; error: unknown }
  | { type: "heartbeat_lost"; jobId: string; error?: unknown }
  | { type: "drain_error"; error: unknown };

export interface AutomationWorkerOptions {
  jobs: AutomationJobPersistence;
  handlers: Partial<AutomationHandlers>;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  clock?: () => Date;
  timers?: AutomationWorkerTimers;
  onEvent?: (event: AutomationWorkerEvent) => void;
}

export interface AutomationWorkerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutomationWorker {
  drainOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export function createDeliveryApplicationAutomationHandlers(
  service: Pick<DeliveryApplicationService, "apply">,
  assertSequence: (job: AutomationJob) => void
): Pick<AutomationHandlers, "apply"> {
  if (!service || typeof service.apply !== "function") {
    throw new Error("DELIVERY_APPLICATION_HANDLER_INVALID");
  }
  if (typeof assertSequence !== "function") throw new Error("DELIVERY_APPLICATION_HANDLER_INVALID");
  return {
    apply: async (job, context) => {
      parseDeliveryApplicationJob(job);
      assertSequence(job);
      await service.apply(job.ownerId, {
        expectedEvidenceVersion: job.evidenceVersion,
        claimToken: job.claimToken
      }, context.signal);
    }
  };
}

export class RetryableAutomationError extends Error {
  readonly retryable = true;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "RetryableAutomationError";
  }
}

export function retryable(code: string, cause?: unknown): RetryableAutomationError {
  if (typeof code !== "string" || code.length > 256
    || !/^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_-]+)?$/.test(code)) {
    throw new Error("AUTOMATION_WORKER_ERROR_CODE_INVALID");
  }
  return new RetryableAutomationError(code, cause === undefined ? undefined : { cause });
}

export function classifyAutomationError(error: unknown): "retryable" | "terminal" {
  if (error instanceof RetryableAutomationError) return "retryable";
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:^|_)(?:CONFIG|VALIDATION)(?:_|$)|(?:_INVALID|_MISSING)(?::|$)/.test(code)
    ? "terminal"
    : "retryable";
}

export function createAutomationWorker(options: AutomationWorkerOptions): AutomationWorker {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 1_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 15_000;
  validateWorkerId(workerId);
  validateDuration(leaseMs, "AUTOMATION_WORKER_LEASE_MS_INVALID");
  validateDuration(pollMs, "AUTOMATION_WORKER_POLL_MS_INVALID");
  validateDuration(stopTimeoutMs, "AUTOMATION_WORKER_STOP_TIMEOUT_MS_INVALID");
  const clock = options.clock ?? (() => new Date());
  const timers = options.timers ?? defaultTimers;
  const heartbeatMs = Math.max(1, Math.floor(leaseMs / 3));
  let inFlight: Promise<boolean> | undefined;
  let pollTimer: unknown;
  let activeHeartbeat: { cancel(): void } | undefined;
  let activeController: AbortController | undefined;
  let state: "idle" | "running" | "stopped" = "idle";
  let stopPromise: Promise<void> | undefined;

  const report = (event: AutomationWorkerEvent) => {
    try { options.onEvent?.(event); } catch {}
  };

  const settle = (jobId: string, settlement: "complete" | "fail", operation: () => boolean) => {
    try {
      if (!operation()) report({ type: "settle_rejected", jobId, settlement });
    } catch (error) {
      report({ type: "settle_error", jobId, settlement, error });
    }
  };

  const runOnce = async (): Promise<boolean> => {
    options.jobs.recoverExpired(clock());
    const job = options.jobs.leaseNext(workerId, clock(), leaseMs);
    if (!job) return false;
    const handler = options.handlers[job.action];
    if (!handler) {
      report({ type: "handler_missing", jobId: job.id, action: job.action });
      settle(job.id, "fail", () => options.jobs.fail(
        job.id, workerId, job.claimToken, `AUTOMATION_HANDLER_MISSING:${job.action}`, false
      ));
      return true;
    }
    let ownershipLost = false;
    const controller = new AbortController();
    activeController = controller;
    let heartbeatTimer: unknown;
    let heartbeatActive = true;
    const cancelHeartbeat = () => {
      heartbeatActive = false;
      if (heartbeatTimer !== undefined) {
        timers.clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const heartbeat = () => {
      heartbeatTimer = undefined;
      if (!heartbeatActive) return;
      try {
        if (!options.jobs.renew(job.id, workerId, job.claimToken, clock(), leaseMs)) {
          ownershipLost = true;
          heartbeatActive = false;
          controller.abort(new Error("AUTOMATION_WORKER_LEASE_LOST"));
          report({ type: "heartbeat_lost", jobId: job.id });
          return;
        }
      } catch (error) {
        ownershipLost = true;
        heartbeatActive = false;
        controller.abort(new Error("AUTOMATION_WORKER_LEASE_LOST", { cause: error }));
        report({ type: "heartbeat_lost", jobId: job.id, error });
        return;
      }
      heartbeatTimer = timers.setTimeout(heartbeat, heartbeatMs);
    };
    heartbeatTimer = timers.setTimeout(heartbeat, heartbeatMs);
    activeHeartbeat = { cancel: cancelHeartbeat };
    let handlerFailed = false;
    let handlerError: unknown;
    try {
      await handler(job, { signal: controller.signal });
    } catch (error) {
      handlerFailed = true;
      handlerError = error;
    } finally {
      cancelHeartbeat();
      activeHeartbeat = undefined;
      if (activeController === controller) activeController = undefined;
    }
    if (ownershipLost) return true;
    if (handlerFailed) {
      settle(job.id, "fail", () => options.jobs.fail(
        job.id, workerId, job.claimToken, handlerError,
        classifyAutomationError(handlerError) === "retryable"
      ));
    } else {
      settle(job.id, "complete", () => options.jobs.complete(job.id, workerId, job.claimToken));
    }
    return true;
  };

  const poll = async () => {
    if (state !== "running") return;
    try {
      await drainOnce();
    } catch (error) {
      report({ type: "drain_error", error });
    }
    if (state !== "running") return;
    try {
      pollTimer = timers.setTimeout(() => {
        pollTimer = undefined;
        void poll();
      }, pollMs);
    } catch (error) {
      report({ type: "drain_error", error });
    }
  };

  const drainOnce = (): Promise<boolean> => {
    if (state === "stopped") return Promise.resolve(false);
    if (inFlight) return inFlight;
    inFlight = runOnce().finally(() => { inFlight = undefined; });
    return inFlight;
  };

  return {
    drainOnce,
    start() {
      if (state === "stopped") throw new Error("AUTOMATION_WORKER_STOPPED");
      if (state === "running") return;
      state = "running";
      void poll();
    },
    stop() {
      if (stopPromise) return stopPromise;
      state = "stopped";
      if (pollTimer !== undefined) {
        timers.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      activeHeartbeat?.cancel();
      activeController?.abort();
      const current = inFlight;
      if (!current) {
        stopPromise = Promise.resolve();
        return stopPromise;
      }
      const waiting = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timeout);
          operation();
        };
        const timeout = timers.setTimeout(() => {
          finish(() => reject(new Error("AUTOMATION_WORKER_STOP_TIMEOUT")));
        }, stopTimeoutMs);
        current.then(
          () => finish(resolve),
          () => finish(resolve)
        );
      });
      stopPromise = waiting.catch((error) => {
        stopPromise = undefined;
        throw error;
      });
      return stopPromise;
    }
  };
}

const MAX_DURATION_MS = 86_400_000;
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const defaultTimers: AutomationWorkerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function validateWorkerId(workerId: unknown) {
  if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128
    || !WORKER_ID_PATTERN.test(workerId)) {
    throw new Error("AUTOMATION_WORKER_ID_INVALID");
  }
}

function validateDuration(value: unknown, code: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_DURATION_MS) {
    throw new Error(code);
  }
}
