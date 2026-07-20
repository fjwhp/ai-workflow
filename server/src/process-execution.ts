import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_LIST_BYTES = 8 * 1024 * 1024;
const LAUNCHCTL_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;
const MANAGED_PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const POLL_MS = 10;

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

interface ManagedProcessDependencies {
  platform?: NodeJS.Platform;
  uid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  listProcesses?: (timeoutMs: number) => Promise<DarwinProcessRow[]>;
  launchctl?: Launchctl;
  coalitionDependencies?: DarwinCoalitionDependencies;
}

type Launchctl = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

export interface DarwinProcessRow {
  pid: number;
  stat: string;
  startedAt: string;
}

export type DarwinPidCoalition =
  | { status: "member"; coalitionId: number }
  | { status: "exited" };

interface DarwinCoalitionDependencies {
  listProcesses: (timeoutMs: number) => Promise<DarwinProcessRow[]>;
  coalitionForPid: (row: DarwinProcessRow, timeoutMs: number) => Promise<DarwinPidCoalition>;
  processExists: (row: DarwinProcessRow, timeoutMs: number) => Promise<boolean>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface DarwinServiceState {
  coalitionId: number;
  state: "running" | "exited";
  exitCode?: number;
}

interface LaunchdProcessPlistInput {
  label: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
}

export async function runManagedProcess(
  file: string,
  args: string[],
  options: ManagedProcessOptions,
  dependencies: ManagedProcessDependencies = {}
): Promise<ManagedProcessResult> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("MANAGED_PROCESS_CONTAINMENT_UNAVAILABLE");
  }
  validateManagedProcessInput(file, args, options);
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("MANAGED_PROCESS_CONTAINMENT_UNAVAILABLE");
  }
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? delay;
  const executionDeadline = now() + options.timeoutMs;
  const executionRemaining = () => deadlineRemaining(
    executionDeadline, now, "MANAGED_PROCESS_DEADLINE_EXCEEDED"
  );
  const listProcesses = dependencies.listProcesses ?? ((timeoutMs) => listDarwinProcesses(uid, timeoutMs));
  const launchctlCommand = dependencies.launchctl ?? defaultLaunchctl;
  const baselineRows = await listProcesses(executionRemaining());
  executionRemaining();
  const baseline = new Map(baselineRows.map((row) => [row.pid, row.startedAt]));
  const controlRoot = await mkdtemp(join(tmpdir(), "ai-workflow-process-"));
  const label = `ai.workflow.process.${process.pid}.${randomUUID().replaceAll("-", "")}`;
  const serviceTarget = `gui/${uid}/${label}`;
  const plistPath = join(controlRoot, "job.plist");
  const configPath = join(controlRoot, "command.json");
  const resultPath = join(controlRoot, "result.json");
  const stdoutPath = join(controlRoot, "stdout");
  const stderrPath = join(controlRoot, "stderr");
  let jobMayExist = false;
  let cleanupAttempted = false;
  let coalitionId: number | undefined;
  let result: ManagedProcessResult | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  const cleanupManagedJob = async () => {
    if (!jobMayExist || cleanupAttempted) return;
    cleanupAttempted = true;
    const cleanupDeadline = now() + MANAGED_PROCESS_CLEANUP_TIMEOUT_MS;
    const cleanupRemaining = () => deadlineRemaining(
      cleanupDeadline, now, "MANAGED_PROCESS_CLEANUP_FAILED"
    );
    const cleanupLaunchctl = async (values: string[]) => {
      try {
        const output = await launchctlCommand(values, cleanupRemaining());
        cleanupRemaining();
        return output;
      } catch (error) {
        cleanupRemaining();
        throw error;
      }
    };
    let containmentError: unknown;
    let bootoutError: unknown;
    if (coalitionId === undefined) {
      try {
        const serviceOutput = (await cleanupLaunchctl(["print", serviceTarget])).stdout;
        const coalition = parseLaunchctlPidCoalition(serviceOutput);
        if (coalition.status === "member") coalitionId = coalition.coalitionId;
      } catch (error) {
        if (launchctlServiceIsAbsent(error)) {
          jobMayExist = false;
          return;
        }
        containmentError = error instanceof Error && error.message === "MANAGED_PROCESS_CLEANUP_FAILED"
          ? error
          : new Error("MANAGED_PROCESS_CLEANUP_DISCOVERY_FAILED", { cause: error });
      }
    }
    if (!containmentError && coalitionId !== undefined) {
      try {
        await terminateDarwinCoalition(
          baseline,
          coalitionId,
          { graceMs: options.termGraceMs ?? 500, deadlineMs: cleanupRemaining() },
          dependencies.coalitionDependencies
            ?? defaultCoalitionDependencies(listProcesses, launchctlCommand, sleep, now)
        );
        coalitionId = undefined;
      } catch (error) {
        containmentError = error;
      }
    }
    try {
      await bootoutAndVerify(serviceTarget, cleanupLaunchctl);
      jobMayExist = false;
    } catch (error) {
      bootoutError = error;
    }
    if (containmentError) throw containmentError;
    if (bootoutError) throw bootoutError;
  };

  try {
    await Promise.all([
      writeFile(stdoutPath, "", { mode: 0o600 }),
      writeFile(stderrPath, "", { mode: 0o600 }),
      writeFile(configPath, JSON.stringify({
        version: 1, file, args, cwd: options.cwd, env: options.env
      }), { mode: 0o600 }),
      writeFile(plistPath, buildLaunchdProcessPlist({
        label, file: process.execPath,
        args: ["--input-type=commonjs", "--eval", managedProcessWrapperSource, configPath, resultPath],
        cwd: controlRoot, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdoutPath, stderrPath
      }), { mode: 0o600 })
    ]);
    const bootstrapTimeoutMs = executionRemaining();
    jobMayExist = true;
    await launchctlCommand(["bootstrap", `gui/${uid}`, plistPath], bootstrapTimeoutMs);

    let exitCode = -1;
    let timedOut = false;
    let outputOverflow = false;
    while (true) {
      if (now() >= executionDeadline) {
        timedOut = true;
        break;
      }
      let serviceOutput: string;
      try {
        serviceOutput = (await launchctlCommand(
          ["print", serviceTarget], executionRemaining()
        )).stdout;
      } catch (error) {
        if (now() >= executionDeadline || processCallTimedOut(error)) {
          timedOut = true;
          break;
        }
        throw error;
      }
      const coalition = parseLaunchctlPidCoalition(serviceOutput);
      if (coalition.status !== "member") throw new Error("MANAGED_PROCESS_SERVICE_INVALID");
      coalitionId = coalition.coalitionId;
      if (now() > executionDeadline) {
        timedOut = true;
        break;
      }
      const completion = await readManagedProcessCompletion(resultPath);
      const sizes = await outputSizes(stdoutPath, stderrPath);
      if (now() > executionDeadline) {
        timedOut = true;
        break;
      }
      if (sizes.stdout + sizes.stderr > options.maxOutputBytes) {
        outputOverflow = true;
        break;
      }
      if (completion) {
        if (completion.error) throw new Error("MANAGED_PROCESS_WRAPPER_FAILED");
        exitCode = completion.exitCode ?? -1;
        break;
      }
      const service = parseLaunchctlService(serviceOutput);
      if (service.state === "exited") throw new Error("MANAGED_PROCESS_WRAPPER_FAILED");
      await sleep(Math.min(POLL_MS, Math.max(0, executionDeadline - now())));
    }

    await cleanupManagedJob();
    const finalSizes = await outputSizes(stdoutPath, stderrPath);
    outputOverflow ||= finalSizes.stdout + finalSizes.stderr > options.maxOutputBytes;
    const output = await readCappedOutput(stdoutPath, stderrPath, options.maxOutputBytes);
    result = { exitCode, ...output, timedOut, outputOverflow };
  } catch (error) {
    primaryError = error;
  } finally {
    if (jobMayExist && !cleanupAttempted) {
      try {
        await cleanupManagedJob();
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await rm(controlRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!result) throw new Error("MANAGED_PROCESS_RESULT_UNAVAILABLE");
  return result;
}

export function parseDarwinProcessRows(stdout: string, uid: number): DarwinProcessRow[] {
  const rows: DarwinProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    if (!match) throw new Error("MANAGED_PROCESS_LIST_INVALID");
    const rowUid = Number(match[1]);
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(rowUid) || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("MANAGED_PROCESS_LIST_INVALID");
    }
    if (rowUid === uid) rows.push({ pid, stat: match[3]!, startedAt: match[4]! });
  }
  return rows;
}

export function darwinProcessCandidates(
  baseline: ReadonlyMap<number, string>,
  rows: DarwinProcessRow[]
) {
  return rows.filter((row) => baseline.get(row.pid) !== row.startedAt);
}

export function parseLaunchctlPidCoalition(stdout: string): DarwinPidCoalition {
  if (/\bproperties\s*=\s*slain\b/.test(stdout)) return { status: "exited" };
  const block = /\bresource coalition\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(stdout)?.[1];
  const id = block && /(?:^|\n)\s*ID\s*=\s*(\d+)\s*(?:\n|$)/.exec(block)?.[1];
  if (!id) throw new Error("MANAGED_PROCESS_COALITION_INVALID");
  const coalitionId = Number(id);
  if (!Number.isSafeInteger(coalitionId) || coalitionId <= 0) {
    throw new Error("MANAGED_PROCESS_COALITION_INVALID");
  }
  return { status: "member", coalitionId };
}

export function parseLaunchctlService(stdout: string): DarwinServiceState {
  const coalition = parseLaunchctlPidCoalition(stdout);
  if (coalition.status !== "member") throw new Error("MANAGED_PROCESS_SERVICE_INVALID");
  const state = /(?:^|\n)\s*state\s*=\s*([^\n]+)\s*(?:\n|$)/.exec(stdout)?.[1]?.trim();
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/.exec(stdout)?.[1];
  const rawExitCode = /(?:^|\n)\s*last exit code\s*=\s*([^\n]+)\s*(?:\n|$)/.exec(stdout)?.[1]?.trim();
  const lastExitReason = /(?:^|\n)\s*last exit reason\s*=\s*([^\n]+)\s*(?:\n|$)/.exec(stdout)?.[1]?.trim();
  if (state === "not running" && lastExitReason) {
    return { coalitionId: coalition.coalitionId, state: "exited" };
  }
  if (pid || rawExitCode === "(never exited)" || (state === "not running" && rawExitCode === undefined)) {
    return { coalitionId: coalition.coalitionId, state: "running" };
  }
  if (rawExitCode && /^-?\d+$/.test(rawExitCode)) {
    const exitCode = Number(rawExitCode);
    if (Number.isSafeInteger(exitCode)) {
      return { coalitionId: coalition.coalitionId, state: "exited", exitCode };
    }
  }
  throw new Error("MANAGED_PROCESS_SERVICE_INVALID");
}

export function buildLaunchdProcessPlist(input: LaunchdProcessPlistInput) {
  const string = (value: string) => `<string>${xmlValue(value)}</string>`;
  const environment = Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `      <key>${xmlValue(key)}</key>\n      ${string(value)}`)
    .join("\n");
  const argumentsXml = [input.file, ...input.args].map((value) => `      ${string(value)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(input.label)}
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    ${string(input.cwd)}
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>StandardOutPath</key>
    ${string(input.stdoutPath)}
    <key>StandardErrorPath</key>
    ${string(input.stderrPath)}
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>
`;
}

async function readManagedProcessCompletion(resultPath: string) {
  let status;
  try {
    status = await lstat(resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("MANAGED_PROCESS_WRAPPER_FAILED", { cause: error });
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > 4096
    || (status.mode & 0o077) !== 0) throw new Error("MANAGED_PROCESS_WRAPPER_FAILED");
  let value: unknown;
  try { value = JSON.parse(await readFile(resultPath, "utf8")); }
  catch (error) { throw new Error("MANAGED_PROCESS_WRAPPER_FAILED", { cause: error }); }
  if (!value || typeof value !== "object" || (value as any).version !== 1
    || !((Number.isSafeInteger((value as any).exitCode) && (value as any).exitCode >= 0)
      || (value as any).exitCode === null)
    || !((value as any).signal === null || typeof (value as any).signal === "string")
    || ((value as any).error !== undefined && (value as any).error !== "spawn")) {
    throw new Error("MANAGED_PROCESS_WRAPPER_FAILED");
  }
  return value as { version: 1; exitCode: number | null; signal: string | null; error?: "spawn" };
}

export async function terminateDarwinCoalition(
  baseline: ReadonlyMap<number, string>,
  coalitionId: number,
  options: { graceMs: number; deadlineMs: number },
  dependencies: DarwinCoalitionDependencies
) {
  const deadline = dependencies.now() + options.deadlineMs;
  const remaining = () => deadlineRemaining(
    deadline, dependencies.now, "MANAGED_PROCESS_CLEANUP_FAILED"
  );
  const members = async () => {
    const matched: DarwinProcessRow[] = [];
    const rows = await dependencies.listProcesses(remaining());
    remaining();
    for (const row of darwinProcessCandidates(baseline, rows)) {
      let membership: DarwinPidCoalition;
      try {
        membership = await dependencies.coalitionForPid(row, remaining());
        remaining();
      } catch (error) {
        const exists = await dependencies.processExists(row, remaining());
        remaining();
        if (!exists) continue;
        throw new Error("MANAGED_PROCESS_COALITION_QUERY_FAILED", { cause: error });
      }
      if (membership.status === "member" && membership.coalitionId === coalitionId) matched.push(row);
    }
    return matched;
  };
  const signal = async (rows: DarwinProcessRow[], value: NodeJS.Signals) => {
    for (const row of rows) {
      const exists = await dependencies.processExists(row, remaining());
      remaining();
      if (!exists) continue;
      try {
        dependencies.signal(row.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };

  await signal(await members(), "SIGTERM");
  if (options.graceMs > 0) await dependencies.sleep(Math.min(options.graceMs, remaining()));

  let stableStoppedScans = 0;
  let priorStoppedSet = "";
  let zeroScans = 0;
  while (true) {
    remaining();
    const current = await members();
    if (current.length === 0) {
      zeroScans += 1;
      if (zeroScans >= 2) return;
      await dependencies.sleep(Math.min(POLL_MS, remaining()));
      continue;
    }
    zeroScans = 0;
    await signal(current, "SIGSTOP");
    const stopped = current.every((row) => row.stat.startsWith("T"));
    const stoppedSet = current.map((row) => `${row.pid}:${row.startedAt}`).sort().join(",");
    if (stopped && stoppedSet === priorStoppedSet) stableStoppedScans += 1;
    else stableStoppedScans = stopped ? 1 : 0;
    priorStoppedSet = stoppedSet;
    if (stableStoppedScans >= 2) {
      await signal(current, "SIGKILL");
      stableStoppedScans = 0;
      priorStoppedSet = "";
    }
    await dependencies.sleep(Math.min(POLL_MS, remaining()));
  }
}

async function listDarwinProcesses(uid: number, timeoutMs: number) {
  try {
    const output = await execFileAsync("/bin/ps", ["-axo", "uid=,pid=,stat=,lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: PROCESS_LIST_BYTES,
      timeout: Math.min(PROCESS_QUERY_TIMEOUT_MS, timeoutMs)
    });
    return parseDarwinProcessRows(output.stdout, uid);
  } catch (error) {
    if (error instanceof Error && error.message === "MANAGED_PROCESS_LIST_INVALID") throw error;
    throw new Error("MANAGED_PROCESS_ENUMERATION_FAILED", { cause: error });
  }
}

function defaultCoalitionDependencies(
  listProcesses: (timeoutMs: number) => Promise<DarwinProcessRow[]>,
  launchctlCommand: Launchctl,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): DarwinCoalitionDependencies {
  return {
    listProcesses,
    coalitionForPid: async (row, timeoutMs) => parseLaunchctlPidCoalition(
      (await launchctlCommand(["print", `pid/${row.pid}`], timeoutMs)).stdout
    ),
    processExists: async (row, timeoutMs) => (await listProcesses(timeoutMs))
      .some((current) => current.pid === row.pid && current.startedAt === row.startedAt),
    signal: (pid, value) => process.kill(pid, value),
    sleep,
    now
  };
}

async function defaultLaunchctl(args: string[], timeoutMs: number) {
  return execFileAsync("/bin/launchctl", args, {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: LAUNCHCTL_OUTPUT_BYTES,
    timeout: Math.min(LAUNCHCTL_TIMEOUT_MS, timeoutMs)
  });
}

async function bootoutAndVerify(
  serviceTarget: string,
  launchctlCommand: (args: string[]) => Promise<{ stdout: string; stderr: string }>
) {
  try {
    await launchctlCommand(["bootout", "--wait", serviceTarget]);
  } catch (error) {
    try { await requireLaunchctlServiceAbsent(serviceTarget, launchctlCommand); }
    catch { throw new Error("MANAGED_PROCESS_BOOTOUT_FAILED", { cause: error }); }
    return;
  }
  await requireLaunchctlServiceAbsent(serviceTarget, launchctlCommand);
}

async function requireLaunchctlServiceAbsent(
  serviceTarget: string,
  launchctlCommand: (args: string[]) => Promise<{ stdout: string; stderr: string }>
) {
  try {
    await launchctlCommand(["print", serviceTarget]);
  } catch (error) {
    if (launchctlServiceIsAbsent(error)) return;
    throw new Error("MANAGED_PROCESS_BOOTOUT_FAILED", { cause: error });
  }
  throw new Error("MANAGED_PROCESS_BOOTOUT_FAILED");
}

function launchctlErrorText(error: unknown) {
  const value = error as { stdout?: unknown; stderr?: unknown };
  return `${String(value.stdout ?? "")}\n${String(value.stderr ?? "")}`;
}

function launchctlServiceIsAbsent(error: unknown) {
  return launchctlErrorText(error).includes("Could not find service");
}

function processCallTimedOut(error: unknown) {
  return (error as { killed?: unknown }).killed === true;
}

function deadlineRemaining(deadline: number, now: () => number, errorCode: string) {
  const remaining = Math.ceil(deadline - now());
  if (remaining <= 0) throw new Error(errorCode);
  return remaining;
}

async function outputSizes(stdoutPath: string, stderrPath: string) {
  const [stdout, stderr] = await Promise.all([stat(stdoutPath), stat(stderrPath)]);
  return { stdout: stdout.size, stderr: stderr.size };
}

async function readCappedOutput(stdoutPath: string, stderrPath: string, maxBytes: number) {
  const stdout = await readPrefix(stdoutPath, maxBytes);
  const stderr = await readPrefix(stderrPath, Math.max(0, maxBytes - stdout.length));
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
}

async function readPrefix(path: string, bytes: number) {
  if (bytes <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const value = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(value, 0, bytes, 0);
    return value.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function xmlValue(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (!(code === 0x9 || code === 0xa || code === 0xd
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff))) {
      throw new Error("MANAGED_PROCESS_PLIST_VALUE_INVALID");
    }
  }
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validateManagedProcessInput(file: string, args: string[], options: ManagedProcessOptions) {
  if (!file || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")
    || !options.cwd || !options.env || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
    || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0
    || (options.termGraceMs !== undefined
      && (!Number.isSafeInteger(options.termGraceMs) || options.termGraceMs < 0))) {
    throw new Error("MANAGED_PROCESS_INPUT_INVALID");
  }
}

function managedProcessWrapperMain() {
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const configPath = process.argv[1];
  const resultPath = process.argv[2];
  const invalid = () => { throw new Error("MANAGED_PROCESS_WRAPPER_INVALID"); };
  if (typeof configPath !== "string" || typeof resultPath !== "string"
    || !path.isAbsolute(configPath) || !path.isAbsolute(resultPath)
    || path.dirname(configPath) !== path.dirname(resultPath)
    || path.basename(configPath) !== "command.json" || path.basename(resultPath) !== "result.json") invalid();
  const status = fs.lstatSync(configPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > 1024 * 1024
    || (status.mode & 0o077) !== 0) invalid();
  let config: any;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { invalid(); }
  const validString = (value: unknown, maxBytes: number) => typeof value === "string"
    && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= maxBytes;
  if (!config || config.version !== 1
    || !validString(config.file, 16 * 1024) || !path.isAbsolute(config.file)
    || !validString(config.cwd, 16 * 1024) || !path.isAbsolute(config.cwd)
    || !Array.isArray(config.args) || config.args.length > 4096
    || config.args.some((argument: unknown) => !validString(argument, 64 * 1024))
    || !config.env || typeof config.env !== "object" || Array.isArray(config.env)
    || Object.entries(config.env).length > 4096
    || Object.entries(config.env).some(([key, value]) => !validString(key, 4096)
      || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024)) invalid();
  const temporaryResult = `${resultPath}.tmp`;
  let finished = false;
  const writeResult = (result: object) => {
    if (finished) return;
    finished = true;
    fs.writeFileSync(temporaryResult, JSON.stringify(result), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryResult, resultPath);
  };
  const child = childProcess.spawn(
    config.file, config.args,
    { cwd: config.cwd, env: config.env, shell: false, stdio: ["ignore", "inherit", "inherit"] }
  );
  child.once("error", () => {
    writeResult({ version: 1, exitCode: null, signal: null, error: "spawn" });
  });
  child.once("close", (exitCode: number | null, signal: string | null) => {
    writeResult({ version: 1, exitCode, signal });
  });
}

export const managedProcessWrapperSource = `(${managedProcessWrapperMain.toString()})()`;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
