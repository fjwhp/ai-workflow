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
      return acceptanceError(reply, error);
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
      return acceptanceError(reply, error);
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
  const { claimToken: _claimToken, leaseOwner: _leaseOwner, ...safe } = run;
  return safe;
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

function acceptanceError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : "DELIVERY_ACCEPTANCE_FAILED";
  if (code.endsWith("_NOT_FOUND")) return notFound(reply, code);
  if (code.endsWith("_INVALID")) return badRequest(reply);
  if (code === "QUALITY_NOT_COMPLETE" || code === "DELIVERY_UNIT_NOT_VERIFIED"
    || code === "DELIVERY_ACCEPTANCE_NOT_ELIGIBLE") {
    return conflict(reply, "QUALITY_NOT_COMPLETE", code);
  }
  if (code === "STALE_DELIVERY_EVIDENCE") return conflict(reply, code);
  if (code === "APPLICATION_ALREADY_ACTIVE" || code === "DELIVERY_ACCEPTANCE_ALREADY_RECORDED"
    || code === "DELIVERY_APPLICATION_RUN_ACTIVE" || code === "DELIVERY_APPLICATION_SEQUENCE_ACTIVE") {
    return conflict(reply, "APPLICATION_ALREADY_ACTIVE", code);
  }
  if (code === "APPLICATION_RETRY_NOT_ALLOWED" || code.startsWith("DELIVERY_APPLICATION_RETRY_")) {
    return conflict(reply, "APPLICATION_RETRY_NOT_ALLOWED", code);
  }
  if (code === "PROJECT_VERSION_APPLICATION_BUSY") return conflict(reply, code);
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

function conflict(reply: FastifyReply, error: string, detailCode?: string) {
  return reply.code(409).send(detailCode && detailCode !== error ? { error, detailCode } : { error });
}

const badRequest = (reply: FastifyReply) => reply.code(400).send({ error: "VALIDATION_ERROR" });
const notFound = (reply: FastifyReply, detailCode: string) =>
  reply.code(404).send({ error: "NOT_FOUND", detailCode });
