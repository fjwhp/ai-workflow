import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_TOKEN = "AI_WORKFLOW_PROCESS_TOKEN";

export interface ManagedProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  termGraceMs?: number;
}

export interface ManagedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
}

export async function runManagedProcess(
  file: string,
  args: string[],
  options: ManagedProcessOptions
): Promise<ManagedProcessResult> {
  const token = randomUUID();
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...options.env, [PROCESS_TOKEN]: token },
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputOverflow = false;
  let termination: Promise<void> | undefined;
  const stop = () => {
    termination ??= terminateExecutionDomain(child.pid, token, options.termGraceMs ?? 500);
  };
  const collect = (destination: Buffer[], value: Buffer) => {
    const remaining = Math.max(0, options.maxOutputBytes - outputBytes);
    if (remaining > 0) destination.push(value.subarray(0, remaining));
    outputBytes += Math.min(value.length, remaining);
    if (value.length > remaining) {
      outputOverflow = true;
      stop();
    }
  };
  child.stdout.on("data", (value: Buffer) => collect(stdout, value));
  child.stderr.on("data", (value: Buffer) => collect(stderr, value));
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  timeout.unref();
  let exitCode = -1;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
  } finally {
    clearTimeout(timeout);
    try {
      stop();
      await termination;
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
  return {
    exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    timedOut, outputOverflow
  };
}

async function terminateExecutionDomain(groupLeader: number | undefined, token: string, graceMs: number) {
  let enumerationError: unknown;
  signalGroup(groupLeader, "SIGTERM");
  try { await signalTaggedProcesses(token, "SIGTERM"); }
  catch (error) { enumerationError = error; }
  await delay(graceMs);
  signalGroup(groupLeader, "SIGKILL");
  try { await signalTaggedProcesses(token, "SIGKILL"); }
  catch (error) { enumerationError ??= error; }
  if (enumerationError) throw new Error("MANAGED_PROCESS_ENUMERATION_FAILED", { cause: enumerationError });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await signalTaggedProcesses(token, "SIGKILL") === 0) return;
    await delay(25);
  }
  throw new Error("MANAGED_PROCESS_CLEANUP_FAILED");
}

function signalGroup(groupLeader: number | undefined, signal: NodeJS.Signals) {
  if (!groupLeader || process.platform === "win32") return;
  try { process.kill(-groupLeader, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function signalTaggedProcesses(token: string, signal: NodeJS.Signals) {
  const pids = await taggedProcessIds(token);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try { process.kill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  return pids.length;
}

async function taggedProcessIds(token: string) {
  if (process.platform === "win32") return [];
  const stdout = (await execFileAsync("/bin/ps", ["eww", "-axo", "pid=,command="], {
    maxBuffer: 8 * 1024 * 1024
  })).stdout;
  const marker = `${PROCESS_TOKEN}=${token}`;
  return stdout.split("\n").flatMap((line) => {
    if (!line.includes(marker)) return [];
    const match = /^\s*(\d+)\s/.exec(line);
    return match ? [Number(match[1])] : [];
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
