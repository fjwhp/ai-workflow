import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyImplementationPatchSync,
  captureImplementationPatchSync,
  implementationPatchHash,
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

  it("rejects an oversized patch before persistence", () => {
    expect(() => validateImplementationPatch(Buffer.alloc(8 * 1024 * 1024 + 1)))
      .toThrow("IMPLEMENTATION_PUBLICATION_PATCH_TOO_LARGE");
  });
});
