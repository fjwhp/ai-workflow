import type { FastifyInstance, FastifyReply } from "fastify";
import type { AutomationJob } from "./automation-job-repository.js";
import type { DeliveryApplicationRun } from "./delivery-application-repository.js";
import type { WorkflowStore } from "./store.js";

const LOCAL_HUMAN_ACTOR = "local-human";

interface RouteOptions { store: WorkflowStore }

export async function registerDeliveryAcceptanceRoutes(app: FastifyInstance, { store }: RouteOptions) {
  app.post("/api/requirements/:id/accept-delivery", async (request, reply) => {
    const requirementId = routeId((request.params as { id?: unknown }).id);
    const comment = boundedText(objectBody(request.body).comment);
    if (!requirementId || !comment) return badRequest(reply);
    if (!store.getRequirement(requirementId)) return notFound(reply, "REQUIREMENT_NOT_FOUND");
    try {
      const acceptance = store.deliveryCoordination.acceptRequirement({
        requirementId,
        actor: LOCAL_HUMAN_ACTOR,
        comment
      });
      const applicationJob = acceptance.jobId
        ? publicApplicationJob(store.automationJobs.get(acceptance.jobId)) : null;
      return reply.code(202).send({ acceptance, applicationJob });
    } catch (error) {
      return acceptanceError(reply, error, "accept");
    }
  });

  app.post("/api/delivery-units/:id/application/retry", async (request, reply) => {
    const unitId = routeId((request.params as { id?: unknown }).id);
    const reason = boundedText(objectBody(request.body).reason);
    if (!unitId || !reason) return badRequest(reply);
    if (!store.deliveryUnits.get(unitId)) return notFound(reply, "DELIVERY_UNIT_NOT_FOUND");
    try {
      const retry = store.deliveryCoordination.retryApplication({
        unitId,
        actor: LOCAL_HUMAN_ACTOR,
        reason
      });
      return reply.code(202).send({ retry, applicationJob: publicApplicationJob(store.automationJobs.get(retry.jobId)) });
    } catch (error) {
      return acceptanceError(reply, error, "retry");
    }
  });

  app.get("/api/delivery-units/:id/application-runs", async (request, reply) => {
    const unitId = routeId((request.params as { id?: unknown }).id);
    if (!unitId) return badRequest(reply);
    if (!store.deliveryUnits.get(unitId)) return notFound(reply, "DELIVERY_UNIT_NOT_FOUND");
    return {
      runs: store.deliveryApplications.listForUnit(unitId).map(publicApplicationRun),
      retries: store.deliveryCoordination.listApplicationRetryAudits(unitId)
    };
  });
}

function publicApplicationRun(run: DeliveryApplicationRun) {
  return {
    id: run.id,
    requirementId: run.requirementId,
    deliveryUnitId: run.deliveryUnitId,
    projectVersionId: run.projectVersionId,
    evidenceVersion: run.evidenceVersion,
    automationJobId: run.automationJobId,
    automationAttempt: run.automationAttempt,
    sourceCommit: run.sourceCommit,
    baseCommit: publicText(run.baseCommit),
    preApplyCommit: publicText(run.preApplyCommit),
    evidenceHash: publicText(run.evidenceHash),
    preflight: publicPreflight(run.preflight),
    commandResults: publicCommandResults(run.commandResults),
    conflictFiles: run.conflictFiles.filter(isSafePublicText),
    error: run.error !== null && isSafePublicText(run.error) ? run.error : null,
    status: run.status,
    resolutionStatus: run.resolutionStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    resolvedAt: run.resolvedAt
  };
}

function publicPreflight(value: unknown) {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  if (typeof value.allowed === "boolean") result.allowed = value.allowed;
  if (Array.isArray(value.checks)) {
    result.checks = value.checks.flatMap((check) => {
      if (!isRecord(check)) return [];
      const projected: Record<string, unknown> = {};
      for (const key of ["id", "label", "name"] as const) {
        if (typeof check[key] === "string" && isSafePublicText(check[key])) projected[key] = check[key];
      }
      for (const key of ["ok", "passed"] as const) {
        if (typeof check[key] === "boolean") projected[key] = check[key];
      }
      if ((typeof check.code === "string" && isSafePublicText(check.code))
        || typeof check.code === "number") projected.code = check.code;
      return [projected];
    });
  }
  if (Array.isArray(value.changedModules)) {
    result.changedModules = value.changedModules.filter(
      (module): module is string => typeof module === "string" && isSafePublicText(module)
    );
  }
  if (Array.isArray(value.plannedCommands)) {
    result.plannedCommands = value.plannedCommands.flatMap((command) => {
      const projected = publicCommand(command, "argsPrefix");
      return projected ? [projected] : [];
    });
  }
  if (value.commandSource === "module_inference" || value.commandSource === "project_fallback"
    || value.commandSource === "unavailable") result.commandSource = value.commandSource;
  if (value.evidenceMode === "worktree" || value.evidenceMode === "commit") {
    result.evidenceMode = value.evidenceMode;
  }
  for (const key of ["sourceCommit", "sourceBranch", "targetBranch", "targetHead"] as const) {
    if (typeof value[key] === "string" && isSafePublicText(value[key])) result[key] = value[key];
  }
  return result;
}

function publicCommandResults(values: unknown[]) {
  return values.flatMap((value) => {
    const projected = publicCommand(value, "args");
    if (!projected || !isRecord(value)) return [];
    for (const key of ["code", "exitCode"] as const) {
      if (typeof value[key] === "number" && Number.isFinite(value[key])) projected[key] = value[key];
    }
    for (const key of ["stdout", "stderr"] as const) {
      if (typeof value[key] === "string" && isSafePublicText(value[key])) projected[key] = value[key];
    }
    return [projected];
  });
}

function publicCommand(value: unknown, argsKey: "args" | "argsPrefix") {
  if (!isRecord(value) || typeof value.command !== "string" || !isSafePublicText(value.command)) return null;
  const result: Record<string, unknown> = { command: value.command };
  const args = value[argsKey];
  if (Array.isArray(args) && args.every((arg) => typeof arg === "string" && isSafePublicText(arg))) {
    result[argsKey] = args;
  } else if (argsKey === "argsPrefix" && Array.isArray(args)) {
    return null;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafePublicText(value: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value)) return false;
  return !/(?:^|[^A-Za-z0-9_./-])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)|file:\/\/|(?:^|[^A-Za-z0-9_./:%?&#+~-])\/\//i
    .test(value);
}

function publicText(value: string) {
  return isSafePublicText(value) ? value : null;
}

function publicApplicationJob(job: AutomationJob | null) {
  if (!job) return null;
  return {
    id: job.id,
    ownerType: job.ownerType,
    ownerId: job.ownerId,
    evidenceVersion: job.evidenceVersion,
    action: job.action,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function routeId(value: unknown) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && !value.includes("\0") ? value : null;
}

function boundedText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096
    && !value.includes("\0") ? value.trim() : null;
}

function acceptanceError(reply: FastifyReply, error: unknown, operation: "accept" | "retry") {
  const code = error instanceof Error ? error.message : "DELIVERY_ACCEPTANCE_FAILED";
  if (operation === "accept") {
    if (code === "QUALITY_NOT_COMPLETE" || code === "DELIVERY_UNIT_NOT_VERIFIED"
      || code === "DELIVERY_ACCEPTANCE_NOT_ELIGIBLE") {
      return conflict(reply, "QUALITY_NOT_COMPLETE", code);
    }
    if (code === "STALE_DELIVERY_EVIDENCE") return conflict(reply, code);
    if (ACCEPTANCE_ACTIVE_CODES.has(code)) {
      return conflict(reply, "APPLICATION_ALREADY_ACTIVE", code);
    }
  } else if (APPLICATION_RETRY_CODES.has(code)) {
    return conflict(reply, "APPLICATION_RETRY_NOT_ALLOWED", code);
  }
  if (code === "PROJECT_VERSION_APPLICATION_BUSY") return conflict(reply, code);
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

const ACCEPTANCE_ACTIVE_CODES = new Set([
  "APPLICATION_ALREADY_ACTIVE",
  "DELIVERY_ACCEPTANCE_ALREADY_RECORDED",
  "DELIVERY_ACCEPTANCE_ACTIVE_WORK",
  "DELIVERY_APPLICATION_RUN_ACTIVE",
  "DELIVERY_APPLICATION_SEQUENCE_ACTIVE"
]);

const APPLICATION_RETRY_CODES = new Set([
  "APPLICATION_RETRY_NOT_ALLOWED",
  "DELIVERY_APPLICATION_RETRY_NOT_ELIGIBLE",
  "DELIVERY_APPLICATION_RETRY_AUDIT_STALE",
  "DELIVERY_APPLICATION_RETRY_AUDIT_CONFLICT",
  "DELIVERY_APPLICATION_RETRY_STALE",
  "DELIVERY_APPLICATION_RETRY_LIMIT",
  "DELIVERY_APPLICATION_SEQUENCE_STALE"
]);

function conflict(reply: FastifyReply, error: string, detailCode?: string) {
  return reply.code(409).send(detailCode && detailCode !== error ? { error, detailCode } : { error });
}

const badRequest = (reply: FastifyReply) => reply.code(400).send({ error: "VALIDATION_ERROR" });
const notFound = (reply: FastifyReply, detailCode: string) =>
  reply.code(404).send({ error: "NOT_FOUND", detailCode });
