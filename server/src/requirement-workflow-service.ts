import { solutionDesignArtifactSchema } from "@ai-workflow/shared";
import type { WorkflowStore } from "./store.js";

interface SolutionDesignApproval {
  decision: string;
  comment: string;
  condition?: string;
}

interface ApproveSolutionDesignInput {
  requirementId: string;
  approval: SolutionDesignApproval;
}

export class RequirementWorkflowService {
  constructor(
    private readonly store: WorkflowStore,
    private readonly clock: () => Date = () => new Date()
  ) {}

  approveSolutionDesign(input: ApproveSolutionDesignInput) {
    if (!(["approve", "conditional"] as string[]).includes(input.approval.decision)) {
      throw new Error("SOLUTION_DESIGN_APPROVAL_DECISION_INVALID");
    }
    const now = this.clock().toISOString();
    return this.store.withImmediateTransaction(() => {
      const state = this.store.getRequirementStateInTransaction(input.requirementId);
      if (!state) throw new Error("REQUIREMENT_NOT_FOUND");
      if (state.stage !== "solution_design") throw new Error("REQUIREMENT_APPROVAL_STATE_CHANGED");
      if (state.status !== "awaiting_approval") throw new Error("REQUIREMENT_APPROVAL_NOT_READY");

      let artifact;
      try {
        artifact = this.store.getLatestArtifact(input.requirementId, "solution_design");
      } catch {
        throw new Error("SOLUTION_DESIGN_ARTIFACT_INVALID");
      }
      if (!artifact) throw new Error("SOLUTION_DESIGN_ARTIFACT_NOT_FOUND");
      const parsed = solutionDesignArtifactSchema.safeParse(artifact.content);
      if (!parsed.success) {
        const deliveryIssue = parsed.error.issues.find((issue) => issue.message.startsWith("DELIVERY_"));
        throw new Error(deliveryIssue?.message ?? "SOLUTION_DESIGN_ARTIFACT_INVALID");
      }

      const snapshot = this.store.createRequirementProjectSnapshotInTransaction(input.requirementId, now);
      const plan = this.store.createDeliveryPlanInTransaction({
        requirementId: input.requirementId,
        snapshot,
        plan: parsed.data.deliveryPlan
      });
      const approval = this.store.insertApprovalInTransaction(input.requirementId, "solution_design", {
        decision: input.approval.decision,
        comment: input.approval.comment,
        condition: input.approval.condition,
        artifactId: artifact.id
      }, now);
      const requirement = this.store.updateRequirementInTransaction(
        input.requirementId,
        "implementation",
        "ai_ready",
        now,
        "solution_design",
        "awaiting_approval"
      );
      return {
        requirement,
        snapshot,
        approval,
        deliveryUnits: plan.units,
        deliveryDependencies: plan.dependencies
      };
    });
  }
}
