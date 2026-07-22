import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { codingGitEnvironmentWithFsmonitor, type GitConfigEntry } from "./repository.js";

const COMMIT_ID = /^[0-9a-f]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_CONFLICT_FILES = 1_024;
const MAX_CONFLICT_FILES_BYTES = 262_144;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 250;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const USE_PROCESS_GROUPS = process.platform !== "win32";

const SAFE_GIT_CONFIG: readonly GitConfigEntry[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["credential.helper", ""],
  ["diff.external", ""],
  ["commit.gpgSign", "false"]
];

export interface DeliveryMergeSimulationInput {
  repoPath: string;
  sourceCommit: string;
  preApplyHead: string;
  signal?: AbortSignal;
  deadlineAt: number;
}

export type DeliveryMergeSimulation =
  | { status: "clean"; mergedTree: string; conflictFiles: [] }
  | { status: "conflict"; mergedTree: null; conflictFiles: string[] };

interface GitExecution {
  repoPath: string;
  signal?: AbortSignal;
  deadlineAt: number;
  indexPath?: string;
}

export async function simulateDeliveryMerge(
  input: DeliveryMergeSimulationInput
): Promise<DeliveryMergeSimulation> {
  validateInputShape(input);
  throwIfAborted(input.signal);
  requireRemainingTime(input.deadlineAt);

  const repoPath = await canonicalRepository(input);
  const execution = { repoPath, signal: input.signal, deadlineAt: input.deadlineAt };
  await requireDirectCommit(execution, input.sourceCommit);
  await requireDirectCommit(execution, input.preApplyHead);
  const sourceParent = await resolveSourceParent(execution, input.sourceCommit);
  throwIfAborted(input.signal);
  requireRemainingTime(input.deadlineAt);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "delivery-merge-index-"));
  const isolatedExecution = { ...execution, indexPath: join(temporaryRoot, "index") };
  let primaryError: unknown;
  try {
    await runGit(isolatedExecution, [
      "read-tree", "-m", "--aggressive", sourceParent, input.preApplyHead, input.sourceCommit
    ]);
    const conflictEvidence = await runConflictScan(isolatedExecution, [
      "ls-files", "-u", "-z"
    ]);
    if (conflictEvidence.hasConflicts) {
      return { status: "conflict", mergedTree: null, conflictFiles: conflictEvidence.files };
    }

    const mergedTree = decodeObjectId((await runGit(isolatedExecution, ["write-tree"])).stdout);
    const sourcePaths = new Set(parseNulPaths((await runGit(execution, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames",
      "--no-ext-diff", "--no-textconv", sourceParent, input.sourceCommit
    ])).stdout, "DELIVERY_APPLICATION_SOURCE_PATH_SET_INVALID"));
    const mergedPaths = parseNulPaths((await runGit(execution, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames",
      "--no-ext-diff", "--no-textconv", input.preApplyHead, mergedTree
    ])).stdout, "DELIVERY_APPLICATION_MERGED_PATH_SET_INVALID");
    if (mergedPaths.some((path) => !sourcePaths.has(path))) {
      throw new Error("DELIVERY_APPLICATION_MERGED_PATH_SET_INVALID");
    }
    return { status: "clean", mergedTree, conflictFiles: [] };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupTemporaryRoot(temporaryRoot);
    } catch (cleanupError) {
      if (!primaryError) {
        throw new Error("DELIVERY_APPLICATION_MERGE_CLEANUP_FAILED", { cause: cleanupError });
      }
    }
  }
}

function validateInputShape(input: unknown): asserts input is DeliveryMergeSimulationInput {
  if (!input || typeof input !== "object") invalidInput();
  const value = input as Partial<DeliveryMergeSimulationInput>;
  if (typeof value.repoPath !== "string"
    || !isAbsolute(value.repoPath)
    || value.repoPath.includes("\0")
    || resolve(value.repoPath) !== value.repoPath
    || typeof value.sourceCommit !== "string"
    || !COMMIT_ID.test(value.sourceCommit)
    || typeof value.preApplyHead !== "string"
    || !COMMIT_ID.test(value.preApplyHead)
    || typeof value.deadlineAt !== "number"
    || !Number.isSafeInteger(value.deadlineAt)
    || value.signal !== undefined && !isAbortSignal(value.signal)) {
    invalidInput();
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function invalidInput(): never {
  throw new Error("DELIVERY_APPLICATION_MERGE_INPUT_INVALID");
}

async function canonicalRepository(input: DeliveryMergeSimulationInput) {
  let canonical: string;
  try {
    canonical = await realpath(input.repoPath);
  } catch (error) {
    throw new Error("DELIVERY_APPLICATION_MERGE_INPUT_INVALID", { cause: error });
  }
  if (canonical !== input.repoPath) invalidInput();
  let topLevel: string;
  try {
    topLevel = decodeLine((await runGit({
      repoPath: canonical,
      signal: input.signal,
      deadlineAt: input.deadlineAt
    }, ["rev-parse", "--show-toplevel"])).stdout);
  } catch (error) {
    preserveExecutionError(error);
    throw new Error("DELIVERY_APPLICATION_MERGE_INPUT_INVALID", { cause: error });
  }
  try {
    if (await realpath(topLevel) !== canonical) invalidInput();
  } catch (error) {
    if (error instanceof Error && error.message === "DELIVERY_APPLICATION_MERGE_INPUT_INVALID") throw error;
    throw new Error("DELIVERY_APPLICATION_MERGE_INPUT_INVALID", { cause: error });
  }
  return canonical;
}

async function resolveSourceParent(execution: GitExecution, sourceCommit: string) {
  try {
    return decodeObjectId((await runGit(execution, [
      "rev-parse", "--verify", `${sourceCommit}^`
    ])).stdout);
  } catch (error) {
    preserveExecutionError(error);
    throw new Error("DELIVERY_APPLICATION_SOURCE_PARENT_INVALID", { cause: error });
  }
}

async function requireDirectCommit(execution: GitExecution, commit: string) {
  try {
    const objectType = decodeLine((await runGit(execution, ["cat-file", "-t", commit])).stdout);
    if (objectType !== "commit") throw new Error("DELIVERY_APPLICATION_MERGE_COMMIT_INVALID");
  } catch (error) {
    preserveExecutionError(error);
    if (error instanceof Error && error.message === "DELIVERY_APPLICATION_MERGE_COMMIT_INVALID") throw error;
    throw new Error("DELIVERY_APPLICATION_MERGE_COMMIT_INVALID", { cause: error });
  }
}

function preserveExecutionError(error: unknown): void {
  if (error instanceof Error
    && (error.message === "DELIVERY_APPLICATION_ABORTED"
      || error.message === "DELIVERY_APPLICATION_DEADLINE_EXCEEDED")) {
    throw error;
  }
}

async function runGit(
  execution: GitExecution,
  args: readonly string[]
) {
  throwIfAborted(execution.signal);
  const timeout = Math.min(requireRemainingTime(execution.deadlineAt), GIT_COMMAND_TIMEOUT_MS);
  const result = await spawnGit(execution, args, gitEnvironment(execution), timeout);
  throwIfAborted(execution.signal);
  requireRemainingTime(execution.deadlineAt);
  if (result.outputOverflow || result.error || result.exitCode !== 0) {
    throw new Error("DELIVERY_APPLICATION_MERGE_GIT_FAILED", { cause: result.error });
  }
  return { stdout: Buffer.concat(result.stdout), stderr: Buffer.concat(result.stderr) };
}

function gitEnvironment(execution: GitExecution) {
  const env = codingGitEnvironmentWithFsmonitor(SAFE_GIT_CONFIG);
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.SSH_ASKPASS = "/usr/bin/false";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  if (execution.indexPath) env.GIT_INDEX_FILE = execution.indexPath;
  return env;
}

function spawnGit(
  execution: GitExecution,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<{
  exitCode: number;
  stdout: Buffer[];
  stderr: Buffer[];
  outputOverflow: boolean;
  error?: Error;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", execution.repoPath, ...args], {
      env,
      shell: false,
      detached: USE_PROCESS_GROUPS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputOverflow = false;
    let aborted = false;
    let timedOut = false;
    let terminating = false;
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      spawnError ??= signalGitProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        spawnError ??= signalGitProcess(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT_BYTES - capturedBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        capturedBytes = MAX_GIT_OUTPUT_BYTES;
        outputOverflow = true;
        terminate();
        return;
      }
      target.push(chunk);
      capturedBytes += chunk.length;
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => { spawnError = error; });
    execution.signal?.addEventListener("abort", abort, { once: true });
    if (execution.signal?.aborted) abort();
    child.once("close", (code) => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      execution.signal?.removeEventListener("abort", abort);
      if (aborted) {
        rejectPromise(new Error("DELIVERY_APPLICATION_ABORTED", { cause: execution.signal?.reason }));
        return;
      }
      if (timedOut) {
        rejectPromise(new Error("DELIVERY_APPLICATION_DEADLINE_EXCEEDED"));
        return;
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout,
        stderr,
        outputOverflow,
        ...(spawnError ? { error: spawnError } : {})
      });
    });
  });
}

async function runConflictScan(execution: GitExecution, args: readonly string[]) {
  throwIfAborted(execution.signal);
  const timeout = Math.min(requireRemainingTime(execution.deadlineAt), GIT_COMMAND_TIMEOUT_MS);
  const parser = new ConflictRecordParser();
  const result = await spawnConflictScan(
    execution,
    args,
    gitEnvironment(execution),
    timeout,
    parser
  );
  throwIfAborted(execution.signal);
  requireRemainingTime(execution.deadlineAt);
  if (result.validationError) throw result.validationError;
  if (result.stderrOverflow || result.error) {
    throw new Error("DELIVERY_APPLICATION_MERGE_GIT_FAILED", { cause: result.error });
  }
  if (result.stdoutOverflow) return parser.overflowResult();
  if (result.exitCode !== 0) throw new Error("DELIVERY_APPLICATION_MERGE_GIT_FAILED");
  return parser.finish();
}

function spawnConflictScan(
  execution: GitExecution,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  parser: ConflictRecordParser
): Promise<{
  exitCode: number;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
  validationError?: Error;
  error?: Error;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", execution.repoPath, ...args], {
      env,
      shell: false,
      detached: USE_PROCESS_GROUPS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stderrBytes = 0;
    let stderrOverflow = false;
    let validationError: Error | undefined;
    let aborted = false;
    let timedOut = false;
    let terminating = false;
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      spawnError ??= signalGitProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        spawnError ??= signalGitProcess(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      if (validationError || stdoutOverflow) return;
      const remaining = MAX_GIT_OUTPUT_BYTES - stdoutBytes;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      try {
        if (accepted.length > 0) parser.write(accepted);
      } catch (error) {
        validationError = error instanceof Error
          ? error
          : new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
        terminate();
      }
      stdoutBytes += accepted.length;
      if (chunk.length > remaining) {
        stdoutOverflow = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT_BYTES - stderrBytes;
      if (chunk.length > remaining) {
        stderrBytes = MAX_GIT_OUTPUT_BYTES;
        stderrOverflow = true;
        terminate();
        return;
      }
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => { spawnError = error; });
    execution.signal?.addEventListener("abort", abort, { once: true });
    if (execution.signal?.aborted) abort();
    child.once("close", (code) => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      execution.signal?.removeEventListener("abort", abort);
      if (aborted) {
        rejectPromise(new Error("DELIVERY_APPLICATION_ABORTED", { cause: execution.signal?.reason }));
        return;
      }
      if (timedOut) {
        rejectPromise(new Error("DELIVERY_APPLICATION_DEADLINE_EXCEEDED"));
        return;
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdoutOverflow,
        stderrOverflow,
        ...(validationError ? { validationError } : {}),
        ...(spawnError ? { error: spawnError } : {})
      });
    });
  });
}

function signalGitProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (USE_PROCESS_GROUPS && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        return;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return error instanceof Error ? error : new Error("Git process group termination failed");
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("DELIVERY_APPLICATION_ABORTED", { cause: signal.reason });
}

function requireRemainingTime(deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("DELIVERY_APPLICATION_DEADLINE_EXCEEDED");
  return remaining;
}

function decodeLine(output: Buffer) {
  let value: string;
  try { value = UTF8.decode(output); }
  catch (error) { throw new Error("DELIVERY_APPLICATION_MERGE_GIT_OUTPUT_INVALID", { cause: error }); }
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\0")) {
    throw new Error("DELIVERY_APPLICATION_MERGE_GIT_OUTPUT_INVALID");
  }
  return value.slice(0, -1);
}

function decodeObjectId(output: Buffer) {
  const objectId = decodeLine(output);
  if (!COMMIT_ID.test(objectId)) throw new Error("DELIVERY_APPLICATION_MERGE_GIT_OUTPUT_INVALID");
  return objectId;
}

class ConflictRecordParser {
  private state: "prefix" | "path" = "prefix";
  private readonly prefixBytes: number[] = [];
  private stage = "";
  private decoder: TextDecoder | undefined;
  private pathBytes = 0;
  private segmentBytes = 0;
  private segmentAllDots = true;
  private currentPathChunks: Buffer[] | undefined;
  private hasRecords = false;
  private previousPath: Buffer | undefined;
  private previousStage = "";
  private files: string[] = [];
  private evidenceBytes = 2;

  write(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.state === "prefix") {
        const byte = chunk[offset]!;
        if (byte === 0) conflictEvidenceInvalid();
        if (byte === 0x09) {
          this.startPath();
        } else {
          if (byte > 0x7f || this.prefixBytes.length >= 64) conflictEvidenceInvalid();
          this.prefixBytes.push(byte);
        }
        offset += 1;
        continue;
      }

      const terminator = chunk.indexOf(0, offset);
      const end = terminator < 0 ? chunk.length : terminator;
      if (end > offset) this.consumePath(chunk.subarray(offset, end));
      if (terminator < 0) return;
      this.finishRecord();
      offset = terminator + 1;
    }
  }

  finish() {
    if (this.state !== "prefix" || this.prefixBytes.length !== 0) conflictEvidenceInvalid();
    return {
      hasConflicts: this.hasRecords,
      files: [...this.files]
    };
  }

  overflowResult() {
    return {
      hasConflicts: true,
      files: [...this.files]
    };
  }

  private startPath() {
    const prefix = Buffer.from(this.prefixBytes).toString("ascii");
    const match = /^(?:100644|100755|120000|160000) [0-9a-f]{40} ([123])$/.exec(prefix);
    if (!match) conflictEvidenceInvalid();
    this.state = "path";
    this.stage = match[1]!;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.pathBytes = 0;
    this.segmentBytes = 0;
    this.segmentAllDots = true;
    this.currentPathChunks = [];
  }

  private consumePath(bytes: Buffer) {
    for (const byte of bytes) {
      if (byte === 0x2f) {
        this.validateSegment();
        this.segmentBytes = 0;
        this.segmentAllDots = true;
      } else {
        this.segmentBytes += 1;
        if (byte !== 0x2e) this.segmentAllDots = false;
      }
    }
    this.pathBytes += bytes.length;
    try { this.decoder!.decode(bytes, { stream: true }); }
    catch (error) {
      throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID", { cause: error });
    }
    this.currentPathChunks!.push(Buffer.from(bytes));
  }

  private finishRecord() {
    this.validateSegment();
    try { this.decoder!.decode(); }
    catch (error) {
      throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID", { cause: error });
    }
    this.hasRecords = true;
    const path = Buffer.concat(this.currentPathChunks!, this.pathBytes);
    const comparison = this.previousPath ? Buffer.compare(this.previousPath, path) : -1;
    // `git ls-files -u` emits index order: path first, then ascending stage.
    if (comparison > 0) conflictEvidenceInvalid();
    if (comparison === 0) {
      if (this.stage <= this.previousStage) conflictEvidenceInvalid();
    } else if (path.length <= MAX_CONFLICT_FILES_BYTES) {
      let text: string;
      try { text = UTF8.decode(path); }
      catch (error) {
        throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID", { cause: error });
      }
      this.addEvidence(text);
    }
    this.previousPath = path;
    this.previousStage = this.stage;
    this.state = "prefix";
    this.prefixBytes.length = 0;
    this.stage = "";
    this.decoder = undefined;
    this.currentPathChunks = undefined;
  }

  private validateSegment() {
    if (this.segmentBytes === 0
      || this.segmentAllDots && (this.segmentBytes === 1 || this.segmentBytes === 2)) {
      conflictEvidenceInvalid();
    }
  }

  private addEvidence(path: string) {
    const last = this.files[this.files.length - 1];
    if (last !== undefined && path > last) {
      if (this.files.length >= MAX_CONFLICT_FILES) return;
      const nextBytes = Buffer.byteLength(JSON.stringify(path), "utf8") + 1;
      if (this.evidenceBytes + nextBytes > MAX_CONFLICT_FILES_BYTES) return;
      this.files.push(path);
      this.evidenceBytes += nextBytes;
      return;
    }
    const candidates = [...this.files, path].sort();
    const bounded: string[] = [];
    let bytes = 2;
    for (const candidate of candidates) {
      if (bounded.length >= MAX_CONFLICT_FILES) break;
      const nextBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8")
        + (bounded.length ? 1 : 0);
      if (bytes + nextBytes > MAX_CONFLICT_FILES_BYTES) break;
      bounded.push(candidate);
      bytes += nextBytes;
    }
    this.files = bounded;
    this.evidenceBytes = bytes;
  }
}

function conflictEvidenceInvalid(): never {
  throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
}

function parseNulPaths(output: Buffer, errorCode: string) {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error(errorCode);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of splitNulRecords(output, errorCode)) {
    const path = decodeGitPath(record, errorCode);
    if (seen.has(path)) throw new Error(errorCode);
    seen.add(path);
    paths.push(path);
  }
  return paths.sort();
}

function splitNulRecords(output: Buffer, errorCode: string) {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) throw new Error(errorCode);
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error(errorCode);
  return records;
}

function decodeGitPath(bytes: Buffer, errorCode: string) {
  let path: string;
  try { path = UTF8.decode(bytes); }
  catch (error) { throw new Error(errorCode, { cause: error }); }
  if (!path
    || path.includes("\0")
    || posix.isAbsolute(path)
    || posix.normalize(path) !== path
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(errorCode);
  }
  return path;
}

async function cleanupTemporaryRoot(path: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rm(path, { recursive: true, force: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DELIVERY_APPLICATION_MERGE_CLEANUP_DEADLINE_EXCEEDED")), CLEANUP_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
