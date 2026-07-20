import { randomUUID } from "node:crypto";
import { lstat, opendir, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runTrustedSubprocess } from "./trusted-subprocess.js";

const ACTIVE_PREFIX = "ai-workflow-verification-";
const QUARANTINE_PREFIX = "ai-workflow-verification-quarantine-";
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_TERM_GRACE_MS = 500;
const CLEANUP_OUTPUT_BYTES = 4096;

interface CleanupDependencies {
  runSubprocess?: typeof runTrustedSubprocess;
}

export async function cleanupVerificationDirectory(
  path: string,
  dependencies: CleanupDependencies = {}
) {
  const { canonical, temporaryRoot } = await validateGeneratedPath(path, "active");
  const suffix = basename(canonical).slice(ACTIVE_PREFIX.length);
  const quarantine = join(temporaryRoot, `${QUARANTINE_PREFIX}${suffix}-${randomUUID()}`);
  try {
    await rename(canonical, quarantine);
  } catch (error) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED", { cause: error });
  }
  await removeQuarantine(quarantine, dependencies);
}

export async function cleanupVerificationQuarantines(options: {
  temporaryRoot?: string;
  maxEntries?: number;
  maxScannedEntries?: number;
  runSubprocess?: typeof runTrustedSubprocess;
}) {
  const maximum = options.maxEntries ?? 4;
  const maximumScanned = options.maxScannedEntries ?? 4096;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  }
  if (!Number.isSafeInteger(maximumScanned) || maximumScanned < 1 || maximumScanned > 4096) {
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  }
  const temporaryRoot = await realpath(resolve(options.temporaryRoot ?? tmpdir()));
  const names: string[] = [];
  let scanned = 0;
  let scanTruncated = false;
  const directory = await opendir(temporaryRoot);
  for await (const entry of directory) {
    if (scanned >= maximumScanned) {
      scanTruncated = true;
      break;
    }
    scanned += 1;
    if (entry.isDirectory() && validQuarantineName(entry.name)) names.push(entry.name);
    if (names.length > maximum) {
      scanTruncated = true;
      break;
    }
  }
  names.sort();
  let removed = 0;
  let failed = 0;
  const failures: Array<{ path: string; error: string }> = [];
  for (const name of names.slice(0, maximum)) {
    const quarantine = join(temporaryRoot, name);
    try {
      await removeQuarantine(quarantine, { runSubprocess: options.runSubprocess });
      removed += 1;
    } catch (error) {
      try {
        if (!await pathExists(quarantine)) {
          removed += 1;
          continue;
        }
      } catch {}
      failed += 1;
      failures.push({ path: quarantine, error: cleanupErrorChain(error) });
    }
  }
  const remaining = failed + Math.max(0, names.length - maximum);
  return {
    scanned, scanTruncated,
    attempted: Math.min(names.length, maximum), removed, failed, remaining, failures
  };
}

function cleanupErrorChain(error: unknown) {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    messages.push(current.message.slice(0, 256));
    current = current.cause;
  }
  return (messages.length ? messages : [String(error).slice(0, 256)]).join(" <- ");
}

async function removeQuarantine(path: string, dependencies: CleanupDependencies) {
  const { canonical } = await validateGeneratedPath(path, "quarantine");
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const run = async (file: string, args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= CLEANUP_TERM_GRACE_MS) throw new Error("AUTOMATED_TEST_CLEANUP_FAILED");
    const result = await (dependencies.runSubprocess ?? runTrustedSubprocess)(file, args, {
      timeoutMs: remaining,
      termGraceMs: CLEANUP_TERM_GRACE_MS,
      maxOutputBytes: CLEANUP_OUTPUT_BYTES
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputOverflow) {
      throw new Error("AUTOMATED_TEST_CLEANUP_FAILED");
    }
  };
  try {
    await run("/bin/chmod", ["-R", "-P", "u+rwx", canonical]);
    await run("/bin/rm", ["-rf", "--", canonical]);
  } catch (error) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED", { cause: error });
  }
  if (await pathExists(canonical)) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED");
  }
}

async function validateGeneratedPath(path: string, kind: "active" | "quarantine") {
  if (!isAbsolute(path)) throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  const name = basename(path);
  if (kind === "active" ? !validActiveName(name) : !validQuarantineName(name)) {
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  }
  try {
    const temporaryRoot = await realpath(dirname(path));
    const canonical = await realpath(path);
    const status = await lstat(canonical);
    if (!status.isDirectory() || dirname(canonical) !== temporaryRoot || basename(canonical) !== name) {
      throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    }
    return { canonical, temporaryRoot };
  } catch (error) {
    if (error instanceof Error && error.message === "AUTOMATED_TEST_CLEANUP_PATH_INVALID") throw error;
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID", { cause: error });
  }
}

function validActiveName(name: string) {
  return name.startsWith(ACTIVE_PREFIX) && !name.startsWith(QUARANTINE_PREFIX)
    && /^[A-Za-z0-9_-]{6,}$/.test(name.slice(ACTIVE_PREFIX.length));
}

function validQuarantineName(name: string) {
  return name.startsWith(QUARANTINE_PREFIX)
    && /^[A-Za-z0-9_-]+$/.test(name.slice(QUARANTINE_PREFIX.length));
}

async function pathExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
