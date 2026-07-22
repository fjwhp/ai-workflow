import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { MAX_AUTOMATED_TEST_COMMANDS } from "@ai-workflow/shared";
import { type EvidenceManifest } from "./evidence-tree.js";
import { redactSensitive } from "./redaction.js";
import { runManagedProcess } from "./process-execution.js";
import {
  snapshotVerificationToolchainBounded,
  type VerificationToolchainSnapshot
} from "./verification-toolchain.js";
import { materializeVerificationManifest } from "./verification-fs-helper.js";
import { cleanupVerificationDirectory, createVerificationDirectory } from "./verification-cleanup.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const COMMAND_TIMEOUT_MS = 300_000;
const COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface FrozenCommand { command: string; argsPrefix?: string[] }
export interface VerificationCommand { id: string; command: string; args: string[] }

export function buildVerificationPlan(commands: FrozenCommand[], acceptanceCriteria: string[]) {
  if (commands.length > MAX_AUTOMATED_TEST_COMMANDS) {
    throw new Error("AUTOMATED_TEST_COMMANDS_LIMIT_EXCEEDED");
  }
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
  toolchainRoot?: string;
  verificationWorktree?: string;
  home?: string;
  temporaryDirectory?: string;
}) {
  return `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read-metadata
${verificationRootAncestors(input.verificationRoot)
    .map((path) => `  (literal ${sandboxLiteral(path)})`).join("\n")})
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
${[input.verificationWorktree, input.home, input.temporaryDirectory].filter(Boolean)
    .map((path) => `(allow file-write* (subpath ${sandboxLiteral(path!)}))`).join("\n")}
${input.toolchainRoot ? `(deny file-write* (subpath ${sandboxLiteral(input.toolchainRoot)}))` : ""}
(deny file-write* (subpath ${sandboxLiteral(input.targetWorktree)}))
(deny file-write* (subpath ${sandboxLiteral(input.gitCommonDir)}))
(deny network*)`;
}

function verificationRootAncestors(verificationRoot: string) {
  const ancestors: string[] = [];
  let current = dirname(verificationRoot);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
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

export interface IsolatedVerificationInput {
  sourceManifest: EvidenceManifest;
  sensitivePatterns: string[];
  targetWorktree: string;
  gitCommonDir: string;
  allowedCommands: FrozenCommand[];
  acceptanceCriteria: string[];
}

export interface AutomatedTestingInput extends IsolatedVerificationInput {
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
  error?: string;
}

export interface AutomatedTestingResult {
  result: "passed" | "failed";
  error?: string;
  commandResults: CommandResult[];
  acceptanceTrace: Array<{ criterion: string; commandIds: string[]; passed: boolean }>;
  toolchain?: {
    fingerprint: string;
    manifest: VerificationToolchainSnapshot["manifest"];
    commands: Array<{
      id: string; configuredCommand: string; executable: string; args: string[];
    }>;
  };
}

export interface AutomatedTestingDependencies {
  platform?: NodeJS.Platform;
  sandboxExecutableAvailable?: () => Promise<boolean>;
  execFile?: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
  runManagedProcess?: typeof runManagedProcess;
  snapshotToolchain?: typeof snapshotVerificationToolchainBounded;
  materializeManifest?: typeof materializeVerificationManifest;
  cleanupDirectory?: typeof cleanupVerificationDirectory;
  now?: () => number;
}

export interface VerificationExecutionLease {
  assertCurrent(): void | Promise<void>;
  deadlineAt?: number;
}

export async function runAutomatedTesting(
  input: AutomatedTestingInput,
  dependencies: AutomatedTestingDependencies = {},
  signal?: AbortSignal
): Promise<AutomatedTestingResult> {
  return runIsolatedVerification(input, dependencies, signal);
}

export async function runIsolatedVerification(
  input: IsolatedVerificationInput,
  dependencies: AutomatedTestingDependencies = {},
  signal?: AbortSignal,
  lease?: VerificationExecutionLease
): Promise<AutomatedTestingResult> {
  const now = dependencies.now ?? Date.now;
  const deadline = Math.min(now() + COMMAND_TIMEOUT_MS, lease?.deadlineAt ?? Number.POSITIVE_INFINITY);
  let plan: ReturnType<typeof buildVerificationPlan>;
  try {
    plan = buildVerificationPlan(input.allowedCommands, input.acceptanceCriteria);
  } catch (error) {
    if (error instanceof Error && error.message === "AUTOMATED_TEST_COMMANDS_LIMIT_EXCEEDED") {
      return {
        result: "failed", error: error.message, commandResults: [], acceptanceTrace: []
      };
    }
    throw error;
  }
  throwIfAutomatedTestAborted(signal);
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return { result: "failed", error: "AUTOMATED_TEST_SANDBOX_UNAVAILABLE", commandResults: [], acceptanceTrace: [] };
  }
  const sandboxAvailable = await (dependencies.sandboxExecutableAvailable ?? defaultSandboxAvailable)();
  throwIfAutomatedTestAborted(signal);
  if (!sandboxAvailable) {
    return { result: "failed", error: "AUTOMATED_TEST_SANDBOX_UNAVAILABLE", commandResults: [], acceptanceTrace: [] };
  }
  if (plan.commands.length === 0) {
    return {
      result: "failed", error: "AUTOMATED_TEST_COMMANDS_UNAVAILABLE", commandResults: [],
      acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed: false }))
    };
  }
  if (now() >= deadline) return automatedDeadlineResult(plan);
  const parent = await createVerificationDirectory();
  const verificationRoot = join(parent, "worktree");
  const executeVerification = async (): Promise<AutomatedTestingResult> => {
    throwIfAutomatedTestAborted(signal);
    try {
      const remaining = Math.ceil(deadline - now());
      if (remaining <= 0) return automatedDeadlineResult(plan);
      await (dependencies.materializeManifest ?? materializeVerificationManifest)(
        verificationRoot, input.sourceManifest,
        { sensitivePatterns: input.sensitivePatterns, timeoutMs: remaining, signal }
      );
    } catch (error) {
      if (automatedTestAborted(signal, error)) throw automatedTestAbort(error);
      if (error instanceof Error && error.message === "AUTOMATED_TEST_DEADLINE_EXCEEDED") {
        return automatedDeadlineResult(plan);
      }
      if (error instanceof Error && (error.message === "CODING_EVIDENCE_MANIFEST_INVALID"
        || error.message === "CODING_EVIDENCE_MANIFEST_SENSITIVE"
        || error.message === "AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED")) {
        return {
          result: "failed",
          error: error.message === "AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED"
            ? error.message : "AUTOMATED_TEST_MATERIALIZATION_UNSAFE",
          commandResults: [],
          acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed: false }))
        };
      }
      throw error;
    }
    throwIfAutomatedTestAborted(signal);
    if (now() >= deadline) return automatedDeadlineResult(plan);
    const home = join(parent, "home");
    const temporaryDirectory = join(parent, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    throwIfAutomatedTestAborted(signal);
    if (now() >= deadline) return automatedDeadlineResult(plan);
    const [canonicalParent, canonicalTargetWorktree, canonicalGitCommonDir, canonicalHome, canonicalTemporaryDirectory]
      = await Promise.all([
        realpath(parent), realpath(input.targetWorktree), realpath(input.gitCommonDir),
        realpath(home), realpath(temporaryDirectory)
    ]);
    throwIfAutomatedTestAborted(signal);
    if (now() >= deadline) return automatedDeadlineResult(plan);
    let toolchain: VerificationToolchainSnapshot | undefined;
    if (!dependencies.execFile) {
      try {
        const toolchainRemaining = Math.ceil(deadline - now());
        if (toolchainRemaining <= 0) return automatedDeadlineResult(plan);
        toolchain = await (dependencies.snapshotToolchain ?? snapshotVerificationToolchainBounded)(
          plan.commands, canonicalParent, { env: process.env, timeoutMs: toolchainRemaining, signal }
        );
      } catch (error) {
        if (automatedTestAborted(signal, error)) throw automatedTestAbort(error);
        if (error instanceof Error && error.message === "AUTOMATED_TEST_DEADLINE_EXCEEDED") {
          return automatedDeadlineResult(plan);
        }
        throw error;
      }
    }
    if (now() >= deadline) return automatedDeadlineResult(plan, toolchain);
    const profile = buildSandboxProfile({
      verificationRoot: canonicalParent,
      targetWorktree: canonicalTargetWorktree,
      gitCommonDir: canonicalGitCommonDir,
      verificationWorktree: join(canonicalParent, "worktree"),
      home: canonicalHome,
      temporaryDirectory: canonicalTemporaryDirectory,
      ...(toolchain ? { toolchainRoot: toolchain.root } : {})
    });
    const env = sanitizedVerificationEnvironment(canonicalHome, canonicalTemporaryDirectory);
    if (toolchain) env.PATH = `${toolchain.binDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const commandResults: CommandResult[] = [];
    let deadlineExceeded = false;
    for (let index = 0; index < plan.commands.length; index += 1) {
      throwIfAutomatedTestAborted(signal);
      const command = plan.commands[index]!;
      const remaining = deadline - now();
      if (remaining <= 0) {
        deadlineExceeded = true;
        commandResults.push(...plan.commands.slice(index).map(deadlineCommandResult));
        break;
      }
      await lease?.assertCurrent();
      throwIfAutomatedTestAborted(signal);
      if (!dependencies.execFile) {
        const frozenCommand = toolchain?.commands[index];
        if (!frozenCommand || frozenCommand.id !== command.id) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
        let output: Awaited<ReturnType<typeof runManagedProcess>>;
        try {
          output = await (dependencies.runManagedProcess ?? runManagedProcess)(
            SANDBOX_EXEC, ["-p", profile, frozenCommand.file, ...frozenCommand.args], {
              cwd: join(canonicalParent, "worktree"), env,
              timeoutMs: remaining, maxOutputBytes: COMMAND_OUTPUT_BYTES, signal
            }
          );
          throwIfAutomatedTestAborted(signal);
          await lease?.assertCurrent();
          throwIfAutomatedTestAborted(signal);
        } catch (error) {
          if (automatedTestAborted(signal, error)) throw automatedTestAbort(error);
          await lease?.assertCurrent();
          throwIfAutomatedTestAborted(signal);
          if (error instanceof Error && error.message === "MANAGED_PROCESS_DEADLINE_EXCEEDED") {
            deadlineExceeded = true;
            commandResults.push(...plan.commands.slice(index).map(deadlineCommandResult));
            break;
          }
          throw error;
        }
        const result: CommandResult = {
          ...command, exitCode: output.exitCode,
          stdout: redactSensitive(output.stdout, input.sensitivePatterns),
          stderr: redactSensitive(output.stderr, input.sensitivePatterns),
          timedOut: output.timedOut, outputOverflow: output.outputOverflow
        };
        if (output.timedOut || now() > deadline) {
          deadlineExceeded = true;
          commandResults.push({
            ...result, exitCode: -1, timedOut: true, error: "AUTOMATED_TEST_DEADLINE_EXCEEDED"
          });
          commandResults.push(...plan.commands.slice(index + 1).map(deadlineCommandResult));
          break;
        }
        commandResults.push(result);
        continue;
      }
      let output: { stdout?: unknown; stderr?: unknown } | undefined;
      let commandError: unknown;
      try {
        output = await dependencies.execFile(SANDBOX_EXEC, ["-p", profile, command.command, ...command.args], {
          cwd: join(canonicalParent, "worktree"),
          env,
          shell: false,
          timeout: remaining,
          maxBuffer: COMMAND_OUTPUT_BYTES,
          windowsHide: true,
          signal
        });
        throwIfAutomatedTestAborted(signal);
      } catch (error) {
        if (automatedTestAborted(signal, error)) throw automatedTestAbort(error);
        commandError = error;
      }
      await lease?.assertCurrent();
      throwIfAutomatedTestAborted(signal);
      if (!commandError) {
        const result: CommandResult = {
          ...command, exitCode: 0,
          stdout: redactSensitive(String(output?.stdout ?? ""), input.sensitivePatterns),
          stderr: redactSensitive(String(output?.stderr ?? ""), input.sensitivePatterns),
          timedOut: false, outputOverflow: false
        };
        if (now() > deadline) {
          deadlineExceeded = true;
          commandResults.push({
            ...result, exitCode: -1, timedOut: true, error: "AUTOMATED_TEST_DEADLINE_EXCEEDED"
          });
          commandResults.push(...plan.commands.slice(index + 1).map(deadlineCommandResult));
          break;
        }
        commandResults.push(result);
      } else {
        const failure = commandError as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
        const timedOut = failure.killed === true || failure.signal === "SIGTERM";
        commandResults.push({
          ...command,
          exitCode: typeof failure.code === "number" ? failure.code : -1,
          stdout: redactSensitive(String(failure.stdout ?? ""), input.sensitivePatterns),
          stderr: redactSensitive(String(failure.stderr ?? ""), input.sensitivePatterns),
          timedOut, outputOverflow: false,
          ...(timedOut ? { error: "AUTOMATED_TEST_DEADLINE_EXCEEDED" } : {})
        });
        if (timedOut) {
          deadlineExceeded = true;
          commandResults.push(...plan.commands.slice(index + 1).map(deadlineCommandResult));
          break;
        }
      }
    }
    throwIfAutomatedTestAborted(signal);
    const passed = !deadlineExceeded
      && commandResults.every((result) => result.exitCode === 0 && !result.timedOut && !result.outputOverflow);
    return {
      result: passed ? "passed" : "failed",
      ...(deadlineExceeded ? { error: "AUTOMATED_TEST_DEADLINE_EXCEEDED" } : {}),
      commandResults,
      acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed })),
      ...(toolchain ? { toolchain: toolchainEvidence(toolchain) } : {})
    };
  };
  let pendingResult: AutomatedTestingResult | undefined;
  let pendingError: unknown;
  let executionFailed = false;
  try {
    pendingResult = await executeVerification();
  } catch (error) {
    executionFailed = true;
    pendingError = error;
  }
  await (dependencies.cleanupDirectory ?? cleanupVerificationDirectory)(parent);
  throwIfAutomatedTestAborted(signal);
  if (executionFailed) throw pendingError;
  return pendingResult!;
}

function automatedTestAborted(signal: AbortSignal | undefined, error: unknown) {
  return signal?.aborted === true || (error instanceof Error && [
    "AUTOMATED_TEST_ABORTED", "MANAGED_PROCESS_ABORTED", "TRUSTED_SUBPROCESS_ABORTED"
  ].includes(error.message));
}

function automatedTestAbort(cause?: unknown) {
  return cause instanceof Error && cause.message === "AUTOMATED_TEST_ABORTED"
    ? cause
    : new Error("AUTOMATED_TEST_ABORTED", cause === undefined ? undefined : { cause });
}

function throwIfAutomatedTestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw automatedTestAbort(signal.reason);
}

function deadlineCommandResult(command: VerificationCommand): CommandResult {
  return {
    ...command, exitCode: -1, stdout: "", stderr: "", timedOut: true, outputOverflow: false,
    error: "AUTOMATED_TEST_DEADLINE_EXCEEDED"
  };
}

function automatedDeadlineResult(
  plan: ReturnType<typeof buildVerificationPlan>,
  toolchain?: VerificationToolchainSnapshot
): AutomatedTestingResult {
  return {
    result: "failed", error: "AUTOMATED_TEST_DEADLINE_EXCEEDED",
    commandResults: plan.commands.map(deadlineCommandResult),
    acceptanceTrace: plan.acceptanceTrace.map((trace) => ({ ...trace, passed: false })),
    ...(toolchain ? { toolchain: toolchainEvidence(toolchain) } : {})
  };
}

function toolchainEvidence(toolchain: VerificationToolchainSnapshot) {
  return {
    fingerprint: toolchain.fingerprint,
    manifest: toolchain.manifest,
    commands: toolchain.commands.map((command) => ({
      id: command.id,
      configuredCommand: command.configuredCommand,
      executable: relativeToolchainPath(command.file, toolchain.root),
      args: command.args.map((argument) => {
        const path = relativeToolchainPath(argument, toolchain.root, false);
        return path === undefined ? argument : `toolchain:${path}`;
      })
    }))
  };
}

function relativeToolchainPath(path: string, root: string): string;
function relativeToolchainPath(path: string, root: string, required: false): string | undefined;
function relativeToolchainPath(path: string, root: string, required = true): string | undefined {
  if (!isAbsolute(path)) {
    if (required) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    return undefined;
  }
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    if (required) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    return undefined;
  }
  return value.split(sep).join("/");
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
