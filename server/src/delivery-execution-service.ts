import { buildCodingEvidence } from "./coding-evidence.js";
import { runCodingAgent, type CodingAgentInput, type CodingAgentResult } from "./coding-agent.js";
import type { DeliveryExecutionPersistence } from "./delivery-execution-repository.js";
import {
  codeReviewDecision,
  runCodeReview,
  type CodeReviewResult
} from "./ai.js";
import {
  runAutomatedTesting,
  type AutomatedTestingInput,
  type AutomatedTestingResult
} from "./automated-testing.js";
import type { DeliveryQualityCompletion, DeliveryQualityPersistence } from "./delivery-quality-repository.js";
import { getWorktreeSnapshot } from "./repository.js";
import { evidenceFingerprint, evidenceManifestHash } from "./evidence-tree.js";
import { redactSensitive } from "./redaction.js";
import { retryable, type AutomationHandlers } from "./automation-worker.js";
import type { AutomationJob } from "./automation-job-repository.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodingAgent = (input: CodingAgentInput) => Promise<CodingAgentResult>;
type WorktreeSnapshot = Awaited<ReturnType<typeof getWorktreeSnapshot>>;
type TargetState = { head: string; refsHash: string; diffHash: string; gitCommonDir: string };
export interface DeliveryQualityDependencies {
  review?: (input: unknown, signal: AbortSignal) => Promise<CodeReviewResult>;
  testing?: (input: AutomatedTestingInput, signal?: AbortSignal) => Promise<AutomatedTestingResult>;
  inspectTarget?: (worktreePath: string) => Promise<TargetState>;
  reviewTimeoutMs?: number;
}

export type QualityStatus = "running" | "passed" | "failed";

export function qualityGate(input: { review: QualityStatus; testing: QualityStatus }) {
  if (input.review === "failed" || input.testing === "failed") return { status: "failed" as const };
  if (input.review === "passed" && input.testing === "passed") return { status: "passed" as const };
  return { status: "running" as const };
}

export class DeliveryExecutionService {
  constructor(
    private readonly persistence: DeliveryExecutionPersistence,
    private readonly codingAgent: CodingAgent = runCodingAgent,
    private readonly model = process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL || "gpt-5.5",
    private readonly qualityPersistence?: DeliveryQualityPersistence,
    private readonly qualityDependencies: DeliveryQualityDependencies = {}
  ) {
    const reviewTimeoutMs = qualityDependencies.reviewTimeoutMs ?? 300_000;
    if (!Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 86_400_000) {
      throw new Error("DELIVERY_QUALITY_REVIEW_TIMEOUT_INVALID");
    }
  }

  async implement(unitId: string) {
    const claim = this.persistence.claimImplementation(unitId, this.model);
    let result: CodingAgentResult;
    let snapshot: WorktreeSnapshot;
    try {
      result = await this.codingAgent({
        requirement: claim.requirement,
        artifacts: claim.artifacts,
        project: claim.project,
        version: claim.version,
        deliveryContext: claim.deliveryContext
      });
      if (!result.evidenceSnapshot) throw new Error("IMPLEMENTATION_EVIDENCE_REQUIRED");
      snapshot = result.evidenceSnapshot;
      validateImplementationIdentity(claim, result, snapshot);
    } catch (error) {
      try {
        this.persistence.failImplementation(claim, errorText(error));
      } catch (settlementError) {
        throw settlementErrorWithCause(settlementError, error);
      }
      throw error;
    }

    const evidence = buildCodingEvidence({
      diff: snapshot.diff, maxDiffChars: Number.MAX_SAFE_INTEGER, files: snapshot.files,
      additions: snapshot.additions, deletions: snapshot.deletions
    });
    const diagnostics = redactSensitive(Array.isArray(result.diagnostics)
      ? result.diagnostics.map(String).join("\n")
      : String(result.diagnostics ?? ""), claim.deliveryContext.sensitivePatterns);
    const events = redactSensitive(result.events ?? [], claim.deliveryContext.sensitivePatterns);
    const summary = redactSensitive(String(result.summary ?? ""), claim.deliveryContext.sensitivePatterns);
    return this.persistence.completeImplementation(claim, {
      branch: result.branch,
      worktreePath: result.worktreePath,
      baseCommit: result.baseCommit,
      commands: [],
      diff: evidence.diff,
      diffHash: snapshot.evidenceHash,
      changedFiles: snapshot.changedFiles,
      identity: snapshot.identity,
      manifest: snapshot.manifest,
      manifestHash: snapshot.manifestHash,
      originalChars: evidence.originalChars,
      truncated: evidence.truncated,
      files: evidence.files,
      additions: evidence.additions,
      deletions: evidence.deletions,
      diagnostics,
      codexThreadId: result.codexThreadId,
      events,
      output: { runId: result.runId, summary }
    });
  }

  async review(unitId: string, evidenceVersion?: number, claimToken?: string, signal?: AbortSignal) {
    const quality = this.requireQualityPersistence();
    const claim = quality.claim(unitId, evidenceVersion, "code_review", claimToken);
    if (claim.status === "aborted") return { status: "aborted" as const, error: claim.error };
    if (claim.status !== "running") return claim.evidence;
    let snapshot: ReturnType<DeliveryExecutionService["loadImmutableSnapshot"]>;
    try {
      snapshot = this.loadImmutableSnapshot(claim.input.codingEvidence);
    } catch (error) {
      const code = qualityErrorCode(error);
      quality.abort(claim, code);
      return { status: "aborted" as const, error: code };
    }
    let result: CodeReviewResult;
    const deadline = qualityDeadlineSignal(signal, this.qualityDependencies.reviewTimeoutMs ?? 300_000);
    try {
      const review = this.qualityDependencies.review
        ?? ((input: unknown, providerSignal: AbortSignal) => runCodeReview(input, () => {}, providerSignal));
      result = await review({
        requirement: claim.input.requirement,
        approvedArtifacts: claim.input.artifacts,
        deliveryContext: {
          moduleIds: claim.input.snapshot.moduleIds,
          acceptanceCriteria: claim.input.snapshot.acceptanceCriteria
        },
        implementation: { diff: snapshot.diff, changedFiles: snapshot.changedFiles }
      }, deadline.signal);
      if (deadline.signal.aborted) {
        throw deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new Error("DELIVERY_QUALITY_REVIEW_ABORTED");
      }
    } catch (error) {
      throw retryable("DELIVERY_QUALITY_PROVIDER_UNAVAILABLE", error);
    } finally {
      deadline.dispose();
    }
    return quality.complete(claim, { ...codeReviewDecision(result), content: result });
  }

  async test(unitId: string, evidenceVersion?: number, claimToken?: string, signal?: AbortSignal) {
    const quality = this.requireQualityPersistence();
    const claim = quality.claim(unitId, evidenceVersion, "automated_testing", claimToken);
    if (claim.status === "aborted") return { status: "aborted" as const, error: claim.error };
    if (claim.status !== "running") return claim.evidence;
    let snapshot: ReturnType<DeliveryExecutionService["loadImmutableSnapshot"]>;
    try {
      snapshot = this.loadImmutableSnapshot(claim.input.codingEvidence);
    } catch (error) {
      const code = qualityErrorCode(error);
      quality.abort(claim, code);
      return { status: "aborted" as const, error: code };
    }
    const inspectTarget = this.qualityDependencies.inspectTarget ?? inspectTargetState;
    let before: TargetState;
    try {
      before = await inspectTarget(claim.input.snapshot.worktreePath);
      throwIfQualitySignalAborted(signal);
    } catch (error) {
      throw retryable("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE", error);
    }
    if (before.head !== claim.input.snapshot.headCommit) {
      quality.abort(claim, "AUTOMATED_TEST_TARGET_HEAD_STALE");
      return { status: "aborted" as const, error: "AUTOMATED_TEST_TARGET_HEAD_STALE" };
    }
    let testResult: AutomatedTestingResult;
    try {
      const testing = this.qualityDependencies.testing
        ?? ((input: AutomatedTestingInput, testSignal?: AbortSignal) => runAutomatedTesting(input, {}, testSignal));
      testResult = await testing({
        sourceManifest: snapshot.manifest,
        sensitivePatterns: [...claim.input.snapshot.sensitivePatterns],
        targetWorktree: claim.input.snapshot.worktreePath,
        gitCommonDir: before.gitCommonDir,
        allowedCommands: claim.input.snapshot.allowedCommands.map((command) => ({
          command: command.command,
          ...(command.argsPrefix ? { argsPrefix: [...command.argsPrefix] } : {})
        })),
        acceptanceCriteria: [...claim.input.snapshot.acceptanceCriteria],
        untrustedEvidence: {
          requirement: claim.input.requirement,
          approvedArtifacts: [...claim.input.artifacts],
          implementation: { diff: snapshot.diff, changedFiles: snapshot.changedFiles },
          codingEvidence: {
            id: claim.input.codingEvidence.id,
            evidenceVersion: claim.input.codingEvidence.evidenceVersion,
            diffHash: claim.input.codingEvidence.diffHash
          },
          deliverySnapshot: {
            ...claim.input.snapshot,
            moduleIds: [...claim.input.snapshot.moduleIds],
            acceptanceCriteria: [...claim.input.snapshot.acceptanceCriteria],
            sensitivePatterns: [...claim.input.snapshot.sensitivePatterns],
            allowedCommands: claim.input.snapshot.allowedCommands.map((command) => ({
              command: command.command,
              ...(command.argsPrefix ? { argsPrefix: [...command.argsPrefix] } : {})
            }))
          }
        }
      }, signal);
      throwIfQualitySignalAborted(signal);
    } catch (error) {
      throw retryable("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE", error);
    }
    if (testResult.error === "AUTOMATED_TEST_SANDBOX_UNAVAILABLE") {
      throw retryable("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE");
    }
    if (testResult.error && testResult.commandResults.length === 0) {
      quality.abort(claim, testResult.error);
      return { status: "aborted" as const, error: testResult.error };
    }
    let after: TargetState;
    try {
      after = await inspectTarget(claim.input.snapshot.worktreePath);
      throwIfQualitySignalAborted(signal);
    } catch (error) {
      throw retryable("AUTOMATED_TEST_INFRASTRUCTURE_UNAVAILABLE", error);
    }
    if (before.head !== after.head || before.refsHash !== after.refsHash || before.diffHash !== after.diffHash) {
      quality.abort(claim, "AUTOMATED_TEST_TARGET_MUTATED");
      return { status: "aborted" as const, error: "AUTOMATED_TEST_TARGET_MUTATED" };
    }
    return quality.complete(claim, {
      result: testResult.result,
      content: {
        ...(testResult.error ? { error: testResult.error } : {}),
        summary: "automated testing completed",
        ...(testResult.toolchain ? { toolchain: testResult.toolchain } : {})
      },
      commandResults: testResult.commandResults,
      acceptanceTrace: testResult.acceptanceTrace
    });
  }

  private requireQualityPersistence() {
    if (!this.qualityPersistence) throw new Error("DELIVERY_QUALITY_PERSISTENCE_REQUIRED");
    return this.qualityPersistence;
  }

  private loadImmutableSnapshot(codingEvidence: DeliveryQualityClaimInput) {
    const manifestHash = evidenceManifestHash(codingEvidence.manifest);
    const diffHash = evidenceFingerprint({
      identity: {
        repositoryPath: codingEvidence.sourceRepoPath,
        gitCommonDir: codingEvidence.gitCommonDir,
        worktreePath: codingEvidence.worktreePath,
        branch: codingEvidence.branch,
        headCommit: codingEvidence.sourceHead
      },
      manifestHash,
      diff: codingEvidence.diff,
      changedFiles: codingEvidence.changedFiles
    });
    if (manifestHash !== codingEvidence.manifestHash || diffHash !== codingEvidence.diffHash) {
      throw new Error("IMPLEMENTATION_EVIDENCE_STALE");
    }
    return { diff: codingEvidence.diff, changedFiles: codingEvidence.changedFiles, manifest: codingEvidence.manifest };
  }
}

type DeliveryQualityRunningClaim = Extract<
  ReturnType<DeliveryQualityPersistence["claim"]>,
  { status: "running" }
>;
type DeliveryQualityClaimInput = DeliveryQualityRunningClaim["input"]["codingEvidence"];

function validateImplementationIdentity(
  claim: Parameters<DeliveryExecutionPersistence["completeImplementation"]>[0],
  result: CodingAgentResult,
  snapshot: WorktreeSnapshot
) {
  const identity = snapshot.identity;
  const expectedWorktreePath = resolve(
    claim.project.repoPath, "..", ".ai-workflow-worktrees", basename(claim.project.repoPath),
    "requirements", claim.requirement.code
  );
  const manifestHash = evidenceManifestHash(snapshot.manifest);
  const evidenceHash = evidenceFingerprint({
    identity, manifestHash, diff: snapshot.diff, changedFiles: snapshot.changedFiles
  });
  if (snapshot.manifestHash !== manifestHash || snapshot.evidenceHash !== evidenceHash
    || snapshot.diff !== result.diff || identity.repositoryPath !== resolve(claim.project.repoPath)
    || identity.gitCommonDir !== resolve(claim.project.repoPath, ".git")
    || identity.worktreePath !== resolve(result.worktreePath) || identity.worktreePath !== expectedWorktreePath
    || identity.branch !== result.branch || result.branch !== `ai/${claim.requirement.code}`
    || identity.headCommit !== result.baseCommit || result.baseCommit !== claim.version.headCommit) {
    throw new Error("IMPLEMENTATION_EVIDENCE_IDENTITY_MISMATCH");
  }
}

export function createDeliveryQualityAutomationHandlers(
  service: Pick<DeliveryExecutionService, "review" | "test">
): Pick<AutomationHandlers, "review" | "test"> {
  return {
    review: async (job, context) => {
      validateQualityJob(job, "review");
      await service.review(job.ownerId, job.evidenceVersion, job.claimToken, context?.signal);
    },
    test: async (job, context) => {
      validateQualityJob(job, "test");
      await service.test(job.ownerId, job.evidenceVersion, job.claimToken, context?.signal);
    }
  };
}

function qualityDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error("DELIVERY_QUALITY_REVIEW_TIMEOUT"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

function throwIfQualitySignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("AUTOMATED_TEST_ABORTED");
}

function validateQualityJob(job: AutomationJob, action: "review" | "test") {
  if (job.ownerType !== "delivery_unit" || job.action !== action
    || !Number.isSafeInteger(job.evidenceVersion) || job.evidenceVersion < 1
    || typeof job.claimToken !== "string" || job.claimToken.length < 1
    || job.claimToken.length > 256 || job.claimToken.includes("\0")) {
    throw new Error("AUTOMATION_INPUT_INVALID");
  }
}

async function inspectTargetState(worktreePath: string): Promise<TargetState> {
  const environment = qualityGitEnvironment();
  const [{ stdout: head }, { stdout: refs }, { stdout: common }, snapshot] = await Promise.all([
    execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { env: environment }),
    execFileAsync("git", ["-C", worktreePath, "for-each-ref", "--format=%(refname)%00%(objectname)"], { env: environment }),
    execFileAsync("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { env: environment }),
    getWorktreeSnapshot(worktreePath)
  ]);
  const commonPath = common.trim();
  return {
    head: head.trim(),
    refsHash: createHash("sha256").update(refs).digest("hex"),
    diffHash: buildCodingEvidence({ diff: snapshot.diff }).diffHash,
    gitCommonDir: isAbsolute(commonPath) ? commonPath : resolve(worktreePath, commonPath)
  };
}

export function qualityGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function globMatches(pattern: string, path: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]").replaceAll("\0", ".*");
  return new RegExp(`^(?:${escaped})$`).test(path) || new RegExp(`(?:^|/)${escaped}$`).test(path);
}

function qualityErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_-]+)?$/.test(message) ? message : "DELIVERY_QUALITY_EXECUTION_FAILED";
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function settlementErrorWithCause(settlementError: unknown, codingError: unknown) {
  if (!(settlementError instanceof Error)) return new Error(String(settlementError), { cause: codingError });
  Object.defineProperty(settlementError, "cause", {
    value: codingError,
    configurable: true,
    writable: true
  });
  return settlementError;
}
