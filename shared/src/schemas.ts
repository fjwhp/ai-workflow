import { z } from "zod";
import { deliveryReleaseConditions, validateDeliveryGraph } from "./delivery-unit.js";
import { workflowStages, workflowStatuses } from "./domain.js";
import { moduleModes, projectRoles, projectUsages } from "./project-association.js";
import { projectVersionStatuses } from "./project-version.js";

export const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);

const nonEmptyIdSchema = z.string().trim().min(1);
export const projectCategorySchema = z.string().trim().min(1);
const allowedCommandSchema = z.object({
  command: z.string().trim().min(1),
  argsPrefix: z.array(z.string()).default([])
});

export const projectInputSchema = z.object({
  name: z.string().trim().min(1),
  repoPath: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1),
  allowedCommands: z.array(allowedCommandSchema),
  sensitivePatterns: z.array(z.string()),
  category: projectCategorySchema.optional()
});

export const projectVersionInputSchema = z.object({
  name: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  reuseExistingWorktree: z.boolean().optional()
});

export const projectUpdateSchema = projectInputSchema.partial().extend({
  category: projectCategorySchema.nullable().optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "Project update must include at least one field" }
);

export const requirementProjectInputSchema = z.object({
  projectId: nonEmptyIdSchema,
  projectVersionId: nonEmptyIdSchema.optional(),
  projectVersionName: z.string().optional(),
  projectVersionBranch: z.string().optional(),
  projectVersionStatus: z.enum(projectVersionStatuses).optional(),
  role: z.enum(projectRoles),
  usage: z.enum(projectUsages),
  deliveryRequired: z.boolean(),
  moduleMode: z.enum(moduleModes),
  moduleIds: z.array(nonEmptyIdSchema),
  position: z.number().int().nonnegative()
}).superRefine((value, ctx) => {
  if (value.usage === "delivery" && !value.projectVersionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectVersionId"], message: "Delivery projects must select a version" });
  }
  if (value.usage === "context") {
    for (const field of ["projectVersionId", "projectVersionName", "projectVersionBranch", "projectVersionStatus"] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Context projects cannot select a version" });
      }
    }
  }
  if (value.usage === "context" && value.deliveryRequired) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryRequired"], message: "Context projects cannot require delivery" });
  }
  if (value.moduleMode === "selected" && value.moduleIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["moduleIds"], message: "Selected mode requires modules" });
  }
  if (value.moduleMode !== "selected" && value.moduleIds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["moduleIds"], message: "Only selected mode can specify modules" });
  }
  if (new Set(value.moduleIds).size !== value.moduleIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["moduleIds"], message: "Module IDs must be unique" });
  }
});

export const requirementProjectsInputSchema = z.array(requirementProjectInputSchema).superRefine((items, ctx) => {
  const primaryIndexes = items.flatMap((item, index) => item.role === "primary" ? [index] : []);
  if (primaryIndexes.length !== 1) {
    const issueIndexes = primaryIndexes.length > 1 ? primaryIndexes : (items.length ? items.map((_, index) => index) : [0]);
    for (const index of issueIndexes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "role"], message: "Exactly one primary project is required" });
    }
  }
  const seenProjectIds = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seenProjectIds.has(item.projectId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "projectId"], message: "Project IDs must be unique" });
    }
    seenProjectIds.add(item.projectId);
  }
});

export const requirementInputSchema = z.object({
  title: z.string().trim().min(2).max(120),
  businessProblem: z.string().trim().min(10),
  expectedOutcome: z.string().trim().min(4),
  priority: prioritySchema.default("medium"),
  primaryProjectId: nonEmptyIdSchema,
  primaryProjectVersionId: nonEmptyIdSchema
});

export const findingSchema = z.object({
  title: z.string(), severity: z.enum(["S0", "S1", "S2", "S3"]),
  evidence: z.string(), impact: z.string(), recommendation: z.string(),
  targetStage: z.enum(workflowStages)
});

export const aiArtifactSchema = z.object({
  conclusion: z.enum(["pass", "conditional", "return"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1), facts: z.array(z.string()), assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()), risks: z.array(z.string()), findings: z.array(findingSchema)
});

export const deliveryDependencyInputSchema = z.object({
  upstreamProjectId: nonEmptyIdSchema,
  downstreamProjectId: nonEmptyIdSchema,
  releaseCondition: z.enum(deliveryReleaseConditions)
});

export const solutionDesignArtifactSchema = aiArtifactSchema.extend({
  deliveryPlan: z.object({
    units: z.array(z.object({
      projectId: nonEmptyIdSchema,
      moduleIds: z.array(nonEmptyIdSchema),
      acceptanceCriteria: z.array(z.string().trim().min(1)).min(1)
    })).min(1),
    dependencies: z.array(deliveryDependencyInputSchema)
  }),
  contracts: z.array(z.object({
    name: z.string(),
    producerProjectId: nonEmptyIdSchema,
    consumerProjectIds: z.array(nonEmptyIdSchema),
    description: z.string()
  }))
}).superRefine((value, ctx) => {
  const projectIds = value.deliveryPlan.units.map((unit) => unit.projectId);
  const seenProjectIds = new Set<string>();
  for (const [index, projectId] of projectIds.entries()) {
    if (seenProjectIds.has(projectId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryPlan", "units", index, "projectId"],
        message: "DELIVERY_UNIT_DUPLICATE_PROJECT"
      });
    }
    seenProjectIds.add(projectId);
  }

  try {
    validateDeliveryGraph(projectIds, value.deliveryPlan.dependencies);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deliveryPlan", "dependencies"],
      message: error instanceof Error ? error.message : "DELIVERY_DEPENDENCY_INVALID"
    });
  }
});

export const productDecisionSchema=z.object({decision:z.string(),rationale:z.string(),evidence:z.string()});
export const productAssumptionSchema=z.object({assumption:z.string(),rationale:z.string(),validation:z.string(),impactIfWrong:z.string()});
export const blockingQuestionSchema=z.object({question:z.string(),impact:z.string(),options:z.array(z.string()).min(2)});
export const productArtifactSchema=aiArtifactSchema.extend({
  underlyingGoal:z.string().min(1),targetUsers:z.array(z.string()).min(1),productDecisions:z.array(productDecisionSchema),
  assumptions:z.array(productAssumptionSchema),scope:z.object({mvp:z.array(z.string()),nonGoals:z.array(z.string())}),
  flows:z.object({primary:z.array(z.string()),exceptions:z.array(z.string())}),acceptanceCriteria:z.array(z.string()).min(1),
  evidence:z.array(z.object({source:z.string(),fact:z.string()})),blockingQuestions:z.array(blockingQuestionSchema)
});

export const approvalInputSchema = z.object({
  decision: z.enum(["approve", "conditional", "return"]),
  comment: z.string().trim().min(2), condition: z.string().optional(),
  targetStage: z.enum(workflowStages).optional()
}).superRefine((value, ctx) => {
  if (value.decision === "conditional" && !value.condition?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "条件批准必须填写条件" });
  }
});

export const requirementSchema = requirementInputSchema.extend({
  id: z.string(), code: z.string(), stage: z.enum(workflowStages),
  status: z.enum(workflowStatuses), createdAt: z.string(), updatedAt: z.string()
});

export type Requirement = z.infer<typeof requirementSchema>;
export type RequirementInput = z.infer<typeof requirementInputSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type ProjectVersionInput = z.infer<typeof projectVersionInputSchema>;
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export type RequirementProjectInput = z.infer<typeof requirementProjectInputSchema>;
export type AiArtifact = z.infer<typeof aiArtifactSchema>;
export type ProductArtifact = z.infer<typeof productArtifactSchema>;
