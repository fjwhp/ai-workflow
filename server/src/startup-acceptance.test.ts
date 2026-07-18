import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];
const runningChildren = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...runningChildren].map(stopChild));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("real server startup acceptance", () => {
  it("backs up incompatible data and serves an empty multi-project-v1 database", { timeout: 15_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workflow-startup-acceptance-"));
    tempDirectories.push(dataDir);
    const databasePath = join(dataDir, "workflow.db");
    const oldBytes = Buffer.from("synthetic incompatible workflow database\n");
    await writeFile(databasePath, oldBytes);
    await writeFile(`${databasePath}.schema-version`, "single-project-v1");
    const port = await reservePort();
    const logs = boundedLogs();
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("server/src/index.ts")], {
      cwd: resolve("."),
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), OPENAI_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    runningChildren.add(child);
    child.stdout?.on("data", logs.append);
    child.stderr?.on("data", logs.append);

    try {
      await waitForHealth(port, child, logs.read);
      await expect(getJson(port, "/api/projects")).resolves.toEqual([]);
      await expect(getJson(port, "/api/requirements")).resolves.toEqual([]);
      const backupNames = (await readdir(dataDir)).filter((name) => /^workflow\.db\.backup-\d{4}-\d{2}-\d{2}T/.test(name) && !name.endsWith("-wal") && !name.endsWith("-shm"));
      expect(backupNames).toHaveLength(1);
      await expect(readFile(join(dataDir, backupNames[0]!))).resolves.toEqual(oldBytes);
      await expect(readFile(`${databasePath}.schema-version`, "utf8")).resolves.toBe("multi-project-v1");
    } finally {
      await stopChild(child);
    }
  });
});

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an ephemeral port");
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return address.port;
}

async function waitForHealth(port: number, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited (${child.exitCode ?? child.signalCode}) before health check passed.\n${logs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Server health check timed out.\n${logs()}`);
}

async function getJson(port: number, path: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

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
