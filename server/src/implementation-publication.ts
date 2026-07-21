import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const MAX_IMPLEMENTATION_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = MAX_IMPLEMENTATION_PATCH_BYTES + 64 * 1024;

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

export function captureImplementationPatchSync(worktreePath: string) {
  validateWorktreePath(worktreePath);
  const tracked = runGit(worktreePath, [
    "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."
  ], undefined, [0]);
  const untracked = runGit(worktreePath, [
    "ls-files", "--others", "--exclude-standard", "-z", "--", "."
  ], undefined, [0]).toString("utf8").split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b));
  const parts = [tracked];
  let total = tracked.length;
  for (const path of untracked) {
    if (path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("IMPLEMENTATION_PUBLICATION_PATH_INVALID");
    }
    const addition = runGit(worktreePath, [
      "diff", "--no-index", "--binary", "--full-index", "--no-ext-diff",
      "--src-prefix=a/", "--dst-prefix=b/",
      "--", "/dev/null", path
    ], undefined, [0, 1]);
    total += addition.length;
    if (total > MAX_IMPLEMENTATION_PATCH_BYTES) {
      throw new Error("IMPLEMENTATION_PUBLICATION_PATCH_TOO_LARGE");
    }
    parts.push(addition);
  }
  return validateImplementationPatch(Buffer.concat(parts, total));
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

function runGit(worktreePath: string, args: string[], input: Buffer | undefined, accepted: number[]) {
  const result = spawnSync("git", [
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
      GIT_OPTIONAL_LOCKS: "0"
    },
    input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
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
