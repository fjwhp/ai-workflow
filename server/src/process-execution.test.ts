import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedProcess } from "./process-execution.js";
import * as processExecution from "./process-execution.js";

const processMocks = vi.hoisted(() => ({
  hiddenProcessScans: 0, processScanError: false, processScanCount: 0,
  execCalls: [] as Array<{ file: string; args: string[]; options: Record<string, any> }>
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: nodePromisify } = await import("node:util");
  const actualExecFileAsync = nodePromisify(actual.execFile);
  const execFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  Object.assign(execFile, actual.execFile);
  (execFile as any)[nodePromisify.custom] = async (...args: any[]) => {
    processMocks.execCalls.push({ file: args[0], args: args[1], options: args[2] });
    if (args[0] === "/bin/ps") processMocks.processScanCount += 1;
    if (args[0] === "/bin/ps" && processMocks.processScanError) {
      throw Object.assign(new Error("process enumeration denied"), { code: "EPERM" });
    }
    if (args[0] === "/bin/ps" && processMocks.processScanCount > 1 && processMocks.hiddenProcessScans > 0) {
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
  processMocks.processScanCount = 0;
  processMocks.execCalls = [];
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
  it.skipIf(process.platform !== "darwin")(
    "removes a new-session descendant that drops the inherited marker after the command succeeds",
    async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-daemon-")); directories.push(directory);
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
      child.unref();
      process.stdout.write(String(child.pid));
    `;

    let pid = 0;
    try {
      const result = await runManagedProcess(process.execPath, ["-e", script], {
        cwd: directory, env: process.env, timeoutMs: 3_000, maxOutputBytes: 1024, termGraceMs: 100
      });
      pid = Number(result.stdout);
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputOverflow: false });
      expect(processIsRunning(pid)).toBe(false);
    } finally {
      if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "isolates concurrent coalitions while removing both unmarked new-session descendants",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "managed-process-concurrent-")); directories.push(directory);
      const script = `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
        child.unref();
        process.stdout.write(String(child.pid));
      `;
      const pids: number[] = [];
      try {
        const results = await Promise.all(["a", "b"].map((name) => runManagedProcess(
          process.execPath, ["-e", script], {
            cwd: directory, env: { PATH: process.env.PATH, PROBE_NAME: name },
            timeoutMs: 3_000, maxOutputBytes: 1024, termGraceMs: 100
          }
        )));
        pids.push(...results.map((result) => Number(result.stdout)));
        expect(results).toEqual([
          expect.objectContaining({ exitCode: 0, timedOut: false, outputOverflow: false }),
          expect.objectContaining({ exitCode: 0, timedOut: false, outputOverflow: false })
        ]);
        expect(pids.every((pid) => !processIsRunning(pid))).toBe(true);
      } finally {
        for (const pid of pids) if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
      }
    }
  );

  it("kills a coalition descendant first discovered after the initial cleanup scan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-process-late-scan-")); directories.push(directory);
    processMocks.hiddenProcessScans = 1;
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

  it("fails closed when Darwin coalition containment is unavailable", async () => {
    await expect(runManagedProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64
    }, { platform: "linux" } as any)).rejects.toThrow("MANAGED_PROCESS_CONTAINMENT_UNAVAILABLE");
  });

  it("does not bootstrap when baseline enumeration consumes the execution deadline", async () => {
    let now = 0;
    const listProcesses = vi.fn(async (timeoutMs: number) => {
      expect(timeoutMs).toBe(1);
      now = 1;
      return [];
    });
    const launchctl = vi.fn();

    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 1, maxOutputBytes: 64
    }, { platform: "darwin", uid: 501, now: () => now, listProcesses, launchctl } as any))
      .rejects.toThrow("MANAGED_PROCESS_DEADLINE_EXCEEDED");
    expect(launchctl).not.toHaveBeenCalled();
  });

  it("uses the independent cleanup budget when bootstrap returns after the deadline", async () => {
    let now = 0;
    let bootedOut = false;
    const service = "pid = 123\nlast exit code = (never exited)\nresource coalition = {\n ID = 77\n }\n";
    const launchctlCalls: Array<{ args: string[]; timeoutMs: number }> = [];
    const launchctl = vi.fn(async (args: string[], timeoutMs: number) => {
      launchctlCalls.push({ args, timeoutMs });
      if (args[0] === "bootstrap") {
        now = 120;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      return { stdout: service, stderr: "" };
    });
    const cleanupList = vi.fn(async () => []);

    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 1, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, now: () => now,
      listProcesses: async () => [], launchctl,
      coalitionDependencies: {
        listProcesses: cleanupList, coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => now
      }
    } as any)).resolves.toMatchObject({ exitCode: -1, timedOut: true, outputOverflow: false });

    expect(launchctlCalls[0]).toMatchObject({ args: ["bootstrap", "gui/501", expect.any(String)], timeoutMs: 1 });
    expect(launchctlCalls[1]).toMatchObject({ args: ["print", expect.any(String)], timeoutMs: 10_000 });
    expect(launchctlCalls.some(({ args }) => args[0] === "bootout")).toBe(true);
    expect(launchctlCalls.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 10_000)).toBe(true);
    expect(cleanupList).toHaveBeenCalled();
  });

  it("fails closed without starting another cleanup call after the cleanup budget expires", async () => {
    let now = 0;
    const service = "pid = 123\nlast exit code = (never exited)\nresource coalition = {\n ID = 77\n }\n";
    const launchctlCalls: Array<{ args: string[]; timeoutMs: number }> = [];
    const launchctl = vi.fn(async (args: string[], timeoutMs: number) => {
      launchctlCalls.push({ args, timeoutMs });
      if (args[0] === "bootstrap") {
        now = 120;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "print") {
        now = 10_120;
        return { stdout: service, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 1, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, now: () => now,
      listProcesses: async () => [], launchctl,
      coalitionDependencies: {
        listProcesses: async () => [], coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => now
      }
    } as any)).rejects.toThrow("MANAGED_PROCESS_CLEANUP_FAILED");

    expect(launchctlCalls).toHaveLength(2);
    expect(launchctlCalls.every(({ timeoutMs }) => timeoutMs > 0)).toBe(true);
  });

  it("treats an execution status timeout as timed out and still cleans the registered job", async () => {
    let now = 0;
    let bootedOut = false;
    let servicePrints = 0;
    const service = "pid = 123\nlast exit code = (never exited)\nresource coalition = {\n ID = 77\n }\n";
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "bootstrap") return { stdout: "", stderr: "" };
      if (args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      servicePrints += 1;
      if (servicePrints === 1) {
        now = 1;
        throw Object.assign(new Error("status deadline"), {
          killed: true, signal: "SIGTERM", stdout: "", stderr: ""
        });
      }
      return { stdout: service, stderr: "" };
    });
    const cleanupList = vi.fn(async () => []);

    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 1, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, now: () => now,
      listProcesses: async () => [], launchctl,
      coalitionDependencies: {
        listProcesses: cleanupList, coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => now
      }
    } as any)).resolves.toMatchObject({ exitCode: -1, timedOut: true, outputOverflow: false });

    expect(servicePrints).toBe(2);
    expect(cleanupList).toHaveBeenCalled();
    expect(launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(true);
  });

  it("fails closed on a status signal before the deadline while still cleaning the job", async () => {
    let bootedOut = false;
    let servicePrints = 0;
    const service = "pid = 123\nlast exit code = (never exited)\nresource coalition = {\n ID = 77\n }\n";
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "bootstrap") return { stdout: "", stderr: "" };
      if (args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      servicePrints += 1;
      if (servicePrints === 1) {
        throw Object.assign(new Error("status externally signaled"), {
          killed: false, signal: "SIGTERM", stdout: "", stderr: ""
        });
      }
      return { stdout: service, stderr: "" };
    });

    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, now: () => 0,
      listProcesses: async () => [], launchctl,
      coalitionDependencies: {
        listProcesses: async () => [], coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => 0
      }
    } as any)).rejects.toThrow("status externally signaled");

    expect(servicePrints).toBe(2);
    expect(launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "bounds fixed-locale process and launchctl queries",
    async () => {
      await runManagedProcess("/bin/echo", [], {
        cwd: "/tmp", env: {}, timeoutMs: 1_000, maxOutputBytes: 64, termGraceMs: 0
      });
      const ps = processMocks.execCalls.find((call) => call.file === "/bin/ps")!;
      const launchctl = processMocks.execCalls.find((call) => call.file === "/bin/launchctl")!;
      expect(ps.args).toEqual(["-axo", "uid=,pid=,stat=,lstart="]);
      expect(ps.options).toMatchObject({ timeout: expect.any(Number), env: { LC_ALL: "C" } });
      expect(launchctl.options).toMatchObject({ timeout: expect.any(Number), env: { LC_ALL: "C" } });
    }
  );

  it("removes its control directory when launchd bootstrap fails", async () => {
    let controlRoot = "";
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "bootstrap") {
        controlRoot = dirname(args[2]!);
        throw new Error("bootstrap denied");
      }
      throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
    });
    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64
    }, {
      platform: "darwin", uid: 501, listProcesses: async () => [], launchctl
    } as any)).rejects.toThrow("bootstrap denied");
    expect(controlRoot).not.toBe("");
    expect(existsSync(controlRoot)).toBe(false);
  });

  it("cleans a registered service when bootstrap reports an ambiguous failure", async () => {
    const service = "pid = 123\nlast exit code = (never exited)\nresource coalition = {\n ID = 77\n }\n";
    let bootedOut = false;
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "bootstrap") throw new Error("bootstrap transport failed");
      if (args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      return { stdout: service, stderr: "" };
    });
    const listProcesses = vi.fn(async () => []);
    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, listProcesses, launchctl,
      coalitionDependencies: {
        listProcesses, coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => 0
      }
    } as any)).rejects.toThrow("bootstrap transport failed");
    expect(listProcesses).toHaveBeenCalledTimes(4);
    expect(launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(true);
  });

  it("cleans the known coalition and boots out after an invalid service state", async () => {
    const service = "state = mystery\nresource coalition = {\n ID = 77\n }\n";
    const calls: string[][] = [];
    let bootedOut = false;
    const launchctl = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "bootout") bootedOut = true;
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      if (args[0] === "print") return { stdout: service, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const listProcesses = vi.fn(async () => []);
    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, listProcesses, launchctl,
      coalitionDependencies: {
        listProcesses, coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => 0
      }
    } as any)).rejects.toThrow("MANAGED_PROCESS_SERVICE_INVALID");
    expect(listProcesses).toHaveBeenCalledTimes(4);
    expect(calls.some((args) => args[0] === "bootout")).toBe(true);
  });

  it("fails closed when service absence cannot be distinguished from a print error", async () => {
    const service = "state = not running\nlast exit code = 0\nresource coalition = {\n ID = 77\n }\n";
    let servicePrints = 0;
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "print") {
        servicePrints += 1;
        if (servicePrints === 1) return { stdout: service, stderr: "" };
        throw Object.assign(new Error("print denied"), { stderr: "Operation not permitted" });
      }
      return { stdout: "", stderr: "" };
    });
    const listProcesses = vi.fn(async () => []);
    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, listProcesses, launchctl,
      coalitionDependencies: {
        listProcesses, coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => 0
      }
    } as any)).rejects.toThrow("MANAGED_PROCESS_BOOTOUT_FAILED");
  });

  it("lets cleanup failure override a successful command while still booting out", async () => {
    const service = "state = not running\nlast exit code = 0\nresource coalition = {\n ID = 77\n }\n";
    let bootedOut = false;
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] === "bootout") bootedOut = true;
      if (args[0] === "print" && bootedOut) {
        throw Object.assign(new Error("absent"), { stderr: "Could not find service" });
      }
      if (args[0] === "print") return { stdout: service, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await expect(runManagedProcess("/bin/echo", [], {
      cwd: "/tmp", env: {}, timeoutMs: 100, maxOutputBytes: 64, termGraceMs: 0
    }, {
      platform: "darwin", uid: 501, listProcesses: async () => [], launchctl,
      coalitionDependencies: {
        listProcesses: async () => { throw new Error("cleanup scan failed"); },
        coalitionForPid: vi.fn(), processExists: vi.fn(), signal: vi.fn(),
        sleep: async () => {}, now: () => 0
      }
    } as any)).rejects.toThrow("cleanup scan failed");
    expect(launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(true);
  });
});

describe("Darwin coalition containment", () => {
  it("detects new PIDs and same-PID reuse from the frozen kernel start time", () => {
    const candidates = (processExecution as any).darwinProcessCandidates;
    expect(candidates).toBeTypeOf("function");
    const baseline = new Map([[101, "Mon Jul 20 00:00:00 2026"], [202, "Mon Jul 20 00:00:01 2026"]]);
    expect(candidates(baseline, [
      { pid: 101, stat: "S", startedAt: "Mon Jul 20 00:00:02 2026" },
      { pid: 202, stat: "S", startedAt: "Mon Jul 20 00:00:01 2026" },
      { pid: 303, stat: "S", startedAt: "Mon Jul 20 00:00:03 2026" }
    ])).toEqual([
      { pid: 101, stat: "S", startedAt: "Mon Jul 20 00:00:02 2026" },
      { pid: 303, stat: "S", startedAt: "Mon Jul 20 00:00:03 2026" }
    ]);
  });

  it("parses fixed-locale ps rows and fails closed on malformed output", () => {
    const parse = (processExecution as any).parseDarwinProcessRows;
    expect(parse).toBeTypeOf("function");
    expect(parse("  501  123 S    Mon Jul 20 00:00:00 2026    \n", 501)).toEqual([
      { pid: 123, stat: "S", startedAt: "Mon Jul 20 00:00:00 2026" }
    ]);
    expect(() => parse("unexpected\n", 501)).toThrow("MANAGED_PROCESS_LIST_INVALID");
  });

  it("distinguishes a coalition member, an exited PID, and unknown launchctl output", () => {
    const parse = (processExecution as any).parseLaunchctlPidCoalition;
    expect(parse).toBeTypeOf("function");
    expect(parse("pid/123 = {\n resource coalition = {\n ID = 77\n }\n}"))
      .toEqual({ status: "member", coalitionId: 77 });
    expect(parse("pid/123 = {\n properties = slain\n}"))
      .toEqual({ status: "exited" });
    expect(() => parse("pid/123 = { active count = 1 }")).toThrow("MANAGED_PROCESS_COALITION_INVALID");
  });

  it("derives service liveness from pid and exit fields across launchd transition states", () => {
    const parse = (processExecution as any).parseLaunchctlService;
    expect(parse).toBeTypeOf("function");
    const coalition = "resource coalition = {\n ID = 77\n }";
    expect(parse(`state = xpcproxy\npid = 123\nlast exit code = (never exited)\n${coalition}`))
      .toEqual({ coalitionId: 77, state: "running" });
    expect(parse(`state = not running\nlast exit code = 9\n${coalition}`))
      .toEqual({ coalitionId: 77, state: "exited", exitCode: 9 });
    expect(() => parse(`state = mystery\n${coalition}`)).toThrow("MANAGED_PROCESS_SERVICE_INVALID");
  });

  it("escapes every structured plist value and rejects XML control characters", () => {
    const build = (processExecution as any).buildLaunchdProcessPlist;
    expect(build).toBeTypeOf("function");
    const plist = build({
      label: "ai.workflow.test", file: "/bin/echo", args: ["<&\""], cwd: "/tmp/<work>",
      env: { SAFE: "<&\"" }, stdoutPath: "/tmp/out", stderrPath: "/tmp/err"
    });
    expect(plist).toContain("&lt;&amp;\"");
    expect(plist).not.toContain("<string><&");
    expect(() => build({
      label: "ai.workflow.test", file: "/bin/echo", args: ["bad\u0001"], cwd: "/tmp",
      env: {}, stdoutPath: "/tmp/out", stderrPath: "/tmp/err"
    })).toThrow("MANAGED_PROCESS_PLIST_VALUE_INVALID");
  });

  it("fails closed on a live candidate coalition query error without signaling it", async () => {
    const terminate = (processExecution as any).terminateDarwinCoalition;
    expect(terminate).toBeTypeOf("function");
    const signal = vi.fn();
    const row = { pid: 303, stat: "S", startedAt: "Mon Jul 20 00:00:03 2026" };
    await expect(terminate(new Map(), 77, { graceMs: 0, deadlineMs: 1_000 }, {
      listProcesses: async () => [row],
      coalitionForPid: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
      processExists: async () => true,
      signal,
      sleep: async () => {},
      now: () => 0
    })).rejects.toThrow("MANAGED_PROCESS_COALITION_QUERY_FAILED");
    expect(signal).not.toHaveBeenCalled();
  });

  it("fails when the stable zero-member proof completes at the cleanup deadline", async () => {
    const terminate = (processExecution as any).terminateDarwinCoalition;
    let now = 0;
    let scans = 0;
    await expect(terminate(new Map(), 77, { graceMs: 0, deadlineMs: 1_000 }, {
      listProcesses: async () => {
        scans += 1;
        if (scans === 3) now = 1_000;
        return [];
      },
      coalitionForPid: vi.fn(),
      processExists: vi.fn(),
      signal: vi.fn(),
      sleep: async () => {},
      now: () => now
    })).rejects.toThrow("MANAGED_PROCESS_CLEANUP_FAILED");
    expect(scans).toBe(3);
  });

  it("signals only the exact coalition and requires stable stopped scans before kill", async () => {
    const terminate = (processExecution as any).terminateDarwinCoalition;
    expect(terminate).toBeTypeOf("function");
    const rows = new Map([
      [303, { pid: 303, stat: "S", startedAt: "Mon Jul 20 00:00:03 2026", coalition: 77 }],
      [404, { pid: 404, stat: "S", startedAt: "Mon Jul 20 00:00:04 2026", coalition: 88 }]
    ]);
    const calls: Array<[number, NodeJS.Signals]> = [];
    await terminate(new Map(), 77, { graceMs: 0, deadlineMs: 1_000 }, {
      listProcesses: async () => [...rows.values()].map(({ coalition: _coalition, ...row }) => row),
      coalitionForPid: async (row: { pid: number }) => {
        const value = rows.get(row.pid);
        return value ? { status: "member", coalitionId: value.coalition } : { status: "exited" };
      },
      processExists: async (row: { pid: number }) => rows.has(row.pid),
      signal: (pid: number, value: NodeJS.Signals) => {
        calls.push([pid, value]);
        if (value === "SIGSTOP") rows.get(pid)!.stat = "T";
        if (value === "SIGKILL") rows.delete(pid);
      },
      sleep: async () => {},
      now: () => 0
    });
    expect(calls.filter(([pid]) => pid === 404)).toEqual([]);
    expect(calls.filter(([pid, signal]) => pid === 303 && signal === "SIGSTOP").length)
      .toBeGreaterThanOrEqual(2);
    expect(calls).toContainEqual([303, "SIGKILL"]);
  });
});
