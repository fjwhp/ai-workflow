import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_LIST_BYTES = 8 * 1024 * 1024;
const LAUNCHCTL_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;
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
  listProcesses?: () => Promise<DarwinProcessRow[]>;
  launchctl?: Launchctl;
  coalitionDependencies?: DarwinCoalitionDependencies;
}

type Launchctl = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DarwinProcessRow {
  pid: number;
  stat: string;
  startedAt: string;
}

export type DarwinPidCoalition =
  | { status: "member"; coalitionId: number }
  | { status: "exited" };

interface DarwinCoalitionDependencies {
  listProcesses: () => Promise<DarwinProcessRow[]>;
  coalitionForPid: (row: DarwinProcessRow) => Promise<DarwinPidCoalition>;
  processExists: (row: DarwinProcessRow) => Promise<boolean>;
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
  const listProcesses = dependencies.listProcesses ?? (() => listDarwinProcesses(uid));
  const launchctlCommand = dependencies.launchctl ?? defaultLaunchctl;
  const baselineRows = await listProcesses();
  const baseline = new Map(baselineRows.map((row) => [row.pid, row.startedAt]));
  const controlRoot = await mkdtemp(join(tmpdir(), "ai-workflow-process-"));
  const label = `ai.workflow.process.${process.pid}.${randomUUID().replaceAll("-", "")}`;
  const serviceTarget = `gui/${uid}/${label}`;
  const plistPath = join(controlRoot, "job.plist");
  const stdoutPath = join(controlRoot, "stdout");
  const stderrPath = join(controlRoot, "stderr");
  const executionDeadline = now() + options.timeoutMs;
  let bootstrapped = false;
  let coalitionId: number | undefined;
  let result: ManagedProcessResult | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    await Promise.all([
      writeFile(stdoutPath, "", { mode: 0o600 }),
      writeFile(stderrPath, "", { mode: 0o600 }),
      writeFile(plistPath, buildLaunchdProcessPlist({
        label, file, args, cwd: options.cwd, env: options.env, stdoutPath, stderrPath
      }), { mode: 0o600 })
    ]);
    try {
      await launchctlCommand(["bootstrap", `gui/${uid}`, plistPath]);
      bootstrapped = true;
    } catch (bootstrapError) {
      try {
        const serviceOutput = (await launchctlCommand(["print", serviceTarget])).stdout;
        bootstrapped = true;
        const coalition = parseLaunchctlPidCoalition(serviceOutput);
        if (coalition.status === "member") coalitionId = coalition.coalitionId;
      } catch (probeError) {
        if (launchctlServiceIsAbsent(probeError)) throw bootstrapError;
        bootstrapped = true;
        throw new Error("MANAGED_PROCESS_BOOTSTRAP_STATE_UNKNOWN", { cause: probeError });
      }
      throw bootstrapError;
    }

    let exitCode = -1;
    let timedOut = false;
    let outputOverflow = false;
    while (true) {
      const serviceOutput = (await launchctlCommand(["print", serviceTarget])).stdout;
      const coalition = parseLaunchctlPidCoalition(serviceOutput);
      if (coalition.status !== "member") throw new Error("MANAGED_PROCESS_SERVICE_INVALID");
      coalitionId = coalition.coalitionId;
      const service = parseLaunchctlService(serviceOutput);
      const sizes = await outputSizes(stdoutPath, stderrPath);
      if (sizes.stdout + sizes.stderr > options.maxOutputBytes) {
        outputOverflow = true;
        break;
      }
      if (service.state === "exited") {
        exitCode = service.exitCode ?? -1;
        break;
      }
      if (now() >= executionDeadline) {
        timedOut = true;
        break;
      }
      await sleep(Math.min(POLL_MS, Math.max(0, executionDeadline - now())));
    }

    if (coalitionId === undefined) throw new Error("MANAGED_PROCESS_COALITION_INVALID");
    await terminateDarwinCoalition(
      baseline,
      coalitionId,
      { graceMs: options.termGraceMs ?? 500, deadlineMs: Math.max(2_000, (options.termGraceMs ?? 500) + 1_000) },
      dependencies.coalitionDependencies
        ?? defaultCoalitionDependencies(listProcesses, launchctlCommand, sleep, now)
    );
    coalitionId = undefined;
    const finalSizes = await outputSizes(stdoutPath, stderrPath);
    outputOverflow ||= finalSizes.stdout + finalSizes.stderr > options.maxOutputBytes;
    const output = await readCappedOutput(stdoutPath, stderrPath, options.maxOutputBytes);
    result = { exitCode, ...output, timedOut, outputOverflow };
  } catch (error) {
    primaryError = error;
  } finally {
    if (coalitionId !== undefined) {
      try {
        await terminateDarwinCoalition(
          baseline,
          coalitionId,
          { graceMs: options.termGraceMs ?? 500, deadlineMs: Math.max(2_000, (options.termGraceMs ?? 500) + 1_000) },
          dependencies.coalitionDependencies
            ?? defaultCoalitionDependencies(listProcesses, launchctlCommand, sleep, now)
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (bootstrapped) {
      try {
        await bootoutAndVerify(serviceTarget, launchctlCommand);
      } catch (error) {
        cleanupError ??= error;
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
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/.exec(stdout)?.[1];
  const rawExitCode = /(?:^|\n)\s*last exit code\s*=\s*([^\n]+)\s*(?:\n|$)/.exec(stdout)?.[1]?.trim();
  if (pid || rawExitCode === "(never exited)") {
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

export async function terminateDarwinCoalition(
  baseline: ReadonlyMap<number, string>,
  coalitionId: number,
  options: { graceMs: number; deadlineMs: number },
  dependencies: DarwinCoalitionDependencies
) {
  const deadline = dependencies.now() + options.deadlineMs;
  const assertBeforeDeadline = () => {
    if (dependencies.now() > deadline) throw new Error("MANAGED_PROCESS_CLEANUP_FAILED");
  };
  const members = async () => {
    assertBeforeDeadline();
    const matched: DarwinProcessRow[] = [];
    for (const row of darwinProcessCandidates(baseline, await dependencies.listProcesses())) {
      let membership: DarwinPidCoalition;
      try {
        membership = await dependencies.coalitionForPid(row);
      } catch (error) {
        if (!(await dependencies.processExists(row))) continue;
        throw new Error("MANAGED_PROCESS_COALITION_QUERY_FAILED", { cause: error });
      }
      if (membership.status === "member" && membership.coalitionId === coalitionId) matched.push(row);
    }
    return matched;
  };
  const signal = async (rows: DarwinProcessRow[], value: NodeJS.Signals) => {
    for (const row of rows) {
      if (!(await dependencies.processExists(row))) continue;
      try {
        dependencies.signal(row.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };

  await signal(await members(), "SIGTERM");
  if (options.graceMs > 0) await dependencies.sleep(options.graceMs);

  let stableStoppedScans = 0;
  let priorStoppedSet = "";
  let zeroScans = 0;
  while (true) {
    assertBeforeDeadline();
    const current = await members();
    if (current.length === 0) {
      zeroScans += 1;
      if (zeroScans >= 2) return;
      await dependencies.sleep(POLL_MS);
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
    await dependencies.sleep(POLL_MS);
  }
}

async function listDarwinProcesses(uid: number) {
  try {
    const output = await execFileAsync("/bin/ps", ["-axo", "uid=,pid=,stat=,lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: PROCESS_LIST_BYTES,
      timeout: PROCESS_QUERY_TIMEOUT_MS
    });
    return parseDarwinProcessRows(output.stdout, uid);
  } catch (error) {
    if (error instanceof Error && error.message === "MANAGED_PROCESS_LIST_INVALID") throw error;
    throw new Error("MANAGED_PROCESS_ENUMERATION_FAILED", { cause: error });
  }
}

function defaultCoalitionDependencies(
  listProcesses: () => Promise<DarwinProcessRow[]>,
  launchctlCommand: Launchctl,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): DarwinCoalitionDependencies {
  return {
    listProcesses,
    coalitionForPid: async (row) => parseLaunchctlPidCoalition(
      (await launchctlCommand(["print", `pid/${row.pid}`])).stdout
    ),
    processExists: async (row) => (await listProcesses())
      .some((current) => current.pid === row.pid && current.startedAt === row.startedAt),
    signal: (pid, value) => process.kill(pid, value),
    sleep,
    now
  };
}

async function defaultLaunchctl(args: string[]) {
  return execFileAsync("/bin/launchctl", args, {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: LAUNCHCTL_OUTPUT_BYTES,
    timeout: LAUNCHCTL_TIMEOUT_MS
  });
}

async function bootoutAndVerify(serviceTarget: string, launchctlCommand: Launchctl) {
  try {
    await launchctlCommand(["bootout", "--wait", serviceTarget]);
  } catch (error) {
    try { await requireLaunchctlServiceAbsent(serviceTarget, launchctlCommand); }
    catch { throw new Error("MANAGED_PROCESS_BOOTOUT_FAILED", { cause: error }); }
    return;
  }
  await requireLaunchctlServiceAbsent(serviceTarget, launchctlCommand);
}

async function requireLaunchctlServiceAbsent(serviceTarget: string, launchctlCommand: Launchctl) {
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
