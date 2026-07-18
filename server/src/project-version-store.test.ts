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

function requirementInput(projectId: string, projectVersionId: string, title: string) {
  return {
    title,
    businessProblem: `${title} business problem`,
    expectedOutcome: `${title} expected outcome`,
    priority: "medium" as const,
    primaryProjectId: projectId,
    primaryProjectVersionId: projectVersionId
  };
}

function createProject(store: WorkflowStore, name: string, repoPath: string) {
  return store.createProject({
    name, repoPath, defaultBranch: "main", allowedCommands: [], sensitivePatterns: []
  });
}

function createVersion(store: WorkflowStore, projectId: string, name = "1.0.0", worktreePath = `/tmp/version-${projectId}`) {
  return store.createProjectVersion({
    projectId, name, branch: `feature/${name}`, baseBranch: "main", worktreePath, headCommit: `head-${name}`
  });
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
    const project = createProject(store, "Concurrent project", join(path, "..", "concurrent-project"));
    const version = createVersion(store, project.id, "1.0.0", join(path, "..", "concurrent-version"));
    const first = spawnCreator(path, requirementInput(project.id, version.id, "Concurrent first"));
    await first.waitFor("ready");
    const second = spawnCreator(path, requirementInput(project.id, version.id, "Concurrent second"));
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
    const project = createProject(store, "Counter recovery project", join(path, "..", "counter-recovery-project"));
    const version = createVersion(store, project.id, "1.0.0", join(path, "..", "counter-recovery-version"));
    database.prepare("DELETE FROM counters WHERE key = 'requirement'").run();

    expect(() => store.createRequirement(requirementInput(project.id, version.id, "Missing counter")))
      .toThrow("REQUIREMENT_COUNTER_MISSING");
    expect(store.listRequirements()).toEqual([]);

    database.prepare("INSERT INTO counters (key, value) VALUES ('requirement', 0)").run();
    expect(store.createRequirement(requirementInput(project.id, version.id, "Recovered counter")).code).toBe("REQ-0001");
  });

  it("allocates committed codes across interleaved connections and rolls back failed allocations", () => {
    const path = databasePath();
    const firstStore = new WorkflowStore(path);
    const secondStore = new WorkflowStore(path);
    stores.push(firstStore, secondStore);
    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");

    const project = createProject(firstStore, "Shared project", join(path, "..", "shared-project"));
    const version = createVersion(firstStore, project.id, "1.0.0", join(path, "..", "shared-version"));
    database.exec(`
      CREATE TRIGGER fail_next_requirement
      BEFORE INSERT ON requirements
      WHEN NEW.title = 'Forced rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    expect(() => firstStore.createRequirement(requirementInput(project.id, version.id, "Forced rollback"))).toThrow("forced rollback");
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 0 });
    database.exec("DROP TRIGGER fail_next_requirement");

    const firstCommitted = secondStore.createRequirement(requirementInput(project.id, version.id, "First committed"));
    database.exec("BEGIN");
    database.prepare("DELETE FROM requirement_projects WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirement_revisions WHERE requirement_id = ?").run(firstCommitted.id);
    database.prepare("DELETE FROM requirements WHERE id = ?").run(firstCommitted.id);
    database.exec("COMMIT");
    const secondCommitted = firstStore.createRequirement(requirementInput(project.id, version.id, "Second committed"));

    expect([firstCommitted.code, secondCommitted.code]).toEqual(["REQ-0001", "REQ-0002"]);
    expect(new Set([firstCommitted.code, secondCommitted.code]).size).toBe(2);
    expect(database.prepare("SELECT value FROM counters WHERE key = 'requirement'").get()).toEqual({ value: 2 });
  });

  it("validates the primary version inside the allocation transaction and rolls back the code", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Atomic project", "/tmp/atomic-project");
    const other = createProject(store, "Other project", "/tmp/atomic-other");
    const version = createVersion(store, project.id, "1.0.0", "/tmp/atomic-version");
    const otherVersion = createVersion(store, other.id, "1.0.0", "/tmp/atomic-other-version");

    expect(() => store.createRequirement(requirementInput(project.id, otherVersion.id, "Wrong version")))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(store.createRequirement(requirementInput(project.id, version.id, "Committed version")).code).toBe("REQ-0001");
  });
});

describe("project version persistence", () => {
  it("persists a caller-provided id and maps duplicate ids to a stable error", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Explicit ID", "/tmp/project-version-explicit-id");
    const input = {
      id: "version-explicit", projectId: project.id, name: "1.0.0", branch: "feature/explicit",
      baseBranch: "main", worktreePath: "/tmp/version-explicit", headCommit: "explicit-head"
    };

    expect(store.createProjectVersion(input)).toMatchObject({ id: "version-explicit" });
    expect(store.getProjectVersion("version-explicit")).toMatchObject({ name: "1.0.0" });
    expect(() => store.createProjectVersion({
      ...input, name: "2.0.0", branch: "feature/explicit-two", worktreePath: "/tmp/version-explicit-two"
    })).toThrow("PROJECT_VERSION_ID_EXISTS");
  });

  it("creates, lists, gets, and updates a complete joined project version", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "API", "/tmp/project-version-api");
    const version = createVersion(store, project.id, "2.2.1", "/tmp/api-v221");

    expect(version).toMatchObject({
      projectId: project.id, projectName: "API", name: "2.2.1", branch: "feature/2.2.1",
      baseBranch: "main", worktreePath: "/tmp/api-v221", status: "active", headCommit: "head-2.2.1",
      pendingRequirementId: undefined, pendingIntegrationRunId: undefined, closedAt: undefined
    });
    expect(version.createdAt).toBe(version.updatedAt);
    expect(store.getProjectVersion(version.id)).toEqual(version);
    expect(store.getProjectVersion("missing")).toBeNull();
    expect(store.listProjectVersions(project.id, "active")).toEqual([version]);
    expect(store.listProjectVersions(project.id, "closed")).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.updateProjectVersionHead(version.id, "def456");
    expect(updated).toMatchObject({ id: version.id, headCommit: "def456" });
    expect(updated!.updatedAt > version.updatedAt).toBe(true);
    expect(store.getProjectVersion(version.id)?.headCommit).toBe("def456");
    expect(store.updateProjectVersionHead("missing", "noop")).toBeNull();
  });

  it("does not update a closed version head", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Closed head", "/tmp/project-version-closed-head");
    const version = createVersion(store, project.id, "closed-head", "/tmp/version-closed-head");
    store.closeProjectVersion(version.id);

    expect(store.updateProjectVersionHead(version.id, "unexpected-head")).toBeNull();
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "closed", headCommit: version.headCommit });
  });

  it("does not update an active version head after its project is archived externally", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const database = new DatabaseSync(path); databases.push(database);
    const project = createProject(store, "Archived update", join(path, "..", "archived-update"));
    const version = createVersion(store, project.id, "archived-update", join(path, "..", "archived-update-version"));
    database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project.id);

    expect(store.updateProjectVersionHead(version.id, "unexpected-head")).toBeNull();
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", headCommit: version.headCommit });
  });

  it("does not close an active version after its project is archived externally", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const database = new DatabaseSync(path); databases.push(database);
    const project = createProject(store, "Archived close", join(path, "..", "archived-close"));
    const version = createVersion(store, project.id, "archived-close", join(path, "..", "archived-close-version"));
    database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project.id);

    expect(() => store.closeProjectVersion(version.id)).toThrow("PROJECT_NOT_ACTIVE");
    expect(store.getProjectVersion(version.id)).toMatchObject({ status: "active", closedAt: undefined });
  });

  it("maps unique conflicts to stable errors while scoping name and branch per project", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const first = createProject(store, "First", "/tmp/version-first");
    const second = createProject(store, "Second", "/tmp/version-second");
    createVersion(store, first.id, "2.0.0", "/tmp/version-first-v2");

    expect(() => store.createProjectVersion({ projectId: first.id, name: "2.0.0", branch: "other", baseBranch: "main", worktreePath: "/tmp/version-name-clash", headCommit: "a" }))
      .toThrow("PROJECT_VERSION_NAME_EXISTS");
    expect(() => store.createProjectVersion({ projectId: first.id, name: "other", branch: "feature/2.0.0", baseBranch: "main", worktreePath: "/tmp/version-branch-clash", headCommit: "b" }))
      .toThrow("PROJECT_VERSION_BRANCH_EXISTS");
    expect(() => store.createProjectVersion({ projectId: second.id, name: "2.0.0", branch: "feature/2.0.0", baseBranch: "main", worktreePath: "/tmp/version-first-v2", headCommit: "c" }))
      .toThrow("PROJECT_VERSION_WORKTREE_EXISTS");
    expect(createVersion(store, second.id, "2.0.0", "/tmp/version-second-v2")).toMatchObject({ name: "2.0.0", branch: "feature/2.0.0" });
    store.archiveProject(second.id);
    expect(() => createVersion(store, second.id, "3.0.0", "/tmp/version-archived"))
      .toThrow("PROJECT_NOT_ACTIVE");
  });

  it("blocks close for pending ownership or active requirements and keeps closed history readable", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const project = createProject(store, "Close policy", join(path, "..", "close-project"));
    const pending = createVersion(store, project.id, "pending", join(path, "..", "pending-version"));
    const database = new DatabaseSync(path); databases.push(database);
    database.prepare("UPDATE project_versions SET pending_requirement_id = ? WHERE id = ?").run("owner", pending.id);
    expect(() => store.closeProjectVersion(pending.id)).toThrow("PROJECT_VERSION_CLOSE_BLOCKED");

    const version = createVersion(store, project.id, "delivery", join(path, "..", "delivery-version"));
    const requirement = store.createRequirement(requirementInput(project.id, version.id, "Active delivery"));
    expect(store.listVersionRequirements(version.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(() => store.closeProjectVersion(version.id)).toThrow("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
    store.updateRequirementState(requirement.id, "integration", "completed");
    const closed = store.closeProjectVersion(version.id);
    expect(closed).toMatchObject({ id: version.id, status: "closed" });
    expect(closed.closedAt).toBeTruthy();
    expect(store.closeProjectVersion(version.id)).toEqual(closed);
    expect(store.listProjectVersions(project.id, "active").map((item) => item.id)).toEqual([pending.id]);
    expect(store.listProjectVersions(project.id, "closed")).toEqual([closed]);
    expect(store.listProjectVersions(project.id, "all")).toHaveLength(2);
    expect(store.getProjectVersion(version.id)).toEqual(closed);
    expect(store.listVersionRequirements(version.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(() => store.closeProjectVersion("missing")).toThrow("PROJECT_VERSION_NOT_FOUND");
  });

  it("preserves archived version associations when a project moves to a new version", () => {
    const path = databasePath();
    const store = new WorkflowStore(path); stores.push(store);
    const project = createProject(store, "Version history", join(path, "..", "history-project"));
    const firstVersion = createVersion(store, project.id, "1.0.0", join(path, "..", "history-v1"));
    const secondVersion = createVersion(store, project.id, "2.0.0", join(path, "..", "history-v2"));
    const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, "Version history"));
    const snapshot = store.createRequirementProjectSnapshot(requirement.id);

    store.replaceRequirementProjects(requirement.id, [{
      projectId: project.id, projectVersionId: secondVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    }]);

    expect(store.listRequirementProjects(requirement.id)[0]).toMatchObject({
      projectVersionId: secondVersion.id, status: "active"
    });
    const database = new DatabaseSync(path); databases.push(database);
    expect(database.prepare(`SELECT project_version_id, status FROM requirement_projects
      WHERE requirement_id = ? ORDER BY status`).all(requirement.id)).toEqual([
      { project_version_id: secondVersion.id, status: "active" },
      { project_version_id: firstVersion.id, status: "archived" }
    ]);
    expect(store.listVersionRequirements(firstVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(store.listVersionRequirements(secondVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(snapshot.associations[0]).toMatchObject({ projectVersionId: firstVersion.id, projectVersionHead: "head-1.0.0" });
    expect(store.getRequirementProjectSnapshot(requirement.id)?.associations[0]).toMatchObject({
      projectVersionId: firstVersion.id, projectVersionHead: "head-1.0.0"
    });
  });

  it.each(["completed", "closed", "cancelled"])(
    "blocks closing a historical version until its requirement is %s",
    (terminalStatus) => {
      const store = new WorkflowStore(":memory:"); stores.push(store);
      const project = createProject(store, `Historical close ${terminalStatus}`, `/tmp/historical-close-${terminalStatus}`);
      const firstVersion = createVersion(store, project.id, "1.0.0", `/tmp/historical-close-${terminalStatus}-v1`);
      const secondVersion = createVersion(store, project.id, "2.0.0", `/tmp/historical-close-${terminalStatus}-v2`);
      const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, `Historical ${terminalStatus}`));
      store.replaceRequirementProjects(requirement.id, [{
        projectId: project.id, projectVersionId: secondVersion.id, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
      }]);

      expect(() => store.closeProjectVersion(firstVersion.id)).toThrow("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
      store.updateRequirementState(requirement.id, "integration", terminalStatus);
      expect(store.closeProjectVersion(firstVersion.id)).toMatchObject({ id: firstVersion.id, status: "closed" });
    }
  );

  it("deduplicates requirements linked to the same version multiple times", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = createProject(store, "Deduplicated history", "/tmp/deduplicated-history");
    const firstVersion = createVersion(store, project.id, "1.0.0", "/tmp/deduplicated-history-v1");
    const secondVersion = createVersion(store, project.id, "2.0.0", "/tmp/deduplicated-history-v2");
    const requirement = store.createRequirement(requirementInput(project.id, firstVersion.id, "Deduplicated history"));
    for (const projectVersionId of [secondVersion.id, firstVersion.id, secondVersion.id]) {
      store.replaceRequirementProjects(requirement.id, [{
        projectId: project.id, projectVersionId, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
      }]);
    }

    expect(store.listVersionRequirements(firstVersion.id).map((item) => item.id)).toEqual([requirement.id]);
    expect(store.listVersionRequirements(secondVersion.id).map((item) => item.id)).toEqual([requirement.id]);
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
