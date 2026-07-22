import { spawn } from "node:child_process";
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
    const conflictScan = await runGit(isolatedExecution, [
      "ls-files", "-u", "-z"
    ], { allowOutputOverflow: true });
    const conflictEvidence = parseConflictFiles(conflictScan.stdout, conflictScan.outputOverflow);
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
  args: readonly string[],
  options: { allowOutputOverflow?: boolean } = {}
) {
  throwIfAborted(execution.signal);
  const timeout = Math.min(requireRemainingTime(execution.deadlineAt), GIT_COMMAND_TIMEOUT_MS);
  const env = codingGitEnvironmentWithFsmonitor(SAFE_GIT_CONFIG);
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.SSH_ASKPASS = "/usr/bin/false";
  env.GIT_OPTIONAL_LOCKS = "0";
  if (execution.indexPath) env.GIT_INDEX_FILE = execution.indexPath;
  const result = await spawnGit(execution, args, env, timeout, !options.allowOutputOverflow);
  throwIfAborted(execution.signal);
  requireRemainingTime(execution.deadlineAt);
  if ((!options.allowOutputOverflow && result.outputOverflow) || result.error || result.exitCode !== 0) {
    throw new Error("DELIVERY_APPLICATION_MERGE_GIT_FAILED", { cause: result.error });
  }
  return {
    stdout: Buffer.concat(result.stdout),
    stderr: Buffer.concat(result.stderr),
    outputOverflow: result.outputOverflow
  };
}

function spawnGit(
  execution: GitExecution,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  terminateOnOverflow: boolean
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
        if (terminateOnOverflow) terminate();
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

function parseConflictFiles(output: Buffer, outputOverflow = false) {
  if (output.length === 0) {
    return { hasConflicts: outputOverflow, files: [] as string[] };
  }
  let completeOutput = output;
  if (output[output.length - 1] !== 0) {
    if (!outputOverflow) conflictEvidenceInvalid();
    const finalTerminator = output.lastIndexOf(0);
    if (finalTerminator < 0) return { hasConflicts: true as const, files: [] as string[] };
    completeOutput = output.subarray(0, finalTerminator + 1);
  }
  const files = new Set<string>();
  const seenStages = new Set<string>();
  for (const record of splitNulRecords(completeOutput, "DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID")) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) conflictEvidenceInvalid();
    const prefix = record.subarray(0, tab).toString("ascii");
    const match = /^(?:100644|100755|120000|160000) [0-9a-f]{40} ([123])$/.exec(prefix);
    if (!match) conflictEvidenceInvalid();
    const pathBytes = record.subarray(tab + 1);
    const path = decodeGitPath(pathBytes, "DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
    const stageKey = `${match[1]}\0${path}`;
    if (seenStages.has(stageKey)) conflictEvidenceInvalid();
    seenStages.add(stageKey);
    files.add(path);
  }
  const result: string[] = [];
  let bytes = 2;
  for (const path of [...files].sort()) {
    if (result.length >= MAX_CONFLICT_FILES) break;
    const nextBytes = Buffer.byteLength(JSON.stringify(path), "utf8") + (result.length ? 1 : 0);
    if (bytes + nextBytes > MAX_CONFLICT_FILES_BYTES) break;
    result.push(path);
    bytes += nextBytes;
  }
  return { hasConflicts: true as const, files: result };
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
