import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequirementDetail } from "./requirement-detail.js";
import { workflowSteps } from "./workflow-view.js";

describe("workflowSteps", () => {
  it("returns the five product delivery stages in order", () => {
    expect(workflowSteps()).toEqual([
      "需求定义",
      "方案设计",
      "实现",
      "质量验证",
      "验收交付"
    ]);
  });
});

describe("RequirementDetail", () => {
  const base = {
    id: "req-1", code: "REQ-1", title: "Ship coordinated projects",
    businessProblem: "Delivery is fragmented", expectedOutcome: "Projects ship together",
    primaryProjectId: "frontend", primaryProjectVersionId: "frontend-v1",
    createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
    priority: "high" as const, status: "ai_ready" as const,
    artifacts: [], approvals: [], projects: [{
      projectId: "frontend", projectName: "Frontend", projectVersionId: "frontend-v1",
      projectVersionName: "3.1.0", projectVersionBranch: "release/3.1",
      role: "primary" as const, usage: "delivery" as const, deliveryRequired: true,
      moduleMode: "all" as const, moduleIds: [], position: 0, status: "active" as const,
      projectStatus: "active" as const
    }],
    deliveryUnits: [{
      id: "unit-frontend", projectId: "frontend", projectVersionId: "frontend-v1", required: true,
      phase: "implementation" as const, status: "ready" as const, evidenceVersion: 1
    }],
    deliveryDependencies: []
  };
  const callbacks = {
    onRun: () => undefined, onViewRun: () => undefined, onEdit: () => undefined,
    onApprove: () => undefined, onIntegrate: () => undefined,
    onRefresh: async () => undefined, onManageProjects: () => undefined
  };
  const renderDetail = (stage: "definition" | "solution_design" | "implementation" | "quality_verification" | "acceptance_delivery") => renderToStaticMarkup(React.createElement(RequirementDetail, {
    ...callbacks, item: { ...base, stage }
  }));

  it("uses the five-stage timeline", () => {
    const markup = renderDetail("implementation");

    for (const label of workflowSteps()) expect(markup).toContain(label);
  });

  it.each([
    "implementation",
    "quality_verification",
    "acceptance_delivery"
  ] as const)("shows the delivery matrix during %s", (stage) => {
    expect(renderDetail(stage)).toContain("项目交付矩阵");
  });

  it.each([
    "definition",
    "solution_design"
  ] as const)("hides the delivery matrix during %s", (stage) => {
    expect(renderDetail(stage)).not.toContain("项目交付矩阵");
  });
});
