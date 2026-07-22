import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  automationActions,
  MAX_AUTOMATION_EVIDENCE_VERSION,
  type AutomationAction
} from "@ai-workflow/shared";

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
  claimToken: string;
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
  renew(jobId: string, workerId: string, claimToken: string, now: Date, leaseMs: number): boolean;
  complete(jobId: string, workerId: string, claimToken: string): boolean;
  fail(jobId: string, workerId: string, claimToken: string, error: unknown, retryable: boolean): boolean;
  cancelByOwnerVersion(ownerId: string, evidenceVersion: number, ownerType?: AutomationJobOwnerType): number;
  recoverExpired(now: Date): number;
  get(jobId: string): AutomationJob | null;
  byDedupe(dedupeKey: string): AutomationJob | null;
  listPending(): AutomationJob[];
}

const MAX_OWNER_ID_LENGTH = 256;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_ATTEMPTS = 100;
const MAX_WORKER_ID_LENGTH = 128;
const MAX_LEASE_MS = 86_400_000;
const MAX_ERROR_LENGTH = 4096;
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const AUTOMATION_LEASE_CLAIM_TOKEN = /^lease:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{1,128}):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DELIVERY_JOB_LEASE_ELIGIBLE_SQL = `(
  automation_jobs.owner_type = 'requirement'
  OR EXISTS (
    SELECT 1 FROM delivery_units unit
    WHERE unit.id = automation_jobs.owner_id
      AND unit.evidence_version = automation_jobs.evidence_version
      AND (
        (automation_jobs.action = 'implement'
          AND unit.phase = 'implementation' AND unit.status = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM coding_evidence coding
            WHERE coding.delivery_unit_id = unit.id
              AND coding.evidence_version = unit.evidence_version
          ))
        OR (automation_jobs.action IN ('review', 'test')
          AND unit.status IN ('awaiting_gate', 'returned', 'failed')
          AND EXISTS (
            SELECT 1 FROM coding_evidence coding
            WHERE coding.delivery_unit_id = unit.id
              AND coding.evidence_version = unit.evidence_version
          ))
        OR (automation_jobs.action = 'apply'
          AND unit.phase = 'acceptance_delivery'
          AND (unit.status = 'ready_for_acceptance' OR (
            unit.status = 'applying' AND EXISTS (
              SELECT 1 FROM delivery_application_runs application
              WHERE application.delivery_unit_id = unit.id
                AND application.evidence_version = automation_jobs.evidence_version
                AND application.automation_job_id = automation_jobs.id
                AND application.automation_attempt = automation_jobs.attempt
                AND application.claim_token = automation_jobs.claim_token
                AND application.status = 'applying'
                AND application.resolution_status = 'pending'
            )
          )))
      )
  )
)`;

export function parseAutomationLeaseClaimToken(
  value: unknown
): { jobId: string; workerId: string } | null {
  if (typeof value !== "string") return null;
  const match = AUTOMATION_LEASE_CLAIM_TOKEN.exec(value);
  return match ? { jobId: match[1]!, workerId: match[2]! } : null;
}

export class AutomationJobRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date()
  ) {}

  enqueue(input: AutomationJobInput, options: { reviveTerminal?: boolean } = {}): AutomationJob {
    const payloadJson = validateEnqueueInput(input);
    if (typeof options.reviveTerminal !== "boolean" && options.reviveTerminal !== undefined) {
      throw new Error("AUTOMATION_JOB_REVIVE_INVALID");
    }
    const dedupeKey = canonicalDedupeKey(input);
    const now = validateDate(this.clock());
    const id = randomUUID();
    this.db.prepare(`INSERT INTO automation_jobs
      (id, claim_token, dedupe_key, owner_type, owner_id, evidence_version, action, status, attempt, max_attempts,
       lease_owner, lease_expires_at, payload_json, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        status = 'pending', attempt = 0, claim_token = CASE
          WHEN automation_jobs.status = 'canceled' AND ? = 0
            THEN automation_jobs.claim_token ELSE excluded.claim_token END,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = NULL, updated_at = excluded.updated_at
      WHERE automation_jobs.status = 'canceled'
        OR (? = 1 AND automation_jobs.status IN ('failed', 'completed'))`)
      .run(id, id, dedupeKey, input.ownerType, input.ownerId, input.evidenceVersion, input.action,
        input.maxAttempts, payloadJson, now, now,
        options.reviveTerminal ? 1 : 0, options.reviveTerminal ? 1 : 0);
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE dedupe_key = ?").get(dedupeKey);
    if (!row) throw new Error("AUTOMATION_JOB_ENQUEUE_FAILED");
    const persisted = decodeAutomationJobRow(row);
    if (
      persisted.ownerType !== input.ownerType
      || persisted.ownerId !== input.ownerId
      || persisted.evidenceVersion !== input.evidenceVersion
      || persisted.action !== input.action
    ) {
      throw new Error("AUTOMATION_JOB_DEDUPE_CONFLICT");
    }
    return persisted;
  }

  leaseNext(workerId: string, now: Date, leaseMs: number): AutomationJob | null {
    const { nowIso, expiresAtIso } = validateLeaseInput(workerId, now, leaseMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db.prepare(`SELECT id FROM automation_jobs
        WHERE status = 'pending' AND attempt < max_attempts
          AND ${DELIVERY_JOB_LEASE_ELIGIBLE_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM requirement_automation_state state
            WHERE state.status = 'paused' AND state.requirement_id = CASE
              WHEN automation_jobs.owner_type = 'requirement' THEN automation_jobs.owner_id
              ELSE (SELECT unit.requirement_id FROM delivery_units unit WHERE unit.id = automation_jobs.owner_id)
            END
          )
        ORDER BY created_at, id LIMIT 1`).get() as { id: string } | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const claimToken = `lease:${candidate.id}:${workerId}:${randomUUID()}`;
      const result = this.db.prepare(`UPDATE automation_jobs
        SET status = 'leased', attempt = attempt + 1, claim_token = ?,
          lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND attempt < max_attempts
          AND ${DELIVERY_JOB_LEASE_ELIGIBLE_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM requirement_automation_state state
            WHERE state.status = 'paused' AND state.requirement_id = CASE
              WHEN automation_jobs.owner_type = 'requirement' THEN automation_jobs.owner_id
              ELSE (SELECT unit.requirement_id FROM delivery_units unit WHERE unit.id = automation_jobs.owner_id)
            END
          )`)
        .run(claimToken, workerId, expiresAtIso, nowIso, candidate.id);
      if (Number(result.changes) !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(candidate.id);
      const job = decodeAutomationJobRow(row);
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
  }

  renew(jobId: string, workerId: string, claimToken: string, now: Date, leaseMs: number): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    validateBoundedId(claimToken, "AUTOMATION_JOB_CLAIM_TOKEN_INVALID");
    const { nowIso, expiresAtIso } = validateLeaseInput(workerId, now, leaseMs);
    const result = this.db.prepare(`UPDATE automation_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND claim_token = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(expiresAtIso, nowIso, jobId, workerId, claimToken, nowIso);
    return Number(result.changes) === 1;
  }

  complete(jobId: string, workerId: string, claimToken: string): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    validateWorkerId(workerId);
    validateBoundedId(claimToken, "AUTOMATION_JOB_CLAIM_TOKEN_INVALID");
    const settleNow = validateDate(this.clock());
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND claim_token = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(settleNow, jobId, workerId, claimToken, settleNow);
    if (Number(result.changes) === 1) return true;
    if (!claimToken.startsWith(`lease:${jobId}:${workerId}:`)) return false;
    const completed = this.db.prepare(`SELECT 1 FROM automation_jobs
      WHERE id = ? AND status = 'completed' AND claim_token = ?`).get(jobId, claimToken);
    return completed !== undefined;
  }

  fail(jobId: string, workerId: string, claimToken: string, error: unknown, retryable: boolean): boolean {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    validateWorkerId(workerId);
    validateBoundedId(claimToken, "AUTOMATION_JOB_CLAIM_TOKEN_INVALID");
    if (typeof retryable !== "boolean") throw new Error("AUTOMATION_JOB_RETRYABLE_INVALID");
    const lastError = sanitizeFailureError(error);
    const settleNow = validateDate(this.clock());
    const result = this.db.prepare(`UPDATE automation_jobs
      SET status = CASE
        WHEN owner_type = 'delivery_unit' AND EXISTS (
          SELECT 1 FROM delivery_units unit
          WHERE unit.id = automation_jobs.owner_id
            AND unit.evidence_version = automation_jobs.evidence_version
            AND unit.status = 'potentially_stale'
        ) THEN 'canceled'
        WHEN ? = 1 AND attempt < max_attempts AND ${DELIVERY_JOB_LEASE_ELIGIBLE_SQL}
          THEN 'pending'
        ELSE 'failed'
      END,
        lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND claim_token = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(retryable ? 1 : 0, lastError, settleNow, jobId, workerId, claimToken, settleNow);
    return Number(result.changes) === 1;
  }

  cancelByOwnerVersion(
    ownerId: string,
    evidenceVersion: number,
    ownerType: AutomationJobOwnerType = "delivery_unit"
  ): number {
    validateOwnerId(ownerId);
    if (ownerType !== "requirement" && ownerType !== "delivery_unit") {
      throw new Error("AUTOMATION_JOB_OWNER_TYPE_INVALID");
    }
    validateEvidenceVersion(evidenceVersion);
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
      SET status = CASE
        WHEN owner_type = 'delivery_unit' AND (
          NOT EXISTS (
            SELECT 1 FROM delivery_units unit
            WHERE unit.id = automation_jobs.owner_id
              AND unit.evidence_version = automation_jobs.evidence_version
          )
          OR EXISTS (
            SELECT 1 FROM delivery_units unit
            WHERE unit.id = automation_jobs.owner_id
              AND unit.evidence_version = automation_jobs.evidence_version
              AND unit.status = 'potentially_stale'
          )
        ) THEN 'canceled'
        WHEN attempt < max_attempts THEN 'pending'
        ELSE 'failed'
      END,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = CASE WHEN attempt >= max_attempts THEN COALESCE(last_error, 'Lease expired') ELSE last_error END,
        updated_at = ?
      WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`)
      .run(nowIso, nowIso);
    return Number(result.changes);
  }

  get(jobId: string): AutomationJob | null {
    validateBoundedId(jobId, "AUTOMATION_JOB_ID_INVALID");
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(jobId);
    return row ? decodeAutomationJobRow(row) : null;
  }

  byDedupe(dedupeKey: string): AutomationJob | null {
    validateBoundedString(dedupeKey, 512, "AUTOMATION_JOB_DEDUPE_KEY_INVALID");
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE dedupe_key = ?").get(dedupeKey);
    return row ? decodeAutomationJobRow(row) : null;
  }

  listPending(): AutomationJob[] {
    return this.db.prepare(`SELECT * FROM automation_jobs
      WHERE status = 'pending' AND attempt < max_attempts
      ORDER BY created_at, id`).all().map(decodeAutomationJobRow);
  }
}

function validateEnqueueInput(input: AutomationJobInput): string {
  if (!input || typeof input !== "object") throw new Error("AUTOMATION_JOB_INPUT_INVALID");
  if (input.ownerType !== "requirement" && input.ownerType !== "delivery_unit") {
    throw new Error("AUTOMATION_JOB_OWNER_TYPE_INVALID");
  }
  validateOwnerId(input.ownerId);
  validateEvidenceVersion(input.evidenceVersion);
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

function validateOwnerId(value: unknown) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_OWNER_ID_LENGTH
    || !OWNER_ID_PATTERN.test(value)
  ) {
    throw new Error("AUTOMATION_JOB_OWNER_INVALID");
  }
}

function validateEvidenceVersion(value: unknown) {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > MAX_AUTOMATION_EVIDENCE_VERSION
  ) {
    throw new Error("AUTOMATION_JOB_EVIDENCE_VERSION_INVALID");
  }
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
    || !WORKER_ID_PATTERN.test(workerId)
  ) {
    throw new Error("AUTOMATION_JOB_WORKER_ID_INVALID");
  }
}

function sanitizeFailureError(error: unknown): string {
  let errorText: string;
  if (typeof error === "string") {
    errorText = error;
  } else if (error instanceof Error) {
    errorText = error.message || error.name;
  } else {
    try {
      errorText = String(error);
    } catch {
      errorText = "Unknown error";
    }
  }
  if (errorText.trim().length === 0) throw new Error("AUTOMATION_JOB_ERROR_INVALID");
  return truncateCodePoints(errorText.replaceAll("\0", "\\0"), MAX_ERROR_LENGTH);
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

function parseStoredPayload(payloadJson: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("AUTOMATION_JOB_PAYLOAD_INVALID");
  }
  assertJsonValue(payload, new Set());
  return payload;
}

function decodeAutomationJobRow(row: unknown): AutomationJob {
  try {
    if (!isRecord(row)) throw new Error("invalid row");
    const id = decodeStoredString(row.id, MAX_OWNER_ID_LENGTH, true);
    const claimToken = decodeStoredString(row.claim_token, MAX_OWNER_ID_LENGTH, true);
    const dedupeKey = decodeStoredString(row.dedupe_key, 512, false);
    if (row.owner_type !== "requirement" && row.owner_type !== "delivery_unit") {
      throw new Error("invalid owner type");
    }
    const ownerType = row.owner_type;
    if (typeof row.owner_id !== "string" || !OWNER_ID_PATTERN.test(row.owner_id)
      || row.owner_id.length > MAX_OWNER_ID_LENGTH) {
      throw new Error("invalid owner");
    }
    const ownerId = row.owner_id;
    if (!Number.isSafeInteger(row.evidence_version) || (row.evidence_version as number) < 1
      || (row.evidence_version as number) > MAX_AUTOMATION_EVIDENCE_VERSION) {
      throw new Error("invalid evidence version");
    }
    const evidenceVersion = row.evidence_version as number;
    if (!(automationActions as readonly unknown[]).includes(row.action)) throw new Error("invalid action");
    const action = row.action as AutomationAction;
    if (!isAutomationJobStatus(row.status)) throw new Error("invalid status");
    const status = row.status;
    if (!Number.isSafeInteger(row.attempt) || (row.attempt as number) < 0) throw new Error("invalid attempt");
    const attempt = row.attempt as number;
    if (!Number.isSafeInteger(row.max_attempts) || (row.max_attempts as number) < 1
      || (row.max_attempts as number) > MAX_ATTEMPTS) {
      throw new Error("invalid maximum attempts");
    }
    const maxAttempts = row.max_attempts as number;
    if (attempt > maxAttempts || (status === "pending" && attempt >= maxAttempts)
      || (status === "leased" && attempt < 1)) {
      throw new Error("invalid attempt state");
    }

    let leaseOwner: string | null;
    let leaseExpiresAt: string | null;
    if (status === "leased") {
      leaseOwner = decodeStoredString(row.lease_owner, MAX_WORKER_ID_LENGTH, true);
      if (!WORKER_ID_PATTERN.test(leaseOwner)) throw new Error("invalid lease owner");
      leaseExpiresAt = decodeStoredTimestamp(row.lease_expires_at);
    } else {
      if (row.lease_owner !== null || row.lease_expires_at !== null) throw new Error("invalid lease state");
      leaseOwner = null;
      leaseExpiresAt = null;
    }

    const payloadJson = decodeStoredString(row.payload_json, MAX_PAYLOAD_BYTES, false, true);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("invalid payload length");
    const payload = parseStoredPayload(payloadJson);
    let lastError: string | null;
    if (row.last_error === null) {
      lastError = null;
    } else {
      if (typeof row.last_error !== "string" || row.last_error.includes("\0")
        || Array.from(row.last_error).length > MAX_ERROR_LENGTH) {
        throw new Error("invalid last error");
      }
      lastError = row.last_error;
    }
    const createdAt = decodeStoredTimestamp(row.created_at);
    const updatedAt = decodeStoredTimestamp(row.updated_at);
    if (updatedAt < createdAt) throw new Error("invalid timestamp order");
    if (leaseExpiresAt !== null && leaseExpiresAt <= updatedAt) throw new Error("invalid lease expiry");
    if (dedupeKey !== canonicalDedupeKey({ ownerType, ownerId, evidenceVersion, action })) {
      throw new Error("invalid dedupe key");
    }

    return {
      id, claimToken, dedupeKey, ownerType, ownerId, evidenceVersion, action, status, attempt, maxAttempts,
      leaseOwner, leaseExpiresAt, payload, lastError, createdAt, updatedAt
    };
  } catch {
    throw new Error("AUTOMATION_JOB_ROW_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutomationJobStatus(value: unknown): value is AutomationJobStatus {
  return value === "pending" || value === "leased" || value === "completed"
    || value === "failed" || value === "canceled";
}

function decodeStoredString(value: unknown, maxLength: number, trim: boolean, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.length < 1)
    || value.length > maxLength || (trim && value.trim() !== value)) {
    throw new Error("invalid string");
  }
  return value;
}

function decodeStoredTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid timestamp");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("invalid timestamp");
  }
  return value;
}
