import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const COMMAND_TIMEOUT_MS = 300_000;
const COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface FrozenCommand { command: string; argsPrefix?: string[] }
export interface VerificationCommand { id: string; command: string; args: string[] }

export function buildVerificationPlan(commands: FrozenCommand[], acceptanceCriteria: string[]) {
  const planned = commands.map((rule, index) => {
    validateCommand(rule);
    return { id: `verify-${index + 1}`, command: rule.command, args: [...(rule.argsPrefix ?? [])] };
  });
  const commandIds = planned.map((command) => command.id);
  return {
    commands: planned,
    acceptanceTrace: acceptanceCriteria.map((criterion) => ({ criterion, commandIds: [...commandIds] }))
  };
}

export function buildSandboxProfile(input: {
  verificationRoot: string;
  targetWorktree: string;
  gitCommonDir: string;
}) {
  return `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process*)
(allow file-read*
  (subpath ${sandboxLiteral(input.verificationRoot)})
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library/Apple")
  (subpath "/private/etc")
  (literal "/dev/null")
  (literal "/dev/urandom"))
(allow file-write* (subpath ${sandboxLiteral(input.verificationRoot)}))
(deny file-write* (subpath ${sandboxLiteral(input.targetWorktree)}))
(deny file-write* (subpath ${sandboxLiteral(input.gitCommonDir)}))
(deny network*)`;
}

export function sanitizedVerificationEnvironment(
  home: string,
  temporaryDirectory: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: temporaryDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
  for (const key of ["LANG", "LC_ALL"]) if (source[key]) env[key] = source[key];
  return env;
}

export interface AutomatedTestingInput {
  sourceWorktree: string;
  targetWorktree: string;
  gitCommonDir: string;
  allowedCommands: FrozenCommand[];
  acceptanceCriteria: string[];
}

export interface CommandResult {
  id: string;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface AutomatedTestingResult {
  result: "passed" | "failed";
  error?: string;
  commandResults: CommandResult[];
  acceptanceTrace: Array<{ criterion: string; commandIds: string[]; passed: boolean }>;
}

export interface AutomatedTestingDependencies {
  platform?: NodeJS.Platform;
  sandboxExecutableAvailable?: () => Promise<boolean>;
  execFile?: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
}

export async function runAutomatedTesting(
  input: AutomatedTestingInput,
  dependencies: AutomatedTestingDependencies = {}
): Promise<AutomatedTestingResult> {
  if ((dependencies.platform ?? process.platform) !== "darwin"
    || !(await (dependencies.sandboxExecutableAvailable ?? defaultSandboxAvailable)())) {
    return { result: "failed", error: "AUTOMATED_TEST_SANDBOX_UNAVAILABLE", commandResults: [], acceptanceTrace: [] };
  }
  const plan = buildVerificationPlan(input.allowedCommands, input.acceptanceCriteria);
  if (plan.commands.length === 0) {
    return {
      result: "failed", error: "AUTOMATED_TEST_COMMANDS_UNAVAILABLE", commandResults: [],
      acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed: false }))
    };
  }
  const parent = await mkdtemp(join(tmpdir(), "ai-workflow-verification-"));
  const verificationRoot = join(parent, "worktree");
  try {
    try {
      await materializeVerificationTree(input.sourceWorktree, verificationRoot);
    } catch (error) {
      if (error instanceof Error && error.message === "AUTOMATED_TEST_MATERIALIZATION_UNSAFE") {
        return {
          result: "failed", error: error.message, commandResults: [],
          acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed: false }))
        };
      }
      throw error;
    }
    const home = join(parent, "home");
    const temporaryDirectory = join(parent, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    const [canonicalParent, canonicalTargetWorktree, canonicalGitCommonDir] = await Promise.all([
      realpath(parent), realpath(input.targetWorktree), realpath(input.gitCommonDir)
    ]);
    const profile = buildSandboxProfile({
      verificationRoot: canonicalParent,
      targetWorktree: canonicalTargetWorktree,
      gitCommonDir: canonicalGitCommonDir
    });
    const env = sanitizedVerificationEnvironment(home, temporaryDirectory);
    const run = dependencies.execFile ?? (async (file, args, options) => execFileAsync(file, args, options as any));
    const commandResults: CommandResult[] = [];
    for (const command of plan.commands) {
      try {
        const output = await run(SANDBOX_EXEC, ["-p", profile, command.command, ...command.args], {
          cwd: join(canonicalParent, "worktree"),
          env,
          shell: false,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: COMMAND_OUTPUT_BYTES,
          windowsHide: true
        });
        commandResults.push({
          ...command, exitCode: 0, stdout: String(output.stdout ?? ""), stderr: String(output.stderr ?? ""), timedOut: false
        });
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
        commandResults.push({
          ...command,
          exitCode: typeof failure.code === "number" ? failure.code : -1,
          stdout: String(failure.stdout ?? ""),
          stderr: String(failure.stderr ?? ""),
          timedOut: failure.killed === true || failure.signal === "SIGTERM"
        });
      }
    }
    const passed = commandResults.every((result) => result.exitCode === 0 && !result.timedOut);
    return {
      result: passed ? "passed" : "failed",
      commandResults,
      acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed }))
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function materializeVerificationTree(sourceWorktree: string, verificationRoot: string) {
  const sourceRoot = await realpath(sourceWorktree).catch(materializationUnsafe);
  const ignored = await ignoredSourcePaths(sourceRoot);
  await cp(sourceRoot, verificationRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: async (source) => {
      const rel = relative(sourceRoot, source);
      const segments = rel ? rel.split(sep) : [];
      if (segments.some((segment) => segment.toLowerCase() === ".git")) return false;
      const gitPath = segments.join("/");
      if ([...ignored].some((ignoredPath) => gitPath === ignoredPath || gitPath.startsWith(`${ignoredPath}/`))) {
        return false;
      }
      const entry = await lstat(source).catch(materializationUnsafe);
      if (entry.isDirectory() || entry.isFile()) return true;
      if (!entry.isSymbolicLink()) materializationUnsafe();
      const link = await readlink(source).catch(materializationUnsafe);
      if (isAbsolute(link)) materializationUnsafe();
      const lexicalTarget = resolve(dirname(source), link);
      if (!isInside(sourceRoot, lexicalTarget)
        || relative(sourceRoot, lexicalTarget).split(sep).some((segment) => segment.toLowerCase() === ".git")) {
        materializationUnsafe();
      }
      const canonicalTarget = await realpath(lexicalTarget).catch(materializationUnsafe);
      if (!isInside(sourceRoot, canonicalTarget)) materializationUnsafe();
      const targetEntry = await lstat(canonicalTarget).catch(materializationUnsafe);
      if (!targetEntry.isDirectory() && !targetEntry.isFile()) materializationUnsafe();
      return true;
    }
  });
}

async function ignoredSourcePaths(sourceRoot: string) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", sourceRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"
    ], { env: verificationGitEnvironment(), maxBuffer: COMMAND_OUTPUT_BYTES });
    return new Set(stdout.split("\0").filter(Boolean).map((path) => path.endsWith("/") ? path.slice(0, -1) : path));
  } catch {
    materializationUnsafe();
  }
}

async function defaultSandboxAvailable() {
  try { await access(SANDBOX_EXEC, constants.X_OK); return true; } catch { return false; }
}

function validateCommand(rule: FrozenCommand) {
  if (!rule || typeof rule !== "object" || typeof rule.command !== "string" || !rule.command.length
    || rule.command.includes("\0") || /[\r\n]/.test(rule.command)
    || (rule.argsPrefix !== undefined && (!Array.isArray(rule.argsPrefix)
      || rule.argsPrefix.some((arg) => typeof arg !== "string" || arg.includes("\0"))))) {
    throw new Error("AUTOMATED_TEST_COMMAND_INVALID");
  }
}

function sandboxLiteral(path: string) {
  if (!path || path.includes("\0") || /[\r\n]/.test(path)) throw new Error("AUTOMATED_TEST_PATH_INVALID");
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isInside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function materializationUnsafe(): never {
  throw new Error("AUTOMATED_TEST_MATERIALIZATION_UNSAFE");
}

function verificationGitEnvironment() {
  const env = { ...process.env };
  const exact = new Set([
    "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
    "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"
  ]);
  for (const key of Object.keys(env)) {
    if (exact.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_0 = "false";
  return env;
}
