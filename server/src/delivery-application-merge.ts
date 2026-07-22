import { spawn } from "node:child_process";
import { mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { codingGitEnvironmentWithFsmonitor, type GitConfigEntry } from "./repository.js";

const COMMIT_ID = /^[0-9a-f]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_CONFLICT_FILES = 1_024;
const MAX_CONFLICT_FILES_BYTES = 262_144;
const PATH_COMPARE_CHUNK_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 250;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

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
      "read-tree", "-m", sourceParent, input.preApplyHead, input.sourceCommit
    ]);
    const conflictEvidence = await runConflictScan(isolatedExecution, temporaryRoot, [
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
      detached: false,
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
      if (terminating || child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

async function runConflictScan(
  execution: GitExecution,
  temporaryRoot: string,
  args: readonly string[]
) {
  throwIfAborted(execution.signal);
  const timeout = Math.min(requireRemainingTime(execution.deadlineAt), GIT_COMMAND_TIMEOUT_MS);
  const parser = new ConflictRecordParser(temporaryRoot);
  let primaryError: unknown;
  try {
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
    if (result.stderrOverflow || result.error || result.exitCode !== 0) {
      throw new Error("DELIVERY_APPLICATION_MERGE_GIT_FAILED", { cause: result.error });
    }
    return parser.finish();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await parser.close();
    } catch (closeError) {
      if (!primaryError) throw closeError;
    }
  }
}

function spawnConflictScan(
  execution: GitExecution,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  parser: ConflictRecordParser
): Promise<{
  exitCode: number;
  stderrOverflow: boolean;
  validationError?: Error;
  error?: Error;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", execution.repoPath, ...args], {
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderrBytes = 0;
    let stderrOverflow = false;
    let validationError: Error | undefined;
    let aborted = false;
    let timedOut = false;
    let terminating = false;
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingParse = Promise.resolve();

    const terminate = () => {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
      if (validationError) return;
      child.stdout.pause();
      pendingParse = pendingParse.then(() => parser.write(chunk)).catch((error) => {
        validationError = error instanceof Error
          ? error
          : new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
        terminate();
      }).finally(() => child.stdout.resume());
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
      void pendingParse.then(() => {
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
          stderrOverflow,
          ...(validationError ? { validationError } : {}),
          ...(spawnError ? { error: spawnError } : {})
        });
      });
    });
  });
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

type SpillSlot = 0 | 1;
type ConflictPath =
  | { kind: "memory"; bytes: Buffer }
  | { kind: "spill"; slot: SpillSlot; length: number };

class ConflictRecordParser {
  private state: "prefix" | "path" = "prefix";
  private readonly prefixBytes: number[] = [];
  private stage = "";
  private decoder: TextDecoder | undefined;
  private pathBytes = 0;
  private segmentBytes = 0;
  private segmentAllDots = true;
  private currentPathChunks: Buffer[] | undefined;
  private currentSpill: Extract<ConflictPath, { kind: "spill" }> | undefined;
  private hasRecords = false;
  private previousPath: ConflictPath | undefined;
  private previousStage = "";
  private spillHandles: [FileHandle | undefined, FileHandle | undefined] = [undefined, undefined];
  private closed = false;
  private files: string[] = [];
  private evidenceBytes = 2;

  constructor(private readonly temporaryRoot: string) {}

  async write(chunk: Buffer) {
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
      if (end > offset) {
        const write = this.consumePath(chunk.subarray(offset, end));
        if (write) await write;
      }
      if (terminator < 0) return;
      const finish = this.finishRecord();
      if (finish) await finish;
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
    this.currentSpill = undefined;
  }

  private consumePath(bytes: Buffer): void | Promise<void> {
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
    if (this.currentSpill) return this.appendToSpill(this.currentSpill, bytes);
    if (this.pathBytes <= MAX_CONFLICT_FILES_BYTES) {
      this.currentPathChunks!.push(Buffer.from(bytes));
      return;
    }
    return this.startSpill(bytes);
  }

  private finishRecord(): void | Promise<void> {
    this.validateSegment();
    try { this.decoder!.decode(); }
    catch (error) {
      throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID", { cause: error });
    }
    this.hasRecords = true;
    const path: ConflictPath = this.currentSpill ?? {
      kind: "memory",
      bytes: Buffer.concat(this.currentPathChunks!, this.pathBytes)
    };
    const comparison = this.previousPath ? this.comparePaths(this.previousPath, path) : -1;
    if (typeof comparison === "number") {
      this.finishPath(path, comparison);
      return;
    }
    return comparison.then((value) => this.finishPath(path, value));
  }

  private finishPath(path: ConflictPath, comparison: number) {
    // `git ls-files -u` emits index order: path first, then ascending stage.
    if (comparison > 0) conflictEvidenceInvalid();
    if (comparison === 0) {
      if (this.stage <= this.previousStage) conflictEvidenceInvalid();
    } else if (path.kind === "memory") {
      let text: string;
      try { text = UTF8.decode(path.bytes); }
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
    this.currentSpill = undefined;
  }

  private async startSpill(bytes: Buffer) {
    try {
      const slot: SpillSlot = this.previousPath?.kind === "spill" && this.previousPath.slot === 0 ? 1 : 0;
      const handle = await this.spillHandle(slot);
      await handle.truncate(0);
      const spill: Extract<ConflictPath, { kind: "spill" }> = { kind: "spill", slot, length: 0 };
      this.currentSpill = spill;
      for (const chunk of this.currentPathChunks!) await this.appendToSpill(spill, chunk);
      await this.appendToSpill(spill, bytes);
      this.currentPathChunks = undefined;
    } catch (error) {
      conflictEvidenceIoInvalid(error);
    }
  }

  private async appendToSpill(path: Extract<ConflictPath, { kind: "spill" }>, bytes: Buffer) {
    try {
      const handle = await this.spillHandle(path.slot);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, path.length + written);
        if (result.bytesWritten === 0) throw new Error("conflict path spill write made no progress");
        written += result.bytesWritten;
      }
      path.length += bytes.length;
    } catch (error) {
      conflictEvidenceIoInvalid(error);
    }
  }

  private comparePaths(left: ConflictPath, right: ConflictPath): number | Promise<number> {
    if (left.kind === "memory" && right.kind === "memory") {
      return Buffer.compare(left.bytes, right.bytes);
    }
    return this.comparePathsWithSpill(left, right);
  }

  private async comparePathsWithSpill(left: ConflictPath, right: ConflictPath) {
    try {
      const leftLength = this.pathLength(left);
      const rightLength = this.pathLength(right);
      const comparedLength = Math.min(leftLength, rightLength);
      const leftBuffer = Buffer.allocUnsafe(PATH_COMPARE_CHUNK_BYTES);
      const rightBuffer = Buffer.allocUnsafe(PATH_COMPARE_CHUNK_BYTES);
      for (let offset = 0; offset < comparedLength; offset += PATH_COMPARE_CHUNK_BYTES) {
        const length = Math.min(PATH_COMPARE_CHUNK_BYTES, comparedLength - offset);
        const leftChunk = await this.readPathChunk(left, offset, length, leftBuffer);
        const rightChunk = await this.readPathChunk(right, offset, length, rightBuffer);
        const comparison = Buffer.compare(leftChunk, rightChunk);
        if (comparison !== 0) return comparison;
      }
      return leftLength < rightLength ? -1 : leftLength > rightLength ? 1 : 0;
    } catch (error) {
      conflictEvidenceIoInvalid(error);
    }
  }

  private pathLength(path: ConflictPath) {
    return path.kind === "memory" ? path.bytes.length : path.length;
  }

  private async readPathChunk(path: ConflictPath, offset: number, length: number, buffer: Buffer) {
    if (path.kind === "memory") return path.bytes.subarray(offset, offset + length);
    const handle = await this.spillHandle(path.slot);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (result.bytesRead === 0) throw new Error("conflict path spill ended early");
      read += result.bytesRead;
    }
    return buffer.subarray(0, length);
  }

  private async spillHandle(slot: SpillSlot) {
    if (this.closed) conflictEvidenceIoInvalid(new Error("conflict path spill is closed"));
    let handle = this.spillHandles[slot];
    if (!handle) {
      handle = await open(join(this.temporaryRoot, `conflict-path-${slot}`), "w+", 0o600);
      this.spillHandles[slot] = handle;
    }
    return handle;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const handles = this.spillHandles.filter((handle): handle is FileHandle => handle !== undefined);
    this.spillHandles = [undefined, undefined];
    const results = await Promise.allSettled(handles.map((handle) => handle.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) conflictEvidenceIoInvalid(failure.reason);
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

function conflictEvidenceIoInvalid(error: unknown): never {
  if (error instanceof Error && error.message === "DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID") {
    throw error;
  }
  throw new Error("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID", { cause: error });
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
