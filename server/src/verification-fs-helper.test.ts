import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeVerificationManifest } from "./verification-fs-helper.js";

const directories: string[] = [];

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function file(path: string, value: string) {
  const content = Buffer.from(value);
  return {
    path, type: "file" as const, mode: "100644" as const, size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"), contentBase64: content.toString("base64")
  };
}

function root() {
  const parent = mkdtempSync(join(tmpdir(), "verification-materializer-"));
  directories.push(parent);
  return join(parent, "worktree");
}

describe("trusted verification filesystem helper", () => {
  it("materializes validated files and internal symlinks in a direct child", async () => {
    const target = root();
    const linkTarget = "src/value.txt";

    await materializeVerificationManifest(target, { version: 1, entries: [
      file(linkTarget, "frozen\n"),
      {
        path: "value.txt", type: "symlink", mode: "120000", target: linkTarget,
        sha256: createHash("sha256").update(linkTarget).digest("hex")
      }
    ] }, { timeoutMs: 2_000, sensitivePatterns: [] });

    expect(readFileSync(join(target, linkTarget), "utf8")).toBe("frozen\n");
    expect(readlinkSync(join(target, "value.txt"))).toBe(linkTarget);
  });

  it.each([
    ["entries", { maxEntries: 1 }],
    ["inodes", { maxInodes: 2 }],
    ["directories", { maxDirectories: 1 }],
    ["depth", { maxDepth: 1 }],
    ["path bytes", { maxPathBytes: 4 }],
    ["file bytes", { maxFileBytes: 2 }],
    ["total bytes", { maxTotalBytes: 2 }]
  ])("rejects the %s limit before writing evidence", async (_name, limits) => {
    const target = root();
    await expect(materializeVerificationManifest(target, {
      version: 1, entries: [file("nested/first.txt", "one"), file("nested/second.txt", "two")]
    }, { timeoutMs: 2_000, sensitivePatterns: [], limits })).rejects
      .toThrow("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
    expect(existsSync(target)).toBe(false);
  });

  it("maps a hard child timeout to the plan deadline without starting more work", async () => {
    const runSubprocess = vi.fn(async () => ({
      exitCode: -1, stdout: "", stderr: "", timedOut: true, outputOverflow: false
    }));

    await expect(materializeVerificationManifest(root(), {
      version: 1, entries: [file("value.txt", "frozen")]
    }, { timeoutMs: 10, sensitivePatterns: [] }, { runSubprocess })).rejects
      .toThrow("AUTOMATED_TEST_DEADLINE_EXCEEDED");
    expect(runSubprocess).toHaveBeenCalledWith(
      process.execPath, expect.arrayContaining(["--eval"]), expect.objectContaining({ timeoutMs: 10 })
    );
  });

  it("forwards cancellation to the materialization child and reports a stable abort", async () => {
    const controller = new AbortController();
    const runSubprocess = vi.fn(async (_file, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("TRUSTED_SUBPROCESS_ABORTED");
    });

    await expect(materializeVerificationManifest(root(), {
      version: 1, entries: [file("value.txt", "frozen")]
    }, { timeoutMs: 2_000, sensitivePatterns: [], signal: controller.signal }, { runSubprocess } as any))
      .rejects.toThrow("AUTOMATED_TEST_ABORTED");
  });

  it("rejects sensitive entries and invalid hashes without leaving a partial tree", async () => {
    const sensitiveTarget = root();
    await expect(materializeVerificationManifest(sensitiveTarget, {
      version: 1, entries: [file(".env", "SECRET=value")]
    }, { timeoutMs: 2_000, sensitivePatterns: [".env"] })).rejects
      .toThrow("CODING_EVIDENCE_MANIFEST_SENSITIVE");
    expect(existsSync(sensitiveTarget)).toBe(false);

    const invalidTarget = root();
    await expect(materializeVerificationManifest(invalidTarget, {
      version: 1, entries: [{ ...file("value.txt", "frozen"), sha256: "0".repeat(64) }]
    }, { timeoutMs: 2_000, sensitivePatterns: [] })).rejects
      .toThrow("CODING_EVIDENCE_MANIFEST_INVALID");
    expect(existsSync(invalidTarget)).toBe(false);
  });
});
