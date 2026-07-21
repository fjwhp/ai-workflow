import React from "react";
import { deliveryUnitStatuses } from "@ai-workflow/shared";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeliveryActionDialog,
  DeliveryMatrix,
  deliveryMatrixRowViews,
  deliveryRowView,
  deliveryStatusViews
} from "./delivery-matrix.js";
import { RequirementDetail } from "./requirement-detail.js";

type NativeRole = "table" | "row" | "columnheader" | "cell";

function renderedRoleQueries(markup: string) {
  const tagsByRole: Record<NativeRole, string> = {
    table: "table",
    row: "tr",
    columnheader: "th",
    cell: "td"
  };
  const textById = new Map([...markup.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => [match[2], accessibleText(match[3])]));

  function allByRole(role: NativeRole) {
    const tag = tagsByRole[role];
    return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) => {
      const labelledBy = match[1].match(/\baria-labelledby="([^"]+)"/i)?.[1];
      return {
        markup: match[0],
        name: labelledBy ? textById.get(labelledBy) ?? "" : accessibleText(match[2])
      };
    });
  }

  return {
    getByRole(role: NativeRole, options: { name: string | RegExp }) {
      const matches = allByRole(role).filter((entry) => typeof options.name === "string"
        ? entry.name === options.name
        : options.name.test(entry.name));
      if (matches.length !== 1) throw new Error(`Expected one ${role} named ${String(options.name)}, found ${matches.length}`);
      return matches[0];
    },
    getAllByRole: allByRole
  };
}

function accessibleText(markup: string): string {
  return markup
    .replace(/<([a-z][\w-]*)\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

type MatrixUnits = React.ComponentProps<typeof DeliveryMatrix>["units"];
type MatrixDependencies = React.ComponentProps<typeof DeliveryMatrix>["dependencies"];

describe("deliveryRowView", () => {
  it("defines a presentation for every shared delivery status", () => {
    expect(Object.keys(deliveryStatusViews)).toEqual([...deliveryUnitStatuses]);
  });

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

  it.each([
    ["acceptance ready", "acceptance_delivery", "ready", "待应用"],
    ["acceptance applying", "acceptance_delivery", "applying", "应用中"],
    ["acceptance applied", "acceptance_delivery", "applied", "已应用"],
    ["acceptance skipped", "acceptance_delivery", "skipped", "已跳过"],
    ["non-acceptance neutral", "quality_verification", "ready", "尚未开始"]
  ] as const)("shows the application state for %s", (_case, phase, status, applicationLabel) => {
    const unit = {
      id: "unit-application", projectId: "application", projectVersionId: "application-v1",
      required: status !== "skipped", phase, status, evidenceVersion: 1
    };

    expect(deliveryRowView(unit, [])).toMatchObject({ applicationLabel });
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

describe("deliveryMatrixRowViews", () => {
  const unit = {
    id: "unit-api", projectId: "api", projectVersionId: "api-v1", required: true,
    phase: "implementation" as const, status: "waiting_dependency" as const, evidenceVersion: 1
  };

  it.each([
    ["unknown upstream", { upstreamUnitId: "unit-missing", downstreamUnitId: unit.id }],
    ["unknown downstream", { upstreamUnitId: unit.id, downstreamUnitId: "unit-missing" }]
  ])("marks a known unit incident to an %s endpoint as invalid", (_case, endpoint) => {
    const dependencies = [{
      ...endpoint,
      releaseCondition: "automated_testing_passed" as const,
      releasedAt: null
    }];

    expect(deliveryMatrixRowViews([unit], dependencies).get(unit.id)).toMatchObject({
      dependencyLabel: "交付依赖数据异常",
      blocker: "交付依赖数据异常",
      nextAction: null
    });
  });

  it("marks every unit participating in a dependency cycle as invalid", () => {
    const peer = { ...unit, id: "unit-web", projectId: "web", projectVersionId: "web-v1" };
    const dependencies = [{
      upstreamUnitId: unit.id, downstreamUnitId: peer.id,
      releaseCondition: "automated_testing_passed" as const, releasedAt: null
    }, {
      upstreamUnitId: peer.id, downstreamUnitId: unit.id,
      releaseCondition: "automated_testing_passed" as const, releasedAt: null
    }];
    const views = deliveryMatrixRowViews([unit, peer], dependencies);

    expect([...views.values()]).toHaveLength(2);
    for (const view of views.values()) expect(view).toMatchObject({
      dependencyLabel: "交付依赖数据异常",
      blocker: "交付依赖数据异常",
      nextAction: null
    });

    const markup = renderToStaticMarkup(React.createElement(DeliveryMatrix, {
      units: [unit, peer], dependencies, projects: []
    }));
    expect(renderedRoleQueries(markup).getAllByRole("cell")
      .filter((cell) => cell.name === "交付依赖数据异常")).toHaveLength(4);
  });

  it("marks every visible row invalid when a dependency has no known endpoint", () => {
    const peer = { ...unit, id: "unit-web", projectId: "web", projectVersionId: "web-v1" };
    const dependencies = [{
      upstreamUnitId: "unit-missing-upstream",
      downstreamUnitId: "unit-missing-downstream",
      releaseCondition: "automated_testing_passed" as const,
      releasedAt: null
    }];

    const views = deliveryMatrixRowViews([unit, peer], dependencies);

    for (const view of views.values()) expect(view).toMatchObject({
      dependencyLabel: "交付依赖数据异常",
      blocker: "交付依赖数据异常",
      nextAction: null
    });
  });

  it("keeps every row in a valid diamond dependency graph free of data errors", () => {
    const units = ["api", "web", "worker", "release"].map((projectId) => ({
      ...unit,
      id: `unit-${projectId}`,
      projectId,
      projectVersionId: `${projectId}-v1`
    }));
    const edge = (upstreamUnitId: string, downstreamUnitId: string) => ({
      upstreamUnitId,
      downstreamUnitId,
      releaseCondition: "automated_testing_passed" as const,
      releasedAt: null
    });
    const views = deliveryMatrixRowViews(units, [
      edge("unit-api", "unit-web"),
      edge("unit-api", "unit-worker"),
      edge("unit-web", "unit-release"),
      edge("unit-worker", "unit-release")
    ]);

    expect([...views.values()]).toHaveLength(4);
    for (const view of views.values()) {
      expect(view.dependencyLabel).not.toBe("交付依赖数据异常");
      expect(view.blocker).not.toBe("交付依赖数据异常");
    }
  });

  it("treats a release from an older upstream evidence version as pending", () => {
    const upstream = { ...unit, id: "unit-api", status: "ready_for_acceptance" as const,
      phase: "quality_verification" as const, evidenceVersion: 2 };
    const downstream = { ...unit, id: "unit-web", projectId: "web", projectVersionId: "web-v1",
      status: "failed" as const };
    const views = deliveryMatrixRowViews([upstream, downstream], [{
      upstreamUnitId: upstream.id, downstreamUnitId: downstream.id,
      releaseCondition: "automated_testing_passed", releasedByEvidenceVersion: 1,
      releasedAt: "2026-07-22T00:00:00.000Z"
    }]);

    expect(views.get(downstream.id)?.dependencyLabel).toBe("等待 unit-api 自动化测试");
  });
});

describe("DeliveryMatrix", () => {
  it("keeps legacy requirement evidence available only outside current delivery ownership", async () => {
    const module = await import("./requirement-detail.js");
    const shouldShowLegacyDeliveryEvidence = (module as any).shouldShowLegacyDeliveryEvidence;
    const RequirementLevelDeliveryEvidence = (module as any).RequirementLevelDeliveryEvidence;
    expect(shouldShowLegacyDeliveryEvidence).toBeTypeOf("function");
    expect(RequirementLevelDeliveryEvidence).toBeTypeOf("function");
    if (!shouldShowLegacyDeliveryEvidence || !RequirementLevelDeliveryEvidence) return;

    expect(shouldShowLegacyDeliveryEvidence("solution_design", "implementation")).toBe(true);
    expect(shouldShowLegacyDeliveryEvidence("implementation", "implementation")).toBe(false);
    expect(shouldShowLegacyDeliveryEvidence("solution_design", "solution_design")).toBe(false);
    const legacyItem = {
      stage: "solution_design", codingEvidence: { status: "valid", diffHash: "legacy-hash",
        fileCount: 1, additions: 2, deletions: 0, branch: "legacy", executionId: "legacy-execution",
        diff: "legacy diff" },
      executions: [{ status: "completed", branch: "legacy", worktreePath: "/tmp/legacy",
        diff: "legacy execution diff" }]
    };
    const legacyMarkup = renderToStaticMarkup(React.createElement(RequirementLevelDeliveryEvidence, {
      item: legacyItem, viewStage: "implementation"
    }));
    const deliveryMarkup = renderToStaticMarkup(React.createElement(RequirementLevelDeliveryEvidence, {
      item: { ...legacyItem, stage: "implementation" }, viewStage: "implementation"
    }));
    expect(legacyMarkup).toContain("legacy-hash");
    expect(legacyMarkup).toContain("独立 Codex 编码会话");
    expect(deliveryMarkup).not.toContain("legacy-hash");
    expect(deliveryMarkup).not.toContain("独立 Codex 编码会话");
  });

  it("does not render superseded requirement-level delivery evidence", () => {
    const supersededHash = "superseded-v1-hash";
    const markup = renderToStaticMarkup(React.createElement(RequirementDetail, {
      item: {
        id: "req-1", code: "REQ-001", title: "Delivery", businessProblem: "Deliver",
        expectedOutcome: "Done", priority: "medium", stage: "implementation", status: "ai_ready",
        createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z",
        artifacts: [], approvals: [], projects: [], deliveryDependencies: [],
        deliveryUnits: [{
          id: "unit-1", projectId: "project-1", projectVersionId: "version-1", required: true,
          phase: "implementation", status: "ready", evidenceVersion: 2,
          implementationEvidence: null, codeReviewEvidence: null, automatedTestingEvidence: null,
          blocker: null, dependencyReleases: [], automation: { status: "active" }, allowedActions: []
        }],
        automation: { status: "active", allowedActions: [] },
        codingEvidence: { status: "stale", diffHash: supersededHash, fileCount: 1,
          additions: 1, deletions: 0, branch: "old", executionId: "old-execution", diff: supersededHash },
        executions: [{ status: "completed", branch: "old", worktreePath: "/tmp/old", diff: supersededHash }]
      } as any,
      onRun: () => undefined, onViewRun: () => undefined, onEdit: () => undefined,
      onApprove: () => undefined, onRefresh: async () => undefined,
      onManageProjects: () => undefined, onDeliveryAction: async () => undefined
    }));

    expect(markup).not.toContain(supersededHash);
    expect(markup).not.toContain("独立 Codex 编码会话");
  });

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
    const screen = renderedRoleQueries(markup);

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
    expect(screen.getByRole("table", { name: "项目交付矩阵" })).toBeDefined();
    expect(screen.getAllByRole("columnheader").map((entry) => entry.name)).toEqual([
      "项目 / 版本", "依赖", "实现", "Code Review", "自动化测试", "应用", "Blocker", "下一步"
    ]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("cell", { name: /^Backend必需2\.4\.0/ })).toBeDefined();
  });

  it("renders only server-authorized unit actions and live evidence conclusions", () => {
    const markup = renderToStaticMarkup(React.createElement(DeliveryMatrix, {
      units: [{
        id: "unit-stale", projectId: "web", projectVersionId: "web-v1", required: true,
        phase: "quality_verification" as const, status: "potentially_stale" as const, evidenceVersion: 2,
        implementationEvidence: { id: "implementation-2", evidenceVersion: 2, diffHash: "abcdef",
          fileCount: 2, additions: 8, deletions: 1 },
        codeReviewEvidence: { id: "review-2", kind: "code_review" as const, result: "passed" as const,
          inputEvidenceVersion: 2 },
        automatedTestingEvidence: null,
        blocker: { code: "DELIVERY_EVIDENCE_POTENTIALLY_STALE", message: "上游证据已变化" },
        dependencyReleases: [], automation: { status: "active" as const },
        allowedActions: [{ type: "reuse_evidence" as const, reasonRequired: true },
          { type: "rerun" as const, reasonRequired: true }]
      }],
      dependencies: [], projects: [{ projectId: "web", projectName: "Web" }],
      onAction: async () => undefined
    }));

    expect(markup).toContain("2 个文件 · +8 / -1");
    expect(markup).toContain("已通过");
    expect(markup).toContain("等待证据");
    expect(markup).toContain("复用证据");
    expect(markup).toContain("重新执行");
    expect(markup).not.toContain("重试实现");
    expect(markup).not.toContain("跳过可选交付");
    expect(markup).not.toContain("只读");
  });

  it("renders an accessible reason dialog without dropping an action error", () => {
    const markup = renderToStaticMarkup(React.createElement(DeliveryActionDialog, {
      action: { type: "skip_optional" as const, label: "跳过可选交付", reasonRequired: true,
        unitId: "unit-docs" },
      busy: false, error: "DELIVERY_UNIT_SKIP_NOT_ELIGIBLE",
      onClose: () => undefined, onSubmit: async () => undefined
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-label="操作原因"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("DELIVERY_UNIT_SKIP_NOT_ELIGIBLE");
    expect(markup).toContain("确认跳过");
  });

  it("stacks the actual delivery row classes across the 901-937px gap and at 390px", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.delivery-row-grid\{[^}]*display:grid[^}]*grid-template-columns:/);
    expect(css).toMatch(/\.delivery-row-grid\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project,.delivery-field\{[^}]*min-width:0/);
    expect(css).toMatch(/\.delivery-project[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.delivery-field[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\[data-field="next-action"\]\{[^}]*max-width:100%/);
    const stackRule = css.match(/@media\(max-width:(\d+)px\)\{[^@]*\.delivery-matrix-header\{(?=[^}]*position:absolute)(?=[^}]*clip:)[^}]*\}[^@]*\.delivery-row-stack\{grid-template-columns:1fr/);
    expect(stackRule).not.toBeNull();
    expect(stackRule![0]).not.toContain("display:none");
    const stackBreakpoint = Number(stackRule![1]);
    expect(stackBreakpoint).toBeGreaterThanOrEqual(937);
    expect(390).toBeLessThanOrEqual(stackBreakpoint);
  });

  it("stacks from the named matrix container width while preserving the desktop grid", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.delivery-matrix\{(?=[^}]*container-name:delivery-matrix)(?=[^}]*container-type:inline-size)[^}]*\}/);
    expect(css).toMatch(/\.delivery-row-grid\{[^}]*display:grid[^}]*grid-template-columns:/);
    const containerRule = css.match(/@container delivery-matrix \(max-width:(\d+)px\)\{([\s\S]*?)(?=@media\(max-width:940px\))/);
    expect(containerRule).not.toBeNull();
    const containerBreakpoint = Number(containerRule![1]);
    expect(containerBreakpoint).toBeGreaterThanOrEqual(760);
    expect(containerBreakpoint).toBeLessThanOrEqual(800);
    expect(containerRule![2]).toMatch(/\.delivery-matrix-header\{(?=[^}]*position:absolute)(?=[^}]*clip:)[^}]*\}/);
    expect(containerRule![2]).toMatch(/\.delivery-row-stack\{grid-template-columns:1fr/);
    expect(containerRule![2]).toMatch(/\.delivery-field\{display:grid/);
  });

  it("defines one five-column desktop stats grid while retaining narrow layouts", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const desktopDeclarations = css.match(/\.stats\{[^}]*grid-template-columns:repeat\((?:4|5),minmax\(0,1fr\)\)/g) ?? [];
    const tabletRule = css.split("\n").find((line) => line.startsWith("@media(max-width:900px){") && line.includes(".stats{"));
    const mobileRule = css.split("\n").find((line) => line.startsWith("@media(max-width:620px){") && line.includes(".stats{"));

    expect(desktopDeclarations).toHaveLength(1);
    expect(desktopDeclarations[0]).toContain("repeat(5,minmax(0,1fr))");
    expect(tabletRule).toContain(".stats{grid-template-columns:repeat(2,1fr)}");
    expect(mobileRule).toContain(".stats{grid-template-columns:1fr 1fr;gap:8px}");
  });
});
