import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyImplementationPatchSync,
  captureImplementationPatchSync,
  implementationPatchHash,
  inspectImplementationChangedPathsSync,
  MAX_IMPLEMENTATION_CHANGED_FILES,
  validateImplementationPatch
} from "./implementation-publication.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function git(path: string, args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "implementation-publication-"));
  directories.push(root);
  const repo = join(root, "repo");
  const target = join(root, "target");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
  git(repo, ["worktree", "add", "--quiet", "--detach", target, "HEAD"]);
  return { repo, target };
}

describe("implementation publication primitives", () => {
  it("captures and applies one deterministic binary patch including untracked files", () => {
    const { repo, target } = fixture();
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    writeFileSync(join(repo, "new.bin"), Buffer.from([0, 1, 2, 255]));

    const patch = captureImplementationPatchSync(repo);
    const expectedHash = implementationPatchHash(patch);
    applyImplementationPatchSync(target, patch);

    expect(captureImplementationPatchSync(target).equals(patch)).toBe(true);
    expect(implementationPatchHash(captureImplementationPatchSync(target))).toBe(expectedHash);
  });

  it("does not mutate the real index while capturing untracked files", () => {
    const { repo } = fixture();
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");
    const before = git(repo, ["status", "--porcelain=v1"]);

    captureImplementationPatchSync(repo);

    expect(git(repo, ["status", "--porcelain=v1"])).toBe(before);
  });

  it("rejects an oversized patch before persistence", () => {
    expect(() => validateImplementationPatch(Buffer.alloc(8 * 1024 * 1024 + 1)))
      .toThrow("IMPLEMENTATION_PUBLICATION_PATCH_TOO_LARGE");
  });

  it("captures through a fixed three-call Git sequence", () => {
    const calls: string[][] = [];
    const execute = ((_file: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }) as any;

    captureImplementationPatchSync("/tmp/fixed-capture", { execute });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(expect.arrayContaining(["read-tree", "HEAD"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["add", "-N", "--all"]));
    expect(calls[2]).toEqual(expect.arrayContaining(["diff", "--binary", "HEAD"]));
  });

  it("rejects a raw change set above the fixed file cap", () => {
    const records = Array.from({ length: MAX_IMPLEMENTATION_CHANGED_FILES + 1 }, (_, index) =>
      `?? file-${index}.txt`).join("\0") + "\0";
    const execute = (() => ({ status: 0, stdout: Buffer.from(records), stderr: Buffer.alloc(0) })) as any;

    expect(() => inspectImplementationChangedPathsSync("/tmp/file-cap", { execute }))
      .toThrow("IMPLEMENTATION_PUBLICATION_TOO_MANY_FILES");
  });

  it("enforces a monotonic capture runtime budget", () => {
    let now = 0;
    const execute = (() => {
      now = 101;
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }) as any;

    expect(() => captureImplementationPatchSync("/tmp/runtime-cap", {
      execute, monotonicNow: () => now, maxRuntimeMs: 100
    })).toThrow("IMPLEMENTATION_PUBLICATION_RUNTIME_EXCEEDED");
  });
});
