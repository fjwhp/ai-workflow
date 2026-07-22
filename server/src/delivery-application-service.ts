import { isAbsolute, posix } from "node:path";
import type { DeliveryUnit } from "./delivery-unit-repository.js";
import type {
  DeliveryApplicationClaim,
  DeliveryApplicationPersistence,
  DeliveryApplicationRun
} from "./delivery-application-repository.js";
import type { DeliveryQualityEvidence } from "./delivery-quality-repository.js";
import {
  applicationOwnData as ownData,
  isApplicationRecord as isPlainRecord
} from "./delivery-application-data.js";
import {
  executeLocalIntegration,
  preflightLocalIntegration,
  type ApplicationPreflight,
  type ApplicationResult,
  type FrozenApplicationInput
} from "./integration.js";
import type { VerificationCommand } from "./verification-plan.js";

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 16_384;
const MAX_PERSISTED_ARRAY_BYTES = 262_144;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EVIDENCE_HASH = /^[0-9a-f]{64}$/;

export interface DeliveryApplicationCodingEvidence {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  evidenceVersion: number;
  projectId: string;
  branch: string;
  worktreePath: string;
  diffHash: string;
  sourceRepoPath: string;
  sourceHead: string;
  files: string[];
  changedFiles: Array<{ path: string }>;
}

export interface DeliveryApplicationContext {
  unit: DeliveryUnit;
  project: { id: string; repoPath: string };
  version: {
    id: string;
    projectId: string;
    branch: string;
    worktreePath: string;
    status: "active";
    headCommit: string;
  };
  snapshot: {
    repoPath: string;
    targetBranch: string;
    targetWorktreePath: string;
    targetHead: string;
    allowedCommands: VerificationCommand[];
    sensitivePatterns: string[];
  };
  codingEvidence: DeliveryApplicationCodingEvidence;
  qualityEvidence: {
    codeReview: DeliveryQualityEvidence;
    automatedTesting: DeliveryQualityEvidence;
  };
}

export interface DeliveryApplicationAutomationInput {
  expectedEvidenceVersion: number;
  claimToken: string;
}

export interface DeliveryApplicationServiceDependencies {
  applications: DeliveryApplicationPersistence;
  loadContext(unitId: string): DeliveryApplicationContext | null | Promise<DeliveryApplicationContext | null>;
}

export type DeliveryApplicationServiceResult = {
  status: "completed" | "conflicted" | "failed";
  run: DeliveryApplicationRun;
  preflight: ApplicationPreflight;
  sourceCommit?: string;
  preApplyHead?: string;
  error: string | null;
};

interface ValidatedContext {
  unitId: string;
  unitStatus: "ready_for_acceptance" | "applying";
  requirementId: string;
  projectId: string;
  projectVersionId: string;
  evidenceVersion: number;
  projectRepoPath: string;
  targetWorktreePath: string;
  targetBranch: string;
  targetHead: string;
  sourceWorktreePath: string;
  sourceBranch: string;
  sourceHead: string;
  evidenceHash: string;
  changedFiles: string[];
  sensitivePatterns: string[];
  allowedCommands: VerificationCommand[];
}

export class DeliveryApplicationService {
  constructor(private readonly dependencies: DeliveryApplicationServiceDependencies) {
    if (!dependencies || typeof dependencies.loadContext !== "function"
      || !dependencies.applications) {
      throw new Error("DELIVERY_APPLICATION_SERVICE_DEPENDENCIES_INVALID");
    }
  }

  async apply(
    deliveryUnitId: string,
    automation: DeliveryApplicationAutomationInput
  ): Promise<DeliveryApplicationServiceResult> {
    const unitId = text(deliveryUnitId, "DELIVERY_APPLICATION_ID_INVALID", MAX_ID_LENGTH);
    const lease = validateAutomationInput(automation);
    const loaded = await this.dependencies.loadContext(unitId);
    const context = validateContext(loaded, unitId, lease.expectedEvidenceVersion);
    const existing = this.dependencies.applications.listForUnit(unitId)
      .find((run) => run.status === "applying" && run.resolutionStatus === "pending");
    if (context.unitStatus === "applying" && !existing) {
      throw new Error("DELIVERY_APPLICATION_UNIT_NOT_READY");
    }
    const frozenInput: FrozenApplicationInput = {
      projectRepoPath: context.projectRepoPath,
      targetWorktreePath: context.targetWorktreePath,
      targetBranch: context.targetBranch,
      sourceWorktreePath: context.sourceWorktreePath,
      sourceBranch: context.sourceBranch,
      evidenceHash: context.evidenceHash,
      sensitivePatterns: context.sensitivePatterns,
      expectedTargetHead: context.targetHead,
      ...(existing?.sourceCommit ? { sourceCommit: existing.sourceCommit } : {}),
      changedFiles: context.changedFiles,
      fallbackCommands: context.allowedCommands
    };
    const preflight = await preflightLocalIntegration(frozenInput);
    let claim = this.dependencies.applications.claim(unitId, {
      expectedEvidenceVersion: lease.expectedEvidenceVersion,
      claimToken: lease.claimToken,
      baseCommit: context.sourceHead,
      preApplyCommit: context.targetHead,
      evidenceHash: context.evidenceHash,
      preflight: existing?.preflight ?? preflight
    });
    const result = await executeLocalIntegration({
      ...frozenInput,
      ...(claim.sourceCommit ? { sourceCommit: claim.sourceCommit } : {}),
      commitMessage: `Apply delivery unit ${context.unitId}`,
      commands: context.allowedCommands,
      onSourcePrepared: async (sourceCommit) => {
        claim = this.dependencies.applications.bindSourceCommit(claim, sourceCommit);
      }
    });
    return this.settle(claim, result);
  }

  private settle(
    claim: DeliveryApplicationClaim,
    result: ApplicationResult
  ): DeliveryApplicationServiceResult {
    if (result.status === "completed") {
      const run = this.dependencies.applications.complete(claim, {
        status: "applied",
        commandResults: result.commandResults
      });
      return serviceResult("completed", run, result, null);
    }
    if (result.status === "conflict") {
      const run = this.dependencies.applications.complete(claim, {
        status: "conflicted",
        commandResults: result.commandResults,
        conflictFiles: result.conflictFiles ?? [],
        error: "APPLICATION_CONFLICT"
      });
      return serviceResult("conflicted", run, result, "APPLICATION_CONFLICT");
    }
    const preflightFailed = !result.preflight.allowed;
    const error = preflightFailed
      ? "APPLICATION_PREFLIGHT_FAILED"
      : result.status === "test_failed"
        ? "APPLICATION_VERIFICATION_FAILED"
        : "APPLICATION_STATE_UNCERTAIN";
    const worktreeState = result.targetState === "untouched_clean" || result.targetState === "rolled_back_clean"
      ? "clean" as const
      : "dirty_or_uncertain" as const;
    const run = this.dependencies.applications.complete(claim, {
      status: "failed",
      worktreeState,
      commandResults: result.commandResults,
      error
    });
    return serviceResult("failed", run, result, error);
  }
}

function serviceResult(
  status: DeliveryApplicationServiceResult["status"],
  run: DeliveryApplicationRun,
  result: ApplicationResult,
  error: string | null
): DeliveryApplicationServiceResult {
  return {
    status,
    run,
    preflight: run.preflight as ApplicationPreflight,
    ...(result.sourceCommit ? { sourceCommit: result.sourceCommit } : {}),
    ...(result.preApplyHead ? { preApplyHead: result.preApplyHead } : {}),
    error
  };
}

function validateAutomationInput(input: unknown): DeliveryApplicationAutomationInput {
  const error = "DELIVERY_APPLICATION_AUTOMATION_INPUT_INVALID";
  const record = recordValue(input, error);
  const expectedEvidenceVersion = ownData(record, "expectedEvidenceVersion", error);
  if (!Number.isSafeInteger(expectedEvidenceVersion) || (expectedEvidenceVersion as number) < 1) {
    throw new Error(error);
  }
  return {
    expectedEvidenceVersion: expectedEvidenceVersion as number,
    claimToken: text(ownData(record, "claimToken", error), error, MAX_ID_LENGTH)
  };
}

function validateContext(
  value: unknown,
  expectedUnitId: string,
  expectedEvidenceVersion: number
): ValidatedContext {
  const error = "DELIVERY_APPLICATION_CONTEXT_INVALID";
  const context = recordValue(value, error);
  const unit = recordValue(ownData(context, "unit", error), error);
  const project = recordValue(ownData(context, "project", error), error);
  const version = recordValue(ownData(context, "version", error), error);
  const snapshot = recordValue(ownData(context, "snapshot", error), error);
  const coding = recordValue(ownData(context, "codingEvidence", error), error);
  const quality = recordValue(ownData(context, "qualityEvidence", error), error);

  const unitId = id(unit, "id", error);
  const requirementId = id(unit, "requirementId", error);
  const projectId = id(unit, "projectId", error);
  const projectVersionId = id(unit, "projectVersionId", error);
  const evidenceVersion = integer(unit, "evidenceVersion", error);
  if (unitId !== expectedUnitId || evidenceVersion !== expectedEvidenceVersion) {
    throw new Error("DELIVERY_APPLICATION_EVIDENCE_STALE");
  }
  const unitStatus = ownData(unit, "status", error);
  if (ownData(unit, "phase", error) !== "acceptance_delivery"
    || (unitStatus !== "ready_for_acceptance" && unitStatus !== "applying")) {
    throw new Error("DELIVERY_APPLICATION_UNIT_NOT_READY");
  }

  if (id(project, "id", error) !== projectId
    || id(version, "id", error) !== projectVersionId
    || id(version, "projectId", error) !== projectId
    || ownData(version, "status", error) !== "active") {
    throw new Error("DELIVERY_APPLICATION_CONTEXT_STALE");
  }
  const projectRepoPath = absolutePath(ownData(project, "repoPath", error), error);
  const targetWorktreePath = absolutePath(ownData(version, "worktreePath", error), error);
  const targetBranch = text(ownData(version, "branch", error), error, 4_096);
  const targetHead = commit(ownData(version, "headCommit", error), error);
  if (absolutePath(ownData(snapshot, "repoPath", error), error) !== projectRepoPath
    || absolutePath(ownData(snapshot, "targetWorktreePath", error), error) !== targetWorktreePath
    || text(ownData(snapshot, "targetBranch", error), error, 4_096) !== targetBranch
    || commit(ownData(snapshot, "targetHead", error), error) !== targetHead) {
    throw new Error("DELIVERY_APPLICATION_CONTEXT_STALE");
  }

  const codingId = id(coding, "id", error);
  if (id(coding, "deliveryUnitId", error) !== unitId
    || id(coding, "requirementId", error) !== requirementId
    || id(coding, "projectId", error) !== projectId
    || integer(coding, "evidenceVersion", error) !== evidenceVersion) {
    throw new Error("DELIVERY_APPLICATION_EVIDENCE_STALE");
  }
  const sourceWorktreePath = absolutePath(ownData(coding, "worktreePath", error), error);
  const sourceBranch = text(ownData(coding, "branch", error), error, 4_096);
  const sourceRepoPath = absolutePath(ownData(coding, "sourceRepoPath", error), error);
  if (sourceRepoPath !== projectRepoPath) throw new Error("DELIVERY_APPLICATION_EVIDENCE_STALE");
  const sourceHead = commit(ownData(coding, "sourceHead", error), error);
  const evidenceHash = evidenceHashValue(ownData(coding, "diffHash", error), error);
  const changedFiles = persistedStringArray(ownData(coding, "files", error), error, 10_000)
    .map((file) => relativeFile(file, error));
  if (changedFiles.length === 0 || new Set(changedFiles).size !== changedFiles.length) {
    throw new Error(error);
  }

  validateQualityEvidence(
    ownData(quality, "codeReview", error), "code_review", unitId,
    requirementId, evidenceVersion, codingId, evidenceHash
  );
  validateQualityEvidence(
    ownData(quality, "automatedTesting", error), "automated_testing", unitId,
    requirementId, evidenceVersion, codingId, evidenceHash
  );

  return {
    unitId, unitStatus, requirementId, projectId, projectVersionId, evidenceVersion,
    projectRepoPath, targetWorktreePath, targetBranch, targetHead,
    sourceWorktreePath, sourceBranch, sourceHead, evidenceHash, changedFiles,
    sensitivePatterns: stringArray(ownData(snapshot, "sensitivePatterns", error), error, 256, 4_096),
    allowedCommands: commandArray(ownData(snapshot, "allowedCommands", error), error)
  };
}

function validateQualityEvidence(
  value: unknown,
  expectedKind: "code_review" | "automated_testing",
  unitId: string,
  requirementId: string,
  evidenceVersion: number,
  codingEvidenceId: string,
  evidenceHash: string
) {
  const invalid = "DELIVERY_APPLICATION_QUALITY_EVIDENCE_STALE";
  const evidence = recordValue(value, invalid);
  if (ownData(evidence, "kind", invalid) !== expectedKind
    || ownData(evidence, "result", invalid) !== "passed"
    || id(evidence, "deliveryUnitId", invalid) !== unitId
    || id(evidence, "requirementId", invalid) !== requirementId
    || integer(evidence, "evidenceVersion", invalid) !== evidenceVersion
    || integer(evidence, "inputEvidenceVersion", invalid) !== evidenceVersion
    || id(evidence, "inputCodingEvidenceId", invalid) !== codingEvidenceId
    || evidenceHashValue(ownData(evidence, "inputDiffHash", invalid), invalid) !== evidenceHash) {
    throw new Error(invalid);
  }
}

function commandArray(value: unknown, error: string): VerificationCommand[] {
  const commands = arrayValues(value, error, 16).map((entry) => {
    const command = recordValue(entry, error);
    return {
      command: text(ownData(command, "command", error), error, 256),
      argsPrefix: stringArray(ownData(command, "argsPrefix", error), error, 32, 512)
    };
  });
  if (Buffer.byteLength(JSON.stringify(commands)) > MAX_PERSISTED_ARRAY_BYTES) throw new Error(error);
  return commands;
}

function persistedStringArray(value: unknown, error: string, maxItems: number) {
  const result = stringArray(value, error, maxItems, 4_096);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PERSISTED_ARRAY_BYTES) throw new Error(error);
  return result;
}

function stringArray(
  value: unknown,
  error: string,
  maxItems: number,
  maxLength = MAX_PATH_LENGTH
): string[] {
  return arrayValues(value, error, maxItems).map((item) => text(item, error, maxLength));
}

function arrayValues(value: unknown, error: string, maxItems: number): unknown[] {
  try {
    if (!Array.isArray(value)) throw new Error(error);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) throw new Error(error);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxItems) throw new Error(error);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
    if (keys.length !== length) throw new Error(error);
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(error);
      return descriptor.value;
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === error) throw cause;
    throw new Error(error, { cause });
  }
}

function recordValue(value: unknown, error: string): Record<string, any> {
  if (!isPlainRecord(value)) throw new Error(error);
  return value;
}

function id(record: Record<string, any>, key: string, error: string) {
  return text(ownData(record, key, error), error, MAX_ID_LENGTH);
}

function integer(record: Record<string, any>, key: string, error: string) {
  const value = ownData(record, key, error);
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(error);
  return value as number;
}

function text(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength
    || value.trim() !== value || value.includes("\0")) throw new Error(error);
  return value;
}

function absolutePath(value: unknown, error: string): string {
  const path = text(value, error, MAX_PATH_LENGTH);
  if (!isAbsolute(path)) throw new Error(error);
  return path;
}

function relativeFile(value: string, error: string): string {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(error);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(error);
  }
  return value;
}

function commit(value: unknown, error: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(error);
  return value;
}

function evidenceHashValue(value: unknown, error: string): string {
  if (typeof value !== "string" || !EVIDENCE_HASH.test(value)) throw new Error(error);
  return value;
}
