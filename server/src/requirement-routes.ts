import { approvalInputSchema, returnStage } from "@ai-workflow/shared";
import type { FastifyInstance } from "fastify";
import { RequirementWorkflowService } from "./requirement-workflow-service.js";
import type { WorkflowStore } from "./store.js";

interface RequirementRouteDependencies {
  store: WorkflowStore;
  service?: RequirementWorkflowService;
  onApproved?: (requirementId: string) => void | Promise<void>;
}

const approvalConflictCodes = new Set([
  "REQUIREMENT_APPROVAL_STATE_CHANGED",
  "REQUIREMENT_APPROVAL_NOT_READY",
  "SOLUTION_DESIGN_APPROVAL_DECISION_INVALID",
  "SOLUTION_DESIGN_ARTIFACT_NOT_FOUND",
  "SOLUTION_DESIGN_ARTIFACT_INVALID",
  "PROJECT_VERSION_APPLICATION_PENDING"
]);

export async function registerRequirementRoutes(
  app: FastifyInstance,
  dependencies: RequirementRouteDependencies
) {
  const { store, onApproved } = dependencies;
  const service = dependencies.service ?? new RequirementWorkflowService(store);

  app.post("/api/requirements/:id/approve", async (req: any, reply) => {
    const parsed = approvalInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    }
    const current = store.getRequirement(req.params.id);
    if (!current) return reply.code(404).send({ error: "NOT_FOUND" });

    let requirement;
    try {
      if (current.stage === "solution_design" && parsed.data.decision !== "return") {
        requirement = service.approveSolutionDesign({
          requirementId: current.id,
          approval: {
            decision: parsed.data.decision,
            comment: parsed.data.comment,
            condition: parsed.data.condition
          }
        }).requirement;
      } else {
        const approval = parsed.data.decision === "return"
          ? { ...parsed.data, targetStage: returnStage(current.stage) }
          : parsed.data;
        requirement = store.applyRequirementApproval({
          requirementId: current.id,
          expectedStage: current.stage,
          approval
        });
      }
    } catch (error) {
      return sendRequirementApprovalError(reply, error);
    }

    if (onApproved) {
      try { await onApproved(current.id); }
      catch { /* Approval is committed; knowledge refresh remains best effort. */ }
    }
    return requirement;
  });
}

function sendRequirementApprovalError(reply: any, error: unknown) {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  if (code === "REQUIREMENT_NOT_FOUND") return reply.code(404).send({ error: "NOT_FOUND" });
  if (code === "PROJECT_VERSION_APPLICATION_PENDING") {
    return reply.code(409).send({ error: code, message: "版本应用处理中，不能修改需求或项目关联" });
  }
  if (code.startsWith("DELIVERY_") || approvalConflictCodes.has(code)) {
    return reply.code(409).send({ error: code });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}
