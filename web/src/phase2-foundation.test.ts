import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequirementDetail } from "./requirement-detail.js";

describe("Phase 2 foundation UI", () => {
  it.each([
    ["implementation", "ai_ready", "实现"],
    ["implementation", "awaiting_approval", "实现"],
    ["quality_verification", "ai_ready", "质量验证"],
    ["quality_verification", "awaiting_approval", "质量验证"],
    ["acceptance_delivery", "ai_ready", "验收交付"],
    ["acceptance_delivery", "awaiting_approval", "验收交付"]
  ] as const)("renders %s/%s as live delivery evidence without requirement-level actions", (stage, status, stageLabel) => {
    const markup = renderToStaticMarkup(React.createElement(RequirementDetail, {
      item: {
        id: "REQ-1", code: "REQ-0001", title: "Foundation",
        businessProblem: "Legacy actions are unsafe in P1",
        expectedOutcome: "Read-only delivery evidence", priority: "high",
        stage, status,
        primaryProjectId: "project-1", primaryProjectVersionId: "version-1",
        createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
        artifacts: [], approvals: [], projects: [], deliveryUnits: [], deliveryDependencies: []
      },
      onRun: () => undefined,
      onViewRun: () => undefined,
      onEdit: () => undefined,
      onApprove: () => undefined,
      onRefresh: async () => undefined,
      onManageProjects: () => undefined
    }));

    expect(markup).toContain(stageLabel);
    expect(markup).toContain("交付进行中");
    expect(markup).toContain("项目交付进度");
    expect(markup).not.toContain("只读");
    expect(markup).not.toContain("启动 AI");
    expect(markup).not.toContain("人工审批");
    expect(markup).not.toContain("手动启动本阶段 AI");
    expect(markup).not.toContain("版本工作区应用");
    expect(markup).not.toContain("应用预检");
    expect(markup).not.toContain("确认应用");
  });

  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)("does not render requirement AI execution controls for downstream %s runs", (stage) => {
    const markup = renderToStaticMarkup(React.createElement(RequirementDetail, {
      item: {
        id: "REQ-2", code: "REQ-0002", title: "Legacy run", businessProblem: "Old state",
        expectedOutcome: "Read-only delivery evidence", priority: "medium", stage, status: "ai_running",
        primaryProjectId: "project-1", primaryProjectVersionId: "version-1",
        createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
        artifacts: [], approvals: [], projects: [], deliveryUnits: [], deliveryDependencies: [],
        runs: [{ id: "run-1", stage, status: "running", model: "legacy", input: {}, createdAt: "2026-07-20T00:00:00.000Z", events: [] }]
      },
      onRun: () => undefined, onViewRun: () => undefined, onEdit: () => undefined,
      onApprove: () => undefined, onRefresh: async () => undefined, onManageProjects: () => undefined
    }));

    expect(markup).toContain("交付进行中");
    expect(markup).not.toContain("查看 AI 执行详情");
    expect(markup).not.toContain("查看实时执行");
    expect(markup).not.toContain("执行记录");
  });
});
