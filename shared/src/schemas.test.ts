import { describe, expect, it } from "vitest";
import {
  MAX_AUTOMATED_TEST_COMMANDS,
  productArtifactSchema,
  projectInputSchema,
  projectUpdateSchema,
  projectVersionInputSchema,
  requirementInputSchema,
  requirementProjectsInputSchema,
  solutionDesignArtifactSchema
} from "./schemas.js";
import { selectDeliveryProjects, selectPrimaryProject, type RequirementProject } from "./project-association.js";

const association = (overrides: Record<string, unknown> = {}) => ({
  projectId: "project-primary",
  role: "primary",
  usage: "context",
  deliveryRequired: false,
  moduleMode: "auto",
  moduleIds: [],
  position: 0,
  ...overrides
});

describe("productArtifactSchema", () => {
  it("accepts autonomous product decisions and structured blockers", () => {
    const result=productArtifactSchema.safeParse({
      conclusion:"pass",confidence:0.9,summary:"完整产品定义",facts:[],openQuestions:[],risks:[],findings:[],
      underlyingGoal:"降低运营建号成本",targetUsers:["平台运营"],
      productDecisions:[{decision:"默认分页 20 条",rationale:"沿用系统惯例",evidence:"UserController.java"}],
      assumptions:[{assumption:"沿用错误码",rationale:"可逆",validation:"接口评审",impactIfWrong:"调整映射"}],
      scope:{mvp:["创建用户"],nonGoals:["批量导入"]},flows:{primary:["填写并提交"],exceptions:["重复账号提示"]},
      acceptanceCriteria:["合法输入创建成功"],evidence:[{source:"UserController.java",fact:"已有用户接口"}],blockingQuestions:[]
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single evidence reference for each product decision",()=>{
    const result=productArtifactSchema.parse({
      conclusion:"pass",confidence:0.9,summary:"完整产品定义",facts:[],openQuestions:[],risks:[],findings:[],underlyingGoal:"降低成本",targetUsers:["运营"],
      productDecisions:[{decision:"沿用权限体系",rationale:"项目已有规则",evidence:"SysUserController.java"}],
      assumptions:[],scope:{mvp:["创建用户"],nonGoals:[]},flows:{primary:["提交"],exceptions:[]},acceptanceCriteria:["创建成功"],evidence:[],blockingQuestions:[]
    });
    expect(result.productDecisions[0]?.evidence).toBe("SysUserController.java");
  });
});

const solutionDesignArtifact = () => ({
  conclusion: "pass",
  confidence: 0.9,
  summary: "Backend and frontend delivery plan",
  facts: [],
  assumptions: [],
  openQuestions: [],
  risks: [],
  findings: [],
  deliveryPlan: {
    units: [
      { projectId: "backend", moduleIds: ["api"], acceptanceCriteria: ["API tests pass"] },
      { projectId: "frontend", moduleIds: ["web"], acceptanceCriteria: ["UI tests pass"] }
    ],
    dependencies: [{
      upstreamProjectId: "backend",
      downstreamProjectId: "frontend",
      releaseCondition: "automated_testing_passed"
    }]
  },
  contracts: [{
    name: "User API",
    producerProjectId: "backend",
    consumerProjectIds: ["frontend"],
    description: "HTTP contract used by the web client"
  }]
});

describe("solutionDesignArtifactSchema", () => {
  it("parses delivery units, dependencies, and contracts", () => {
    expect(solutionDesignArtifactSchema.parse(solutionDesignArtifact())).toMatchObject({
      deliveryPlan: {
        units: [{ projectId: "backend" }, { projectId: "frontend" }],
        dependencies: [{ upstreamProjectId: "backend", downstreamProjectId: "frontend" }]
      },
      contracts: [{ producerProjectId: "backend", consumerProjectIds: ["frontend"] }]
    });
  });

  it("rejects a dependency endpoint that is not a delivery unit", () => {
    const artifact = solutionDesignArtifact();
    artifact.deliveryPlan.dependencies[0]!.downstreamProjectId = "missing";
    expect(solutionDesignArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects duplicate delivery unit project IDs", () => {
    const artifact = solutionDesignArtifact();
    artifact.deliveryPlan.units[1]!.projectId = "backend";
    expect(solutionDesignArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects a self dependency", () => {
    const artifact = solutionDesignArtifact();
    artifact.deliveryPlan.dependencies[0]!.downstreamProjectId = "backend";
    expect(solutionDesignArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects duplicate dependencies", () => {
    const artifact = solutionDesignArtifact();
    artifact.deliveryPlan.dependencies.push({ ...artifact.deliveryPlan.dependencies[0]! });
    expect(solutionDesignArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects cyclic dependencies", () => {
    const artifact = solutionDesignArtifact();
    artifact.deliveryPlan.dependencies.push({
      upstreamProjectId: "frontend",
      downstreamProjectId: "backend",
      releaseCondition: "automated_testing_passed"
    });
    expect(solutionDesignArtifactSchema.safeParse(artifact).success).toBe(false);
  });
});

describe("requirementProjectsInputSchema", () => {
  it("accepts a context-only primary and delivery collaborator", () => {
    const input = requirementProjectsInputSchema.parse([
      association({ projectId: " primary " }),
      association({
        projectId: " delivery ", role: "collaborator", usage: "delivery",
        projectVersionId: " version-delivery ",
        deliveryRequired: true, moduleMode: "selected", moduleIds: [" api ", "web"], position: 1
      })
    ]);

    const records: RequirementProject[] = input.map((item, index) => ({
      ...item, id: `association-${index}`, requirementId: "requirement-1", status: "active" as const,
      projectStatus: "active" as const,
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z"
    }));
    records.push(
      { ...records[1]!, id: "association-later", projectId: "later", position: 3 },
      { ...records[1]!, id: "association-archived", projectId: "archived", position: 0, status: "archived" }
    );
    expect(input[0]?.projectId).toBe("primary");
    expect(input[1]?.projectVersionId).toBe("version-delivery");
    expect(input[1]?.moduleIds).toEqual(["api", "web"]);
    expect(selectPrimaryProject(records)?.projectId).toBe("primary");
    expect(selectDeliveryProjects(records).map((item) => item.projectId)).toEqual(["delivery", "later"]);
  });

  it("rejects duplicate projects", () => {
    const result = requirementProjectsInputSchema.safeParse([
      association(), association({
        role: "collaborator", usage: "delivery", projectVersionId: "version-delivery",
        deliveryRequired: true, position: 1
      })
    ]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([1, "projectId"]);
  });

  it("rejects selected mode without modules", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association({ moduleMode: "selected" })
    ]).success).toBe(false);
  });

  it("rejects duplicate selected module IDs after trimming", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association({ moduleMode: "selected", moduleIds: ["api", " api "] })
    ]).success).toBe(false);
  });

  it.each(["auto", "all"])("rejects modules provided in %s mode", (moduleMode) => {
    expect(requirementProjectsInputSchema.safeParse([
      association({ moduleMode, moduleIds: ["api"] })
    ]).success).toBe(false);
  });

  it("rejects zero primary associations", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association({ role: "collaborator" })
    ]).success).toBe(false);
  });

  it("rejects an empty association collection", () => {
    expect(requirementProjectsInputSchema.safeParse([]).success).toBe(false);
  });

  it("rejects two primary associations", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association(), association({ projectId: "project-2", position: 1 })
    ]).success).toBe(false);
  });

  it("rejects context associations that require delivery", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association({ deliveryRequired: true })
    ]).success).toBe(false);
  });

  it("requires delivery associations to select a project version", () => {
    const result = requirementProjectsInputSchema.safeParse([
      association({ usage: "delivery", deliveryRequired: true })
    ]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([0, "projectVersionId"]);
  });

  it("rejects a project version on context associations with a clear error", () => {
    const result = requirementProjectsInputSchema.safeParse([
      association({ projectVersionId: "version-context" })
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: [0, "projectVersionId"],
        message: "Context projects cannot select a version"
      }));
    }
  });

  it.each([
    ["projectVersionName", "Release 1"],
    ["projectVersionBranch", "feature/release-1"],
    ["projectVersionStatus", "active"]
  ] as const)("rejects %s on context associations", (field, value) => {
    const result = requirementProjectsInputSchema.safeParse([
      association({ [field]: value })
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: [0, field],
        message: "Context projects cannot select a version"
      }));
    }
  });

  it("preserves optional project version display fields", () => {
    const input = requirementProjectsInputSchema.parse([
      association({
        usage: "delivery",
        deliveryRequired: true,
        projectVersionId: "version-delivery",
        projectVersionName: "Release 1",
        projectVersionBranch: "feature/release-1",
        projectVersionStatus: "active"
      })
    ]);

    expect(input[0]).toMatchObject({
      projectVersionName: "Release 1",
      projectVersionBranch: "feature/release-1",
      projectVersionStatus: "active"
    });
  });

  it("rejects an unknown project version display status", () => {
    expect(requirementProjectsInputSchema.safeParse([
      association({
        usage: "delivery",
        deliveryRequired: true,
        projectVersionId: "version-delivery",
        projectVersionStatus: "planned"
      })
    ]).success).toBe(false);
  });
});

describe("project schemas", () => {
  it("accepts the current project create fields", () => {
    expect(projectInputSchema.safeParse({
      name: "Repository", repoPath: "/tmp/repository", defaultBranch: "main",
      allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: [".env"]
    }).success).toBe(true);
  });

  it("defaults omitted allowed-command arguments to an empty prefix", () => {
    expect(projectInputSchema.parse({
      name: "Repository", repoPath: "/tmp/repository", defaultBranch: "main",
      allowedCommands: [{ command: "npm" }], sensitivePatterns: []
    }).allowedCommands).toEqual([{ command: "npm", argsPrefix: [] }]);
  });

  it("rejects more than sixteen frozen verification commands", () => {
    expect(projectInputSchema.safeParse({
      name: "Repository", repoPath: "/tmp/repository", defaultBranch: "main",
      allowedCommands: Array.from({ length: MAX_AUTOMATED_TEST_COMMANDS + 1 }, (_, index) => ({ command: `verify-${index}` })),
      sensitivePatterns: []
    }).success).toBe(false);
  });

  it("rejects an empty project update", () => {
    expect(projectUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("accepts null category to clear it", () => {
    expect(projectUpdateSchema.parse({ category: null })).toEqual({ category: null });
  });
});

describe("projectVersionInputSchema", () => {
  it("trims project version input strings", () => {
    expect(projectVersionInputSchema.parse({
      name: " Release 1 ", branch: " feature/release-1 ", baseBranch: " main ",
      reuseExistingWorktree: true
    })).toEqual({
      name: "Release 1", branch: "feature/release-1", baseBranch: "main",
      reuseExistingWorktree: true
    });
  });

  it.each(["name", "branch", "baseBranch"])("rejects an empty %s", (field) => {
    expect(projectVersionInputSchema.safeParse({
      name: "Release 1", branch: "feature/release-1", baseBranch: "main", [field]: "   "
    }).success).toBe(false);
  });
});

describe("requirementInputSchema", () => {
  const input = {
    title: "Requirement", businessProblem: "A concrete business problem",
    expectedOutcome: "Useful outcome", priority: "medium" as const,
    primaryProjectVersionId: "version-1"
  };

  it("requires a primary project ID", () => {
    expect(requirementInputSchema.safeParse(input).success).toBe(false);
  });

  it("trims the primary project ID", () => {
    expect(requirementInputSchema.parse({ ...input, primaryProjectId: " project-1 " }).primaryProjectId).toBe("project-1");
  });

  it("requires a primary project version ID", () => {
    const { primaryProjectVersionId: _, ...withoutVersion } = {
      ...input,
      primaryProjectId: "project-1"
    };

    expect(requirementInputSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it("trims the primary project version ID", () => {
    expect(requirementInputSchema.parse({
      ...input,
      primaryProjectId: "project-1",
      primaryProjectVersionId: " version-1 "
    }).primaryProjectVersionId).toBe("version-1");
  });
});
