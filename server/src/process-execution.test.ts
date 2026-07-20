import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedProcess } from "./process-execution.js";

const processMocks = vi.hoisted(() => ({ hiddenProcessScans: 0, processScanError: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: nodePromisify } = await import("node:util");
  const actualExecFileAsync = nodePromisify(actual.execFile);
  const execFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  Object.assign(execFile, actual.execFile);
  (execFile as any)[nodePromisify.custom] = async (...args: any[]) => {
    if (args[0] === "/bin/ps" && processMocks.processScanError) {
      throw Object.assign(new Error("process enumeration denied"), { code: "EPERM" });
    }
    if (args[0] === "/bin/ps" && processMocks.hiddenProcessScans > 0) {
      processMocks.hiddenProcessScans -= 1;
      return { stdout: "", stderr: "" };
    }
    return actualExecFileAsync(...args as Parameters<typeof actualExecFileAsync>);
  };
  return { ...actual, execFile };
});

const directories: string[] = [];
afterEach(() => {
  processMocks.hiddenProcessScans = 0;
  processMocks.processScanError = false;
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function processIsRunning(pid: number) {
  try {
    const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Boolean(state) && !state.startsWith("Z");
  }
  catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

describe("runManagedProcess", () => {
  it("removes a detached closed-stdio descendant after the command succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-daemon-")); directories.push(directory);
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      process.stdout.write(String(child.pid));
    `;

    const result = await runManagedProcess(process.execPath, ["-e", script], {
      cwd: directory, env: process.env, timeoutMs: 3_000, maxOutputBytes: 1024, termGraceMs: 100
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputOverflow: false });
    expect(processIsRunning(Number(result.stdout))).toBe(false);
  });

  it("kills a tagged descendant first discovered after the initial KILL scan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-late-scan-")); directories.push(directory);
    processMocks.hiddenProcessScans = 2;
    const result = await runManagedProcess(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      process.stdout.write(String(child.pid));
    `], {
      cwd: directory, env: process.env, timeoutMs: 3_000, maxOutputBytes: 1024, termGraceMs: 10
    });
    const pid = Number(result.stdout);
    try {
      expect(processIsRunning(pid)).toBe(false);
    } finally {
      if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("fails closed when tagged descendant enumeration is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-enumeration-")); directories.push(directory);
    processMocks.processScanError = true;

    await expect(runManagedProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: directory, env: process.env, timeoutMs: 3_000, maxOutputBytes: 1024, termGraceMs: 10
    })).rejects.toThrow("MANAGED_PROCESS_ENUMERATION_FAILED");
  });

  it("escalates from TERM to KILL when the command ignores termination", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-timeout-")); directories.push(directory);
    const result = await runManagedProcess(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `], {
      cwd: directory, env: process.env, timeoutMs: 100, maxOutputBytes: 1024, termGraceMs: 100
    });

    expect(result).toMatchObject({ timedOut: true, outputOverflow: false });
  });

  it("kills the execution domain when combined output exceeds the cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-output-")); directories.push(directory);
    const result = await runManagedProcess(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      console.log(process.pid);
      process.stdout.write("x".repeat(4096));
      setInterval(() => {}, 1000);
    `], {
      cwd: directory, env: process.env, timeoutMs: 3_000, maxOutputBytes: 256, termGraceMs: 100
    });

    expect(result).toMatchObject({ timedOut: false, outputOverflow: true });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256);
    expect(processIsRunning(Number(result.stdout.split("\n", 1)[0]))).toBe(false);
  });
});
