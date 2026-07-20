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

const schemaVersion = "phase-2-delivery-quality-v6";

interface StartupApp {
  addHook(name: "onClose", hook: () => Promise<void> | void): unknown;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

export interface StartupOptions {
  env?: NodeJS.ProcessEnv;
  makeDirectory?: typeof mkdirSync;
  prepareDatabase?: typeof prepareCleanDatabase;
  createStore?: (databasePath: string) => WorkflowStore;
  writeVersionMarker?: typeof writeDatabaseVersionMarker;
  buildApplication?: (store: WorkflowStore) => Promise<StartupApp>;
  createWorker?: (options: AutomationWorkerOptions) => AutomationWorker;
  automationHandlers?: Partial<AutomationHandlers>;
  clock?: () => Date;
  onWorkerEvent?: (event: AutomationWorkerEvent) => void;
  installSignalHandlers?: boolean;
  writeListening?: (listeningUrl: string) => void;
}

export async function startServer(options: StartupOptions = {}) {
  const env = options.env ?? process.env;
  const dataDir = resolve(env.DATA_DIR || "data");
  (options.makeDirectory ?? mkdirSync)(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = resolve(dataDir, "workflow.db");
  env.DATABASE_PATH = databasePath;
  await (options.prepareDatabase ?? prepareCleanDatabase)(databasePath, schemaVersion);
  const store = (options.createStore ?? ((path) => new WorkflowStore(path)))(databasePath);
  let worker: AutomationWorker | undefined;
  let app: StartupApp | undefined;
  let resourcesClosed = false;
  let closePromise: Promise<void> | undefined;
  let signalsInstalled = false;
  const removeSignalHandlers = () => {
    if (!signalsInstalled) return;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    signalsInstalled = false;
  };
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    removeSignalHandlers();
    try {
      await worker?.stop();
    } finally {
      store.close();
    }
  };
  const close = () => {
    if (!closePromise) {
      closePromise = Promise.resolve()
        .then(() => app?.close())
        .finally(closeResources);
    }
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
    const clock = options.clock ?? (() => new Date());
    store.automationJobs.recoverExpired(clock());
    const workerOptions: AutomationWorkerOptions = {
      jobs: store.automationJobs,
      handlers: options.automationHandlers ?? {},
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) await startServer({ installSignalHandlers: true });
