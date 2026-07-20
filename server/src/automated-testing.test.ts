import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSandboxProfile,
  buildVerificationPlan,
  sanitizedVerificationEnvironment,
  runAutomatedTesting
} from "./automated-testing.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function initializeSource(source: string) {
  execFileSync("git", ["-C", source, "init"]);
  execFileSync("git", ["-C", source, "add", "--all"]);
}

function initializeTarget() {
  const target = mkdtempSync(join(tmpdir(), "automated-test-target-"));
  directories.push(target);
  execFileSync("git", ["-C", target, "init"]);
  return target;
}

describe("automated testing safety", () => {
  it("builds commands only from frozen rules and traces every criterion", () => {
    const plan = buildVerificationPlan(
      [{ command: "npm", argsPrefix: ["test", "--", "orders"] }],
      ["Order contract passes", "No regression"]
    );
    expect(plan.commands).toEqual([{ id: "verify-1", command: "npm", args: ["test", "--", "orders"] }]);
    expect(plan.acceptanceTrace).toEqual([
      { criterion: "Order contract passes", commandIds: ["verify-1"] },
      { criterion: "No regression", commandIds: ["verify-1"] }
    ]);
  });

  it("denies network and writes to real worktree and Git metadata", () => {
    const profile = buildSandboxProfile({
      verificationRoot: "/tmp/verify", targetWorktree: "/repo/worktree", gitCommonDir: "/repo/.git"
    });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("/repo/worktree");
    expect(profile).toContain("/repo/.git");
    expect(profile).toContain("/tmp/verify");
    expect(profile).toContain('(import "dyld-support.sb")');
    expect(profile).not.toContain("(allow file-read*)");
  });

  it("constructs a minimal environment without credentials or proxies", () => {
    const env = sanitizedVerificationEnvironment("/tmp/home", "/tmp/tmp", {
      PATH: "/usr/bin", HOME: "/real/home", SSH_AUTH_SOCK: "secret", GITHUB_TOKEN: "secret",
      HTTPS_PROXY: "http://proxy", GIT_CONFIG_GLOBAL: "/real/config", LANG: "en_US.UTF-8"
    });
    expect(env).toEqual({
      PATH: "/usr/bin", HOME: "/tmp/home", TMPDIR: "/tmp/tmp", LANG: "en_US.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0"
    });
  });

  it("fails closed when sandbox-exec is unavailable", async () => {
    await expect(runAutomatedTesting({
      sourceWorktree: "/tmp/source", targetWorktree: "/tmp/target", gitCommonDir: "/tmp/repo/.git",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["passes"]
    }, { platform: "linux" })).resolves.toMatchObject({
      result: "failed", error: "AUTOMATED_TEST_SANDBOX_UNAVAILABLE", commandResults: []
    });
  });

  it("runs fixed argv with shell disabled in a disposable copy and records trace", async () => {
    const source = mkdtempSync(join(tmpdir(), "automated-test-source-")); directories.push(source);
    writeFileSync(join(source, "package.json"), "{}\n");
    initializeSource(source);
    writeFileSync(join(source, "new-test.ts"), "export {};\n");
    const target = initializeTarget();
    const calls: Array<{ file: string; args: string[]; options: any }> = [];
    const execFile = vi.fn(async (file: string, args: string[], options: any) => {
      calls.push({ file, args, options });
      expect(existsSync(join(options.cwd, "package.json"))).toBe(true);
      expect(existsSync(join(options.cwd, "new-test.ts"))).toBe(true);
      return { stdout: "ok\n", stderr: "" };
    });
    const result = await runAutomatedTesting({
      sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile });

    expect(result).toMatchObject({
      result: "passed",
      commandResults: [{ id: "verify-1", command: "npm", args: ["test"], exitCode: 0 }],
      acceptanceTrace: [{ criterion: "tests pass", commandIds: ["verify-1"], passed: true }]
    });
    const command = calls.find((call) => call.file === "/usr/bin/sandbox-exec")!;
    expect(command.args.slice(-2)).toEqual(["npm", "test"]);
    expect(command.options).toMatchObject({ shell: false, timeout: 300_000, maxBuffer: 1_048_576 });
    expect(command.options.cwd).not.toBe(source);
    expect(command.options.cwd).not.toBe(target);
  });

  it("canonicalizes every sandbox path before composing rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "automated-test-canonical-")); directories.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source); mkdirSync(target);
    writeFileSync(join(source, "package.json"), "{}\n");
    initializeSource(source);
    execFileSync("git", ["-C", target, "init"]);
    let canonicalVerificationRoot = "";
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = vi.fn(async (file: string, args: string[], options: any) => {
      calls.push({ file, args });
      canonicalVerificationRoot = dirname(realpathSync(options.cwd));
      return { stdout: "ok\n", stderr: "" };
    });

    await runAutomatedTesting({
      sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile });

    const profile = calls.find((call) => call.file === "/usr/bin/sandbox-exec")!.args[1]!;
    expect(profile).toContain(`(subpath "${canonicalVerificationRoot}")`);
    expect(profile).toContain(`(subpath "${realpathSync(target)}")`);
    expect(profile).toContain(`(subpath "${realpathSync(join(target, ".git"))}")`);
  });

  it("rejects a source-tree symlink before running any command", async () => {
    const root = mkdtempSync(join(tmpdir(), "automated-test-link-")); directories.push(root);
    const source = join(root, "source");
    const outside = join(root, "outside-secret");
    writeFileSync(outside, "SECRET\n");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(source);
    symlinkSync(outside, join(source, "linked-secret"));
    initializeSource(source);
    const execFile = vi.fn();

    await expect(runAutomatedTesting({
      sourceWorktree: source, targetWorktree: "/real/target", gitCommonDir: "/real/repo/.git",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile }))
      .resolves.toMatchObject({ result: "failed", error: "AUTOMATED_TEST_MATERIALIZATION_UNSAFE" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("preserves an internal relative symlink inside the disposable tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "automated-test-internal-link-")); directories.push(root);
    const source = join(root, "source");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(source, "packages"), { recursive: true });
    writeFileSync(join(source, "packages", "tool.js"), "ok\n");
    symlinkSync("packages/tool.js", join(source, "tool.js"));
    initializeSource(source);
    const target = initializeTarget();
    const execFile = vi.fn(async (_file: string, _args: string[], options: any) => {
      const { readlinkSync } = await import("node:fs");
      expect(readlinkSync(join(options.cwd, "tool.js"))).toBe("packages/tool.js");
      return { stdout: "ok", stderr: "" };
    });

    await expect(runAutomatedTesting({
      sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile }))
      .resolves.toMatchObject({ result: "passed" });
  });

  it("excludes ignored artifacts that are not part of the immutable implementation evidence", async () => {
    const source = mkdtempSync(join(tmpdir(), "automated-test-ignored-")); directories.push(source);
    mkdirSync(join(source, "ignored"));
    writeFileSync(join(source, ".gitignore"), "ignored/\n");
    writeFileSync(join(source, "tracked.txt"), "tracked\n");
    writeFileSync(join(source, "ignored", "untrusted-tool"), "modified outside evidence\n");
    initializeSource(source);
    const target = initializeTarget();
    const execFile = vi.fn(async (_file: string, _args: string[], options: any) => {
      expect(existsSync(join(options.cwd, "tracked.txt"))).toBe(true);
      expect(existsSync(join(options.cwd, "ignored", "untrusted-tool"))).toBe(false);
      return { stdout: "ok", stderr: "" };
    });

    await expect(runAutomatedTesting({
      sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile }))
      .resolves.toMatchObject({ result: "passed" });
  });

  it("records an explicit failure when excluded node_modules makes the fixed command fail", async () => {
    const source = mkdtempSync(join(tmpdir(), "automated-test-missing-deps-")); directories.push(source);
    mkdirSync(join(source, "node_modules"));
    writeFileSync(join(source, ".gitignore"), "node_modules/\n");
    writeFileSync(join(source, "package.json"), "{}\n");
    writeFileSync(join(source, "node_modules", "untrusted-dependency"), "ignored\n");
    initializeSource(source);
    const target = initializeTarget();
    const execFile = vi.fn(async (_file: string, _args: string[], options: any) => {
      expect(existsSync(join(options.cwd, "node_modules"))).toBe(false);
      throw Object.assign(new Error("dependency unavailable"), {
        code: 1, stdout: "", stderr: "missing dependency"
      });
    });

    await expect(runAutomatedTesting({
      sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], acceptanceCriteria: ["tests pass"]
    }, { platform: "darwin", sandboxExecutableAvailable: async () => true, execFile }))
      .resolves.toMatchObject({
        result: "failed",
        commandResults: [{ id: "verify-1", exitCode: 1, stderr: "missing dependency" }],
        acceptanceTrace: [{ criterion: "tests pass", commandIds: ["verify-1"], passed: false }]
      });
  });

  it.skipIf(process.platform !== "darwin" || process.env.RUN_MACOS_SANDBOX_ACCEPTANCE !== "1")(
    "contains real target Git, publication, and network mutation attempts",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "automated-test-sandbox-marker-")); directories.push(root);
      const source = join(root, "source");
      const target = join(root, "target");
      mkdirSync(source); mkdirSync(target);
      execFileSync("git", ["-C", target, "init", "-b", "main"]);
      execFileSync("git", ["-C", target, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", target, "config", "user.name", "Test"]);
      writeFileSync(join(target, "tracked.txt"), "before\n");
      execFileSync("git", ["-C", target, "add", "--all"]);
      execFileSync("git", ["-C", target, "commit", "-m", "base"]);
      const headBefore = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const refsBefore = execFileSync("git", ["-C", target, "show-ref"], { encoding: "utf8" });
      const marker = join(target, ".git", "sandbox-marker");
      const script = join(source, "probe.sh");
      writeFileSync(script, `set +e
printf hacked > '${marker}'; echo git_write:$?
git -C '${target}' commit --allow-empty -m hacked >/dev/null 2>&1; echo commit:$?
git -C '${target}' tag hacked >/dev/null 2>&1; echo tag:$?
curl --max-time 2 https://example.com >/dev/null 2>&1; echo network:$?
if command -v gh >/dev/null 2>&1; then gh api user >/dev/null 2>&1; echo gh:$?; else echo gh:unavailable; fi
exit 0
`);
      initializeSource(source);

      const result = await runAutomatedTesting({
        sourceWorktree: source, targetWorktree: target, gitCommonDir: join(target, ".git"),
        allowedCommands: [{ command: "/bin/sh", argsPrefix: ["probe.sh"] }], acceptanceCriteria: ["sandbox contains mutations"]
      });

      expect(result.result, JSON.stringify(result.commandResults[0])).toBe("passed");
      const output = result.commandResults[0]!.stdout;
      for (const attempt of ["git_write", "commit", "tag", "network"]) expect(output).toMatch(new RegExp(`${attempt}:[1-9]`));
      expect(output).toMatch(/gh:(?:unavailable|[1-9])/);
      expect(existsSync(marker)).toBe(false);
      expect(execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(headBefore);
      expect(execFileSync("git", ["-C", target, "show-ref"], { encoding: "utf8" })).toBe(refsBefore);
    }
  );
});
