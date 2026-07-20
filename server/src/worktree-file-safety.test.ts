import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  safeReadWorktreeFile,
  safeReadWorktreeFileBuffer,
  safeWriteWorktreeFile
} from "./worktree-file-safety.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryWorktree() {
  const worktree = await mkdtemp(join(tmpdir(), "worktree-file-safety-"));
  directories.push(worktree);
  return worktree;
}

describe("worktree file safety", () => {
  it("reads and writes regular files", async () => {
    const worktree = await temporaryWorktree();
    await writeFile(join(worktree, "input.txt"), "你好 😀", "utf8");

    expect(await safeReadWorktreeFile(worktree, "input.txt")).toBe("你好 😀");
    await safeWriteWorktreeFile(worktree, "nested/output.txt", "safe output");
    expect(await readFile(join(worktree, "nested/output.txt"), "utf8")).toBe("safe output");
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0x80])],
    ["NUL content", Buffer.from([0x41, 0x00, 0x42])]
  ])("rejects %s through the text reader", async (_label, bytes) => {
    const worktree = await temporaryWorktree();
    await writeFile(join(worktree, "binary.dat"), bytes);

    await expect(safeReadWorktreeFile(worktree, "binary.dat")).rejects.toThrow("CODING_FILE_NOT_TEXT");
  });

  it("returns byte-faithful content through the Buffer reader", async () => {
    const worktree = await temporaryWorktree();
    const bytes = Buffer.from([0x00, 0x80, 0x81, 0xff]);
    await writeFile(join(worktree, "binary.dat"), bytes);

    expect(await safeReadWorktreeFileBuffer(worktree, "binary.dat")).toEqual(bytes);
  });

  it("rejects final and parent symlinks", async () => {
    const worktree = await temporaryWorktree();
    const outside = await mkdtemp(join(tmpdir(), "worktree-file-safety-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(outside, "secret.txt"), join(worktree, "final-link"));
    await symlink(outside, join(worktree, "parent-link"));

    await expect(safeReadWorktreeFile(worktree, "final-link")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
    await expect(safeReadWorktreeFile(worktree, "parent-link/secret.txt")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
    await expect(safeWriteWorktreeFile(worktree, "final-link", "unsafe")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
    await expect(safeWriteWorktreeFile(worktree, "parent-link/output.txt", "unsafe")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
  });

  it("rejects FIFO reads and writes before a blocking open", async () => {
    const worktree = await temporaryWorktree();
    const fifoPath = join(worktree, "channel");
    await exec("mkfifo", [fifoPath]);
    const startedAt = Date.now();

    await expect(safeReadWorktreeFile(worktree, "channel")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
    await expect(safeWriteWorktreeFile(worktree, "channel", "unsafe")).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
