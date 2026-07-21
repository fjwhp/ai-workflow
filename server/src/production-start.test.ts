import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) terminate(child, "SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("production server package runtime", () => {
  it("starts from a clean build through the published shared runtime", { timeout: 45_000 }, async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "flowgate-production-workspace-"));
    directories.push(workspace);
    for (const path of ["package.json", "package-lock.json", "tsconfig.base.json", "shared", "server", "web"]) {
      cpSync(resolve(root, path), resolve(workspace, path), {
        recursive: true,
        filter: (source) => !source.split("/").some((segment) => segment === "dist" || segment === "node_modules")
      });
    }
    await execFileAsync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
      cwd: workspace, timeout: 30_000
    });
    await execFileAsync("npm", ["run", "build"], { cwd: workspace, timeout: 30_000 });
    const dataDir = mkdtempSync(resolve(tmpdir(), "flowgate-production-start-"));
    directories.push(dataDir);
    const child = spawn("npm", ["start", "-w", "server"], {
      cwd: workspace,
      detached: process.platform !== "win32",
      env: { ...process.env, DATA_DIR: dataDir, PORT: "0", AUTOMATION_WORKER_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    const started = await waitForListening(child);
    expect(started.stdout).toContain("FLOWGATE_LISTENING");
    expect(started.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    const sharedPackage = JSON.parse(readFileSync(resolve(workspace, "shared/package.json"), "utf8"));
    expect(sharedPackage.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }
    });
    const { stdout: packedOutput } = await execFileAsync(
      "npm", ["pack", "--dry-run", "--json", "-w", "shared"], { cwd: workspace, timeout: 15_000 }
    );
    const packed = JSON.parse(packedOutput)[0].files.map((file: { path: string }) => file.path);
    expect(packed).toContain("dist/index.js");
    expect(packed).toContain("dist/domain.js");

    terminate(child, "SIGTERM");
    const exit = await waitForExit(child);
    expect(exit.signal === "SIGTERM" || exit.code === 0).toBe(true);
    children.splice(children.indexOf(child), 1);
  });
});

function waitForListening(child: ChildProcess) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`PRODUCTION_START_TIMEOUT\n${stdout}\n${stderr}`)), 10_000);
    const finish = () => {
      if (!stdout.includes("FLOWGATE_LISTENING")) return;
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); finish(); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`PRODUCTION_START_EXITED:${code}:${signal}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("PRODUCTION_STOP_TIMEOUT")), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}
