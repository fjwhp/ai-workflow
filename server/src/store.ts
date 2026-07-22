import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultGateConfig, parseGateConfig, returnStage, workflowStages, type GateConfig, type ProjectVersion, type RequirementInput, type RequirementProject, type RequirementProjectInput, type WorkflowStage } from "@ai-workflow/shared";
import { hasMaterialAssociationChange, validateRequirementProjects } from "./requirement-projects.js";
import { buildReworkContext } from "./rework-context.js";
import { createPhase2Schema } from "./database-schema.js";
import {
  DeliveryUnitRepository,
  type CreateDeliveryPlanInput,
  type DeliveryPlanResult,
  type DeliveryUnitPersistence
} from "./delivery-unit-repository.js";
import {
  DeliveryExecutionRepository,
  type DeliveryImplementationPublicationInput,
  type DeliveryExecutionPersistence
} from "./delivery-execution-repository.js";
import {
  DeliveryUnitDetailRepository,
  type DeliveryUnitDetailPersistence
} from "./delivery-unit-detail.js";
import {
  DeliveryQualityRepository,
  type DeliveryQualityPersistence
} from "./delivery-quality-repository.js";
import {
  DeliveryApplicationRepository,
  type DeliveryApplicationPersistence
} from "./delivery-application-repository.js";
import {
  DeliveryCoordinator,
  type DeliveryCoordinationPersistence
} from "./delivery-coordinator.js";
import {
  AutomationJobRepository,
  type AutomationJobPersistence
} from "./automation-job-repository.js";
import {
  ExecutionRepository,
  type CodingEvidenceInput,
  type ExecutionInput
} from "./execution-repository.js";
import { deliveryEventGeneration } from "./delivery-live-events.js";
import {
  applyImplementationPatchSync,
  captureImplementationPatchSync,
  implementationPatchHash,
  readImplementationHeadSync,
  reverseImplementationPatchSync,
  validateImplementationPatch
} from "./implementation-publication.js";
import { cleanupJournaledCodingAttemptWorktree } from "./repository.js";

const IMPLEMENTATION_PUBLICATION_LEASE_RESERVATION_MS = 60_000;

export type { ExecutionInput } from "./execution-repository.js";

export type RequirementProjectWithVersionMetadata = RequirementProject & {
  projectVersionWorktreePath?: string;
  projectVersionHead?: string;
};

export interface RequirementProjectSnapshot {
  id: string;
  requirementId: string;
  version: number;
  associations: RequirementProjectWithVersionMetadata[];
  status: "active" | "superseded";
  supersededAt: string | null;
  createdAt: string;
}

export interface RequirementArtifact {
  id: string;
  requirementId: string;
  stage: WorkflowStage;
  version: number;
  title: string;
  content: unknown;
  createdAt: string;
}

export interface StageRunInput {
  requirementId: string;
  stage: WorkflowStage;
  model: string;
  input: unknown;
  projectId?: string;
  projectVersionId?: string;
  expectedRequirementUpdatedAt?: string;
  expectedRequirementStatus?: string;
  expectedRequirementProjectIds?: string[];
  expectedProjectUpdatedAt?: string;
}

export class WorkflowStore {
  private db: DatabaseSync;
  private readonly deliveryUnitRepository: DeliveryUnitRepository;
  private readonly deliveryExecutionRepository: DeliveryExecutionRepository;
  private readonly deliveryQualityRepository: DeliveryQualityRepository;
  private readonly deliveryApplicationRepository: DeliveryApplicationRepository;
  private readonly executionRepository: ExecutionRepository;
  public readonly deliveryUnits: DeliveryUnitPersistence;
  public readonly deliveryExecutions: DeliveryExecutionPersistence;
  public readonly deliveryQuality: DeliveryQualityPersistence;
  public readonly deliveryApplications: DeliveryApplicationPersistence;
  public readonly deliveryCoordination: DeliveryCoordinationPersistence;
  public readonly deliveryUnitDetails: DeliveryUnitDetailPersistence;
  public readonly automationJobs: AutomationJobPersistence;

  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly publicationHooks: {
      afterApply?: () => void;
      beforeRecoverySettlement?: () => void;
    } = {}
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    createPhase2Schema(this.db);
    this.deliveryUnitRepository = new DeliveryUnitRepository(this.db);
    this.deliveryExecutionRepository = new DeliveryExecutionRepository(this.db, clock);
    this.deliveryQualityRepository = new DeliveryQualityRepository(this.db, clock);
    this.deliveryApplicationRepository = new DeliveryApplicationRepository(this.db, clock);
    const deliveryCoordinator = new DeliveryCoordinator(this.db, this.deliveryQualityRepository);
    const deliveryUnitDetails = new DeliveryUnitDetailRepository(this.db, this.deliveryUnitRepository);
    this.executionRepository = new ExecutionRepository(this.db);
    const automationJobRepository = new AutomationJobRepository(this.db, clock);
    this.deliveryUnits = {
      createPlan: (input) => this.withImmediateTransaction(
        () => this.deliveryUnitRepository.createPlanInTransaction(input)
      ),
      get: (unitId) => this.deliveryUnitRepository.get(unitId),
      listForRequirement: (requirementId) => this.deliveryUnitRepository.listForRequirement(requirementId),
      listDependencies: (requirementId) => this.deliveryUnitRepository.listDependencies(requirementId)
    };
    this.deliveryApplications = {
      claim: (unitId, input) => this.withImmediateTransaction(
        () => this.deliveryApplicationRepository.claimInTransaction(unitId, input)
      ),
      bindSourceCommit: (claim, sourceCommit) => this.withImmediateTransaction(
        () => this.deliveryApplicationRepository.bindSourceCommitInTransaction(claim, sourceCommit)
      ),
      complete: (claim, completion) => this.withImmediateTransaction(
        () => this.deliveryApplicationRepository.completeInTransaction(claim, completion)
      ),
      resolve: (run, resolution) => this.withImmediateTransaction(
        () => this.deliveryApplicationRepository.resolveInTransaction(run, resolution)
      ),
      get: (runId) => this.deliveryApplicationRepository.get(runId),
      listForUnit: (unitId) => this.deliveryApplicationRepository.listForUnit(unitId),
      aggregate: (requirementId) => this.withReadTransaction(
        () => this.deliveryApplicationRepository.aggregate(requirementId)
      )
    };
    this.deliveryExecutions = {
      claimImplementation: (unitId, model, automation) => this.withImmediateTransaction(
        () => this.deliveryExecutionRepository.claimImplementationInTransaction(unitId, model, automation)
      ),
      completeImplementation: (claim, result) => this.withImmediateTransaction(
        () => {
          const unit = this.deliveryExecutionRepository.completeImplementationInTransaction(claim, result);
          deliveryCoordinator.recordImplementationEvidenceInTransaction(unit.id, unit.evidenceVersion);
          if (!deliveryCoordinator.isRequirementPaused(unit.requirementId)) {
            for (const action of ["review", "test"] as const) {
              automationJobRepository.enqueue({
                ownerType: "delivery_unit",
                ownerId: unit.id,
                evidenceVersion: unit.evidenceVersion,
                action,
                payload: {},
                maxAttempts: 3
              });
            }
          }
          return unit;
        }
      ),
      prepareImplementationPublication: (claim, input) => this.withImmediateTransaction(
        () => this.prepareImplementationPublicationInTransaction(claim, input)
      ),
      reconcilePreparedImplementation: async () => {
        await this.reconcileImplementationPublications();
      },
      publishPreparedImplementation: (claim, result) => this.withImmediateTransaction(() => {
        const lease = claim.automationLease;
        if (!lease) throw new Error("IMPLEMENTATION_PUBLICATION_AUTOMATION_REQUIRED");
        const row = this.db.prepare(`SELECT * FROM implementation_publication_journals
          WHERE delivery_unit_id = ? AND evidence_version = ?
            AND status IN ('prepared', 'committed', 'manual')
          ORDER BY created_at DESC, id DESC LIMIT 1`).get(
          claim.deliveryUnit.id, claim.deliveryUnit.evidenceVersion
        ) as any;
        if (!row || row.job_id !== lease.jobId || row.claim_token !== lease.claimToken
          || row.worker_id !== lease.workerId || row.execution_id !== claim.executionId
          || row.run_id !== claim.runId) {
          throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
        }
        if (row.status === "committed") {
          const job = automationJobRepository.get(lease.jobId);
          if (job?.status !== "completed" || job.claimToken !== lease.claimToken) {
            throw new Error("IMPLEMENTATION_PUBLICATION_SETTLEMENT_INVALID");
          }
          const completed = this.deliveryUnitRepository.get(claim.deliveryUnit.id);
          if (!completed || !this.deliveryExecutionRepository.getCodingEvidence(
            claim.deliveryUnit.id, claim.deliveryUnit.evidenceVersion
          )) throw new Error("IMPLEMENTATION_PUBLICATION_SETTLEMENT_INVALID");
          return completed;
        }
        if (row.status !== "prepared") throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
        this.deliveryExecutionRepository.assertImplementationLeaseInTransaction(claim);
        if (readImplementationHeadSync(row.authoritative_worktree_path) !== row.base_commit
          || implementationPatchHash(captureImplementationPatchSync(row.authoritative_worktree_path))
            !== row.baseline_diff_hash) {
          throw new Error("IMPLEMENTATION_AUTHORITATIVE_WORKTREE_DIRTY");
        }
        const patch = Buffer.from(row.patch_blob);
        validateImplementationPatch(patch);
        if (patch.length !== row.patch_bytes || implementationPatchHash(patch) !== row.patch_sha256) {
          throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_INVALID");
        }
        applyImplementationPatchSync(row.authoritative_worktree_path, patch);
        this.publicationHooks.afterApply?.();
        this.deliveryExecutionRepository.assertImplementationLeaseInTransaction(claim);
        const published = captureImplementationPatchSync(row.authoritative_worktree_path);
        if (!published.equals(patch) || implementationPatchHash(published) !== row.published_diff_hash) {
          throw new Error("IMPLEMENTATION_PUBLICATION_DIFF_MISMATCH");
        }
        const unit = this.deliveryExecutionRepository.completeImplementationInTransaction(claim, result);
        deliveryCoordinator.recordImplementationEvidenceInTransaction(unit.id, unit.evidenceVersion);
        if (!deliveryCoordinator.isRequirementPaused(unit.requirementId)) {
          for (const action of ["review", "test"] as const) {
            automationJobRepository.enqueue({
              ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: unit.evidenceVersion,
              action, payload: {}, maxAttempts: 3
            });
          }
        }
        if (!automationJobRepository.complete(lease.jobId, lease.workerId, lease.claimToken)) {
          throw new Error("IMPLEMENTATION_PUBLICATION_JOB_SETTLEMENT_STALE");
        }
        const now = this.nowIso();
        const committed = this.db.prepare(`UPDATE implementation_publication_journals
          SET status = 'committed', updated_at = ?, committed_at = ?
          WHERE id = ? AND status = 'prepared' AND claim_token = ?`).run(
          now, now, row.id, lease.claimToken
        );
        if (committed.changes !== 1) throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
        return unit;
      }),
      getCompletedImplementation: (unitId, evidenceVersion, claimToken) => {
        const row = this.db.prepare(`SELECT job_id FROM implementation_publication_journals
          WHERE delivery_unit_id = ? AND evidence_version = ? AND claim_token = ? AND status = 'committed'`)
          .get(unitId, evidenceVersion, claimToken) as { job_id: string } | undefined;
        if (!row) return null;
        const job = automationJobRepository.get(row.job_id);
        if (job?.status !== "completed" || job.claimToken !== claimToken
          || !this.deliveryExecutionRepository.getCodingEvidence(unitId, evidenceVersion)) return null;
        return this.deliveryUnitRepository.get(unitId);
      },
      settleImplementationPublicationCleanup: (claim, status, error) => this.withImmediateTransaction(() => {
        const lease = claim.automationLease;
        if (!lease) throw new Error("IMPLEMENTATION_PUBLICATION_AUTOMATION_REQUIRED");
        const now = this.nowIso();
        const lastError = status === "failed" ? boundedPublicationError(error) : null;
        const settled = this.db.prepare(`UPDATE implementation_publication_journals
          SET cleanup_status = ?, last_error = ?, cleanup_completed_at = ?, updated_at = ?
          WHERE delivery_unit_id = ? AND evidence_version = ? AND job_id = ? AND claim_token = ?
            AND status = 'committed'`).run(
          status, lastError, status === "completed" ? now : null, now,
          claim.deliveryUnit.id, claim.deliveryUnit.evidenceVersion, lease.jobId, lease.claimToken
        );
        if (settled.changes !== 1) throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
      }),
      failImplementation: (claim, error) => this.withImmediateTransaction(
        () => this.deliveryExecutionRepository.failImplementationInTransaction(claim, error)
      ),
      assertImplementationLease: (claim) => this.withImmediateTransaction(
        () => this.deliveryExecutionRepository.assertImplementationLeaseInTransaction(claim)
      ),
      listExecutions: (deliveryUnitId, evidenceVersion) =>
        this.deliveryExecutionRepository.listExecutions(deliveryUnitId, evidenceVersion),
      getCodingEvidence: (deliveryUnitId, evidenceVersion) =>
        this.deliveryExecutionRepository.getCodingEvidence(deliveryUnitId, evidenceVersion)
    };
    this.automationJobs = {
      enqueue: (input) => automationJobRepository.enqueue(input),
      leaseNext: (workerId, now, leaseMs) => automationJobRepository.leaseNext(workerId, now, leaseMs),
      renew: (jobId, workerId, now, leaseMs) => automationJobRepository.renew(jobId, workerId, now, leaseMs),
      complete: (jobId, workerId, claimToken) => automationJobRepository.complete(jobId, workerId, claimToken),
      fail: (jobId, workerId, error, retryable) => this.withImmediateTransaction(() => {
        const settled = automationJobRepository.fail(jobId, workerId, error, retryable);
        if (settled) this.deliveryQualityRepository.abortTerminalAutomationClaimsInTransaction();
        return settled;
      }),
      cancelByOwnerVersion: (ownerId, evidenceVersion, ownerType) =>
        automationJobRepository.cancelByOwnerVersion(ownerId, evidenceVersion, ownerType),
      recoverExpired: (now) => this.withImmediateTransaction(() => {
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("AUTOMATION_JOB_DATE_INVALID");
        const expiredImplementations = this.db.prepare(`SELECT id, owner_id, evidence_version
          FROM automation_jobs WHERE owner_type = 'delivery_unit' AND action = 'implement'
            AND status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`)
          .all(now.toISOString()) as Array<{ id: string; owner_id: string; evidence_version: number }>;
        const recovered = automationJobRepository.recoverExpired(now);
        this.settleExpiredImplementationsInTransaction(expiredImplementations, now.toISOString());
        this.deliveryQualityRepository.abortTerminalAutomationClaimsInTransaction();
        return recovered;
      }),
      get: (jobId) => automationJobRepository.get(jobId),
      byDedupe: (dedupeKey) => automationJobRepository.byDedupe(dedupeKey),
      listPending: () => automationJobRepository.listPending()
    };
    this.deliveryQuality = {
      claim: (unitId, evidenceVersion, kind, claimToken) => this.withImmediateTransaction(
        () => this.deliveryQualityRepository.claimInTransaction(unitId, evidenceVersion, kind, claimToken)
      ),
      complete: (claim, completion) => this.withImmediateTransaction(
        () => deliveryCoordinator.recordQualityInTransaction(claim, completion)
      ),
      abort: (claim, error) => this.withImmediateTransaction(
        () => this.deliveryQualityRepository.abortInTransaction(claim, error)
      ),
      latest: (unitId, kind) => this.deliveryQualityRepository.latest(unitId, kind)
    };
    this.deliveryCoordination = {
      overrideQuality: (input) => this.withImmediateTransaction(
        () => deliveryCoordinator.overrideQualityInTransaction(input)
      ),
      resolveStale: (input) => this.withImmediateTransaction(
        () => deliveryCoordinator.resolveStaleInTransaction(input)
      ),
      completeContractEvidence: (input) => this.withImmediateTransaction(
        () => deliveryCoordinator.completeContractEvidenceInTransaction(input)
      ),
      pauseAutomation: (input) => {
        try {
          return this.withImmediateTransaction(() => deliveryCoordinator.pauseAutomationInTransaction(input));
        } catch (error) {
          if (error instanceof Error && error.message === "REQUIREMENT_AUTOMATION_STATE_CONFLICT") {
            this.withImmediateTransaction(() => deliveryCoordinator.auditAutomationConflictInTransaction(input, "pause"));
          }
          throw error;
        }
      },
      resumeAutomation: (input) => {
        try {
          return this.withImmediateTransaction(() => deliveryCoordinator.resumeAutomationInTransaction(input));
        } catch (error) {
          if (error instanceof Error && error.message === "REQUIREMENT_AUTOMATION_STATE_CONFLICT") {
            this.withImmediateTransaction(() => deliveryCoordinator.auditAutomationConflictInTransaction(input, "resume"));
          }
          throw error;
        }
      },
      skipOptional: (input) => this.withImmediateTransaction(
        () => deliveryCoordinator.skipOptionalInTransaction(input)
      ),
      retryUnit: (input) => this.withImmediateTransaction(
        () => deliveryCoordinator.retryUnitInTransaction(input)
      ),
      listQualityOverrides: (unitId, evidenceVersion) =>
        deliveryCoordinator.listQualityOverrides(unitId, evidenceVersion)
    };
    this.deliveryUnitDetails = {
      getForRequirement: (requirementId) => this.withReadTransaction(
        () => deliveryUnitDetails.getForRequirement(requirementId)
      )
    };
  }

  withImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private prepareImplementationPublicationInTransaction(
    claim: import("./delivery-execution-repository.js").DeliveryExecutionClaim,
    input: DeliveryImplementationPublicationInput
  ) {
    const lease = claim.automationLease;
    if (!lease) throw new Error("IMPLEMENTATION_PUBLICATION_AUTOMATION_REQUIRED");
    this.deliveryExecutionRepository.assertImplementationLeaseInTransaction(claim);
    const reservationStart = this.clock();
    if (!Number.isFinite(reservationStart.getTime())) {
      throw new Error("IMPLEMENTATION_PUBLICATION_DATE_INVALID");
    }
    const reservationExpires = new Date(
      reservationStart.getTime() + IMPLEMENTATION_PUBLICATION_LEASE_RESERVATION_MS
    ).toISOString();
    const reserved = this.db.prepare(`UPDATE automation_jobs SET
        lease_expires_at = CASE WHEN lease_expires_at < ? THEN ? ELSE lease_expires_at END,
        updated_at = ?
      WHERE id = ? AND claim_token = ? AND lease_owner = ? AND status = 'leased'
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`).run(
      reservationExpires, reservationExpires, reservationStart.toISOString(),
      lease.jobId, lease.claimToken, lease.workerId, reservationStart.toISOString()
    );
    if (reserved.changes !== 1) throw new Error("DELIVERY_IMPLEMENTATION_AUTOMATION_LEASE_STALE");
    validateImplementationPatch(input.patch);
    if (input.repoPath !== claim.project.repoPath
      || !Number.isSafeInteger(input.attemptDev) || input.attemptDev < 0
      || !Number.isSafeInteger(input.attemptIno) || input.attemptIno < 0
      || !Number.isSafeInteger(input.attemptUid) || input.attemptUid < 0
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.attemptNonce)) {
      throw new Error("IMPLEMENTATION_PUBLICATION_INPUT_INVALID");
    }
    const baseCommit = readImplementationHeadSync(input.authoritativeWorktreePath);
    const baseline = captureImplementationPatchSync(input.authoritativeWorktreePath);
    if (baseCommit !== claim.version.headCommit || baseline.length !== 0) {
      throw new Error("IMPLEMENTATION_AUTHORITATIVE_WORKTREE_DIRTY");
    }
    const now = this.nowIso();
    const id = randomUUID();
    const patchHash = implementationPatchHash(input.patch);
    const existing = this.db.prepare(`SELECT * FROM implementation_publication_journals
      WHERE delivery_unit_id = ? AND evidence_version = ?
        AND status IN ('prepared', 'committed', 'manual')
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(
      claim.deliveryUnit.id, claim.deliveryUnit.evidenceVersion
    ) as any;
    if (existing) {
      if (existing.status === "prepared" && existing.job_id === lease.jobId
        && existing.claim_token === lease.claimToken && existing.patch_sha256 === patchHash
        && existing.attempt_dev === input.attemptDev && existing.attempt_ino === input.attemptIno
        && existing.attempt_nonce === input.attemptNonce) {
        return mapImplementationPublicationJournal(existing);
      }
      throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_CONFLICT");
    }
    this.db.prepare(`INSERT INTO implementation_publication_journals
      (id, job_id, claim_token, worker_id, delivery_unit_id, evidence_version, execution_id, run_id,
       attempt_path, attempt_dev, attempt_ino, attempt_uid, attempt_nonce, repo_path,
       authoritative_worktree_path, base_commit, baseline_diff_hash, patch_blob, patch_sha256,
       patch_bytes, published_diff_hash, status, cleanup_status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'pending', NULL, ?, ?)`)
      .run(id, lease.jobId, lease.claimToken, lease.workerId, claim.deliveryUnit.id,
        claim.deliveryUnit.evidenceVersion, claim.executionId, claim.runId, input.attemptPath,
        input.attemptDev, input.attemptIno, input.attemptUid, input.attemptNonce, input.repoPath,
        input.authoritativeWorktreePath, baseCommit, implementationPatchHash(baseline), input.patch,
        patchHash, input.patch.length, patchHash, now, now);
    return { id, status: "prepared" as const, cleanupStatus: "pending" as const };
  }

  private nowIso() {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error("IMPLEMENTATION_PUBLICATION_DATE_INVALID");
    return now.toISOString();
  }

  private withReadTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createDeliveryPlanInTransaction(input: CreateDeliveryPlanInput): DeliveryPlanResult {
    return this.deliveryUnitRepository.createPlanInTransaction(input);
  }

  createRequirement(input: RequirementInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const association = validateRequirementProjects([{
        projectId: input.primaryProjectId, projectVersionId: input.primaryProjectVersionId,
        role: "primary", usage: "delivery", deliveryRequired: true,
        moduleMode: "auto", moduleIds: [], position: 0
      }], {
        projects: this.projectValidationRows([input.primaryProjectId]),
        versions: this.versionValidationRows([input.primaryProjectVersionId])
      })[0]!;
      const code = this.nextRequirementCode();
      this.db.prepare(`INSERT INTO requirements
        (id, code, title, business_problem, expected_outcome, priority, stage, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'definition', 'ai_ready', ?, ?)`)
        .run(id, code, input.title, input.businessProblem, input.expectedOutcome, input.priority, now, now);
      this.insertRequirementRevision(id, 1, { ...input, clarifications: "" }, "创建需求", now);
      this.insertRequirementAssociation(id, association, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getRequirement(id)!;
  }

  private nextRequirementCode() {
    const row = this.db.prepare(
      "UPDATE counters SET value = value + 1 WHERE key = 'requirement' RETURNING value"
    ).get() as { value: number } | undefined;
    if (!row) throw new Error("REQUIREMENT_COUNTER_MISSING");
    return `REQ-${String(row.value).padStart(4, "0")}`;
  }

  listRequirements() {
    return this.db.prepare("SELECT r.* FROM requirements r ORDER BY r.created_at DESC").all()
      .map((row) => this.mapRequirementWithProjects(row as any));
  }

  getRequirement(id: string) {
    const row = this.db.prepare("SELECT r.* FROM requirements r WHERE r.id = ?").get(id);
    return row ? this.mapRequirementWithProjects(row as any) : null;
  }

  setRequirementProject(id: string, projectId: string | null, projectVersionId?: string): any {
    if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(id)) return null;
    if (!projectId || !projectVersionId || !this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(projectId)) return null;
    this.replaceRequirementProjects(id, [{ projectId, projectVersionId, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 0 }]);
    return this.getRequirement(id);
  }

  private insertRequirementAssociation(requirementId: string, input: RequirementProjectInput, now: string) {
    this.db.prepare(`INSERT INTO requirement_projects
      (id, requirement_id, project_id, project_version_id, role, usage, delivery_required, module_mode, module_ids_json, position, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(randomUUID(), requirementId, input.projectId, input.projectVersionId ?? null, input.role, input.usage, input.deliveryRequired ? 1 : 0,
        input.moduleMode, JSON.stringify(input.moduleIds), input.position, now, now);
  }

  listRequirementProjects(requirementId: string): RequirementProjectWithVersionMetadata[] {
    return (this.db.prepare(`SELECT rp.*, p.name AS project_name, p.status AS project_status,
        pv.name AS project_version_name, pv.branch AS project_version_branch,
        pv.status AS project_version_status, pv.worktree_path AS project_version_worktree_path,
        pv.head_commit AS project_version_head
      FROM requirement_projects rp JOIN projects p ON p.id = rp.project_id
      LEFT JOIN project_versions pv ON pv.id = rp.project_version_id
      WHERE rp.requirement_id = ? AND rp.status = 'active' ORDER BY rp.position, rp.created_at`).all(requirementId) as any[])
      .map(mapRequirementProject);
  }

  listArchivedRequirementProjectHistory(requirementId: string): RequirementProjectWithVersionMetadata[] {
    return (this.db.prepare(`SELECT rp.*, p.name AS project_name, p.status AS project_status,
        pv.name AS project_version_name, pv.branch AS project_version_branch,
        pv.status AS project_version_status, pv.worktree_path AS project_version_worktree_path,
        pv.head_commit AS project_version_head
      FROM requirement_projects rp JOIN projects p ON p.id = rp.project_id
      LEFT JOIN project_versions pv ON pv.id = rp.project_version_id
      WHERE rp.requirement_id = ? AND rp.status = 'archived' AND p.status = 'archived'
        AND NOT EXISTS (
          SELECT 1 FROM requirement_projects active
          WHERE active.requirement_id = rp.requirement_id AND active.project_id = rp.project_id AND active.status = 'active'
        )
        AND rp.rowid = (
          SELECT historical.rowid FROM requirement_projects historical
          WHERE historical.requirement_id = rp.requirement_id AND historical.project_id = rp.project_id
            AND historical.status = 'archived'
          ORDER BY historical.updated_at DESC, historical.created_at DESC, historical.rowid DESC LIMIT 1
        )
      ORDER BY rp.position, rp.created_at`).all(requirementId) as any[]).map(mapRequirementProject);
  }

  replaceRequirementProjects(requirementId: string, inputs: RequirementProjectInput[]): RequirementProject[] {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projects = this.replaceRequirementProjectsInTransaction(requirementId, inputs, now);
      this.db.exec("COMMIT");
      return projects;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  replaceRequirementProjectsAndInvalidate(requirementId: string, inputs: RequirementProjectInput[]) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.listRequirementProjects(requirementId);
      const projects = this.replaceRequirementProjectsInTransaction(requirementId, inputs, now);
      const materialChange = hasMaterialAssociationChange(before, projects);
      const solutionDesignInvalidated = materialChange &&
        this.invalidateSolutionDesignForProjectChangeInTransaction(requirementId, now);
      this.db.exec("COMMIT");
      return { projects, materialChange, solutionDesignInvalidated: Boolean(solutionDesignInvalidated) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private replaceRequirementProjectsInTransaction(
    requirementId: string,
    inputs: RequirementProjectInput[],
    now: string
  ): RequirementProject[] {
    if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(requirementId)) throw new Error("REQUIREMENT_NOT_FOUND");
    if (
      this.db.prepare("SELECT id FROM requirement_project_snapshots WHERE requirement_id = ? AND status = 'active' LIMIT 1").get(requirementId)
      || this.db.prepare("SELECT id FROM delivery_units WHERE requirement_id = ? LIMIT 1").get(requirementId)
    ) {
      throw new Error("REQUIREMENT_DELIVERY_PLAN_FROZEN");
    }
    if (this.db.prepare("SELECT id FROM stage_runs WHERE requirement_id = ? AND status = 'running'").get(requirementId)) throw new Error("RUN_ALREADY_ACTIVE");
    const projectIds = [...new Set(inputs.map((item) => item.projectId))];
    const versionIds = [...new Set(inputs.flatMap((item) => item.projectVersionId ? [item.projectVersionId] : []))];
    const validated = validateRequirementProjects(inputs, {
      projects: this.projectValidationRows(projectIds),
      versions: this.versionValidationRows(versionIds),
      modulesByProject: this.moduleIndexes(projectIds)
    });
    this.db.prepare("UPDATE requirement_projects SET status = 'archived', updated_at = ? WHERE requirement_id = ? AND status = 'active'").run(now, requirementId);
    for (const input of validated) this.insertRequirementAssociation(requirementId, input, now);
    this.db.prepare("UPDATE requirements SET updated_at = ? WHERE id = ?").run(now, requirementId);
    return this.listRequirementProjects(requirementId);
  }

  createRequirementProjectSnapshot(requirementId: string): RequirementProjectSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.createRequirementProjectSnapshotInTransaction(requirementId, now);
      this.db.exec("COMMIT");
      return item;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createRequirementProjectSnapshotInTransaction(requirementId: string, now: string): RequirementProjectSnapshot {
    if (!this.db.prepare("SELECT id FROM requirements WHERE id = ?").get(requirementId)) throw new Error("REQUIREMENT_NOT_FOUND");
    const associations = this.listRequirementProjects(requirementId);
    const version = (this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM requirement_project_snapshots WHERE requirement_id = ?").get(requirementId) as { version: number }).version;
    const item: RequirementProjectSnapshot = {
      id: randomUUID(), requirementId, version, associations,
      status: "active", supersededAt: null, createdAt: now
    };
    this.supersedeRequirementProjectSnapshotInTransaction(requirementId, now);
    this.db.prepare(`INSERT INTO requirement_project_snapshots
      (id, requirement_id, version, associations_json, status, superseded_at, created_at) VALUES (?, ?, ?, ?, 'active', NULL, ?)`)
      .run(item.id, requirementId, version, JSON.stringify(associations), now);
    return item;
  }

  getRequirementProjectSnapshot(requirementId: string): RequirementProjectSnapshot | null {
    const row = this.db.prepare("SELECT * FROM requirement_project_snapshots WHERE requirement_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(requirementId) as any;
    return row ? mapRequirementProjectSnapshot(row) : null;
  }

  listRequirementProjectSnapshots(requirementId: string): RequirementProjectSnapshot[] {
    return (this.db.prepare("SELECT * FROM requirement_project_snapshots WHERE requirement_id = ? ORDER BY version DESC").all(requirementId) as any[])
      .map(mapRequirementProjectSnapshot);
  }

  supersedeRequirementProjectSnapshot(requirementId: string) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.supersedeRequirementProjectSnapshotInTransaction(requirementId, now);
      this.db.exec("COMMIT");
      return changed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private supersedeRequirementProjectSnapshotInTransaction(requirementId: string, now: string) {
    return Number(this.db.prepare("UPDATE requirement_project_snapshots SET status = 'superseded', superseded_at = ? WHERE requirement_id = ? AND status = 'active'")
      .run(now, requirementId).changes);
  }

  invalidateSolutionDesignForProjectChange(requirementId: string) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invalidated = this.invalidateSolutionDesignForProjectChangeInTransaction(requirementId, now);
      this.db.exec("COMMIT");
      return invalidated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private invalidateSolutionDesignForProjectChangeInTransaction(requirementId: string, now: string) {
    const requirement = this.db.prepare("SELECT stage FROM requirements WHERE id = ?").get(requirementId) as { stage: WorkflowStage } | undefined;
    if (!requirement || workflowStages.indexOf(requirement.stage) < workflowStages.indexOf("solution_design")) return false;
    const approved = this.db.prepare("SELECT id FROM approvals WHERE requirement_id = ? AND stage = 'solution_design' AND decision = 'approve' LIMIT 1").get(requirementId);
    const artifact = this.db.prepare("SELECT id FROM artifacts WHERE requirement_id = ? AND stage = 'solution_design' LIMIT 1").get(requirementId);
    if (!approved || !artifact || !this.getRequirementProjectSnapshot(requirementId)) return false;
    const reason = "项目关联或模块范围发生变化";
    this.insertApprovalInTransaction(requirementId, "solution_design", { decision: "return", comment: reason, targetStage: "solution_design", actorType: "system", reasons: [reason] }, now);
    this.supersedeRequirementProjectSnapshotInTransaction(requirementId, now);
    this.db.prepare("UPDATE requirements SET stage = 'solution_design', status = 'ai_ready', updated_at = ? WHERE id = ?")
      .run(now, requirementId);
    return true;
  }

  projectHasActiveDelivery(projectId: string) {
    return Boolean(this.db.prepare(`SELECT r.id FROM requirements r JOIN requirement_projects rp ON rp.requirement_id = r.id
      WHERE rp.project_id = ? AND rp.status = 'active' AND rp.usage = 'delivery'
      AND r.stage IN ('implementation','quality_verification','acceptance_delivery') AND r.status != 'completed' LIMIT 1`).get(projectId));
  }

  private projectValidationRows(projectIds: string[]) {
    if (!projectIds.length) return [];
    const placeholders = projectIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT id, status FROM projects WHERE id IN (${placeholders})`).all(...projectIds) as Array<{ id: string; status: string }>;
  }

  private versionValidationRows(versionIds: string[]) {
    const result = new Map<string, { id: string; projectId: string; status: string }>();
    if (!versionIds.length) return result;
    const placeholders = versionIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, project_id, status FROM project_versions WHERE id IN (${placeholders})`)
      .all(...versionIds) as Array<{ id: string; project_id: string; status: string }>;
    for (const row of rows) result.set(row.id, { id: row.id, projectId: row.project_id, status: row.status });
    return result;
  }

  private moduleIndexes(projectIds: string[]) {
    const result = new Map<string, string[]>();
    for (const projectId of projectIds) {
      const project = this.getProject(projectId);
      const row = this.db.prepare(`SELECT entries_json FROM project_knowledge_versions
        WHERE project_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1`).get(projectId) as { entries_json: string } | undefined;
      const entries = row ? JSON.parse(row.entries_json) as any[] : [];
      const modules = entries.filter((entry) => entry.kind === "module").flatMap((entry) => [entry.moduleId, entry.id, entry.path].filter((value): value is string => typeof value === "string"));
      const detected = (project?.technology ?? []).filter((value: unknown): value is string => typeof value === "string");
      if (modules.length || detected.length) result.set(projectId, [...modules, ...detected]);
    }
    return result;
  }

  private mapRequirementWithProjects(row: any) {
    const projects = this.listRequirementProjects(row.id);
    const primary = projects.find((item) => item.role === "primary");
    const deliveries = projects.filter((item) => item.status === "active" && item.usage === "delivery");
    const delivery = deliveries.length === 1 ? deliveries[0] : null;
    return {
      ...mapRequirement(row), projects,
      primaryProjectId: primary?.projectId, primaryProjectName: primary?.projectName,
      projectId: delivery?.projectId, projectName: delivery?.projectName
    };
  }

  reviseRequirement(id: string, input: any) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRequirement(id);
      if (!current || !["returned", "blocked", "draft"].includes(current.status)) {
        this.db.exec("COMMIT");
        return null;
      }
      const version = (current.version ?? 1) + 1;
      const resumeStage = current.stage;
      this.db.prepare(`UPDATE requirements SET title = ?, business_problem = ?, expected_outcome = ?, priority = ?,
        clarifications = ?, version = ?, stage = ?, status = 'ai_ready', updated_at = ? WHERE id = ?`)
        .run(input.title, input.businessProblem, input.expectedOutcome, input.priority, input.clarifications ?? "", version, resumeStage, now, id);
      if (!this.db.prepare("SELECT id FROM requirement_revisions WHERE requirement_id = ? AND version = 1").get(id)) {
        this.insertRequirementRevision(id, 1, current, "历史版本", current.createdAt);
      }
      this.insertRequirementRevision(id, version, input, input.changeSummary ?? "根据打回意见补充需求", now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getRequirement(id);
  }

  private insertRequirementRevision(requirementId: string, version: number, input: any, changeSummary: string, createdAt: string) {
    this.db.prepare("INSERT INTO requirement_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), requirementId, version, input.title, input.businessProblem, input.expectedOutcome,
      input.priority, input.clarifications ?? "", changeSummary, createdAt
    );
  }

  listRequirementRevisions(requirementId: string) {
    return this.db.prepare("SELECT * FROM requirement_revisions WHERE requirement_id = ? ORDER BY version DESC").all(requirementId).map((row: any) => ({
      id: row.id, requirementId: row.requirement_id, version: row.version, title: row.title,
      businessProblem: row.business_problem, expectedOutcome: row.expected_outcome, priority: row.priority,
      clarifications: row.clarifications, changeSummary: row.change_summary, createdAt: row.created_at
    }));
  }

  updateRequirementState(id: string, stage: WorkflowStage, status: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(stage, status, new Date().toISOString(), id);
      this.db.exec("COMMIT");
      return this.getRequirement(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getRequirementStateInTransaction(id: string): { stage: WorkflowStage; status: string } | null {
    return (this.db.prepare("SELECT stage, status FROM requirements WHERE id = ?").get(id) as {
      stage: WorkflowStage;
      status: string;
    } | undefined) ?? null;
  }

  updateRequirementInTransaction(
    id: string,
    stage: WorkflowStage,
    status: string,
    now: string,
    expectedStage?: WorkflowStage,
    expectedStatus?: string
  ) {
    const clauses = ["id = ?"];
    const parameters: any[] = [stage, status, now, id];
    if (expectedStage !== undefined) {
      clauses.push("stage = ?");
      parameters.push(expectedStage);
    }
    if (expectedStatus !== undefined) {
      clauses.push("status = ?");
      parameters.push(expectedStatus);
    }
    const result = this.db.prepare(
      `UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE ${clauses.join(" AND ")}`
    ).run(...parameters);
    if (result.changes !== 1) throw new Error("REQUIREMENT_APPROVAL_STATE_CHANGED");
    return this.getRequirement(id)!;
  }

  addArtifact(requirementId: string, stage: WorkflowStage, title: string, content: unknown) {
    return this.insertRequirementArtifactInTransaction(requirementId, stage, title, content, new Date().toISOString());
  }

  private insertRequirementArtifactInTransaction(requirementId: string, stage: WorkflowStage, title: string, content: unknown, now: string) {
    const versionRow = this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts
      WHERE owner_type = 'requirement' AND owner_id = ? AND stage = ?`)
      .get(requirementId, stage) as { version: number };
    const artifact = { id: randomUUID(), requirementId, stage, version: versionRow.version, title, content, createdAt: now };
    this.db.prepare(`INSERT INTO artifacts
      (id, requirement_id, owner_type, owner_id, stage, version, title, content_json, created_at)
      VALUES (?, ?, 'requirement', ?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, requirementId, requirementId, stage, artifact.version, title, JSON.stringify(content), artifact.createdAt);
    return artifact;
  }

  listArtifacts(requirementId: string) {
    return this.db.prepare("SELECT * FROM artifacts WHERE requirement_id = ? ORDER BY created_at DESC, version DESC, rowid DESC").all(requirementId).map((row: any) => ({
      id: row.id, requirementId: row.requirement_id, stage: row.stage, version: row.version,
      title: row.title, content: JSON.parse(row.content_json), createdAt: row.created_at
    }));
  }

  getLatestArtifact(requirementId: string, stage: WorkflowStage): RequirementArtifact | null {
    const row = this.db.prepare(`SELECT * FROM artifacts
      WHERE requirement_id = ? AND stage = ?
        AND owner_type = 'requirement' AND owner_id = requirement_id
      ORDER BY version DESC, created_at DESC, rowid DESC LIMIT 1`).get(requirementId, stage) as any;
    return row ? {
      id: row.id,
      requirementId: row.requirement_id,
      stage: row.stage,
      version: row.version,
      title: row.title,
      content: JSON.parse(row.content_json),
      createdAt: row.created_at
    } : null;
  }

  createStageRun(input: StageRunInput) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requirement = this.db.prepare("SELECT stage, status, version, updated_at FROM requirements WHERE id = ?").get(input.requirementId) as { stage: string; status: string; version: number; updated_at: string } | undefined;
      if (!requirement) throw new Error("REQUIREMENT_NOT_FOUND");
      if (this.db.prepare("SELECT id FROM stage_runs WHERE requirement_id = ? AND stage = ? AND status = 'running'").get(input.requirementId, input.stage)) {
        throw new Error("RUN_ALREADY_ACTIVE");
      }
      if (input.expectedRequirementUpdatedAt !== undefined && (
        requirement.updated_at !== input.expectedRequirementUpdatedAt
        || requirement.stage !== input.stage
        || (input.expectedRequirementStatus !== undefined && requirement.status !== input.expectedRequirementStatus)
      )) {
        throw new Error("REQUIREMENT_CHANGED_DURING_RUN_PREPARATION");
      }
      if (input.expectedRequirementProjectIds !== undefined) {
        const currentProjectIds = (this.db.prepare(`SELECT id FROM requirement_projects
          WHERE requirement_id = ? AND status = 'active' ORDER BY position, created_at, rowid`).all(input.requirementId) as { id: string }[]).map((row) => row.id);
        if (JSON.stringify(currentProjectIds) !== JSON.stringify(input.expectedRequirementProjectIds)) {
          throw new Error("REQUIREMENT_CHANGED_DURING_RUN_PREPARATION");
        }
      }
      if (!(requirement.stage === "definition" || requirement.stage === "solution_design")) throw new Error("REQUIREMENT_AI_STAGE_UNSUPPORTED");
      if (requirement.status !== "ai_ready") throw new Error("REQUIREMENT_RUN_NOT_READY");
      const now = new Date().toISOString();
      const item = { id: randomUUID(), ...input, status: "running", createdAt: now, completedAt: null };
      this.db.prepare(`INSERT INTO stage_runs
        (id, requirement_id, owner_type, owner_id, evidence_version, stage, status, model, input_json, created_at)
        VALUES (?, ?, 'requirement', ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, item.requirementId, item.requirementId, requirement.version, item.stage, item.status, item.model, JSON.stringify(item.input), item.createdAt);
      const claimed = this.db.prepare(`UPDATE requirements SET status = 'ai_running', updated_at = ?
        WHERE id = ? AND stage = ? AND status = 'ai_ready' AND updated_at = ?`)
        .run(now, input.requirementId, input.stage, requirement.updated_at);
      if (claimed.changes !== 1) throw new Error("REQUIREMENT_CHANGED_DURING_RUN_PREPARATION");
      this.appendStageRunEvent(item.id, "run.started", { stage: item.stage, model: item.model });
      this.db.exec("COMMIT");
      return item;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: stage_runs.owner_type, stage_runs.owner_id, stage_runs.stage")) throw new Error("RUN_ALREADY_ACTIVE");
      throw error;
    }
  }

  appendStageRunEvent(runId: string, type: string, payload: unknown) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM stage_run_events WHERE run_id = ?").get(runId) as { sequence: number };
    const event = { id: randomUUID(), runId, sequence: row.sequence, type, payload, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO stage_run_events VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, runId, event.sequence, type, JSON.stringify(payload), event.createdAt);
    return event;
  }

  getStageRun(id: string) {
    const row = this.db.prepare("SELECT * FROM stage_runs WHERE id = ?").get(id) as any;
    if (!row) return null;
    const events = this.db.prepare("SELECT * FROM stage_run_events WHERE run_id = ? ORDER BY sequence").all(id).map(mapStageRunEvent);
    return mapStageRun(row, events);
  }

  listStageRuns(requirementId: string, stage?: WorkflowStage) {
    const rows = stage
      ? this.db.prepare("SELECT * FROM stage_runs WHERE requirement_id = ? AND stage = ? ORDER BY created_at DESC, rowid DESC").all(requirementId, stage)
      : this.db.prepare("SELECT * FROM stage_runs WHERE requirement_id = ? ORDER BY created_at DESC, rowid DESC").all(requirementId);
    return rows.map((row: any) => mapStageRun(row, []));
  }

  commitStageRunSuccess(input: {
    runId: string;
    requirementId: string;
    stage: WorkflowStage;
    title: string;
    content: unknown;
    output: unknown;
    gate: { decision: "auto_approve" | "auto_return" | "human_review"; reasons: string[] };
  }) {
    const now = new Date().toISOString();
    return this.withImmediateTransaction(() => {
      const run = this.db.prepare(`SELECT requirement_id, owner_type, owner_id, stage, status, created_at
        FROM stage_runs WHERE id = ?`).get(input.runId) as {
          requirement_id: string; owner_type: string; owner_id: string; stage: WorkflowStage; status: string; created_at: string;
        } | undefined;
      if (!run || run.status !== "running" || run.owner_type !== "requirement"
        || run.owner_id !== input.requirementId || run.requirement_id !== input.requirementId || run.stage !== input.stage) {
        throw new Error("STAGE_RUN_COMMIT_STALE");
      }
      const requirement = this.db.prepare("SELECT stage, status, updated_at FROM requirements WHERE id = ?")
        .get(input.requirementId) as { stage: WorkflowStage; status: string; updated_at: string } | undefined;
      if (!requirement || requirement.stage !== input.stage || requirement.status !== "ai_running"
        || requirement.updated_at !== run.created_at) {
        throw new Error("STAGE_RUN_COMMIT_STALE");
      }

      const artifact = this.insertRequirementArtifactInTransaction(input.requirementId, input.stage, input.title, input.content, now);
      this.appendStageRunEvent(input.runId, "gate.decided", input.gate);
      const approvalDecision = input.gate.decision === "auto_approve" ? "approve"
        : input.gate.decision === "auto_return" ? "return" : "review";
      const targetStage = input.gate.decision === "auto_return" ? returnStage(input.stage) : null;
      const approval = this.insertApprovalInTransaction(input.requirementId, input.stage, {
        decision: approvalDecision,
        comment: input.gate.reasons.join("；"),
        targetStage,
        actorType: "ai_gate",
        artifactId: artifact.id,
        reasons: input.gate.reasons
      }, now);

      let nextStage: WorkflowStage = input.stage;
      let nextStatus: string;
      if (input.gate.decision === "auto_approve") {
        const stageIndex = workflowStages.indexOf(input.stage);
        nextStage = workflowStages[stageIndex + 1] ?? input.stage;
        nextStatus = nextStage === input.stage ? "completed" : "ai_ready";
      } else if (input.gate.decision === "auto_return") {
        nextStage = targetStage!;
        nextStatus = "returned";
        this.insertReworkContext(input.requirementId, buildReworkContext({ approval, artifact }), now);
      } else {
        nextStatus = "awaiting_approval";
      }
      const transitioned = this.db.prepare(`UPDATE requirements SET stage = ?, status = ?, updated_at = ?
        WHERE id = ? AND stage = ? AND status = 'ai_running' AND updated_at = ?`)
        .run(nextStage, nextStatus, now, input.requirementId, input.stage, run.created_at);
      if (transitioned.changes !== 1) throw new Error("STAGE_RUN_COMMIT_STALE");

      const completed = this.db.prepare(`UPDATE stage_runs SET status = 'completed', output_json = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND owner_type = 'requirement' AND owner_id = ?
          AND requirement_id = ? AND stage = ?`)
        .run(JSON.stringify(input.output), now, input.runId, input.requirementId, input.requirementId, input.stage);
      if (completed.changes !== 1) throw new Error("STAGE_RUN_COMMIT_STALE");
      this.appendStageRunEvent(input.runId, "run.completed", { completedAt: now });
      return { artifact, approval, requirement: this.getRequirement(input.requirementId), run: this.getStageRun(input.runId) };
    });
  }

  completeStageRun(id: string, output: unknown) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE stage_runs SET status = 'completed', output_json = ?, completed_at = ? WHERE id = ?").run(JSON.stringify(output), now, id);
    this.appendStageRunEvent(id, "run.completed", { completedAt: now });
    return this.getStageRun(id);
  }

  failStageRun(id: string, error: string, status = "failed") {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT requirement_id, stage, status, created_at FROM stage_runs WHERE id = ?").get(id) as { requirement_id: string; stage: string; status: string; created_at: string } | undefined;
      if (!run) throw new Error("RUN_NOT_FOUND");
      if (run.status === "running") {
        this.db.prepare("UPDATE stage_runs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(status, error, now, id);
        this.appendStageRunEvent(id, status === "interrupted" ? "run.interrupted" : "run.failed", { error });
        this.db.prepare(`UPDATE requirements SET status = 'ai_ready', updated_at = ?
          WHERE id = ? AND stage = ? AND status = 'ai_running' AND updated_at = ?`)
          .run(now, run.requirement_id, run.stage, run.created_at);
      }
      this.db.exec("COMMIT");
      return this.getStageRun(id);
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }

  interruptActiveStageRuns() {
    const rows = this.db.prepare(`SELECT id FROM stage_runs WHERE status = 'running'
      AND NOT (owner_type = 'delivery_unit' AND stage = 'implementation')`).all() as { id: string }[];
    rows.forEach(({ id }) => this.failStageRun(id, "服务进程已重启，运行被中断", "interrupted"));
    return rows.length;
  }

  async reconcileImplementationPublications() {
    const candidates = this.db.prepare(`SELECT * FROM implementation_publication_journals
      WHERE status IN ('prepared', 'committed', 'canceled') AND cleanup_status <> 'completed'
      ORDER BY created_at, id`).all() as any[];
    let reconciled = 0;
    for (const candidate of candidates) {
      let manual = false;
      if (candidate.status === "prepared") {
        manual = this.withImmediateTransaction(() => {
          const row = this.db.prepare(`SELECT * FROM implementation_publication_journals
            WHERE id = ?`).get(candidate.id) as any;
          if (!row || row.status !== "prepared") return false;
          const patch = validateImplementationPatch(Buffer.from(row.patch_blob));
          const currentHead = readImplementationHeadSync(row.authoritative_worktree_path);
          const current = captureImplementationPatchSync(row.authoritative_worktree_path);
          const clean = current.length === 0
            && implementationPatchHash(current) === row.baseline_diff_hash;
          const exact = current.equals(patch)
            && implementationPatchHash(current) === row.published_diff_hash;
          if (currentHead !== row.base_commit || (!clean && !exact)) {
            const now = this.nowIso();
            this.db.prepare(`UPDATE implementation_publication_journals
              SET status = 'manual', last_error = ?, updated_at = ? WHERE id = ? AND status = 'prepared'`)
              .run("IMPLEMENTATION_PUBLICATION_MANUAL_RECOVERY_REQUIRED", now, row.id);
            return true;
          }
          if (exact) {
            reverseImplementationPatchSync(row.authoritative_worktree_path, patch);
            const restored = captureImplementationPatchSync(row.authoritative_worktree_path);
            if (restored.length !== 0
              || implementationPatchHash(restored) !== row.baseline_diff_hash) {
              throw new Error("IMPLEMENTATION_PUBLICATION_RECOVERY_ROLLBACK_FAILED");
            }
          }
          const now = this.nowIso();
          this.db.prepare(`UPDATE implementation_publication_journals
            SET status = 'canceled', last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'prepared'`).run(now, row.id);
          const recoveredJob = this.db.prepare(`UPDATE automation_jobs SET
              status = CASE WHEN attempt < max_attempts THEN 'pending' ELSE 'failed' END,
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = CASE WHEN attempt < max_attempts THEN NULL ELSE ? END,
              updated_at = ?
            WHERE id = ? AND claim_token = ? AND status = 'leased'
            RETURNING status`)
            .get("IMPLEMENTATION_PUBLICATION_INTERRUPTED", now, row.job_id, row.claim_token) as
              { status: "pending" | "failed" } | undefined;
          if (!recoveredJob) throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
          this.publicationHooks.beforeRecoverySettlement?.();
          this.settleJournaledImplementationInTransaction(row, recoveredJob.status, now);
          return false;
        });
      }
      if (manual) throw new Error("IMPLEMENTATION_PUBLICATION_MANUAL_RECOVERY_REQUIRED");
      try {
        await cleanupJournaledCodingAttemptWorktree(candidate.repo_path, candidate.attempt_path, {
          version: 1,
          uid: candidate.attempt_uid,
          dev: candidate.attempt_dev,
          ino: candidate.attempt_ino,
          nonce: candidate.attempt_nonce
        });
        this.updatePublicationCleanup(candidate.id, "completed");
      } catch (error) {
        this.updatePublicationCleanup(
          candidate.id,
          "failed",
          error instanceof Error ? error.message : String(error)
        );
      }
      reconciled += 1;
    }
    return reconciled;
  }

  private updatePublicationCleanup(id: string, status: "completed" | "failed", error?: string) {
    this.withImmediateTransaction(() => {
      const now = this.nowIso();
      const updated = this.db.prepare(`UPDATE implementation_publication_journals SET
          cleanup_status = ?, cleanup_completed_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status IN ('committed', 'canceled')`).run(
        status, status === "completed" ? now : null,
        status === "failed" ? boundedPublicationError(error) : null, now, id
      );
      if (updated.changes !== 1) throw new Error("IMPLEMENTATION_PUBLICATION_JOURNAL_STALE");
    });
  }

  private settleJournaledImplementationInTransaction(
    row: {
      run_id: string;
      execution_id: string;
      delivery_unit_id: string;
      evidence_version: number;
    },
    jobStatus: "pending" | "failed",
    now: string,
    error = "实现发布被中断，已自动回滚"
  ) {
    const run = this.db.prepare(`UPDATE stage_runs SET status = 'interrupted', error = ?, completed_at = ?
      WHERE id = ? AND owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = ?
        AND stage = 'implementation' AND status = 'running'`).run(
      error, now, row.run_id, row.delivery_unit_id, row.evidence_version
    );
    if (run.changes !== 1) throw new Error("IMPLEMENTATION_PUBLICATION_SETTLEMENT_STALE");
    this.appendStageRunEvent(row.run_id, "run.interrupted", { error });
    const execution = this.db.prepare(`UPDATE executions SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ? AND delivery_unit_id = ? AND evidence_version = ?
        AND stage = 'implementation' AND status = 'running'`).run(
      error, now, row.execution_id, row.delivery_unit_id, row.evidence_version
    );
    const unit = this.db.prepare(`UPDATE delivery_units SET status = ?, updated_at = ?
      WHERE id = ? AND evidence_version = ? AND phase = 'implementation' AND status = 'running'`).run(
      jobStatus === "pending" ? "ready" : "failed", now,
      row.delivery_unit_id, row.evidence_version
    );
    if (execution.changes !== 1 || unit.changes !== 1) {
      throw new Error("IMPLEMENTATION_PUBLICATION_SETTLEMENT_STALE");
    }
  }

  recoverAbandonedDeliveryExecutions(now: Date) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("AUTOMATION_JOB_DATE_INVALID");
    const nowIso = now.toISOString();
    return this.withImmediateTransaction(() => {
      const candidates = this.db.prepare(`SELECT run.id AS run_id, run.owner_id, run.evidence_version,
          execution.id AS execution_id
        FROM stage_runs run
        JOIN executions execution ON execution.delivery_unit_id = run.owner_id
          AND execution.evidence_version = run.evidence_version
          AND execution.stage = 'implementation' AND execution.status = 'running'
        WHERE run.owner_type = 'delivery_unit' AND run.stage = 'implementation'
          AND run.status = 'running' AND NOT EXISTS (
            SELECT 1 FROM automation_jobs job WHERE job.owner_type = 'delivery_unit'
              AND job.owner_id = run.owner_id AND job.evidence_version = run.evidence_version
              AND job.action = 'implement' AND job.status = 'leased'
          )`).all() as Array<{
            run_id: string; execution_id: string; owner_id: string; evidence_version: number
          }>;
      const jobs = new AutomationJobRepository(this.db, () => now);
      for (const candidate of candidates) {
        const existing = jobs.byDedupe(`implement:${candidate.owner_id}:v${candidate.evidence_version}`);
        const retryable = existing?.status !== "failed";
        this.settleJournaledImplementationInTransaction({
          run_id: candidate.run_id,
          execution_id: candidate.execution_id,
          delivery_unit_id: candidate.owner_id,
          evidence_version: candidate.evidence_version
        }, retryable ? "pending" : "failed", nowIso, "服务进程已重启，运行被中断");
        if (retryable) jobs.enqueue({ ownerType: "delivery_unit", ownerId: candidate.owner_id,
          evidenceVersion: candidate.evidence_version, action: "implement", payload: {}, maxAttempts: 3 },
        { reviveTerminal: true });
      }
      return candidates.length;
    });
  }

  private settleExpiredImplementationsInTransaction(
    candidates: Array<{ id: string; owner_id: string; evidence_version: number }>,
    now: string
  ) {
    const error = "服务进程已重启，运行被中断";
    for (const candidate of candidates) {
      const job = this.db.prepare("SELECT status FROM automation_jobs WHERE id = ?").get(candidate.id) as
        { status: "pending" | "failed" } | undefined;
      if (!job || (job.status !== "pending" && job.status !== "failed")) continue;
      const binding = this.db.prepare(`SELECT run.id AS run_id, execution.id AS execution_id
        FROM stage_runs run
        JOIN executions execution ON execution.delivery_unit_id = run.owner_id
          AND execution.evidence_version = run.evidence_version
          AND execution.stage = 'implementation' AND execution.status = 'running'
        WHERE run.owner_type = 'delivery_unit' AND run.owner_id = ? AND run.evidence_version = ?
          AND run.stage = 'implementation' AND run.status = 'running'`).get(
        candidate.owner_id, candidate.evidence_version
      ) as { run_id: string; execution_id: string } | undefined;
      if (!binding) continue;
      this.settleJournaledImplementationInTransaction({
        ...binding,
        delivery_unit_id: candidate.owner_id,
        evidence_version: candidate.evidence_version
      }, job.status, now, error);
    }
  }

  recoverInterruptedRequirements() {
    const result = this.db.prepare(`UPDATE requirements SET status = 'ai_ready', updated_at = ?
      WHERE status = 'ai_running' AND NOT EXISTS (
        SELECT 1 FROM stage_runs WHERE stage_runs.requirement_id = requirements.id
          AND stage_runs.stage = requirements.stage AND stage_runs.status = 'running'
      )`).run(new Date().toISOString());
    return Number(result.changes);
  }

  addApproval(requirementId: string, stage: WorkflowStage, input: any) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const approval = this.insertApprovalInTransaction(requirementId, stage, input, now);
      this.db.exec("COMMIT");
      return approval;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  insertApprovalInTransaction(requirementId: string, stage: WorkflowStage, input: any, now: string) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO approvals
      (id, requirement_id, stage, decision, comment, condition_text, target_stage, created_at, actor_type, artifact_id, reasons_json, return_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requirementId, stage, input.decision, input.comment, input.condition ?? null, input.targetStage ?? null, now,
        input.actorType ?? "human", input.artifactId ?? null, JSON.stringify(input.reasons ?? []), input.returnCount ?? null);
    return { id, requirement_id: requirementId, stage, decision: input.decision, comment: input.comment, target_stage: input.targetStage ?? null, created_at: now, actor_type: input.actorType ?? "human", artifact_id: input.artifactId ?? null, return_count: input.returnCount ?? null };
  }

  applyRequirementApproval(input: { requirementId: string; expectedStage: WorkflowStage; approval: any }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requirement = this.db.prepare("SELECT stage, status FROM requirements WHERE id = ?").get(input.requirementId) as { stage: WorkflowStage; status: string } | undefined;
      if (!requirement) throw new Error("REQUIREMENT_NOT_FOUND");
      if (requirement.stage !== input.expectedStage) throw new Error("REQUIREMENT_APPROVAL_STATE_CHANGED");
      if (requirement.status !== "awaiting_approval") throw new Error("REQUIREMENT_APPROVAL_NOT_READY");
      const approval = input.approval.decision === "return"
        ? { ...input.approval, targetStage: returnStage(requirement.stage) }
        : input.approval;
      const approvalRecord = this.insertApprovalInTransaction(input.requirementId, requirement.stage, approval, now);
      if (approval.decision === "return") {
        const artifact = this.listArtifacts(input.requirementId).find((entry: any) => entry.stage === requirement.stage);
        this.insertReworkContext(input.requirementId, buildReworkContext({ approval: approvalRecord, artifact }), now);
        this.db.prepare("UPDATE requirements SET stage = ?, status = 'returned', updated_at = ? WHERE id = ?")
          .run(approval.targetStage, now, input.requirementId);
      } else {
        const index = workflowStages.indexOf(requirement.stage);
        const nextStage = workflowStages[index + 1];
        const targetStage = nextStage ?? requirement.stage;
        const status = nextStage ? "ai_ready" : "completed";
        this.db.prepare("UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(targetStage, status, now, input.requirementId);
      }
      this.db.exec("COMMIT");
      return this.getRequirement(input.requirementId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listApprovals(requirementId: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE requirement_id = ? ORDER BY created_at DESC, rowid DESC").all(requirementId);
  }


  getGateConfig(): GateConfig {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = 'gate_config'").get() as { value_json: string } | undefined;
    if (!row) return { ...defaultGateConfig, mandatoryHumanStages: [...defaultGateConfig.mandatoryHumanStages] };
    try {
      return parseGateConfig(JSON.parse(row.value_json));
    } catch {
      return parseGateConfig(undefined);
    }
  }

  updateGateConfig(config: GateConfig) {
    const value = { ...config, mandatoryHumanStages: [...config.mandatoryHumanStages] };
    this.db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('gate_config', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(value), new Date().toISOString());
    return this.getGateConfig();
  }

  applyGateDecision(input: { requirementId: string; stage: WorkflowStage; artifactId: string; decision: "auto_approve" | "auto_return" | "human_review"; reasons: string[] }) {
    const now = new Date().toISOString();
    let gateApproval: any;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM approvals WHERE actor_type = 'ai_gate' AND artifact_id = ?").get(input.artifactId)) {
        this.db.exec("COMMIT");
        return { applied: false, requirement: this.getRequirement(input.requirementId) };
      }
      const approvalDecision = input.decision === "auto_approve" ? "approve" : input.decision === "auto_return" ? "return" : "review";
      const targetStage = input.decision === "auto_return" ? returnStage(input.stage) : null;
      gateApproval = this.insertApprovalInTransaction(input.requirementId, input.stage, {
        decision: approvalDecision, comment: input.reasons.join("；"), targetStage,
        actorType: "ai_gate", artifactId: input.artifactId, reasons: input.reasons
      }, now);
      if (input.decision === "auto_approve") {
        const index = workflowStages.indexOf(input.stage);
        const nextStage = workflowStages[index + 1];
        this.db.prepare("UPDATE requirements SET stage = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(nextStage ?? input.stage, nextStage ? "ai_ready" : "completed", now, input.requirementId);
      } else if (input.decision === "auto_return") {
        this.db.prepare("UPDATE requirements SET stage = ?, status = 'returned', updated_at = ? WHERE id = ?")
          .run(targetStage, now, input.requirementId);
      } else {
        this.db.prepare("UPDATE requirements SET status = 'awaiting_approval', updated_at = ? WHERE id = ?").run(now, input.requirementId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { applied: true, requirement: this.getRequirement(input.requirementId), approval: gateApproval };
  }

  createProject(input: any) {
    const repoPath = canonicalRepoPath(input.repoPath);
    if (this.findProjectByRepoPath(repoPath)) throw new Error("PROJECT_REPO_PATH_EXISTS");
    const now = new Date().toISOString();
    const item = { id: randomUUID(), ...input, repoPath, category: input.category ?? null, technology: input.technology ?? [], status: "active", createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO projects (id,name,repo_path,default_branch,allowed_commands,sensitive_patterns,category,technology_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.name, item.repoPath, item.defaultBranch,
      JSON.stringify(item.allowedCommands ?? []), JSON.stringify(item.sensitivePatterns ?? []), item.category, JSON.stringify(item.technology), item.status, item.createdAt, item.updatedAt);
    return item;
  }

  createProjectVersion(input: {
    id?: string;
    projectId: string;
    name: string;
    branch: string;
    baseBranch: string;
    worktreePath: string;
    headCommit: string;
  }): ProjectVersion {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(input.projectId)) {
        throw new Error("PROJECT_NOT_ACTIVE");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE project_id = ? AND name = ?").get(input.projectId, input.name)) {
        throw new Error("PROJECT_VERSION_NAME_EXISTS");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE project_id = ? AND branch = ?").get(input.projectId, input.branch)) {
        throw new Error("PROJECT_VERSION_BRANCH_EXISTS");
      }
      if (this.db.prepare("SELECT id FROM project_versions WHERE worktree_path = ?").get(input.worktreePath)) {
        throw new Error("PROJECT_VERSION_WORKTREE_EXISTS");
      }
      this.db.prepare(`INSERT INTO project_versions
        (id, project_id, name, branch, base_branch, worktree_path, status, head_commit,
         created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`)
        .run(id, input.projectId, input.name, input.branch, input.baseBranch, input.worktreePath, input.headCommit, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw mapProjectVersionConstraint(error);
    }
    return this.getProjectVersion(id)!;
  }

  listProjectVersions(projectId: string, status: "active" | "closed" | "all"): ProjectVersion[] {
    const statusClause = status === "all" ? "" : " AND pv.status = ?";
    const parameters = status === "all" ? [projectId] : [projectId, status];
    return (this.db.prepare(`SELECT pv.*, p.name AS project_name FROM project_versions pv
      JOIN projects p ON p.id = pv.project_id WHERE pv.project_id = ?${statusClause}
      ORDER BY pv.created_at DESC`).all(...parameters) as any[]).map(mapProjectVersion);
  }

  getProjectVersion(id: string): ProjectVersion | null {
    const row = this.db.prepare(`SELECT pv.*, p.name AS project_name FROM project_versions pv
      JOIN projects p ON p.id = pv.project_id WHERE pv.id = ?`).get(id);
    return row ? mapProjectVersion(row as any) : null;
  }

  updateProjectVersionHead(id: string, headCommit: string): ProjectVersion | null {
    const result = this.db.prepare(`UPDATE project_versions SET head_commit = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_versions.project_id AND p.status = 'active')`)
      .run(headCommit, new Date().toISOString(), id);
    return result.changes ? this.getProjectVersion(id) : null;
  }

  closeProjectVersion(id: string): ProjectVersion {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.db.prepare(`SELECT pv.*, p.status AS project_status FROM project_versions pv
        JOIN projects p ON p.id = pv.project_id WHERE pv.id = ?`).get(id) as any;
      if (!version) throw new Error("PROJECT_VERSION_NOT_FOUND");
      if (version.project_status !== "active") throw new Error("PROJECT_NOT_ACTIVE");
      if (version.status === "closed") {
        this.db.exec("COMMIT");
        return this.getProjectVersion(id)!;
      }
      const activeRequirement = this.db.prepare(`SELECT r.id FROM requirements r
        JOIN requirement_projects rp ON rp.requirement_id = r.id
        WHERE rp.project_version_id = ?
          AND r.status NOT IN ('completed', 'closed', 'cancelled') LIMIT 1`).get(id);
      if (activeRequirement) throw new Error("PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE project_versions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      this.db.exec("COMMIT");
      return this.getProjectVersion(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listVersionRequirements(id: string): any[] {
    return (this.db.prepare(`SELECT DISTINCT r.* FROM requirements r
      JOIN requirement_projects rp ON rp.requirement_id = r.id
      WHERE rp.project_version_id = ? ORDER BY r.created_at DESC`).all(id) as any[])
      .map((row) => this.mapRequirementWithProjects(row));
  }


  updateProject(id: string, input: any) {
    const changesExecutionIdentity=["repoPath","defaultBranch","allowedCommands","sensitivePatterns","technology"].some((field)=>Object.prototype.hasOwnProperty.call(input,field));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const current = this.getProject(id);
      if (!current){this.db.exec("COMMIT");return null;}
      if(changesExecutionIdentity&&this.db.prepare(`SELECT sr.id FROM stage_runs sr
        JOIN requirement_projects rp ON rp.requirement_id = sr.requirement_id
        WHERE sr.status = 'running' AND rp.status = 'active' AND rp.usage = 'delivery' AND rp.project_id = ? LIMIT 1`).get(id)){
        throw new Error("PROJECT_IN_ACTIVE_EXECUTION");
      }
      const repoPath = input.repoPath === undefined ? current.repoPath : canonicalRepoPath(input.repoPath);
      const duplicate = this.findProjectByRepoPath(repoPath);
      if (duplicate && duplicate.id !== id) throw new Error("PROJECT_REPO_PATH_EXISTS");
      const timestamp=new Date().toISOString(),updatedAt=timestamp===current.updatedAt?new Date(Date.parse(timestamp)+1).toISOString():timestamp;
      const item = { ...current, ...input, repoPath, category: input.category === undefined ? current.category : input.category, updatedAt };
      this.db.prepare(`UPDATE projects SET name=?,repo_path=?,default_branch=?,allowed_commands=?,sensitive_patterns=?,category=?,technology_json=?,updated_at=? WHERE id=?`)
        .run(item.name, item.repoPath, item.defaultBranch, JSON.stringify(item.allowedCommands), JSON.stringify(item.sensitivePatterns), item.category, JSON.stringify(item.technology), item.updatedAt, id);
      this.db.exec("COMMIT");
      return this.getProject(id);
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  archiveProject(id: string) {
    if (!this.getProject(id)) return null;
    this.db.prepare("UPDATE projects SET status='archived',updated_at=? WHERE id=? AND status!='archived'").run(new Date().toISOString(), id);
    return this.getProject(id);
  }

  beginProjectKnowledge(projectId:string,sourceHead:string,refreshReason:string){
    const row=this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM project_knowledge_versions WHERE project_id=?").get(projectId) as {version:number};
    const item={id:randomUUID(),projectId,version:row.version,status:"building",sourceHead,refreshReason,createdAt:new Date().toISOString()};
    this.db.prepare(`INSERT INTO project_knowledge_versions (id,project_id,version,status,source_head,refresh_reason,created_at) VALUES (?,?,?,?,?,?,?)`).run(item.id,projectId,item.version,item.status,sourceHead,refreshReason,item.createdAt);
    return item;
  }

  completeProjectKnowledge(id:string,input:{summary:string;entries:any[]}){
    const completedAt=new Date().toISOString(),modules=new Set(input.entries.filter(entry=>entry.kind==="module").map(entry=>entry.path)).size;
    this.db.prepare("UPDATE project_knowledge_versions SET status='ready',summary=?,entries_json=?,entry_count=?,module_count=?,completed_at=? WHERE id=? AND status='building'").run(input.summary,JSON.stringify(input.entries),input.entries.length,modules,completedAt,id);
    return this.getProjectKnowledgeVersion(id);
  }

  failProjectKnowledge(id:string,error:string){this.db.prepare("UPDATE project_knowledge_versions SET status='failed',error=?,completed_at=? WHERE id=? AND status='building'").run(error,new Date().toISOString(),id);return this.getProjectKnowledgeVersion(id);}
  cancelBuildingProjectKnowledge(projectId:string,reason:string){return Number(this.db.prepare("UPDATE project_knowledge_versions SET status='canceled',error=?,completed_at=? WHERE project_id=? AND status='building'").run(reason,new Date().toISOString(),projectId).changes);}
  getProjectKnowledgeVersion(id:string){const row:any=this.db.prepare("SELECT * FROM project_knowledge_versions WHERE id=?").get(id);return row?mapProjectKnowledge(row):null;}
  getLatestProjectKnowledge(projectId:string){const row:any=this.db.prepare("SELECT * FROM project_knowledge_versions WHERE project_id=? ORDER BY version DESC LIMIT 1").get(projectId);return row?mapProjectKnowledge(row):null;}
  getProjectKnowledgeStatus(projectId:string){return this.getLatestProjectKnowledge(projectId)??{projectId,status:"missing",version:0};}
  listProjectKnowledgeVersions(projectId:string){return (this.db.prepare("SELECT * FROM project_knowledge_versions WHERE project_id=? ORDER BY version DESC").all(projectId) as any[]).map(mapProjectKnowledge);}
  interruptActiveProjectKnowledge(){return Number(this.db.prepare("UPDATE project_knowledge_versions SET status='failed',error='服务进程已重启，知识库生成被中断',completed_at=? WHERE status='building'").run(new Date().toISOString()).changes);}

  replaceKnowledgeCandidates(requirementId:string,projectId:string,candidates:any[]){
    const now=new Date().toISOString();this.db.exec("BEGIN");
    try{this.db.prepare("DELETE FROM knowledge_candidates WHERE requirement_id=?").run(requirementId);const insert=this.db.prepare("INSERT INTO knowledge_candidates VALUES (?,?,?,?,?,?,?,?,?)");
      for(const candidate of candidates)insert.run(randomUUID(),requirementId,projectId,candidate.subjectKey,"candidate",candidate.publishDecision,JSON.stringify(candidate),now,now);
      this.db.exec("COMMIT");return this.listKnowledgeCandidates(requirementId);
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  listKnowledgeCandidates(requirementId:string){return (this.db.prepare("SELECT * FROM knowledge_candidates WHERE requirement_id=? ORDER BY created_at").all(requirementId) as any[]).map(row=>({...JSON.parse(row.payload_json),id:row.id,status:row.status,publishDecision:row.publish_decision,createdAt:row.created_at,updatedAt:row.updated_at}));}

  publishKnowledgeCandidates(requirementId:string){
    const candidates=this.listKnowledgeCandidates(requirementId).filter((item:any)=>item.status==="candidate");const projectId=candidates[0]?.projectId;if(!projectId)throw new Error("PROJECT_REQUIRED");
    const now=new Date().toISOString();let publishedCount=0,reviewCount=0,conflictCount=0;this.db.exec("BEGIN");
    try{for(const candidate of candidates){if(candidate.publishDecision==="human_review"||candidate.riskLevel==="high"){this.db.prepare("UPDATE knowledge_candidates SET status='review',updated_at=? WHERE id=?").run(now,candidate.id);reviewCount++;continue;}
        const record:any=this.db.prepare("SELECT * FROM knowledge_records WHERE project_id=? AND subject_key=?").get(projectId,candidate.subjectKey);
        if(record){const active:any=this.db.prepare("SELECT content FROM knowledge_record_versions WHERE record_id=? AND version=?").get(record.id,record.current_version);if(active?.content!==candidate.content){this.db.prepare("UPDATE knowledge_candidates SET status='conflict',updated_at=? WHERE id=?").run(now,candidate.id);conflictCount++;}else this.db.prepare("UPDATE knowledge_candidates SET status='published',updated_at=? WHERE id=?").run(now,candidate.id);continue;}
        const recordId=randomUUID();this.db.prepare("INSERT INTO knowledge_records VALUES (?,?,?,?,?,'active',1,?,?)").run(recordId,projectId,candidate.subjectKey,candidate.layer,candidate.type,now,now);
        this.db.prepare("INSERT INTO knowledge_record_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),recordId,1,candidate.title,candidate.content,JSON.stringify(candidate.modules||[]),JSON.stringify(candidate.tags||[]),JSON.stringify(candidate.evidence||[]),requirementId,candidate.sourceStage,candidate.confidence,candidate.riskLevel,now);
        this.db.prepare("UPDATE knowledge_candidates SET status='published',updated_at=? WHERE id=?").run(now,candidate.id);publishedCount++;}
      const status=conflictCount?"conflict":reviewCount?"review":"published";this.db.prepare("INSERT INTO knowledge_change_sets VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(requirement_id) DO UPDATE SET status=excluded.status,published_count=excluded.published_count,review_count=excluded.review_count,conflict_count=excluded.conflict_count,completed_at=excluded.completed_at").run(randomUUID(),requirementId,projectId,status,publishedCount,reviewCount,conflictCount,now,now);
      this.db.exec("COMMIT");return {status,publishedCount,reviewCount,conflictCount,candidates:this.listKnowledgeCandidates(requirementId)};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  getKnowledgeChangeSet(requirementId:string){const row:any=this.db.prepare("SELECT * FROM knowledge_change_sets WHERE requirement_id=?").get(requirementId);return row?{id:row.id,requirementId:row.requirement_id,projectId:row.project_id,status:row.status,publishedCount:row.published_count,reviewCount:row.review_count,conflictCount:row.conflict_count,createdAt:row.created_at,completedAt:row.completed_at,candidates:this.listKnowledgeCandidates(requirementId)}:{status:"candidate",publishedCount:0,reviewCount:0,conflictCount:0,candidates:this.listKnowledgeCandidates(requirementId)};}

  listProjectMemory(projectId:string){const rows=this.db.prepare(`SELECT r.*,v.title,v.content,v.modules_json,v.tags_json,v.evidence_json,v.source_requirement_id,v.source_stage,v.confidence,v.risk_level,v.created_at AS version_created_at FROM knowledge_records r JOIN knowledge_record_versions v ON v.record_id=r.id AND v.version=r.current_version WHERE r.project_id=? ORDER BY r.updated_at DESC`).all(projectId) as any[];const records=rows.map(row=>({id:row.id,projectId:row.project_id,subjectKey:row.subject_key,layer:row.layer,type:row.type,status:row.status,version:row.current_version,title:row.title,content:row.content,modules:JSON.parse(row.modules_json),tags:JSON.parse(row.tags_json),evidence:JSON.parse(row.evidence_json),sourceRequirementId:row.source_requirement_id,sourceStage:row.source_stage,confidence:row.confidence,riskLevel:row.risk_level,createdAt:row.version_created_at}));return {records,total:records.length,layers:Object.fromEntries(["source_fact","project_rule","decision","requirement_experience"].map(layer=>[layer,records.filter(item=>item.layer===layer).length]))};}

  listProjects(options: { activeOnly?: boolean } = {}) {
    const sql = `SELECT * FROM projects${options.activeOnly ? " WHERE status = 'active'" : ""} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all().map(mapProject);
  }

  getProject(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? mapProject(row as any) : null;
  }

  findProjectByRepoPath(repoPath: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(canonicalRepoPath(repoPath));
    return row ? mapProject(row as any) : null;
  }

  addExecution(input: ExecutionInput) {
    return this.executionRepository.add(input);
  }

  listExecutions(requirementId: string) {
    return this.executionRepository.listForRequirement(requirementId);
  }

  addCodingEvidence(input: CodingEvidenceInput) {
    return this.executionRepository.addCodingEvidence(input);
  }

  getLatestCodingEvidence(requirementId: string) {
    return this.executionRepository.getLatestCodingEvidence(requirementId);
  }

  addReworkContext(requirementId: string,input:any){
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.insertReworkContext(requirementId, input, now);
      this.db.exec("COMMIT");
      return item;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private insertReworkContext(requirementId: string,input: any, now: string){
    const item={id:randomUUID(),requirementId,createdAt:now,...input};
    this.db.prepare(`INSERT INTO rework_contexts
      (id,requirement_id,approval_id,artifact_id,source_stage,target_stage,actor_type,decision_at,unstructured,items_json,risks_json,questions_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,requirementId,item.approvalId,item.artifactId??null,item.sourceStage,item.targetStage,item.actorType,item.decisionAt,item.unstructured?1:0,JSON.stringify(item.items||[]),JSON.stringify(item.risks||[]),JSON.stringify(item.openQuestions||[]),item.createdAt);
    return item;
  }

  getLatestReworkContext(requirementId:string){
    const row=this.db.prepare("SELECT * FROM rework_contexts WHERE requirement_id=? ORDER BY decision_at DESC LIMIT 1").get(requirementId) as any;
    return row?{id:row.id,requirementId:row.requirement_id,approvalId:row.approval_id,artifactId:row.artifact_id,sourceStage:row.source_stage,targetStage:row.target_stage,actorType:row.actor_type,decisionAt:row.decision_at,unstructured:Boolean(row.unstructured),items:JSON.parse(row.items_json),risks:JSON.parse(row.risks_json),openQuestions:JSON.parse(row.questions_json),createdAt:row.created_at}:null;
  }

  getDeliveryEventGeneration(requirementId: string) {
    return deliveryEventGeneration(this.db, requirementId);
  }

  close() { this.db.close(); }
}

function mapRequirement(row: any) {
  return {
    id: row.id, code: row.code, title: row.title, businessProblem: row.business_problem,
    expectedOutcome: row.expected_outcome, priority: row.priority, projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined, version: row.version ?? 1, clarifications: row.clarifications ?? "",
    stage: row.stage, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRequirementProject(row: any): RequirementProjectWithVersionMetadata {
  return {
    id: row.id, requirementId: row.requirement_id, projectId: row.project_id, projectName: row.project_name,
    projectVersionId: row.project_version_id ?? undefined,
    projectVersionName: row.project_version_name ?? undefined,
    projectVersionBranch: row.project_version_branch ?? undefined,
    projectVersionStatus: row.project_version_status ?? undefined,
    projectVersionWorktreePath: row.project_version_worktree_path ?? undefined,
    projectVersionHead: row.project_version_head ?? undefined,
    role: row.role, usage: row.usage, deliveryRequired: Boolean(row.delivery_required), moduleMode: row.module_mode,
    moduleIds: JSON.parse(row.module_ids_json || "[]"), position: row.position, status: row.status,
    projectStatus: row.project_status,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRequirementProjectSnapshot(row: any): RequirementProjectSnapshot {
  return {
    id: row.id, requirementId: row.requirement_id, version: row.version,
    associations: parseRequirementProjectSnapshotAssociations(row.associations_json), status: row.status,
    supersededAt: row.superseded_at, createdAt: row.created_at
  };
}

function parseRequirementProjectSnapshotAssociations(value: unknown): RequirementProjectWithVersionMetadata[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed as RequirementProjectWithVersionMetadata[] : [];
}

function mapProject(row: any) {
  return { id: row.id, name: row.name, repoPath: row.repo_path, defaultBranch: row.default_branch,
    allowedCommands: JSON.parse(row.allowed_commands || "[]"), sensitivePatterns: JSON.parse(row.sensitive_patterns || "[]"),
    category: row.category ?? null, technology: JSON.parse(row.technology_json || "[]"), status: row.status || "active",
    createdAt: row.created_at, updatedAt: row.updated_at || row.created_at };
}

function mapProjectVersion(row: any): ProjectVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    name: row.name,
    branch: row.branch,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    status: row.status,
    headCommit: row.head_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined
  };
}

function mapProjectVersionConstraint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("project_versions.id")) return new Error("PROJECT_VERSION_ID_EXISTS");
  if (message.includes("project_versions.project_id, project_versions.name")) return new Error("PROJECT_VERSION_NAME_EXISTS");
  if (message.includes("project_versions.project_id, project_versions.branch")) return new Error("PROJECT_VERSION_BRANCH_EXISTS");
  if (message.includes("project_versions.worktree_path")) return new Error("PROJECT_VERSION_WORKTREE_EXISTS");
  return error;
}

function canonicalRepoPath(repoPath: string) {
  const resolved = resolve(repoPath);
  try { return realpathSync(resolved); }
  catch { return resolved; }
}

function mapStageRun(row: any, events: any[]) {
  return { id: row.id, requirementId: row.requirement_id, ownerType: row.owner_type, ownerId: row.owner_id,
    evidenceVersion: row.evidence_version, stage: row.stage, status: row.status, model: row.model,
    input: JSON.parse(row.input_json || "null"), output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error, createdAt: row.created_at, completedAt: row.completed_at, events };
}

function mapStageRunEvent(row: any) {
  return { id: row.id, runId: row.run_id, sequence: row.sequence, type: row.type,
    payload: JSON.parse(row.payload_json), createdAt: row.created_at };
}

function mapImplementationPublicationJournal(row: any) {
  return {
    id: row.id,
    status: row.status as "prepared" | "committed" | "canceled" | "manual",
    cleanupStatus: row.cleanup_status as "pending" | "completed" | "failed"
  };
}

function boundedPublicationError(error: string | undefined) {
  const value = String(error ?? "IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED").replaceAll("\0", "").trim();
  return Array.from(value || "IMPLEMENTATION_ATTEMPT_CLEANUP_FAILED").slice(0, 4096).join("");
}

function mapProjectKnowledge(row:any){return {id:row.id,projectId:row.project_id,version:row.version,status:row.status,sourceHead:row.source_head,refreshReason:row.refresh_reason,summary:row.summary??"",entries:JSON.parse(row.entries_json||"[]"),entryCount:row.entry_count,moduleCount:row.module_count,error:row.error,createdAt:row.created_at,completedAt:row.completed_at};}
