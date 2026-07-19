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
  it("uses the five-stage timeline and only shows the delivery matrix in delivery stages", () => {
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
    const implementation = renderToStaticMarkup(React.createElement(RequirementDetail, {
      ...callbacks, item: { ...base, stage: "implementation" as const }
    }));
    const definition = renderToStaticMarkup(React.createElement(RequirementDetail, {
      ...callbacks, item: { ...base, stage: "definition" as const }
    }));

    for (const label of workflowSteps()) expect(implementation).toContain(label);
    expect(implementation).toContain("项目交付矩阵");
    expect(definition).not.toContain("项目交付矩阵");
  });
});
