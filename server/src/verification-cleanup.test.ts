import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  renameSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVerificationDirectory,
  cleanupVerificationDirectory,
  cleanupVerificationQuarantines,
  VERIFICATION_OWNERSHIP_MARKER
} from "./verification-cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!existsSync(directory)) continue;
    makeDirectoriesWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectoriesWritable(directory: string) {
  const status = lstatSync(directory);
  if (!status.isDirectory()) return;
  chmodSync(directory, 0o700);
  for (const child of readdirSync(directory)) {
    const path = join(directory, child);
    if (lstatSync(path).isDirectory()) makeDirectoriesWritable(path);
  }
}

async function verificationDirectory() {
  const directory = await createVerificationDirectory();
  directories.push(directory);
  return directory;
}

async function quarantineDirectory(parent: string) {
  const active = await createVerificationDirectory(parent);
  const marker = JSON.parse(readFileSync(join(active, VERIFICATION_OWNERSHIP_MARKER), "utf8"));
  const suffix = basename(active).slice("ai-workflow-verification-".length);
  const quarantine = join(parent, `ai-workflow-verification-quarantine-${suffix}-${marker.nonce}`);
  renameSync(active, quarantine);
  return quarantine;
}

describe("bounded verification cleanup", () => {
  it("creates an owner-only root with an inode-bound ownership marker", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-owner-parent-"));
    directories.push(parent);

    const directory = await createVerificationDirectory(parent);
    const status = lstatSync(directory);
    const markerPath = join(directory, VERIFICATION_OWNERSHIP_MARKER);
    const markerStatus = lstatSync(markerPath);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));

    expect(status.mode & 0o777).toBe(0o700);
    expect(markerStatus.mode & 0o777).toBe(0o600);
    expect(marker).toEqual({
      version: 1,
      uid: status.uid,
      nonce: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      dev: status.dev,
      ino: status.ino
    });
  });

  it("removes a read-only verification tree through fixed-argv /bin/rm", async () => {
    const directory = await verificationDirectory();
    mkdirSync(join(directory, ".toolchain", "fingerprint", "packages"), { recursive: true });
    writeFileSync(join(directory, ".toolchain", "fingerprint", "packages", "file"), "value");
    chmodSync(join(directory, ".toolchain", "fingerprint", "packages"), 0o555);
    chmodSync(join(directory, ".toolchain", "fingerprint"), 0o555);
    chmodSync(join(directory, ".toolchain"), 0o555);

    await cleanupVerificationDirectory(directory);

    expect(existsSync(directory)).toBe(false);
  });

  it("keeps a quarantined tree and fails closed when rm exceeds its budget", async () => {
    const directory = await verificationDirectory();
    const runSubprocess = vi.fn(async () => ({
      exitCode: -1, stdout: "", stderr: "", timedOut: true, outputOverflow: false
    }));

    await expect(cleanupVerificationDirectory(directory, { runSubprocess }))
      .rejects.toThrow("AUTOMATED_TEST_CLEANUP_FAILED");

    expect(existsSync(directory)).toBe(false);
    const quarantines = readdirSync(tmpdir()).filter((entry) => entry.startsWith("ai-workflow-verification-quarantine-"));
    expect(quarantines).toContainEqual(expect.stringContaining(basename(directory).slice("ai-workflow-verification-".length)));
    for (const quarantine of quarantines) directories.push(join(tmpdir(), quarantine));
  });

  it("rejects paths outside the strict generated verification prefix without invoking rm", async () => {
    const runSubprocess = vi.fn();
    await expect(cleanupVerificationDirectory(join(tmpdir(), "not-a-verification-root"), { runSubprocess }))
      .rejects.toThrow("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    expect(runSubprocess).not.toHaveBeenCalled();
  });

  it("ignores unrelated directories that merely share the quarantine prefix", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-unrelated-"));
    directories.push(parent);
    const unrelated = join(parent, "ai-workflow-verification-quarantine-user-data");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "important.txt"), "keep");
    const runSubprocess = vi.fn();

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent, runSubprocess });

    expect(result).toMatchObject({ scanned: 1, attempted: 0, removed: 0, failed: 0 });
    expect(runSubprocess).not.toHaveBeenCalled();
    expect(readFileSync(join(unrelated, "important.txt"), "utf8")).toBe("keep");
  });

  it("reports a quarantine with a forged ownership marker without deleting it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-forged-"));
    directories.push(parent);
    const quarantine = await quarantineDirectory(parent);
    const markerPath = join(quarantine, VERIFICATION_OWNERSHIP_MARKER);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify({ ...marker, ino: marker.ino + 1 }), { mode: 0o600 });
    const runSubprocess = vi.fn();

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent, runSubprocess });

    expect(result).toMatchObject({ attempted: 1, removed: 0, failed: 1 });
    expect(result.failures[0]?.error).toContain("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    expect(runSubprocess).not.toHaveBeenCalled();
    expect(existsSync(quarantine)).toBe(true);
  });

  it("ignores a symlink with an otherwise valid quarantine name", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "verification-janitor-target-"));
    directories.push(parent, target);
    writeFileSync(join(target, "important.txt"), "keep");
    const link = join(parent,
      "ai-workflow-verification-quarantine-ABC123-00000000-0000-4000-8000-000000000000");
    symlinkSync(target, link);
    const runSubprocess = vi.fn();

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent, runSubprocess });

    expect(result).toMatchObject({ scanned: 1, attempted: 0, removed: 0, failed: 0 });
    expect(runSubprocess).not.toHaveBeenCalled();
    expect(readFileSync(join(target, "important.txt"), "utf8")).toBe("keep");
  });

  it("detects an inode replacement before rm and leaves the replacement untouched", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-replaced-"));
    directories.push(parent);
    const quarantine = await quarantineDirectory(parent);
    const original = `${quarantine}.original`;
    const marker = readFileSync(join(quarantine, VERIFICATION_OWNERSHIP_MARKER), "utf8");
    const runSubprocess = vi.fn(async () => {
      renameSync(quarantine, original);
      mkdirSync(quarantine, { mode: 0o700 });
      writeFileSync(join(quarantine, VERIFICATION_OWNERSHIP_MARKER), marker, { mode: 0o600 });
      writeFileSync(join(quarantine, "important.txt"), "keep");
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputOverflow: false };
    });

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent, runSubprocess });

    expect(result).toMatchObject({ attempted: 1, removed: 0, failed: 1 });
    expect(result.failures[0]?.error).toContain("AUTOMATED_TEST_CLEANUP_PATH_INVALID");
    expect(runSubprocess).toHaveBeenCalledOnce();
    expect(readFileSync(join(quarantine, "important.txt"), "utf8")).toBe("keep");
  });

  it("processes at most the configured number of strict quarantine directories per startup", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-parent-"));
    directories.push(parent);
    const quarantines = await Promise.all([0, 1, 2].map(() => quarantineDirectory(parent)));
    const runSubprocess = vi.fn(async () => ({
      exitCode: 0, stdout: "", stderr: "", timedOut: false, outputOverflow: false
    }));

    const result = await cleanupVerificationQuarantines({
      temporaryRoot: parent, maxEntries: 2, runSubprocess
    });

    expect(runSubprocess).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      scanned: 3, scanTruncated: true, attempted: 2, removed: 0, failed: 2, remaining: 3,
      failures: quarantines.sort().slice(0, 2).map((path) => ({
        path: join(realpathSync(parent), basename(path)), error: expect.stringContaining("AUTOMATED_TEST_CLEANUP_FAILED")
      }))
    });
  });

  it("bounds directory scanning as well as quarantine cleanup work", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-scan-"));
    directories.push(parent);
    await Promise.all([0, 1, 2, 3, 4].map(() => quarantineDirectory(parent)));
    const runSubprocess = vi.fn(async () => ({
      exitCode: 0, stdout: "", stderr: "", timedOut: false, outputOverflow: false
    }));

    const result = await cleanupVerificationQuarantines({
      temporaryRoot: parent, maxEntries: 4, maxScannedEntries: 2, runSubprocess
    } as any);

    expect(runSubprocess).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      scanned: 2, scanTruncated: true, attempted: 2, removed: 0, failed: 2, remaining: 2,
      failures: [
        { path: expect.stringContaining(`${realpathSync(parent)}/ai-workflow-verification-quarantine-`), error: expect.stringContaining("AUTOMATED_TEST_CLEANUP_FAILED") },
        { path: expect.stringContaining(`${realpathSync(parent)}/ai-workflow-verification-quarantine-`), error: expect.stringContaining("AUTOMATED_TEST_CLEANUP_FAILED") }
      ]
    });
  });

  it("removes a valid quarantine left by an earlier process", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-old-"));
    directories.push(parent);
    const quarantine = await quarantineDirectory(parent);
    writeFileSync(join(quarantine, "stale.txt"), "stale");

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent });

    expect(result).toEqual({
      scanned: 1, scanTruncated: false, attempted: 1,
      removed: 1, failed: 0, remaining: 0, failures: []
    });
    expect(existsSync(quarantine)).toBe(false);
  });

  it("treats a quarantine concurrently removed by another janitor as recovered", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-race-"));
    directories.push(parent);
    const quarantine = await quarantineDirectory(parent);
    const runSubprocess = vi.fn(async () => {
      rmSync(quarantine, { recursive: true, force: true });
      throw Object.assign(new Error("path disappeared"), { code: "ENOENT" });
    });

    const result = await cleanupVerificationQuarantines({ temporaryRoot: parent, runSubprocess });

    expect(result).toEqual({
      scanned: 1, scanTruncated: false, attempted: 1,
      removed: 1, failed: 0, remaining: 0, failures: []
    });
  });
});
