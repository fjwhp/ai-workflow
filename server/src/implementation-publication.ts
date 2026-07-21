import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_IMPLEMENTATION_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_IMPLEMENTATION_CHANGED_FILES = 4096;
const MAX_GIT_OUTPUT_BYTES = MAX_IMPLEMENTATION_PATCH_BYTES + 64 * 1024;
const DEFAULT_IMPLEMENTATION_GIT_RUNTIME_MS = 15_000;

export interface ImplementationGitOptions {
  execute?: typeof spawnSync;
  monotonicNow?: () => number;
  maxRuntimeMs?: number;
}

export interface ImplementationChangedPath {
  path: string;
  status: "added" | "modified" | "deleted";
  ignored: boolean;
}

export function implementationPatchHash(patch: Buffer) {
  validateImplementationPatch(patch);
  return createHash("sha256").update(patch).digest("hex");
}

export function validateImplementationPatch(patch: Buffer) {
  if (!Buffer.isBuffer(patch)) throw new Error("IMPLEMENTATION_PUBLICATION_PATCH_INVALID");
  if (patch.length > MAX_IMPLEMENTATION_PATCH_BYTES) {
    throw new Error("IMPLEMENTATION_PUBLICATION_PATCH_TOO_LARGE");
  }
  return patch;
}

export function captureImplementationPatchSync(worktreePath: string, options: ImplementationGitOptions = {}) {
  validateWorktreePath(worktreePath);
  const runtime = implementationGitRuntime(options);
  const temporary = mkdtempSync(join(tmpdir(), "flowgate-publication-index-"));
  const env = { GIT_INDEX_FILE: join(temporary, "index") };
  try {
    runGit(worktreePath, ["read-tree", "HEAD"], undefined, [0], runtime, env);
    runGit(worktreePath, ["add", "-N", "--all", "--", "."], undefined, [0], runtime, env);
    return validateImplementationPatch(runGit(worktreePath, [
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."
    ], undefined, [0], runtime, env));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function inspectImplementationChangedPathsSync(
  worktreePath: string,
  options: ImplementationGitOptions = {}
): ImplementationChangedPath[] {
  validateWorktreePath(worktreePath);
  const runtime = implementationGitRuntime(options);
  const output = runGit(worktreePath, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"
  ], undefined, [0], runtime).toString("utf8");
  const records = output.split("\0").filter(Boolean);
  if (records.length > MAX_IMPLEMENTATION_CHANGED_FILES) {
    throw new Error("IMPLEMENTATION_PUBLICATION_TOO_MANY_FILES");
  }
  const changes = records.map((record) => {
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("IMPLEMENTATION_PUBLICATION_STATUS_INVALID");
    }
    const code = record.slice(0, 2);
    const path = record.slice(3).replace(/\/$/, "");
    if (!path || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("IMPLEMENTATION_PUBLICATION_PATH_INVALID");
    }
    const ignored = code === "!!";
    const status = code === "??" || code.includes("A") ? "added" as const
      : code.includes("D") ? "deleted" as const : "modified" as const;
    return { path, status, ignored };
  });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function applyImplementationPatchSync(worktreePath: string, patch: Buffer) {
  validateWorktreePath(worktreePath);
  validateImplementationPatch(patch);
  if (patch.length === 0) return;
  const args = ["apply", "--binary", "--whitespace=nowarn", "-"];
  runGit(worktreePath, [...args.slice(0, -1), "--check", "-"], patch, [0]);
  runGit(worktreePath, args, patch, [0]);
}

export function reverseImplementationPatchSync(worktreePath: string, patch: Buffer) {
  validateWorktreePath(worktreePath);
  validateImplementationPatch(patch);
  if (patch.length === 0) return;
  runGit(worktreePath, ["apply", "--binary", "--whitespace=nowarn", "--reverse", "--check", "-"], patch, [0]);
  runGit(worktreePath, ["apply", "--binary", "--whitespace=nowarn", "--reverse", "-"], patch, [0]);
}

export function readImplementationHeadSync(worktreePath: string) {
  return runGit(worktreePath, ["rev-parse", "--verify", "HEAD"], undefined, [0]).toString("utf8").trim();
}

interface ImplementationGitRuntime {
  execute: typeof spawnSync;
  now: () => number;
  deadline: number;
}

function implementationGitRuntime(options: ImplementationGitOptions): ImplementationGitRuntime {
  const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_IMPLEMENTATION_GIT_RUNTIME_MS;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 60_000) {
    throw new Error("IMPLEMENTATION_PUBLICATION_RUNTIME_INVALID");
  }
  const now = options.monotonicNow ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) throw new Error("IMPLEMENTATION_PUBLICATION_RUNTIME_INVALID");
  return { execute: options.execute ?? spawnSync, now, deadline: started + maxRuntimeMs };
}

function runGit(
  worktreePath: string,
  args: string[],
  input: Buffer | undefined,
  accepted: number[],
  runtime?: ImplementationGitRuntime,
  extraEnv: NodeJS.ProcessEnv = {}
) {
  const active = runtime ?? implementationGitRuntime({});
  const remaining = active.deadline - active.now();
  if (!(remaining > 0)) throw new Error("IMPLEMENTATION_PUBLICATION_RUNTIME_EXCEEDED");
  const result = active.execute("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-C", worktreePath,
    ...args
  ], {
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ...extraEnv
    },
    input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: Math.max(1, Math.ceil(remaining)),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (active.now() >= active.deadline || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("IMPLEMENTATION_PUBLICATION_RUNTIME_EXCEEDED", { cause: result.error });
  }
  if (result.error || result.status === null || !accepted.includes(result.status)) {
    const detail = Buffer.from(result.stderr ?? Buffer.alloc(0)).toString("utf8").slice(0, 4096).trim();
    throw new Error("IMPLEMENTATION_PUBLICATION_GIT_FAILED", {
      cause: result.error ?? new Error(detail || `git exited ${String(result.status)}`)
    });
  }
  const stdout = Buffer.from(result.stdout ?? Buffer.alloc(0));
  if (stdout.length > MAX_GIT_OUTPUT_BYTES) throw new Error("IMPLEMENTATION_PUBLICATION_GIT_OUTPUT_TOO_LARGE");
  return stdout;
}

function validateWorktreePath(path: string) {
  if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0")) {
    throw new Error("IMPLEMENTATION_PUBLICATION_PATH_INVALID");
  }
}
