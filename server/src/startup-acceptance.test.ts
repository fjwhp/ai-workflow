import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];
const runningChildren = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...runningChildren].map(stopChild));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("real server startup acceptance", () => {
  it("backs up a v1 database and starts with no legacy stages or gate settings", { timeout: 15_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workflow-startup-acceptance-"));
    tempDirectories.push(dataDir);
    const databasePath = join(dataDir, "workflow.db");
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      CREATE TABLE requirements (id TEXT PRIMARY KEY, stage TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      INSERT INTO requirements VALUES ('legacy-requirement', 'prd');
      INSERT INTO settings VALUES ('gate_config', '{"mandatoryHumanStages":["coding","acceptance"]}');
    `);
    oldDatabase.close();
    await writeFile(`${databasePath}.schema-version`, "phase-2-delivery-v1");
    const stdout = boundedLogs();
    const allLogs = boundedLogs();
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("server/src/index.ts")], {
      cwd: resolve("."),
      env: { ...process.env, DATA_DIR: dataDir, PORT: "0", OPENAI_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    runningChildren.add(child);
    child.stdout?.on("data", (chunk) => { stdout.append(chunk); allLogs.append(chunk); });
    child.stderr?.on("data", allLogs.append);

    try {
      const baseUrl = await waitForListeningEvent(child, stdout.read, allLogs.read);
      await waitForHealth(baseUrl, child, allLogs.read);
      await expect(getJson(baseUrl, "/api/projects")).resolves.toEqual([]);
      await expect(getJson(baseUrl, "/api/requirements")).resolves.toEqual([]);
      await expect(getJson(baseUrl, "/api/settings/gates")).resolves.toMatchObject({
        mandatoryHumanStages: []
      });
      const backupNames = (await readdir(dataDir)).filter((name) => /^workflow\.db\.backup-\d{4}-\d{2}-\d{2}T/.test(name) && !name.endsWith("-wal") && !name.endsWith("-shm"));
      expect(backupNames).toHaveLength(1);
      const backup = new DatabaseSync(join(dataDir, backupNames[0]!));
      expect(backup.prepare("SELECT stage FROM requirements").get()).toEqual({ stage: "prd" });
      expect(JSON.parse((backup.prepare("SELECT value_json FROM settings WHERE key = 'gate_config'").get() as { value_json: string }).value_json))
        .toEqual({ mandatoryHumanStages: ["coding", "acceptance"] });
      backup.close();
      await expect(readFile(`${databasePath}.schema-version`, "utf8")).resolves.toBe("phase-2-five-stage-v2");
    } finally {
      await stopChild(child);
    }
  });
});

async function waitForListeningEvent(child: ChildProcess, stdout: () => string, logs: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assertChildRunning(child, logs, "listening event");
    const match = stdout().match(/(?:^|\n)FLOWGATE_LISTENING (\{[^\n]+\})(?:\n|$)/);
    if (match) {
      const event = JSON.parse(match[1]!) as { url?: unknown };
      if (typeof event.url !== "string") throw new Error(`Invalid FLOWGATE_LISTENING event.\n${logs()}`);
      const url = new URL(event.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error(`Unsafe FLOWGATE_LISTENING URL: ${event.url}`);
      return url.origin;
    }
    await delay(25);
  }
  throw new Error(`Server listening event timed out.\n${logs()}`);
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assertChildRunning(child, logs, "health check");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`Server health check timed out.\n${logs()}`);
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function assertChildRunning(child: ChildProcess, logs: () => string, milestone: string) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited (${child.exitCode ?? child.signalCode}) before ${milestone}.\n${logs()}`);
}

const delay = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function stopChild(child: ChildProcess) {
  runningChildren.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([exited.then(() => true), new Promise<false>((resolveTimeout) => { killTimer = setTimeout(() => resolveTimeout(false), 2_000); })]);
  if (killTimer) clearTimeout(killTimer);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

function boundedLogs(maxChars = 32_000) {
  let output = "";
  return {
    append: (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-maxChars); },
    read: () => output
  };
}
