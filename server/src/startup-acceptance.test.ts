import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createPhase2Schema } from "./database-schema.js";

const tempDirectories: string[] = [];
const runningChildren = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...runningChildren].map(stopChild));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("real server startup acceptance", () => {
  it("backs up deployed automation v4 before creating the quality coordination v10 schema", { timeout: 15_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workflow-startup-acceptance-"));
    tempDirectories.push(dataDir);
    const databasePath = join(dataDir, "workflow.db");
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      CREATE TABLE project_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL,
        base_branch TEXT NOT NULL, worktree_path TEXT NOT NULL, status TEXT NOT NULL, head_commit TEXT NOT NULL,
        pending_requirement_id TEXT, pending_integration_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE TABLE approvals (id TEXT PRIMARY KEY, override_json TEXT);
      CREATE TABLE integration_runs (id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_integration_runs_active ON integration_runs(requirement_id) WHERE status = 'running';
      CREATE TABLE automation_jobs (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL, evidence_version INTEGER NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        lease_owner TEXT, lease_expires_at TEXT, payload_json TEXT NOT NULL, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO project_versions VALUES (
        'version-old', 'project-old', 'v2', 'feature/v2', 'main', '/tmp/old-v2', 'active', 'abc123',
        'requirement-old', 'run-old', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', NULL
      );
      INSERT INTO approvals VALUES ('approval-old', '{"actor":"legacy"}');
      INSERT INTO integration_runs VALUES ('run-old', 'requirement-old', 'running');
    `);
    oldDatabase.close();
    await writeFile(`${databasePath}.schema-version`, "phase-2-automation-v4");
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
      const live = new DatabaseSync(databasePath);
      const expectedFresh = new DatabaseSync(":memory:");
      createPhase2Schema(expectedFresh);
      expect(schemaObjects(live)).toEqual(schemaObjects(expectedFresh));
      expectedFresh.close();
      expect(columns(live, "project_versions")).toEqual([
        "id", "project_id", "name", "branch", "base_branch", "worktree_path", "status",
        "head_commit", "created_at", "updated_at", "closed_at"
      ]);
      expect(columns(live, "approvals")).not.toContain(["override", "json"].join("_"));
      expect(object(live, "table", ["integration", "runs"].join("_"))).toBeUndefined();
      expect(object(live, "index", ["idx", "integration", "runs", "active"].join("_"))).toBeUndefined();
      expect(columns(live, "automation_jobs")).toEqual(expect.arrayContaining(["evidence_version", "max_attempts"]));
      live.close();
      const backupNames = (await readdir(dataDir)).filter((name) => /^workflow\.db\.backup-\d{4}-\d{2}-\d{2}T/.test(name) && !name.endsWith("-wal") && !name.endsWith("-shm"));
      expect(backupNames).toHaveLength(1);
      const backup = new DatabaseSync(join(dataDir, backupNames[0]!));
      expect(columns(backup, "project_versions")).toEqual(expect.arrayContaining([
        ["pending", "requirement", "id"].join("_"), ["pending", "integration", "run", "id"].join("_")
      ]));
      expect(columns(backup, "approvals")).toContain(["override", "json"].join("_"));
      expect(object(backup, "table", ["integration", "runs"].join("_"))).toBeDefined();
      expect(object(backup, "index", ["idx", "integration", "runs", "active"].join("_"))).toBeDefined();
      expect(columns(backup, "automation_jobs")).toEqual(expect.arrayContaining(["evidence_version", "max_attempts"]));
      expect(object(backup, "index", "idx_automation_jobs_pending_lease")).toBeUndefined();
      backup.close();
      await expect(readFile(`${databasePath}.schema-version`, "utf8")).resolves.toBe("phase-2-quality-coordination-v10");
    } finally {
      await stopChild(child);
    }
  });
});

function columns(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function object(database: DatabaseSync, type: "table" | "index", name: string) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
}

function schemaObjects(database: DatabaseSync) {
  return database.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
}

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
