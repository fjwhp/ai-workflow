import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { WorkflowStore } from "./store.js";
import { buildApp } from "./app.js";
import { prepareCleanDatabase, writeDatabaseVersionMarker } from "./database-reset.js";

const schemaVersion = "phase-2-automation-v4";

const dataDir = resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const databasePath = resolve(dataDir, "workflow.db");
process.env.DATABASE_PATH = databasePath;
await prepareCleanDatabase(databasePath, schemaVersion);
const store = new WorkflowStore(databasePath);
await writeDatabaseVersionMarker(databasePath, schemaVersion);
store.interruptActiveStageRuns();
store.interruptActiveProjectKnowledge();
store.recoverInterruptedRequirements();
const app = await buildApp(store);
const listeningUrl = await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT || 3210) });
process.stdout.write(`FLOWGATE_LISTENING ${JSON.stringify({ url: listeningUrl })}\n`);
