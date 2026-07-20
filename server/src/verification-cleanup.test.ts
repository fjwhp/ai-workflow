import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupVerificationDirectory,
  cleanupVerificationQuarantines
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

function verificationDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "ai-workflow-verification-"));
  directories.push(directory);
  return directory;
}

describe("bounded verification cleanup", () => {
  it("removes a read-only verification tree through fixed-argv /bin/rm", async () => {
    const directory = verificationDirectory();
    mkdirSync(join(directory, ".toolchain", "fingerprint", "packages"), { recursive: true });
    writeFileSync(join(directory, ".toolchain", "fingerprint", "packages", "file"), "value");
    chmodSync(join(directory, ".toolchain", "fingerprint", "packages"), 0o555);
    chmodSync(join(directory, ".toolchain", "fingerprint"), 0o555);
    chmodSync(join(directory, ".toolchain"), 0o555);

    await cleanupVerificationDirectory(directory);

    expect(existsSync(directory)).toBe(false);
  });

  it("keeps a quarantined tree and fails closed when rm exceeds its budget", async () => {
    const directory = verificationDirectory();
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

  it("processes at most the configured number of strict quarantine directories per startup", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-parent-"));
    directories.push(parent);
    for (const suffix of ["a", "b", "c"]) {
      mkdirSync(join(parent, `ai-workflow-verification-quarantine-${suffix}`));
    }
    const runSubprocess = vi.fn(async () => ({
      exitCode: 0, stdout: "", stderr: "", timedOut: false, outputOverflow: false
    }));

    const result = await cleanupVerificationQuarantines({
      temporaryRoot: parent, maxEntries: 2, runSubprocess
    });

    expect(runSubprocess).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      scanned: 3, scanTruncated: true, attempted: 2, removed: 0, failed: 2, remaining: 3,
      failures: [
        { path: join(realpathSync(parent), "ai-workflow-verification-quarantine-a"), error: expect.stringContaining("AUTOMATED_TEST_CLEANUP_FAILED") },
        { path: join(realpathSync(parent), "ai-workflow-verification-quarantine-b"), error: expect.stringContaining("AUTOMATED_TEST_CLEANUP_FAILED") }
      ]
    });
  });

  it("bounds directory scanning as well as quarantine cleanup work", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-scan-"));
    directories.push(parent);
    for (const suffix of ["a", "b", "c", "d", "e"]) {
      mkdirSync(join(parent, `ai-workflow-verification-quarantine-${suffix}`));
    }
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

  it("treats a quarantine concurrently removed by another janitor as recovered", async () => {
    const parent = mkdtempSync(join(tmpdir(), "verification-janitor-race-"));
    directories.push(parent);
    const quarantine = join(parent, "ai-workflow-verification-quarantine-race");
    mkdirSync(quarantine);
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
