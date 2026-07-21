import type { FastifyInstance, FastifyReply } from "fastify";
import type { DeliveryQualityKind } from "./delivery-quality-repository.js";
import type { WorkflowStore } from "./store.js";

const LOCAL_HUMAN_ACTOR = "local-human";

interface RouteOptions { store: WorkflowStore }

export async function registerDeliveryUnitRoutes(app: FastifyInstance, { store }: RouteOptions) {
  app.post("/api/delivery-units/:id/stale-resolution", async (request, reply) => {
    const unitId = routeId((request.params as { id?: unknown }).id);
    const body = objectBody(request.body);
    const decision = body.decision;
    const reason = boundedReason(body.reason);
    if (decision !== "reuse" && decision !== "rerun") return badRequest(reply, "DELIVERY_STALE_RESOLUTION_INVALID");
    if (!unitId || !reason) return badRequest(reply, "DELIVERY_STALE_RESOLUTION_INVALID");
    if (!store.deliveryUnits.get(unitId)) return notFound(reply, "DELIVERY_UNIT_NOT_FOUND");
    try {
      return store.deliveryCoordination.resolveStale({ unitId, decision, reason, actor: LOCAL_HUMAN_ACTOR });
    } catch (error) { return coordinationError(reply, error); }
  });

  app.post("/api/delivery-units/:id/quality-override", async (request, reply) => {
    const unitId = routeId((request.params as { id?: unknown }).id);
    const body = objectBody(request.body);
    const kind = body.kind;
    const reason = boundedReason(body.reason);
    const acceptedRisk = boundedReason(body.acceptedRisk);
    if (!unitId || (kind !== "code_review" && kind !== "automated_testing") || !reason || !acceptedRisk) {
      return badRequest(reply, "DELIVERY_QUALITY_OVERRIDE_INVALID");
    }
    const unit = store.deliveryUnits.get(unitId);
    if (!unit) return notFound(reply, "DELIVERY_UNIT_NOT_FOUND");
    try {
      return store.deliveryCoordination.overrideQuality({ unitId, evidenceVersion: unit.evidenceVersion,
        kind: kind as DeliveryQualityKind, actor: LOCAL_HUMAN_ACTOR, reason, acceptedRisk });
    } catch (error) { return coordinationError(reply, error); }
  });

  app.post("/api/delivery-units/:id/skip", async (request, reply) => {
    const unitId = routeId((request.params as { id?: unknown }).id);
    const reason = boundedReason(objectBody(request.body).reason);
    if (!unitId || !reason) return badRequest(reply, "DELIVERY_UNIT_SKIP_INVALID");
    if (!store.deliveryUnits.get(unitId)) return notFound(reply, "DELIVERY_UNIT_NOT_FOUND");
    try {
      return store.deliveryCoordination.skipOptional({ unitId, actor: LOCAL_HUMAN_ACTOR, reason });
    } catch (error) { return coordinationError(reply, error); }
  });

  app.post("/api/requirements/:id/automation/pause", async (request, reply) => {
    return automationRoute(store, request.params, request.body, reply, "pause");
  });
  app.post("/api/requirements/:id/automation/resume", async (request, reply) => {
    return automationRoute(store, request.params, request.body, reply, "resume");
  });
}

function automationRoute(
  store: WorkflowStore,
  rawParams: unknown,
  rawBody: unknown,
  reply: FastifyReply,
  action: "pause" | "resume"
) {
  const requirementId = routeId((rawParams as { id?: unknown } | null)?.id);
  const reason = boundedReason(objectBody(rawBody).reason);
  if (!requirementId || !reason) return badRequest(reply, "REQUIREMENT_AUTOMATION_INPUT_INVALID");
  try {
    const input = { requirementId, actor: LOCAL_HUMAN_ACTOR, reason };
    return action === "pause"
      ? store.deliveryCoordination.pauseAutomation(input)
      : store.deliveryCoordination.resumeAutomation(input);
  } catch (error) { return coordinationError(reply, error); }
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

function boundedReason(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096
    && !value.includes("\0") ? value.trim() : null;
}

function coordinationError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : "DELIVERY_COORDINATION_FAILED";
  if (code.endsWith("_INVALID")) return badRequest(reply, code);
  if (code.endsWith("_NOT_FOUND")) return notFound(reply, code);
  if (code.includes("CONFLICT") || code.includes("NOT_ACTIVE") || code.includes("NOT_PAUSED")
    || code.includes("NOT_ELIGIBLE") || code.includes("STALE") || code.includes("UNSATISFIED")
    || code.includes("REQUIRED") || code.includes("LIMIT")) {
    return reply.code(409).send({ error: code });
  }
  throw error;
}

const badRequest = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
const notFound = (reply: FastifyReply, error: string) => reply.code(404).send({ error });
