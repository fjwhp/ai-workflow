import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeEvidenceManifest, type EvidenceManifest } from "./evidence-tree.js";
import { redactSensitive } from "./redaction.js";
import { runManagedProcess } from "./process-execution.js";

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
  sourceManifest: EvidenceManifest;
  sensitivePatterns: string[];
  targetWorktree: string;
  gitCommonDir: string;
  allowedCommands: FrozenCommand[];
  acceptanceCriteria: string[];
  untrustedEvidence: {
    requirement: unknown;
    approvedArtifacts: unknown[];
    implementation: {
      diff: string;
      changedFiles: Array<
        | { path: string; status: "deleted" }
        | { path: string; status: "added" | "modified"; kind: "text"; content: string }
        | { path: string; status: "added" | "modified"; kind: "binary"; size: number; sha256: string }
      >;
    };
    codingEvidence: { id: string; evidenceVersion: number; diffHash: string };
    deliverySnapshot: {
      repoPath: string; branch: string; baseBranch: string; worktreePath: string; headCommit: string;
      moduleIds: string[]; acceptanceCriteria: string[]; sensitivePatterns: string[];
      allowedCommands: FrozenCommand[];
    };
  };
}

export interface CommandResult {
  id: string;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
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
      await materializeEvidenceManifest(verificationRoot, input.sourceManifest, {
        sensitivePatterns: input.sensitivePatterns
      });
    } catch (error) {
      if (error instanceof Error && (error.message === "CODING_EVIDENCE_MANIFEST_INVALID"
        || error.message === "CODING_EVIDENCE_MANIFEST_SENSITIVE")) {
        return {
          result: "failed", error: "AUTOMATED_TEST_MATERIALIZATION_UNSAFE", commandResults: [],
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
    const commandResults: CommandResult[] = [];
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    for (const command of plan.commands) {
      if (!dependencies.execFile) {
        const output = await runManagedProcess(SANDBOX_EXEC, ["-p", profile, command.command, ...command.args], {
          cwd: join(canonicalParent, "worktree"), env,
          timeoutMs: Math.max(1, deadline - Date.now()), maxOutputBytes: COMMAND_OUTPUT_BYTES
        });
        commandResults.push({
          ...command, exitCode: output.exitCode,
          stdout: redactSensitive(output.stdout, input.sensitivePatterns),
          stderr: redactSensitive(output.stderr, input.sensitivePatterns),
          timedOut: output.timedOut, outputOverflow: output.outputOverflow
        });
        continue;
      }
      try {
        const output = await dependencies.execFile(SANDBOX_EXEC, ["-p", profile, command.command, ...command.args], {
          cwd: join(canonicalParent, "worktree"),
          env,
          shell: false,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: COMMAND_OUTPUT_BYTES,
          windowsHide: true
        });
        commandResults.push({
          ...command, exitCode: 0,
          stdout: redactSensitive(String(output.stdout ?? ""), input.sensitivePatterns),
          stderr: redactSensitive(String(output.stderr ?? ""), input.sensitivePatterns),
          timedOut: false, outputOverflow: false
        });
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
        commandResults.push({
          ...command,
          exitCode: typeof failure.code === "number" ? failure.code : -1,
          stdout: redactSensitive(String(failure.stdout ?? ""), input.sensitivePatterns),
          stderr: redactSensitive(String(failure.stderr ?? ""), input.sensitivePatterns),
          timedOut: failure.killed === true || failure.signal === "SIGTERM", outputOverflow: false
        });
      }
    }
    const passed = commandResults.every((result) => result.exitCode === 0 && !result.timedOut && !result.outputOverflow);
    return {
      result: passed ? "passed" : "failed",
      commandResults,
      acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed }))
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
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
