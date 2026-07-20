import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { automationActions, type AutomationAction } from "@ai-workflow/shared";

export type AutomationJobOwnerType = "requirement" | "delivery_unit";
export type AutomationJobStatus = "pending" | "leased" | "completed" | "failed" | "canceled";

export interface AutomationJobInput {
  ownerType: AutomationJobOwnerType;
  ownerId: string;
  evidenceVersion: number;
  action: AutomationAction;
  payload: unknown;
  maxAttempts: number;
}

export interface AutomationJob {
  id: string;
  dedupeKey: string;
  ownerType: AutomationJobOwnerType;
  ownerId: string;
  evidenceVersion: number;
  action: AutomationAction;
  status: AutomationJobStatus;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  payload: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationJobPersistence {
  enqueue(input: AutomationJobInput): AutomationJob;
  leaseNext(workerId: string, now: Date, leaseMs: number): AutomationJob | null;
  renew(jobId: string, workerId: string, now: Date, leaseMs: number): boolean;
  complete(jobId: string, workerId: string): boolean;
  fail(jobId: string, workerId: string, error: string, retryable: boolean): boolean;
  cancelByOwnerVersion(ownerId: string, evidenceVersion: number, ownerType?: AutomationJobOwnerType): number;
  recoverExpired(now: Date): number;
  get(jobId: string): AutomationJob | null;
  byDedupe(dedupeKey: string): AutomationJob | null;
  listPending(): AutomationJob[];
}

interface AutomationJobRow {
  id: string;
  dedupe_key: string;
  owner_type: AutomationJobOwnerType;
  owner_id: string;
  evidence_version: number;
  action: AutomationAction;
  status: AutomationJobStatus;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  payload_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_OWNER_ID_LENGTH = 256;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_ATTEMPTS = 100;
const MAX_WORKER_ID_LENGTH = 128;
const MAX_LEASE_MS = 86_400_000;
const MAX_ERROR_LENGTH = 4096;

export class AutomationJobRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

  enqueue(input: AutomationJobInput): AutomationJob {
    const payloadJson = validateEnqueueInput(input);
    const dedupeKey = canonicalDedupeKey(input);
    const now = validateDate(this.clock());
    this.db.prepare(`INSERT INTO automation_jobs
      (id, dedupe_key, owner_type, owner_id, evidence_version, action, status, attempt, max_attempts,
       lease_owner, lease_expires_at, payload_json, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(randomUUID(), dedupeKey, input.ownerType, input.ownerId, input.evidenceVersion, input.action,
        input.maxAttempts, payloadJson, now, now);
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE dedupe_key = ?").get(dedupeKey) as AutomationJobRow | undefined;
    if (!row) throw new Error("AUTOMATION_JOB_ENQUEUE_FAILED");
    if (
      row.owner_type !== input.ownerType
      || row.owner_id !== input.ownerId
      || row.evidence_version !== input.evidenceVersion
      || row.action !== input.action
    ) {
      throw new Error("AUTOMATION_JOB_DEDUPE_CONFLICT");
    }
    return mapAutomationJob(row);
  }

  leaseNext(workerId: string, now: Date, leaseMs: number): AutomationJob | null {
    const { nowIso, expiresAtIso } = validateLeaseInput(workerId, now, leaseMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db.prepare(`SELECT id FROM automation_jobs
        WHERE status = 'pending' AND attempt < max_attempts
        ORDER BY created_at, id LIMIT 1`).get() as { id: string } | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const result = this.db.prepare(`UPDATE automation_jobs
        SET status = 'leased', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND attempt < max_attempts`)
        .run(workerId, expiresAtIso, nowIso, candidate.id);
      if (Number(result.changes) !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(candidate.id) as unknown as AutomationJobRow;
      this.db.exec("COMMIT");
      return mapAutomationJob(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(jobId: string, workerId: string, now: Date, leaseMs: number): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    const { nowIso, expiresAtIso } = validateLeaseInput(workerId, now, leaseMs);
    const result = this.db.prepare(`UPDATE automation_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(expiresAtIso, nowIso, jobId, workerId, nowIso);
    return Number(result.changes) === 1;
  }

  complete(jobId: string, workerId: string): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    validateWorkerId(workerId);
    const settleNow = validateDate(this.clock());
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(settleNow, jobId, workerId, settleNow);
    return Number(result.changes) === 1;
  }

  fail(jobId: string, workerId: string, error: string, retryable: boolean): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    validateWorkerId(workerId);
    if (typeof error !== "string" || error.trim().length === 0) {
      throw new Error("AUTOMATION_JOB_ERROR_INVALID");
    }
    if (typeof retryable !== "boolean") throw new Error("AUTOMATION_JOB_RETRYABLE_INVALID");
    const lastError = truncateCodePoints(error, MAX_ERROR_LENGTH);
    const settleNow = validateDate(this.clock());
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = CASE WHEN ? = 1 AND attempt < max_attempts THEN 'pending' ELSE 'failed' END,
        lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(retryable ? 1 : 0, lastError, settleNow, jobId, workerId, settleNow);
    return Number(result.changes) === 1;
  }

  cancelByOwnerVersion(
    ownerId: string,
    evidenceVersion: number,
    ownerType: AutomationJobOwnerType = "delivery_unit"
  ): number {
    validateBoundedId(ownerId, "AUTOMATION_JOB_OWNER_ID_INVALID");
    if (ownerType !== "requirement" && ownerType !== "delivery_unit") {
      throw new Error("AUTOMATION_JOB_OWNER_TYPE_INVALID");
    }
    if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1) {
      throw new Error("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
    }
    const cancelNow = validateDate(this.clock());
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE owner_type = ? AND owner_id = ? AND evidence_version = ? AND status IN ('pending', 'leased')`)
      .run(cancelNow, ownerType, ownerId, evidenceVersion);
    return Number(result.changes);
  }

  recoverExpired(now: Date): number {
    const nowIso = validateDate(now);
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = CASE WHEN attempt < max_attempts THEN 'pending' ELSE 'failed' END,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = CASE WHEN attempt >= max_attempts THEN COALESCE(last_error, 'Lease expired') ELSE last_error END,
        updated_at = ?
      WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`)
      .run(nowIso, nowIso);
    return Number(result.changes);
  }

  get(jobId: string): AutomationJob | null {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(jobId) as AutomationJobRow | undefined;
    return row ? mapAutomationJob(row) : null;
  }

  byDedupe(dedupeKey: string): AutomationJob | null {
    validateBoundedString(dedupeKey, 512, "AUTOMATION_JOB_DEDUPE_KEY_INVALID");
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE dedupe_key = ?").get(dedupeKey) as AutomationJobRow | undefined;
    return row ? mapAutomationJob(row) : null;
  }

  listPending(): AutomationJob[] {
    return (this.db.prepare("SELECT * FROM automation_jobs WHERE status = 'pending' ORDER BY created_at, id").all() as unknown as AutomationJobRow[])
      .map(mapAutomationJob);
  }
}

function validateEnqueueInput(input: AutomationJobInput): string {
  if (!input || typeof input !== "object") throw new Error("AUTOMATION_JOB_INPUT_INVALID");
  if (input.ownerType !== "requirement" && input.ownerType !== "delivery_unit") {
    throw new Error("AUTOMATION_JOB_OWNER_TYPE_INVALID");
  }
  validateBoundedId(input.ownerId, "AUTOMATION_JOB_OWNER_ID_INVALID");
  if (!Number.isSafeInteger(input.evidenceVersion) || input.evidenceVersion < 1) {
    throw new Error("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
  }
  if (!(automationActions as readonly unknown[]).includes(input.action)) {
    throw new Error("AUTOMATION_JOB_ACTION_INVALID");
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS) {
    throw new Error("AUTOMATION_JOB_MAX_ATTEMPTS_INVALID");
  }
  assertJsonValue(input.payload, new Set());
  const payloadJson = JSON.stringify(input.payload);
  if (payloadJson === undefined || Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  }
  return payloadJson;
}

function validateBoundedId(value: unknown, errorCode: string) {
  validateBoundedString(value, MAX_OWNER_ID_LENGTH, errorCode);
}

function validateBoundedString(value: unknown, maxLength: number, errorCode: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new Error(errorCode);
  }
}

function canonicalDedupeKey(input: Pick<AutomationJobInput, "ownerType" | "ownerId" | "evidenceVersion" | "action">) {
  const owner = input.ownerType === "delivery_unit" ? input.ownerId : `requirement:${input.ownerId}`;
  return `${input.action}:${owner}:v${input.evidenceVersion}`;
}

function truncateCodePoints(value: string, maxCodePoints: number) {
  let end = 0;
  let count = 0;
  for (const codePoint of value) {
    if (count === maxCodePoints) break;
    end += codePoint.length;
    count += 1;
  }
  return value.slice(0, end);
}

function validateLeaseInput(workerId: string, now: Date, leaseMs: number) {
  validateWorkerId(workerId);
  const nowIso = validateDate(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    throw new Error("AUTOMATION_JOB_LEASE_MS_INVALID");
  }
  const expiresAt = new Date(now.getTime() + leaseMs);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("AUTOMATION_JOB_LEASE_DATE_INVALID");
  return { nowIso, expiresAtIso: expiresAt.toISOString() };
}

function validateWorkerId(workerId: unknown) {
  if (
    typeof workerId !== "string"
    || workerId.length < 1
    || workerId.length > MAX_WORKER_ID_LENGTH
    || workerId.trim() !== workerId
  ) {
    throw new Error("AUTOMATION_JOB_WORKER_ID_INVALID");
  }
}

function validateDate(date: unknown): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("AUTOMATION_JOB_DATE_INVALID");
  }
  return date.toISOString();
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  }
  if (typeof value !== "object") throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  if (ancestors.has(value)) throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  if (Array.isArray(value)) {
    ancestors.add(value);
    for (const item of value) assertJsonValue(item, ancestors);
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  ancestors.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) assertJsonValue(item, ancestors);
  ancestors.delete(value);
}

function mapAutomationJob(row: AutomationJobRow): AutomationJob {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    evidenceVersion: row.evidence_version,
    action: row.action,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    payload: JSON.parse(row.payload_json),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
