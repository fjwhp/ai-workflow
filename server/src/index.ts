import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowStore } from "./store.js";
import { buildApp } from "./app.js";
import { prepareCleanDatabase, writeDatabaseVersionMarker } from "./database-reset.js";
import {
  createAutomationWorker,
  type AutomationHandlers,
  type AutomationWorker,
  type AutomationWorkerEvent,
  type AutomationWorkerOptions
} from "./automation-worker.js";
import {
  createDeliveryQualityAutomationHandlers,
  DeliveryExecutionService
} from "./delivery-execution-service.js";
import { cleanupVerificationQuarantines } from "./verification-cleanup.js";

const schemaVersion = "phase-2-quality-attempt-v14";

interface StartupApp {
  addHook(name: "onClose", hook: () => Promise<void> | void): unknown;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

export interface StartupOptions {
  env?: NodeJS.ProcessEnv;
  makeDirectory?: typeof mkdirSync;
  prepareDatabase?: typeof prepareCleanDatabase;
  createStore?: (databasePath: string, clock: () => Date) => WorkflowStore;
  writeVersionMarker?: typeof writeDatabaseVersionMarker;
  buildApplication?: (store: WorkflowStore) => Promise<StartupApp>;
  createWorker?: (options: AutomationWorkerOptions) => AutomationWorker;
  createDeliveryService?: (store: WorkflowStore) => Pick<DeliveryExecutionService, "review" | "test">;
  automationHandlers?: Partial<AutomationHandlers>;
  clock?: () => Date;
  onWorkerEvent?: (event: AutomationWorkerEvent) => void;
  installSignalHandlers?: boolean;
  writeListening?: (listeningUrl: string) => void;
  cleanupVerificationQuarantines?: typeof cleanupVerificationQuarantines;
  reportVerificationCleanup?: (
    result: Awaited<ReturnType<typeof cleanupVerificationQuarantines>>
  ) => void;
}

export async function startServer(options: StartupOptions = {}) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const dataDir = resolve(env.DATA_DIR || "data");
  (options.makeDirectory ?? mkdirSync)(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = resolve(dataDir, "workflow.db");
  env.DATABASE_PATH = databasePath;
  await (options.prepareDatabase ?? prepareCleanDatabase)(databasePath, schemaVersion);
  const store = (options.createStore ?? ((path, storeClock) => new WorkflowStore(path, storeClock)))(databasePath, clock);
  let worker: AutomationWorker | undefined;
  let app: StartupApp | undefined;
  let resourcesClosed = false;
  let resourceClosePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let appCloseAttempted = false;
  let signalsInstalled = false;
  const removeSignalHandlers = () => {
    if (!signalsInstalled) return;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    signalsInstalled = false;
  };
  const closeResources = () => {
    if (resourcesClosed) return Promise.resolve();
    if (resourceClosePromise) return resourceClosePromise;
    removeSignalHandlers();
    const attempt = Promise.resolve().then(async () => {
      await worker?.stop();
      store.close();
      resourcesClosed = true;
    });
    resourceClosePromise = attempt.catch((error) => {
      resourceClosePromise = undefined;
      throw error;
    });
    return resourceClosePromise;
  };
  const close = () => {
    if (closePromise) return closePromise;
    const attempt = Promise.resolve().then(async () => {
      if (!appCloseAttempted && app) {
        appCloseAttempted = true;
        try {
          await app.close();
        } catch (error) {
          if (!(error instanceof Error && error.message === "AUTOMATION_WORKER_STOP_TIMEOUT")) {
            try { await closeResources(); } catch {}
          }
          throw error;
        }
      }
      await closeResources();
    });
    closePromise = attempt.catch((error) => {
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  };
  function onSignal() {
    void close().catch((error) => {
      process.exitCode = 1;
      process.stderr.write(`FLOWGATE_SHUTDOWN_ERROR ${formatError(error)}\n`);
    });
  }

  try {
    await (options.writeVersionMarker ?? writeDatabaseVersionMarker)(databasePath, schemaVersion);
    store.interruptActiveStageRuns();
    store.interruptActiveProjectKnowledge();
    store.recoverInterruptedRequirements();
    store.automationJobs.recoverExpired(clock());
    store.recoverAbandonedDeliveryExecutions(clock());
    const cleanupResult = await (options.cleanupVerificationQuarantines ?? cleanupVerificationQuarantines)({
      maxEntries: 4, maxScannedEntries: 4096
    });
    if (cleanupResult.failed > 0 || cleanupResult.remaining > 0 || cleanupResult.scanTruncated) {
      (options.reportVerificationCleanup ?? reportVerificationCleanup)(cleanupResult);
    }
    const deliveryService = (options.createDeliveryService ?? ((workflowStore) => new DeliveryExecutionService(
      workflowStore.deliveryExecutions, undefined, undefined, workflowStore.deliveryQuality
    )))(store);
    const workerOptions: AutomationWorkerOptions = {
      jobs: store.automationJobs,
      handlers: {
        ...createDeliveryQualityAutomationHandlers(deliveryService),
        ...options.automationHandlers
      },
      clock,
      onEvent: options.onWorkerEvent ?? reportWorkerEvent
    };
    if (env.AUTOMATION_WORKER_ID !== undefined) workerOptions.workerId = env.AUTOMATION_WORKER_ID;
    if (env.AUTOMATION_WORKER_LEASE_MS !== undefined) {
      workerOptions.leaseMs = Number(env.AUTOMATION_WORKER_LEASE_MS);
    }
    if (env.AUTOMATION_WORKER_POLL_MS !== undefined) {
      workerOptions.pollMs = Number(env.AUTOMATION_WORKER_POLL_MS);
    }
    worker = (options.createWorker ?? createAutomationWorker)(workerOptions);
    app = await (options.buildApplication ?? buildApp)(store);
    app.addHook("onClose", closeResources);
    if (options.installSignalHandlers) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      signalsInstalled = true;
    }
    if (automationWorkerEnabled(env.AUTOMATION_WORKER_ENABLED)) worker.start();
    const listeningUrl = await app.listen({ host: "127.0.0.1", port: Number(env.PORT || 3210) });
    (options.writeListening ?? ((url) => {
      process.stdout.write(`FLOWGATE_LISTENING ${JSON.stringify({ url })}\n`);
    }))(listeningUrl);
    return { app, store, worker, listeningUrl, close };
  } catch (error) {
    try {
      await close();
    } catch {}
    throw error;
  }
}

function automationWorkerEnabled(value: string | undefined) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("AUTOMATION_WORKER_ENABLED_INVALID");
}

function reportWorkerEvent(event: AutomationWorkerEvent) {
  const error = "error" in event ? formatError(event.error) : undefined;
  process.stderr.write(`FLOWGATE_AUTOMATION_WORKER ${JSON.stringify({ ...event, error })}\n`);
}

function reportVerificationCleanup(
  result: Awaited<ReturnType<typeof cleanupVerificationQuarantines>>
) {
  process.stderr.write(`FLOWGATE_VERIFICATION_CLEANUP ${JSON.stringify(result)}\n`);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) await startServer({ installSignalHandlers: true });
