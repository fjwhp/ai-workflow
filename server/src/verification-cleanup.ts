import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, opendir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runTrustedSubprocess } from "./trusted-subprocess.js";

const ACTIVE_PREFIX = "ai-workflow-verification-";
const QUARANTINE_PREFIX = "ai-workflow-verification-quarantine-";
export const VERIFICATION_OWNERSHIP_MARKER = ".ai-workflow-verification-owner.json";
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_TERM_GRACE_MS = 500;
const CLEANUP_OUTPUT_BYTES = 4096;

interface CleanupDependencies {
  runSubprocess?: typeof runTrustedSubprocess;
}

interface VerificationOwnership {
  version: 1;
  uid: number;
  nonce: string;
  dev: number;
  ino: number;
}

export async function createVerificationDirectory(temporaryRoot = tmpdir()) {
  const canonicalRoot = await realpath(resolve(temporaryRoot));
  const directory = await mkdtemp(join(canonicalRoot, ACTIVE_PREFIX));
  await chmod(directory, 0o700);
  const status = await lstat(directory);
  const marker = {
    version: 1,
    uid: status.uid,
    nonce: randomUUID(),
    dev: status.dev,
    ino: status.ino
  };
  const markerPath = join(directory, VERIFICATION_OWNERSHIP_MARKER);
  await writeFile(markerPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(markerPath, 0o600);
  return directory;
}

export async function cleanupVerificationDirectory(
  path: string,
  dependencies: CleanupDependencies = {}
) {
  const owned = await validateOwnedGeneratedPath(path, "active");
  const { canonical, temporaryRoot } = await validateOwnedGeneratedPath(path, "active", owned.ownership);
  const suffix = basename(canonical).slice(ACTIVE_PREFIX.length);
  const quarantine = join(temporaryRoot, `${QUARANTINE_PREFIX}${suffix}-${owned.ownership.nonce}`);
  try {
    await rename(canonical, quarantine);
  } catch (error) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED", { cause: error });
  }
  await removeQuarantine(quarantine, dependencies, owned.ownership);
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
      const owned = await validateOwnedGeneratedPath(quarantine, "quarantine");
      await removeQuarantine(quarantine, { runSubprocess: options.runSubprocess }, owned.ownership);
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

async function removeQuarantine(
  path: string,
  dependencies: CleanupDependencies,
  expectedOwnership: VerificationOwnership
) {
  const { canonical } = await validateOwnedGeneratedPath(path, "quarantine", expectedOwnership);
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
    await validateOwnedGeneratedPath(canonical, "quarantine", expectedOwnership);
    await run("/bin/chmod", ["-R", "-P", "u+rwX", canonical]);
    await validateOwnedGeneratedPath(canonical, "quarantine", expectedOwnership);
    await run("/bin/rm", ["-rf", "--", canonical]);
  } catch (error) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED", { cause: error });
  }
  if (await pathExists(canonical)) {
    throw new Error("AUTOMATED_TEST_CLEANUP_FAILED");
  }
}

async function validateOwnedGeneratedPath(
  path: string,
  kind: "active" | "quarantine",
  expectedOwnership?: VerificationOwnership
) {
  if (!isAbsolute(path)) throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  const name = basename(path);
  if (kind === "active" ? !validActiveName(name) : !validQuarantineName(name)) {
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
  }
  try {
    const temporaryRoot = await realpath(dirname(path));
    const directStatus = await lstat(path);
    if (!directStatus.isDirectory() || (directStatus.mode & 0o777) !== 0o700) {
      throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    }
    const canonical = await realpath(path);
    const status = await lstat(canonical);
    const uid = typeof process.getuid === "function" ? process.getuid() : status.uid;
    if (!status.isDirectory() || status.dev !== directStatus.dev || status.ino !== directStatus.ino
      || status.uid !== uid || dirname(canonical) !== temporaryRoot || basename(canonical) !== name) {
      throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    }
    const marker = await readOwnershipMarker(canonical, uid);
    if (marker.dev !== status.dev || marker.ino !== status.ino
      || (kind === "quarantine" && quarantineNonce(name) !== marker.nonce)
      || (expectedOwnership && !sameOwnership(marker, expectedOwnership))) {
      throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    }
    return { canonical, temporaryRoot, ownership: marker };
  } catch (error) {
    if (error instanceof Error && error.message === "AUTOMATED_TEST_CLEANUP_PATH_INVALID") throw error;
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID", { cause: error });
  }
}

async function readOwnershipMarker(directory: string, uid: number): Promise<VerificationOwnership> {
  let handle;
  try {
    handle = await open(join(directory, VERIFICATION_OWNERSHIP_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = await handle.stat();
    if (!status.isFile() || status.uid !== uid || (status.mode & 0o777) !== 0o600 || status.size > 4096) {
      throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    }
    const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!validOwnership(parsed)) throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "AUTOMATED_TEST_CLEANUP_PATH_INVALID") throw error;
    throw new Error("AUTOMATED_TEST_CLEANUP_PATH_INVALID", { cause: error });
  } finally {
    await handle?.close();
  }
}

function validOwnership(value: unknown): value is VerificationOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return Object.keys(marker).sort().join(",") === "dev,ino,nonce,uid,version"
    && marker.version === 1
    && [marker.uid, marker.dev, marker.ino].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
    && typeof marker.nonce === "string" && validNonce(marker.nonce);
}

function sameOwnership(left: VerificationOwnership, right: VerificationOwnership) {
  return left.version === right.version && left.uid === right.uid && left.nonce === right.nonce
    && left.dev === right.dev && left.ino === right.ino;
}

function quarantineNonce(name: string) {
  return name.slice(QUARANTINE_PREFIX.length + 7);
}

function validNonce(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validActiveName(name: string) {
  return name.startsWith(ACTIVE_PREFIX) && !name.startsWith(QUARANTINE_PREFIX)
    && /^[A-Za-z0-9]{6}$/.test(name.slice(ACTIVE_PREFIX.length));
}

function validQuarantineName(name: string) {
  return name.startsWith(QUARANTINE_PREFIX)
    && /^[A-Za-z0-9]{6}-/.test(name.slice(QUARANTINE_PREFIX.length))
    && validNonce(quarantineNonce(name));
}

async function pathExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
