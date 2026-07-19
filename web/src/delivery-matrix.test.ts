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

  it("uses released evidence for automated testing without treating it as code review", () => {
    const backend = {
      id: "unit-backend", projectId: "backend", projectVersionId: "backend-v1",
      phase: "quality_verification" as const, status: "awaiting_gate" as const, evidenceVersion: 2
    };

    expect(deliveryRowView(backend, [{
      upstreamUnitId: "unit-backend", downstreamUnitId: "unit-frontend",
      releaseCondition: "automated_testing_passed", releasedByEvidenceVersion: 2,
      releasedAt: "2026-07-20T01:00:00.000Z"
    }])).toMatchObject({
      reviewLabel: "尚无证据",
      automatedTestingLabel: "已通过 · 证据 v2"
    });
  });
});

describe("DeliveryMatrix", () => {
  it("renders one read-only delivery row per unit with independent review and testing fields", () => {
    const units = [{
      id: "unit-backend", projectId: "backend", projectVersionId: "backend-v1",
      phase: "quality_verification" as const, status: "awaiting_gate" as const, evidenceVersion: 2
    }, {
      id: "unit-frontend", projectId: "frontend", projectVersionId: "frontend-v1",
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

  it("keeps delivery rows and actions inside a 390px viewport", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.delivery-row-grid\{[^}]*display:grid[^}]*grid-template-columns:/);
    expect(css).toMatch(/\.delivery-row-grid\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project,.delivery-field\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.delivery-field[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\[data-field="next-action"\]\{[^}]*max-width:100%/);
    expect(css).toMatch(/@media\(max-width:620px\)\{[^@]*\.delivery-row-stack\{[^}]*grid-template-columns:1fr/);
  });
});
