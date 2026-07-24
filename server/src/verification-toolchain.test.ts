import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotVerificationToolchain } from "./verification-toolchain.js";
import * as verificationToolchain from "./verification-toolchain.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => {
    makeDirectoriesWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  });
});

function makeDirectoriesWritable(directory: string) {
  if (!lstatSync(directory).isDirectory()) return;
  chmodSync(directory, 0o700);
  for (const child of readdirSync(directory)) {
    const path = join(directory, child);
    if (lstatSync(path).isDirectory()) makeDirectoriesWritable(path);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verification-toolchain-"));
  directories.push(root);
  const runtime = join(root, "runtime");
  const bin = join(runtime, "bin");
  const npm = join(runtime, "lib", "node_modules", "npm");
  const shim = join(root, "shim");
  mkdirSync(join(npm, "bin"), { recursive: true });
  mkdirSync(join(npm, "lib"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(bin, "node"), "frozen-node-binary\n");
  chmodSync(join(bin, "node"), 0o755);
  writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm", version: "1.2.3" }));
  writeFileSync(join(npm, "bin", "npm-cli.js"), "#!/usr/bin/env node\nrequire('../lib/cli.js')\n");
  chmodSync(join(npm, "bin", "npm-cli.js"), 0o755);
  writeFileSync(join(npm, "lib", "cli.js"), "module.exports = () => 'original'\n");
  symlinkSync(relative(shim, join(npm, "bin", "npm-cli.js")), join(shim, "npm"));
  symlinkSync(relative(shim, join(bin, "node")), join(shim, "node"));
  return { root, runtime, npm, shim, destination: join(root, "verification") };
}

describe("verification toolchain snapshot", () => {
  it("terminates an isolated snapshot that exceeds its remaining plan budget", async () => {
    const boundedSnapshot = (verificationToolchain as any).snapshotVerificationToolchainBounded;
    expect(boundedSnapshot).toBeTypeOf("function");
    const input = fixture();
    const runSubprocess = async () => ({
      exitCode: -1, stdout: "", stderr: "", timedOut: true, outputOverflow: false
    });

    await expect(boundedSnapshot(
      [{ id: "verify-1", command: "npm", args: ["test"] }],
      input.destination,
      { env: { PATH: input.shim }, timeoutMs: 50 },
      { runSubprocess }
    )).rejects.toThrow("AUTOMATED_TEST_DEADLINE_EXCEEDED");
  });

  it("forwards cancellation to the snapshot child and reports a stable abort", async () => {
    const boundedSnapshot = (verificationToolchain as any).snapshotVerificationToolchainBounded;
    const input = fixture();
    const controller = new AbortController();
    const runSubprocess = vi.fn(async (_file, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("TRUSTED_SUBPROCESS_ABORTED");
    });

    await expect(boundedSnapshot(
      [{ id: "verify-1", command: "npm", args: ["test"] }], input.destination,
      { env: { PATH: input.shim }, timeoutMs: 2_000, signal: controller.signal }, { runSubprocess }
    )).rejects.toThrow("AUTOMATED_TEST_ABORTED");
  });

  it("rejects isolated snapshot output that changes the frozen argv", async () => {
    const boundedSnapshot = (verificationToolchain as any).snapshotVerificationToolchainBounded;
    const input = fixture();
    const fingerprint = "a".repeat(64);
    const root = join(input.destination, ".toolchain", fingerprint);
    const runSubprocess = async () => ({
      exitCode: 0, stderr: "", timedOut: false, outputOverflow: false,
      stdout: JSON.stringify({
        root, fingerprint, binDirectory: join(root, "bin"),
        commands: [{
          id: "verify-1", configuredCommand: "npm", file: join(root, "bin", "node"),
          args: ["--eval", "test"]
        }],
        manifest: [{
          path: "bin/node", type: "file", mode: 0o555, size: 1, sha256: "b".repeat(64)
        }]
      })
    });

    await expect(boundedSnapshot(
      [{ id: "verify-1", command: "npm", args: ["test"] }], input.destination,
      { env: { PATH: input.shim }, timeoutMs: 50 }, { runSubprocess }
    )).rejects.toThrow("AUTOMATED_TEST_TOOLCHAIN_FAILED");
  });

  it("copies a canonical npm and shebang-node closure into a content-addressed read-only layer", async () => {
    const input = fixture();

    const snapshot = await snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: ["test"] }],
      input.destination,
      { env: { PATH: input.shim } }
    );

    expect(snapshot.root).toContain(join(input.destination, ".toolchain", snapshot.fingerprint));
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.commands).toEqual([expect.objectContaining({
      id: "verify-1", configuredCommand: "npm", args: [expect.stringMatching(/npm-cli\.js$/), "test"]
    })]);
    expect(snapshot.commands[0]!.file).toMatch(/\/bin\/node$/);
    expect(snapshot.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/packages\/.+\/package\.json$/), type: "file" }),
      expect.objectContaining({ path: expect.stringMatching(/packages\/.+\/lib\/cli\.js$/), type: "file" }),
      expect.objectContaining({ path: "bin/node", type: "file" })
    ]));
    expect(snapshot.manifest.every((entry) => (entry.mode & 0o222) === 0)).toBe(true);

    writeFileSync(join(input.npm, "lib", "cli.js"), "module.exports = () => 'mutated'\n");
    const frozenCli = snapshot.manifest.find((entry) => entry.path.endsWith("/lib/cli.js"))!;
    expect(readFileSync(join(snapshot.root, ...frozenCli.path.split("/")), "utf8")).toContain("original");
  });

  it("produces the same fingerprint for the same closure in a second verification root", async () => {
    const input = fixture();
    const secondDestination = join(input.root, "verification-two");

    const first = await snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: ["test"] }], input.destination, { env: { PATH: input.shim } }
    );
    const second = await snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: ["test"] }], secondDestination, { env: { PATH: input.shim } }
    );

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("rejects source mutation during the snapshot instead of freezing mixed content", async () => {
    const input = fixture();

    await expect(snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: ["test"] }],
      input.destination,
      {
        env: { PATH: input.shim },
        afterCopy: async () => writeFileSync(join(input.npm, "lib", "cli.js"), "mutated during copy\n")
      }
    )).rejects.toThrow("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
  });

  it("rejects cyclic executables, oversized shebangs, and closure limits", async () => {
    const input = fixture();
    const cycle = join(input.root, "cycle");
    mkdirSync(cycle);
    symlinkSync("b", join(cycle, "a"));
    symlinkSync("a", join(cycle, "b"));
    await expect(snapshotVerificationToolchain(
      [{ id: "verify-1", command: "a", args: [] }], input.destination, { env: { PATH: cycle } }
    )).rejects.toThrow("AUTOMATED_TEST_TOOLCHAIN_INVALID");

    writeFileSync(join(input.npm, "bin", "npm-cli.js"), `#!${"x".repeat(5000)}\n`);
    await expect(snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: [] }], input.destination, { env: { PATH: input.shim } }
    )).rejects.toThrow("AUTOMATED_TEST_TOOLCHAIN_INVALID");

    writeFileSync(join(input.npm, "bin", "npm-cli.js"), "#!/usr/bin/env node\n");
    await expect(snapshotVerificationToolchain(
      [{ id: "verify-1", command: "npm", args: [] }], input.destination,
      { env: { PATH: input.shim }, limits: { maxFiles: 2 } }
    )).rejects.toThrow("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  });
});
