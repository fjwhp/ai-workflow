import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryMatrix, deliveryRowView } from "./delivery-matrix.js";

describe("deliveryRowView", () => {
  it("waits for the upstream project's automated testing without inventing an action", () => {
    const frontend = {
      id: "unit-frontend",
      projectId: "frontend",
      projectVersionId: "frontend-v1",
      required: true,
      phase: "implementation" as const,
      status: "waiting_dependency" as const,
      evidenceVersion: 1
    };

    expect(deliveryRowView(frontend, [{
      upstreamUnitId: "unit-backend",
      downstreamUnitId: "unit-frontend",
      upstreamProjectName: "Backend",
      releaseCondition: "automated_testing_passed",
      releasedAt: null
    }])).toMatchObject({
      dependencyLabel: "等待 Backend 自动化测试",
      nextAction: null
    });
  });

  it("does not treat a released dependency edge as unit quality evidence", () => {
    const backend = {
      id: "unit-backend", projectId: "backend", projectVersionId: "backend-v1", required: true,
      phase: "quality_verification" as const, status: "ready" as const, evidenceVersion: 2
    };

    expect(deliveryRowView(backend, [{
      upstreamUnitId: "unit-backend", downstreamUnitId: "unit-frontend",
      releaseCondition: "automated_testing_passed", releasedByEvidenceVersion: 2,
      releasedAt: "2026-07-20T01:00:00.000Z"
    }])).toMatchObject({
      reviewLabel: "等待独立审查证据",
      automatedTestingLabel: "等待自动化测试证据"
    });
  });

  it.each([
    ["implementation ready", "implementation", "ready", "等待独立审查证据", "等待自动化测试证据"],
    ["quality aggregate running", "quality_verification", "running", "等待独立审查证据", "等待自动化测试证据"],
    ["implementation aggregate awaiting gate", "quality_verification", "awaiting_gate", "等待独立审查证据", "等待自动化测试证据"],
    ["aggregate returned", "quality_verification", "returned", "等待独立审查证据", "等待自动化测试证据"],
    ["aggregate failed", "quality_verification", "failed", "等待独立审查证据", "等待自动化测试证据"],
    ["leaf ready for acceptance", "quality_verification", "ready_for_acceptance", "已通过", "已通过"],
    ["leaf applied", "acceptance_delivery", "applied", "已通过", "已通过"]
  ] as const)("does not invent per-check conclusions while %s", (_case, phase, status, reviewLabel, automatedTestingLabel) => {
    const leaf = {
      id: "unit-leaf", projectId: "leaf", projectVersionId: "leaf-v1", required: true,
      phase, status, evidenceVersion: 3
    };

    expect(deliveryRowView(leaf, [])).toMatchObject({ reviewLabel, automatedTestingLabel });
  });

  it("keeps an optional skipped unit explicit and non-actionable in every delivery column", () => {
    const skipped = {
      id: "unit-optional", projectId: "docs", projectVersionId: "docs-v1", required: false,
      phase: "acceptance_delivery" as const, status: "skipped" as const, evidenceVersion: 1
    };

    expect(deliveryRowView(skipped, [])).toMatchObject({
      dependencyLabel: "无需等待 · 已跳过",
      implementationLabel: "已跳过",
      reviewLabel: "已跳过",
      automatedTestingLabel: "已跳过",
      applicationLabel: "已跳过",
      blocker: "可选交付已跳过",
      nextAction: null
    });

    const markup = renderToStaticMarkup(React.createElement(DeliveryMatrix, {
      units: [skipped], dependencies: [], projects: [{
        projectId: "docs", projectName: "Docs", projectVersionId: "docs-v1",
        projectVersionName: "1.0.0", projectVersionBranch: "release/1.0"
      }]
    }));
    expect(markup).toContain("可选");
    expect(markup).not.toContain("delivery-blocker");
  });

  it("renders a required skipped unit as an invalid blocking state", () => {
    const skipped = {
      id: "unit-required", projectId: "api", projectVersionId: "api-v1", required: true,
      phase: "acceptance_delivery" as const, status: "skipped" as const, evidenceVersion: 1
    };

    expect(deliveryRowView(skipped, [])).toMatchObject({
      blocker: "必需交付已跳过",
      nextAction: null
    });
    const markup = renderToStaticMarkup(React.createElement(DeliveryMatrix, {
      units: [skipped], dependencies: [], projects: [{
        projectId: "api", projectName: "API", projectVersionId: "api-v1",
        projectVersionName: "2.0.0", projectVersionBranch: "release/2.0"
      }]
    }));
    expect(markup).toContain("必需交付已跳过");
    expect(markup).toContain("delivery-blocker");
  });
});

describe("DeliveryMatrix", () => {
  it("renders one read-only delivery row per unit with independent review and testing fields", () => {
    const units = [{
      id: "unit-backend", projectId: "backend", projectVersionId: "backend-v1", required: true,
      phase: "quality_verification" as const, status: "awaiting_gate" as const, evidenceVersion: 2
    }, {
      id: "unit-frontend", projectId: "frontend", projectVersionId: "frontend-v1", required: true,
      phase: "implementation" as const, status: "waiting_dependency" as const, evidenceVersion: 1
    }];
    const dependencies = [{
      upstreamUnitId: "unit-backend", downstreamUnitId: "unit-frontend",
      releaseCondition: "automated_testing_passed" as const,
      releasedAt: null
    }];
    const projects = [{
      projectId: "backend", projectName: "Backend", projectVersionId: "backend-v1",
      projectVersionName: "2.4.0", projectVersionBranch: "release/2.4"
    }, {
      projectId: "frontend", projectName: "Frontend", projectVersionId: "frontend-v1",
      projectVersionName: "3.1.0", projectVersionBranch: "release/3.1"
    }];

    const markup = renderToStaticMarkup(React.createElement(DeliveryMatrix, {
      units, dependencies, projects
    }));

    expect(markup.match(/data-delivery-row=/g)).toHaveLength(2);
    expect(markup).toContain("Backend");
    expect(markup).toContain("2.4.0 · release/2.4");
    expect(markup).toContain("Frontend");
    expect(markup).toContain("等待 Backend 自动化测试");
    expect(markup).toContain("实现");
    expect(markup).toContain("Code Review");
    expect(markup).toContain("自动化测试");
    expect(markup).toContain("应用");
    expect(markup).toContain("Blocker");
    expect(markup).toContain("下一步");
    expect(markup.match(/data-field="code-review"/g)).toHaveLength(2);
    expect(markup.match(/data-field="automated-testing"/g)).toHaveLength(2);
    expect(markup.match(/data-field="next-action"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<button|<form|<input|<select/);
  });

  it("stacks the actual delivery row classes across the 901-937px gap and at 390px", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.delivery-row-grid\{[^}]*display:grid[^}]*grid-template-columns:/);
    expect(css).toMatch(/\.delivery-row-grid\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project,.delivery-field\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.delivery-field[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\[data-field="next-action"\]\{[^}]*max-width:100%/);
    const stackRule = css.match(/@media\(max-width:(\d+)px\)\{[^@]*\.delivery-matrix-header\{display:none\}[^@]*\.delivery-row-stack\{grid-template-columns:1fr/);
    expect(stackRule).not.toBeNull();
    const stackBreakpoint = Number(stackRule![1]);
    expect(stackBreakpoint).toBeGreaterThanOrEqual(937);
    expect(390).toBeLessThanOrEqual(stackBreakpoint);
  });
});
