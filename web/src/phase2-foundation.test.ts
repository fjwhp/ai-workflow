import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequirementDetail } from "./requirement-detail.js";

describe("Phase 2 foundation UI", () => {
  it("renders acceptance delivery as read-only evidence without local application actions", () => {
    const markup = renderToStaticMarkup(React.createElement(RequirementDetail, {
      item: {
        id: "REQ-1", code: "REQ-0001", title: "Foundation",
        businessProblem: "Legacy actions are unsafe in P1",
        expectedOutcome: "Read-only delivery evidence", priority: "high",
        stage: "acceptance_delivery", status: "ai_ready",
        primaryProjectId: "project-1", primaryProjectVersionId: "version-1",
        createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
        artifacts: [], approvals: [], executions: [], projects: [], deliveryUnits: [], deliveryDependencies: []
      },
      onRun: () => undefined,
      onViewRun: () => undefined,
      onEdit: () => undefined,
      onApprove: () => undefined,
      onRefresh: async () => undefined,
      onManageProjects: () => undefined
    }));

    expect(markup).not.toContain("版本工作区应用");
    expect(markup).not.toContain("应用预检");
    expect(markup).not.toContain("确认应用");
  });
});
