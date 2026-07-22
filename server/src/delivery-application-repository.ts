import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  aggregateDeliveryStatus,
  deliveryUnitStatuses,
  type AggregateDeliveryStatus,
  type DeliveryUnitStatus
} from "@ai-workflow/shared";
import { redactSensitive } from "./redaction.js";

const MAX_STRUCTURED_BYTES = 1_048_576;
const MAX_TEXT_LENGTH = 256;
const MAX_ERROR_LENGTH = 65_536;
const MAX_CONFLICT_FILES = 1_024;
const deliveryUnitStatusSet = new Set<string>(deliveryUnitStatuses);

export type DeliveryApplicationStatus = "applying" | "applied" | "conflicted" | "failed";
export type DeliveryApplicationResolutionStatus = "pending" | "not_required";

export interface DeliveryApplicationClaimInput {
  claimToken: string;
  sourceCommit: string;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflight: unknown;
}

export interface DeliveryApplicationCompletion {
  status: "applied" | "conflicted" | "failed";
  commandResults?: unknown[];
  conflictFiles?: string[];
  error?: string | null;
}

export interface DeliveryApplicationRun {
  id: string;
  requirementId: string;
  deliveryUnitId: string;
  projectVersionId: string;
  evidenceVersion: number;
  claimToken: string;
  sourceCommit: string;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflight: unknown;
  commandResults: unknown[];
  conflictFiles: string[];
  error: string | null;
  status: DeliveryApplicationStatus;
  resolutionStatus: DeliveryApplicationResolutionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DeliveryApplicationPersistence {
  claim(unitId: string, input: DeliveryApplicationClaimInput): DeliveryApplicationRun;
  complete(runId: string, completion: DeliveryApplicationCompletion): DeliveryApplicationRun;
  get(runId: string): DeliveryApplicationRun | null;
  listForUnit(unitId: string): DeliveryApplicationRun[];
  aggregate(requirementId: string): AggregateDeliveryStatus;
}

interface UnitRow {
  id: string;
  requirement_id: string;
  project_version_id: string;
  evidence_version: number;
  phase: string;
  status: string;
  version_status: string;
  sensitive_patterns_json: string;
}

interface SerializedClaimInput {
  claimToken: string;
  sourceCommit: string;
  baseCommit: string;
  preApplyCommit: string;
  evidenceHash: string;
  preflightJson: string;
}

interface SerializedCompletion {
  status: "applied" | "conflicted" | "failed";
  resolutionStatus: DeliveryApplicationResolutionStatus;
  commandResultsJson: string;
  conflictFilesJson: string;
  error: string | null;
}

export class DeliveryApplicationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

  claimInTransaction(unitId: string, input: DeliveryApplicationClaimInput): DeliveryApplicationRun {
    validateId(unitId);
    let serialized = validateClaimInput(input);
    const existingToken = this.db.prepare("SELECT * FROM delivery_application_runs WHERE claim_token = ?")
      .get(serialized.claimToken) as any;
    if (existingToken) {
      if (existingToken.delivery_unit_id !== unitId) throw new Error("DELIVERY_APPLICATION_CLAIM_CONFLICT");
      serialized = sanitizeClaim(serialized, this.loadSensitivePatterns(unitId));
      if (
        existingToken.source_commit === serialized.sourceCommit
        && existingToken.base_commit === serialized.baseCommit
        && existingToken.pre_apply_commit === serialized.preApplyCommit
        && existingToken.evidence_hash === serialized.evidenceHash
        && existingToken.preflight_json === serialized.preflightJson
      ) {
        if (existingToken.status === "applying" && !this.db.prepare(`SELECT 1 FROM delivery_units
          WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
            AND phase = 'acceptance_delivery' AND status = 'applying'`).get(
          existingToken.delivery_unit_id, existingToken.requirement_id, existingToken.project_version_id,
          existingToken.evidence_version
        )) throw new Error("DELIVERY_APPLICATION_CLAIM_STALE");
        return mapRun(existingToken);
      }
      throw new Error("DELIVERY_APPLICATION_CLAIM_CONFLICT");
    }

    const unit = this.db.prepare(`SELECT unit.id, unit.requirement_id, unit.project_version_id,
        unit.evidence_version, unit.phase, unit.status, version.status AS version_status,
        snapshot.sensitive_patterns_json
      FROM delivery_units unit
      JOIN project_versions version ON version.id = unit.project_version_id
      JOIN delivery_unit_snapshots snapshot ON snapshot.delivery_unit_id = unit.id
      WHERE unit.id = ?`).get(unitId) as UnitRow | undefined;
    if (!unit) throw new Error("DELIVERY_UNIT_NOT_FOUND");
    if (this.db.prepare(`SELECT 1 FROM delivery_application_runs
      WHERE delivery_unit_id = ? AND status = 'applying'`).get(unit.id)) {
      throw new Error("DELIVERY_APPLICATION_RUN_ACTIVE");
    }
    if (
      unit.phase !== "acceptance_delivery"
      || unit.status !== "ready_for_acceptance"
      || unit.version_status !== "active"
    ) throw new Error("DELIVERY_APPLICATION_UNIT_NOT_READY");

    if (this.db.prepare(`SELECT 1 FROM delivery_application_runs
      WHERE project_version_id = ? AND status = 'applying'`).get(unit.project_version_id)) {
      throw new Error("DELIVERY_APPLICATION_VERSION_ACTIVE");
    }
    serialized = sanitizeClaim(serialized, parseSensitivePatterns(unit.sensitive_patterns_json));

    const id = randomUUID();
    const now = this.now();
    try {
      this.db.prepare(`INSERT INTO delivery_application_runs
        (id, requirement_id, delivery_unit_id, project_version_id, evidence_version, claim_token,
          source_commit, base_commit, pre_apply_commit, evidence_hash, preflight_json,
          command_results_json, conflict_files_json, error, status, resolution_status,
          created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'applying', 'pending', ?, ?, NULL)`)
        .run(id, unit.requirement_id, unit.id, unit.project_version_id, unit.evidence_version,
          serialized.claimToken, serialized.sourceCommit, serialized.baseCommit, serialized.preApplyCommit,
          serialized.evidenceHash, serialized.preflightJson, now, now);
    } catch (error) {
      throw mapClaimConstraint(error);
    }
    const updated = this.db.prepare(`UPDATE delivery_units
      SET status = 'applying', updated_at = ?, completed_at = NULL
      WHERE id = ? AND evidence_version = ? AND phase = 'acceptance_delivery'
        AND status = 'ready_for_acceptance'`).run(now, unit.id, unit.evidence_version);
    if (updated.changes !== 1) throw new Error("DELIVERY_APPLICATION_UNIT_STALE");
    return this.getRequired(id);
  }

  completeInTransaction(runId: string, completion: DeliveryApplicationCompletion): DeliveryApplicationRun {
    validateId(runId);
    let serialized = validateCompletion(completion);
    const run = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId) as any;
    if (!run) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    if (run.status !== "applying") throw new Error("DELIVERY_APPLICATION_RUN_SETTLED");
    serialized = sanitizeCompletion(serialized, this.loadSensitivePatterns(run.delivery_unit_id));

    const now = this.now();
    const settled = this.db.prepare(`UPDATE delivery_application_runs
      SET status = ?, resolution_status = ?, command_results_json = ?, conflict_files_json = ?,
        error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND project_version_id = ? AND evidence_version = ?
        AND claim_token = ? AND status = 'applying'`).run(
      serialized.status, serialized.resolutionStatus, serialized.commandResultsJson,
      serialized.conflictFilesJson, serialized.error, now, now, run.id, run.delivery_unit_id,
      run.project_version_id, run.evidence_version, run.claim_token
    );
    if (settled.changes !== 1) throw new Error("DELIVERY_APPLICATION_RUN_STALE");
    const unitSettled = this.db.prepare(`UPDATE delivery_units
      SET status = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND requirement_id = ? AND project_version_id = ? AND evidence_version = ?
        AND phase = 'acceptance_delivery' AND status = 'applying'`).run(
      serialized.status, now, now, run.delivery_unit_id, run.requirement_id,
      run.project_version_id, run.evidence_version
    );
    if (unitSettled.changes !== 1) throw new Error("DELIVERY_APPLICATION_UNIT_STALE");
    this.aggregateInTransaction(run.requirement_id);
    return this.getRequired(runId);
  }

  get(runId: string): DeliveryApplicationRun | null {
    validateId(runId);
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId);
    return row ? mapRun(row as any) : null;
  }

  listForUnit(unitId: string): DeliveryApplicationRun[] {
    validateId(unitId);
    return (this.db.prepare(`SELECT * FROM delivery_application_runs
      WHERE delivery_unit_id = ? ORDER BY created_at, id`).all(unitId) as any[]).map(mapRun);
  }

  aggregate(requirementId: string): AggregateDeliveryStatus {
    validateId(requirementId);
    if (!this.db.prepare("SELECT 1 FROM requirements WHERE id = ?").get(requirementId)) {
      throw new Error("REQUIREMENT_NOT_FOUND");
    }
    return this.aggregateInTransaction(requirementId);
  }

  private aggregateInTransaction(requirementId: string): AggregateDeliveryStatus {
    const rows = this.db.prepare(`SELECT required, status FROM delivery_units
      WHERE requirement_id = ? ORDER BY position, id`).all(requirementId) as Array<{
        required: number; status: string;
      }>;
    for (const row of rows) {
      if ((row.required !== 0 && row.required !== 1) || !deliveryUnitStatusSet.has(row.status)) {
        throw new Error("DELIVERY_APPLICATION_AGGREGATE_INVALID");
      }
    }
    return aggregateDeliveryStatus(rows.map((row) => ({
      required: row.required === 1,
      status: row.status as DeliveryUnitStatus
    })));
  }

  private getRequired(runId: string): DeliveryApplicationRun {
    const row = this.db.prepare("SELECT * FROM delivery_application_runs WHERE id = ?").get(runId);
    if (!row) throw new Error("DELIVERY_APPLICATION_RUN_NOT_FOUND");
    return mapRun(row as any);
  }

  private loadSensitivePatterns(unitId: string): string[] {
    const row = this.db.prepare(`SELECT sensitive_patterns_json FROM delivery_unit_snapshots
      WHERE delivery_unit_id = ?`).get(unitId) as { sensitive_patterns_json: string } | undefined;
    if (!row) throw new Error("DELIVERY_UNIT_SNAPSHOT_NOT_FOUND");
    return parseSensitivePatterns(row.sensitive_patterns_json);
  }

  private now(): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("DELIVERY_APPLICATION_DATE_INVALID");
    }
    return now.toISOString();
  }
}

function validateClaimInput(input: DeliveryApplicationClaimInput): SerializedClaimInput {
  if (!isPlainRecord(input)) throw new Error("DELIVERY_APPLICATION_CLAIM_INVALID");
  const claimToken = validateText(ownData(input, "claimToken", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const sourceCommit = validateText(ownData(input, "sourceCommit", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const baseCommit = validateText(ownData(input, "baseCommit", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const preApplyCommit = validateText(ownData(input, "preApplyCommit", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const evidenceHash = validateText(ownData(input, "evidenceHash", "DELIVERY_APPLICATION_CLAIM_INVALID"),
    "DELIVERY_APPLICATION_CLAIM_INVALID");
  const preflightJson = serializeStructured(
    ownData(input, "preflight", "DELIVERY_APPLICATION_CLAIM_INVALID"), "PREFLIGHT"
  );
  return { claimToken, sourceCommit, baseCommit, preApplyCommit, evidenceHash, preflightJson };
}

function validateCompletion(completion: DeliveryApplicationCompletion): SerializedCompletion {
  if (!isPlainRecord(completion)) {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  const status = ownData(completion, "status", "DELIVERY_APPLICATION_COMPLETION_INVALID");
  if (status !== "applied" && status !== "conflicted" && status !== "failed") {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  const commandResults = ownOptionalData(
    completion, "commandResults", "DELIVERY_APPLICATION_COMPLETION_INVALID"
  ) ?? [];
  if (!Array.isArray(commandResults)) throw new Error("DELIVERY_APPLICATION_COMMAND_RESULTS_INVALID");
  const commandResultsJson = serializeStructured(commandResults, "COMMAND_RESULTS", true);
  const conflictFiles = validateConflictFiles(ownOptionalData(
    completion, "conflictFiles", "DELIVERY_APPLICATION_COMPLETION_INVALID"
  ) ?? []);
  const conflictFilesJson = serializeStructured(conflictFiles, "CONFLICT_FILES", true);
  const errorValue = ownOptionalData(completion, "error", "DELIVERY_APPLICATION_COMPLETION_INVALID");
  const error = errorValue == null
    ? null
    : validateText(errorValue, "DELIVERY_APPLICATION_ERROR_INVALID", MAX_ERROR_LENGTH);

  if (status === "applied") {
    if (conflictFiles.length > 0 || error !== null) throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
    return {
      status, resolutionStatus: "not_required", commandResultsJson,
      conflictFilesJson, error
    };
  }
  if (status === "conflicted" && conflictFiles.length === 0) {
    throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  }
  if (error === null) throw new Error("DELIVERY_APPLICATION_ERROR_INVALID");
  if (status === "failed" && conflictFiles.length > 0) {
    throw new Error("DELIVERY_APPLICATION_COMPLETION_INVALID");
  }
  return {
    status, resolutionStatus: "pending", commandResultsJson,
    conflictFilesJson, error
  };
}

function validateConflictFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONFLICT_FILES) {
    throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  }
  const files = value.map((file) => validateText(
    file, "DELIVERY_APPLICATION_CONFLICT_FILES_INVALID", 4_096
  ));
  if (new Set(files).size !== files.length) throw new Error("DELIVERY_APPLICATION_CONFLICT_FILES_INVALID");
  return files;
}

function sanitizeClaim(input: SerializedClaimInput, patterns: string[]): SerializedClaimInput {
  const preflight = sanitizeEvidence(JSON.parse(input.preflightJson), patterns);
  return { ...input, preflightJson: serializeStructured(preflight, "PREFLIGHT") };
}

function sanitizeCompletion(
  completion: SerializedCompletion,
  patterns: string[]
): SerializedCompletion {
  const sanitized = sanitizeEvidence({
    commandResults: JSON.parse(completion.commandResultsJson),
    conflictFiles: JSON.parse(completion.conflictFilesJson),
    error: completion.error
  }, patterns) as { commandResults: unknown; conflictFiles: unknown; error: unknown };
  const commandResultsJson = serializeStructured(sanitized.commandResults, "COMMAND_RESULTS", true);
  const conflictFiles = validateConflictFiles(sanitized.conflictFiles);
  const conflictFilesJson = serializeStructured(conflictFiles, "CONFLICT_FILES", true);
  const error = sanitized.error === null
    ? null
    : validateText(sanitized.error, "DELIVERY_APPLICATION_ERROR_INVALID", MAX_ERROR_LENGTH);
  return { ...completion, commandResultsJson, conflictFilesJson, error };
}

function sanitizeEvidence(value: unknown, patterns: string[]): unknown {
  try {
    return redactSensitive(value, patterns, {
      maxDepth: 64,
      maxNodes: 50_000,
      maxStringCodePoints: MAX_STRUCTURED_BYTES,
      maxCollectionItems: 20_000,
      maxBytes: MAX_STRUCTURED_BYTES
    });
  } catch (error) {
    throw new Error("DELIVERY_APPLICATION_EVIDENCE_INVALID", { cause: error });
  }
}

function parseSensitivePatterns(json: string): string[] {
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value) && value.length <= 256 && value.every((item) =>
      typeof item === "string" && item.length <= 4_096 && !item.includes("\0"))) return value;
  } catch {}
  throw new Error("DELIVERY_APPLICATION_SENSITIVE_PATTERNS_INVALID");
}

function validateId(value: unknown): asserts value is string {
  validateText(value, "DELIVERY_APPLICATION_ID_INVALID");
}

function validateText(value: unknown, error: string, maxLength = MAX_TEXT_LENGTH): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || value.includes("\0")
  ) throw new Error(error);
  return value;
}

function serializeStructured(value: unknown, field: string, requireArray = false): string {
  if (requireArray && !Array.isArray(value)) throw new Error(`DELIVERY_APPLICATION_${field}_INVALID`);
  try {
    validateJsonValue(value, new Set(), 0);
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("invalid");
    if (Buffer.byteLength(json) > MAX_STRUCTURED_BYTES) {
      throw new Error(`DELIVERY_APPLICATION_${field}_LIMIT`);
    }
    return json;
  } catch (error) {
    if (error instanceof Error && error.message === `DELIVERY_APPLICATION_${field}_LIMIT`) throw error;
    throw new Error(`DELIVERY_APPLICATION_${field}_INVALID`);
  }
}

function validateJsonValue(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 64) throw new Error("invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid");
    return;
  }
  if (typeof value !== "object") throw new Error("invalid");
  if (ancestors.has(value)) throw new Error("invalid");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) {
        throw new Error("invalid");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error("invalid");
        validateJsonValue(descriptor.value, ancestors, depth + 1);
      }
      return;
    }
    if (!isPlainRecord(value)) throw new Error("invalid");
    for (const key of Object.keys(value)) {
      if (key.includes("\0")) throw new Error("invalid");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("invalid");
      validateJsonValue(descriptor.value, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, any>, key: string, error: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(error);
  return descriptor.value;
}

function ownOptionalData(record: Record<string, any>, key: string, error: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return ownData(record, key, error);
}

function mapRun(row: any): DeliveryApplicationRun {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    deliveryUnitId: row.delivery_unit_id,
    projectVersionId: row.project_version_id,
    evidenceVersion: row.evidence_version,
    claimToken: row.claim_token,
    sourceCommit: row.source_commit,
    baseCommit: row.base_commit,
    preApplyCommit: row.pre_apply_commit,
    evidenceHash: row.evidence_hash,
    preflight: JSON.parse(row.preflight_json),
    commandResults: JSON.parse(row.command_results_json),
    conflictFiles: JSON.parse(row.conflict_files_json),
    error: row.error,
    status: row.status,
    resolutionStatus: row.resolution_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function mapClaimConstraint(error: unknown): Error {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    if (error.message.includes("claim_token")) return new Error("DELIVERY_APPLICATION_CLAIM_CONFLICT");
    if (error.message.includes("delivery_unit_id")) return new Error("DELIVERY_APPLICATION_RUN_ACTIVE");
    if (error.message.includes("project_version_id")) {
      return new Error("DELIVERY_APPLICATION_VERSION_ACTIVE");
    }
  }
  return error instanceof Error ? error : new Error("DELIVERY_APPLICATION_CLAIM_FAILED");
}
