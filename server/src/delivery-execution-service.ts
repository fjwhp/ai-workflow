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
import type { AutomationHandlers } from "./automation-worker.js";
import type { AutomationJob } from "./automation-job-repository.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodingAgent = (input: CodingAgentInput) => Promise<CodingAgentResult>;
type WorktreeSnapshot = Awaited<ReturnType<typeof getWorktreeSnapshot>>;
type TargetState = { head: string; refsHash: string; diffHash: string; gitCommonDir: string };
export interface DeliveryQualityDependencies {
  getSnapshot?: (worktreePath: string) => Promise<WorktreeSnapshot>;
  review?: (input: unknown) => Promise<CodeReviewResult>;
  testing?: (input: AutomatedTestingInput) => Promise<AutomatedTestingResult>;
  inspectTarget?: (worktreePath: string) => Promise<TargetState>;
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
  ) {}

  async implement(unitId: string) {
    const claim = this.persistence.claimImplementation(unitId, this.model);
    let result: CodingAgentResult;
    try {
      result = await this.codingAgent({
        requirement: claim.requirement,
        artifacts: claim.artifacts,
        project: claim.project,
        version: claim.version,
        deliveryContext: claim.deliveryContext
      });
    } catch (error) {
      try {
        this.persistence.failImplementation(claim, errorText(error));
      } catch (settlementError) {
        throw settlementErrorWithCause(settlementError, error);
      }
      throw error;
    }

    const evidence = buildCodingEvidence({
      diff: result.diff,
      files: result.files,
      additions: result.additions,
      deletions: result.deletions
    });
    const diagnostics = Array.isArray(result.diagnostics)
      ? result.diagnostics.map(String).join("\n")
      : String(result.diagnostics ?? "");
    return this.persistence.completeImplementation(claim, {
      branch: result.branch,
      worktreePath: result.worktreePath,
      baseCommit: result.baseCommit,
      commands: [],
      diff: evidence.diff,
      diffHash: evidence.diffHash,
      originalChars: evidence.originalChars,
      truncated: evidence.truncated,
      files: evidence.files,
      additions: evidence.additions,
      deletions: evidence.deletions,
      diagnostics,
      codexThreadId: result.codexThreadId,
      events: result.events,
      output: { runId: result.runId, summary: result.summary }
    });
  }

  async review(unitId: string, evidenceVersion?: number, claimToken?: string) {
    const quality = this.requireQualityPersistence();
    const claim = quality.claim(unitId, evidenceVersion, "code_review", claimToken);
    if (claim.settledEvidence) return claim.settledEvidence;
    let completion: DeliveryQualityCompletion;
    try {
      const snapshot = await this.loadImmutableSnapshot(claim.input.codingEvidence.worktreePath,
        claim.input.codingEvidence.diffHash, claim.input.snapshot.sensitivePatterns);
      const result = await (this.qualityDependencies.review ?? runCodeReview)({
        requirement: claim.input.requirement,
        approvedArtifacts: claim.input.artifacts,
        deliveryContext: {
          moduleIds: claim.input.snapshot.moduleIds,
          acceptanceCriteria: claim.input.snapshot.acceptanceCriteria
        },
        implementation: { diff: snapshot.diff, changedFiles: snapshot.changedFiles }
      });
      completion = { ...codeReviewDecision(result), content: result };
    } catch (error) {
      completion = {
        result: "failed",
        content: { error: qualityErrorCode(error) }
      };
    }
    return quality.complete(claim, completion);
  }

  async test(unitId: string, evidenceVersion?: number, claimToken?: string) {
    const quality = this.requireQualityPersistence();
    const claim = quality.claim(unitId, evidenceVersion, "automated_testing", claimToken);
    if (claim.settledEvidence) return claim.settledEvidence;
    let testResult: AutomatedTestingResult | undefined;
    let completion: DeliveryQualityCompletion;
    try {
      const snapshot = await this.loadImmutableSnapshot(claim.input.codingEvidence.worktreePath,
        claim.input.codingEvidence.diffHash, claim.input.snapshot.sensitivePatterns);
      const inspectTarget = this.qualityDependencies.inspectTarget ?? inspectTargetState;
      const before = await inspectTarget(claim.input.snapshot.worktreePath);
      if (before.head !== claim.input.snapshot.headCommit) throw new Error("AUTOMATED_TEST_TARGET_HEAD_STALE");
      testResult = await (this.qualityDependencies.testing ?? runAutomatedTesting)({
        sourceWorktree: claim.input.codingEvidence.worktreePath,
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
      });
      await this.loadImmutableSnapshot(claim.input.codingEvidence.worktreePath,
        claim.input.codingEvidence.diffHash, claim.input.snapshot.sensitivePatterns);
      const after = await inspectTarget(claim.input.snapshot.worktreePath);
      if (before.head !== after.head || before.refsHash !== after.refsHash || before.diffHash !== after.diffHash) {
        throw new Error("AUTOMATED_TEST_TARGET_MUTATED");
      }
      completion = {
        result: testResult.result,
        content: { ...(testResult.error ? { error: testResult.error } : {}), summary: "automated testing completed" },
        commandResults: testResult.commandResults,
        acceptanceTrace: testResult.acceptanceTrace
      };
    } catch (error) {
      completion = {
        result: "failed", content: { error: qualityErrorCode(error) },
        commandResults: testResult?.commandResults ?? [], acceptanceTrace: testResult?.acceptanceTrace ?? []
      };
    }
    return quality.complete(claim, completion);
  }

  private requireQualityPersistence() {
    if (!this.qualityPersistence) throw new Error("DELIVERY_QUALITY_PERSISTENCE_REQUIRED");
    return this.qualityPersistence;
  }

  private async loadImmutableSnapshot(worktreePath: string, expectedDiffHash: string, sensitivePatterns: string[]) {
    const snapshot = await (this.qualityDependencies.getSnapshot ?? getWorktreeSnapshot)(worktreePath);
    if (buildCodingEvidence({ diff: snapshot.diff }).diffHash !== expectedDiffHash) {
      throw new Error("IMPLEMENTATION_EVIDENCE_STALE");
    }
    const sensitive = snapshot.files.find((file) => sensitivePatterns.some((pattern) => globMatches(pattern, file)));
    if (sensitive) throw new Error("IMPLEMENTATION_EVIDENCE_SENSITIVE_PATH");
    return snapshot;
  }
}

export function createDeliveryQualityAutomationHandlers(
  service: Pick<DeliveryExecutionService, "review" | "test">
): Pick<AutomationHandlers, "review" | "test"> {
  return {
    review: async (job) => {
      validateQualityJob(job, "review");
      await service.review(job.ownerId, job.evidenceVersion, job.id);
    },
    test: async (job) => {
      validateQualityJob(job, "test");
      await service.test(job.ownerId, job.evidenceVersion, job.id);
    }
  };
}

function validateQualityJob(job: AutomationJob, action: "review" | "test") {
  if (job.ownerType !== "delivery_unit" || job.action !== action
    || !Number.isSafeInteger(job.evidenceVersion) || job.evidenceVersion < 1) {
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
