import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  databases.splice(0).forEach((database) => database.close());
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "project-version-store-"));
  directories.push(directory);
  return join(directory, "workflow.db");
}

function columns(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);
}

function requirementInput(projectId: string, title: string) {
  return {
    title,
    businessProblem: `${title} business problem`,
    expectedOutcome: `${title} expected outcome`,
    priority: "medium" as const,
    primaryProjectId: projectId,
    primaryProjectVersionId: "version-1"
  };
}

describe("project versions fresh schema", () => {
  it("owns branch and worktree state and removes the free integration target", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);

    expect(columns(database, "project_versions")).toEqual(expect.arrayContaining([
      "id", "project_id", "name", "branch", "base_branch", "worktree_path", "status",
      "head_commit", "pending_requirement_id", "pending_integration_run_id", "created_at",
      "updated_at", "closed_at"
    ]));
    expect(columns(database, "requirement_projects")).toContain("project_version_id");
    expect(columns(database, "executions")).toEqual(expect.arrayContaining(["project_version_id", "base_commit"]));
    expect(columns(database, "integration_runs")).toEqual(expect.arrayContaining([
      "project_version_id", "pre_apply_head", "resolution_status", "resolution_commit"
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requirement_integration_targets'").get()).toBeUndefined();
  });

  it("initializes the global requirement counter at zero", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);

    expect(columns(database, "counters")).toEqual(["key", "value"]);
    expect(database.prepare("SELECT key, value FROM counters WHERE key = 'requirement'").get()).toEqual({ key: "requirement", value: 0 });
  });
});

describe("requirement code allocation", () => {
  it("serializes simultaneous creation from independent processes", { timeout: 15_000 }, async () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const project = store.createProject({
      name: "Concurrent project",
      repoPath: join(path, "..", "concurrent-project"),
      defaultBranch: "main",
      allowedCommands: [],
      sensitivePatterns: []
    });
    const first = spawnCreator(path, requirementInput(project.id, "Concurrent first"));
    await first.waitFor("ready");
    const second = spawnCreator(path, requirementInput(project.id, "Concurrent second"));
    await second.waitFor("ready");
    const locker = new DatabaseSync(path);
    databases.push(locker);
    locker.exec("BEGIN IMMEDIATE");
    const firstStarting = first.waitFor("starting");
    const secondStarting = second.waitFor("starting");
    first.child.send("go");
    second.child.send("go");
    await Promise.all([firstStarting, secondStarting]);
    locker.exec("COMMIT");

    const outcomes = await Promise.all([first.waitForOutcome(), second.waitForOutcome()]);
    await Promise.all([waitForExit(first.child), waitForExit(second.child)]);

    expect(outcomes).toEqual(expect.arrayContaining([
      { type: "result", code: "REQ-0001" },
      { type: "result", code: "REQ-0002" }
    ]));
  });

  it("reports a missing counter and keeps the connection usable after rollback", () => {
    const path = databasePath();
    const store = new WorkflowStore(path);
    stores.push(store);
    const database = new DatabaseSync(path);
    databases.push(database);
    const project = store.createProject({
      name: "Counter recovery project",
      repoPath: join(path, "..", "counter-recovery-project"),
      defaultBranch: "main",
      allowedCommands: [],
      sensitivePatterns: []
    });
    database.prepare("DELETE FROM counters WHERE key = 'requirement'").run();

    expect(() => store.createRequirement(requirementInput(project.id, "Missing counter")))
      .toThrow("REQUIREMENT_COUNTER_MISSING");
    expect(store.listRequirements()).toEqual([]);

    database.prepare("INSERT INTO counters (key, value) VALUES ('requirement', 0)").run();
    expect(store.createRequirement(requirementInput(project.id, "Recovered counter")).code).toBe("REQ-0001");
  });

  it("allocates committed codes across interleaved connections and rolls back failed allocations", () => {
    const path = databasePath();
    const firstStore = new WorkflowStore(path);
    const secondStore = new WorkflowStore(path);
    stores.push(firstStore, secondStore);
    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");

    const project = firstStore.createProject({
      name: "Shared project",
      repoPath: join(path, "..", "shared-project"),
      defaultBranch: "main",
      allowedCommands: [],
      sensitivePatterns: []
    });
    database.exec(`
      CREATE TRIGGER fail_next_requirement
      BEFORE INSERT ON requirements
      WHEN NEW.title = 'Forced rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    expect(() => firstStore.createRequirement(requirementInput(project.id, "Forced rollback"))).toThrow("forced rollback");
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 0 });
    database.exec("DROP TRIGGER fail_next_requirement");

    const firstCommitted = secondStore.createRequirement(requirementInput(project.id, "First committed"));
    database.exec("BEGIN");
    database.prepare("DELETE FROM requirement_projects WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirement_revisions WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirements WHERE id = ?").run(firstCommitted.id);
    database.exec("COMMIT");
    const secondCommitted = firstStore.createRequirement(requirementInput(project.id, "Second committed"));

    expect([firstCommitted.code, secondCommitted.code]).toEqual(["REQ-0001", "REQ-0002"]);
    expect(new Set([firstCommitted.code, secondCommitted.code]).size).toBe(2);
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 2 });
  });
});

type ChildMessage =
  | { type: "ready" | "starting" }
  | { type: "result"; code: string }
  | { type: "error"; message: string; code?: string };

const creatorScript = `
(async () => {
  const { WorkflowStore } = await import(process.env.STORE_MODULE_URL);
  const store = new WorkflowStore(process.env.DATABASE_PATH);
  const finish = (message, exitCode) => process.send(message, () => {
    store.close();
    process.exit(exitCode);
  });
  process.on("message", (message) => {
    if (message !== "go") return;
    process.send({ type: "starting" });
    try {
      const requirement = store.createRequirement(JSON.parse(process.env.REQUIREMENT_INPUT));
      finish({ type: "result", code: requirement.code }, 0);
    } catch (error) {
      finish({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" ? error.code : undefined
      }, 1);
    }
  });
  process.send({ type: "ready" });
})().catch((error) => {
  process.send({ type: "error", message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
});
`;

function spawnCreator(path: string, input: ReturnType<typeof requirementInput>) {
  const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "--eval", creatorScript], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_PATH: path,
      REQUIREMENT_INPUT: JSON.stringify(input),
      STORE_MODULE_URL: pathToFileURL(resolve("server/src/store.ts")).href
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  children.add(child);
  let logs = "";
  child.stdout?.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
  const messages: ChildMessage[] = [];
  const waiters: Array<{
    types: ChildMessage["type"][];
    resolve: (message: ChildMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  child.on("message", (message: ChildMessage) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.types.includes(message.type));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    else messages.push(message);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Child exited (${code ?? signal}) before ${waiter.types.join("/")}.\nMessages: ${JSON.stringify(messages)}\n${logs}`));
    }
  });
  const waitForAny = (types: ChildMessage["type"][]) => {
    const queued = messages.findIndex((message) => types.includes(message.type));
    if (queued >= 0) return Promise.resolve(messages.splice(queued, 1)[0]!);
    return new Promise<ChildMessage>((resolveMessage, reject) => {
      const waiter = {
        types,
        resolve: resolveMessage,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Child timed out waiting for ${types.join("/")}.\nMessages: ${JSON.stringify(messages)}\n${logs}`));
        }, 10_000)
      };
      waiters.push(waiter);
    });
  };
  return {
    child,
    waitFor: (type: ChildMessage["type"]) => waitForAny([type]),
    waitForOutcome: () => waitForAny(["result", "error"])
  };
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}
