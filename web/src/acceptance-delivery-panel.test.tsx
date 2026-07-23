import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AcceptanceDeliveryPanel,
  ApplicationRunsToggle,
  ApplicationRunsView,
  RetryApplicationDialog,
  acceptanceCommentSubmission,
  acceptanceDeliveryView,
  acceptanceErrorView,
  loadApplicationRuns,
  runValueKey,
  submitAcceptanceAction,
  submitRetryIfAllowed,
  toggleApplicationRuns,
  type ApplicationRunsState,
  type ApplicationRunsResponse
} from "./acceptance-delivery-panel.js";
import { acceptanceDeliveryRequest } from "./delivery-unit-view.js";
import { DeliveryMatrix, type DeliveryUnitView } from "./delivery-matrix.js";
import { RequirementAcceptanceDelivery, RequirementDetail } from "./requirement-detail.js";

const projects = [{
  projectId: "backend", projectName: "Backend", projectVersionId: "backend-v1",
  projectVersionName: "2.4.0", projectVersionBranch: "release/backend-with-a-long-name"
}, {
  projectId: "frontend", projectName: "Frontend", projectVersionId: "frontend-v1",
  projectVersionName: "3.1.0", projectVersionBranch: "release/frontend"
}];

const units: DeliveryUnitView[] = [{
  id: "unit-backend", projectId: "backend", projectVersionId: "backend-v1", required: true,
  phase: "acceptance_delivery" as const, status: "applied" as const, evidenceVersion: 2,
  allowedActions: []
}, {
  id: "unit-frontend", projectId: "frontend", projectVersionId: "frontend-v1", required: true,
  phase: "acceptance_delivery" as const, status: "conflicted" as const, evidenceVersion: 3,
  allowedActions: [{ type: "retry_application" as const, reasonRequired: true }]
}];

describe("acceptanceDeliveryView", () => {
  it("presents a partial application and derives actions only from server whitelists", () => {
    expect(acceptanceDeliveryView(units, [])).toMatchObject({
      status: "partially_applied",
      statusLabel: "部分应用",
      participatingCount: 2,
      appliedCount: 1,
      retryUnitId: "unit-frontend",
      canAccept: false
    });
  });

  it("allows pre-acceptance only when the requirement action is present", () => {
    const ready = units.map((unit) => ({ ...unit, status: "ready_for_acceptance" as const,
      allowedActions: [] }));
    expect(acceptanceDeliveryView(ready, [{ type: "accept_delivery", commentRequired: true }]))
      .toMatchObject({ status: "awaiting_acceptance", canAccept: true, retryUnitId: null });
    expect(acceptanceDeliveryView(ready, [])).toMatchObject({ canAccept: false });
  });
});

describe("AcceptanceDeliveryPanel", () => {
  const props = {
    requirementId: "requirement-1", units, projects, allowedActions: [] as const,
    onAccept: async () => undefined, onRetry: async () => undefined,
    onRefresh: async () => undefined, onRefreshError: () => undefined,
    onLoadRuns: async () => ({ runs: [], retries: [] })
  };

  it("renders applied rows without rollback and conflicted rows with the sole legal recovery action", () => {
    const markup = renderToStaticMarkup(<AcceptanceDeliveryPanel {...props}/>);
    const backend = markup.match(/data-acceptance-unit="unit-backend"[\s\S]*?<\/li>/)?.[0] ?? "";
    const frontend = markup.match(/data-acceptance-unit="unit-frontend"[\s\S]*?<\/li>/)?.[0] ?? "";

    expect(markup).toContain("部分应用");
    expect(markup).toContain("已应用 1 / 2");
    expect(backend).toContain("已应用");
    expect(backend).not.toMatch(/回滚|重试应用/);
    expect(frontend).toContain("存在冲突");
    expect(frontend).toContain("重试应用");
    expect(frontend.match(/<button/g)).toHaveLength(2);
    expect(markup).not.toContain("回滚");
  });

  it("renders an explicitly required acceptance comment and fixed-size busy control", () => {
    const ready = units.map((unit) => ({ ...unit, status: "ready_for_acceptance" as const,
      allowedActions: [] }));
    const markup = renderToStaticMarkup(<AcceptanceDeliveryPanel {...props} units={ready}
      allowedActions={[{ type: "accept_delivery", commentRequired: true }]}/>);

    expect(markup).toContain('aria-label="验收意见"');
    expect(markup).toContain("required");
    expect(markup).toContain("确认验收");
    expect(acceptanceCommentSubmission("  ")).toEqual({ ok: false, error: "请填写验收意见" });
    expect(acceptanceCommentSubmission("  已核对业务结果  ")).toEqual({
      ok: true, value: { comment: "已核对业务结果" }
    });
  });

  it("exposes stable mobile structure for a 390px stacked identity, evidence, status, and action", () => {
    const markup = renderToStaticMarkup(<AcceptanceDeliveryPanel {...props}/>);
    const css = readFileSync(new URL("./associations.css", import.meta.url), "utf8");

    expect(markup).toContain('class="acceptance-unit-identity"');
    expect(markup).toContain('data-acceptance-field="evidence"');
    expect(markup).toContain('data-acceptance-field="status"');
    expect(markup).toContain('data-acceptance-field="actions"');
    expect(css).toMatch(/@media\(max-width:620px\)[^{]*\{[\s\S]*?\.acceptance-unit-row\{[^}]*grid-template-columns:1fr/);
    expect(css).toMatch(/@media\(max-width:620px\)[^{]*\{[\s\S]*?\.acceptance-unit-actions button\{[^}]*width:100%/);
  });

  it("closes a stale retry dialog and refuses submission after the live whitelist is revoked", async () => {
    const dialogProps = {
      retryUnitId: "unit-frontend", busy: false, error: "",
      onClose: () => undefined, onSubmit: async () => undefined
    };
    const authorized = renderToStaticMarkup(<RetryApplicationDialog {...dialogProps} units={units}/>);
    const revokedUnits = units.map((unit) => ({ ...unit, allowedActions: [] }));
    const revoked = renderToStaticMarkup(<RetryApplicationDialog {...dialogProps} units={revokedUnits}/>);
    const onRetry = vi.fn(async () => undefined);

    expect(authorized).toContain('role="alertdialog"');
    expect(authorized).toContain("重试应用");
    expect(revoked).toBe("");
    expect(await submitRetryIfAllowed(revokedUnits, "unit-frontend", "conflict fixed", onRetry))
      .toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("acceptance delivery integration", () => {
  it("keeps historical delivery tabs read-only while preserving current acceptance actions", () => {
    const onRetry = vi.fn(async () => undefined);
    const props = {
      item: { id: "requirement-1", stage: "acceptance_delivery" as const,
        deliveryUnits: units, allowedActions: [{ type: "accept_delivery" as const,
          commentRequired: true as const }] },
      projects, onAcceptDelivery: async () => undefined, onApplicationRetry: onRetry,
      onRefresh: async () => undefined, onDeliveryRefreshError: () => undefined,
      onLoadApplicationRuns: async () => ({ runs: [], retries: [] })
    };
    const current = renderToStaticMarkup(<RequirementAcceptanceDelivery {...props}
      viewStage="acceptance_delivery"/>);
    const historicalImplementation = renderToStaticMarkup(<RequirementAcceptanceDelivery {...props}
      viewStage="implementation"/>);
    const historicalQuality = renderToStaticMarkup(<RequirementAcceptanceDelivery {...props}
      viewStage="quality_verification"/>);

    expect(current).toContain("确认验收");
    expect(current).toContain("重试应用");
    for (const historical of [historicalImplementation, historicalQuality]) {
      expect(historical).toBe("");
      expect(historical).not.toMatch(/确认验收|重试应用/);
    }
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders the unframed acceptance section before the delivery matrix in requirement detail", () => {
    const markup = renderToStaticMarkup(<RequirementDetail item={{
      id: "requirement-1", code: "REQ-1", title: "Acceptance", businessProblem: "Apply safely",
      expectedOutcome: "All projects applied", priority: "high", stage: "acceptance_delivery",
      status: "awaiting_approval", createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z", artifacts: [], approvals: [],
      projects: projects.map((project) => ({ ...project, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 })),
      deliveryUnits: units, deliveryDependencies: [],
      allowedActions: []
    } as any} onRun={() => undefined} onViewRun={() => undefined} onEdit={() => undefined}
      onApprove={() => undefined} onRefresh={async () => undefined} onManageProjects={() => undefined}
      onAcceptDelivery={async () => undefined} onApplicationRetry={async () => undefined}
      onLoadApplicationRuns={async () => ({ runs: [], retries: [] })}/>);

    expect(markup).toContain("验收与应用");
    expect(markup.indexOf("验收与应用")).toBeLessThan(markup.indexOf("项目交付矩阵"));
    expect(markup).toContain('class="acceptance-delivery"');
    expect(markup).not.toContain('class="section acceptance-delivery"');
  });

  it("keeps retry_application in the acceptance panel instead of duplicating it in the matrix", () => {
    const markup = renderToStaticMarkup(<DeliveryMatrix units={units} dependencies={[]} projects={projects}
      onAction={async () => undefined}/>);
    expect(markup).not.toContain("重试应用");
    expect(markup).not.toContain("retry_application");
  });

  it("wires main through actor-free request mappings and the lazy runs GET", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(source).toContain("onAcceptDelivery=");
    expect(source).toContain("onApplicationRetry=");
    expect(source).toContain("onLoadApplicationRuns=");
    expect(source).toContain("acceptanceDeliveryRequest(selected.id");
    expect(source).toContain("`/delivery-units/${unitId}/application-runs`");
    expect(source).not.toMatch(/onAcceptDelivery=[\s\S]{0,300}actor/);
    expect(source).not.toMatch(/onApplicationRetry=[\s\S]{0,300}actor/);
  });
});

describe("acceptance delivery mutations", () => {
  it.each([
    [{ status: 400, code: "VALIDATION_ERROR", message: "VALIDATION_ERROR" }, "输入内容无效，请检查后重试"],
    [{ status: 404, code: "NOT_FOUND", message: "NOT_FOUND" }, "记录不存在或已变化，请刷新后重试"],
    [{ status: 500, code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" }, "服务暂时不可用，请稍后重试"],
    [{ status: 418, code: "UNKNOWN_API_CODE", message: "UNKNOWN_API_CODE" }, "操作失败，请重试"]
  ])("maps API error %s to a stable user-facing message", (error, expected) => {
    expect(acceptanceErrorView(error)).toBe(expected);
    expect(acceptanceErrorView(new Error(error.message))).toBe("操作失败，请重试");
  });

  it.each([
    [new TypeError("Failed to fetch"), "网络连接失败，请检查网络后重试"],
    [new TypeError("NetworkError when attempting to fetch resource."), "网络连接失败，请检查网络后重试"],
    [new Error("/Users/alice/private/worktree failed"), "操作失败，请重试"],
    [new Error("git status failed with exit 128"), "操作失败，请重试"],
    [new Error("网络连接已中断，请稍后重试"), "操作失败，请重试"],
    ["VALIDATION_ERROR", "操作失败，请重试"]
  ])("maps non-API error %s without exposing internal details", (error, expected) => {
    expect(acceptanceErrorView(error)).toBe(expected);
  });

  it.each([
    ["accept", acceptanceDeliveryRequest("requirement-1", { type: "accept_delivery", comment: "checked" }),
      { path: "/requirements/requirement-1/accept-delivery", body: { comment: "checked" } }],
    ["retry", acceptanceDeliveryRequest("requirement-1", {
      type: "retry_application", unitId: "unit-frontend", reason: "conflict resolved"
    }), { path: "/delivery-units/unit-frontend/application/retry", body: { reason: "conflict resolved" } }]
  ])("maps %s without a client actor", (_case, actual, expected) => {
    expect(actual).toEqual(expected);
    expect(actual.body).not.toHaveProperty("actor");
  });

  it("blocks a duplicate while busy and refreshes exactly once after success", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const busy = { current: false };
    const mutate = vi.fn(async () => pending);
    const refresh = vi.fn(async () => undefined);
    const setBusy = vi.fn();
    const first = submitAcceptanceAction({ busy, mutate, refresh, setBusy,
      onMutationSuccess: vi.fn(), onRefreshError: vi.fn(), onConflict: vi.fn() });
    const duplicate = await submitAcceptanceAction({ busy, mutate, refresh, setBusy,
      onMutationSuccess: vi.fn(), onRefreshError: vi.fn(), onConflict: vi.fn() });
    release();
    await first;

    expect(duplicate).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("settles the mutation and reports a refresh failure through the existing warning channel", async () => {
    const events: string[] = [];
    await submitAcceptanceAction({ busy: { current: false }, setBusy: () => undefined,
      mutate: async () => { events.push("mutation"); }, onMutationSuccess: () => events.push("success"),
      refresh: async () => { events.push("refresh"); throw new Error("offline"); },
      onRefreshError: () => events.push("refresh-warning"), onConflict: () => undefined });
    expect(events).toEqual(["mutation", "success", "refresh", "refresh-warning"]);
  });

  it("announces a refreshed conflict only after refresh succeeds without settling the mutation", async () => {
    const events: string[] = [];
    const onMutationSuccess = vi.fn();
    const onConflict = vi.fn((message: string) => events.push(message));
    const refresh = vi.fn(async () => { events.push("refresh"); });
    const result = await submitAcceptanceAction({ busy: { current: false }, setBusy: () => undefined,
      mutate: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); },
      onMutationSuccess, refresh, onRefreshError: vi.fn(), onConflict });
    expect(result).toBe(false);
    expect(onConflict).toHaveBeenCalledWith("交付状态已变化，已刷新最新状态");
    expect(events).toEqual(["refresh", "交付状态已变化，已刷新最新状态"]);
    expect(onMutationSuccess).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports the refresh failure truthfully after a conflict and uses the refresh warning channel", async () => {
    const onConflict = vi.fn();
    const onRefreshError = vi.fn();
    const refreshError = new Error("offline");
    const result = await submitAcceptanceAction({ busy: { current: false }, setBusy: () => undefined,
      mutate: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); },
      onMutationSuccess: vi.fn(), refresh: async () => { throw refreshError; },
      onRefreshError, onConflict });

    expect(result).toBe(false);
    expect(onConflict).toHaveBeenCalledWith("交付状态已变化，但刷新失败，请重新打开需求");
    expect(onRefreshError).toHaveBeenCalledWith(refreshError);
  });

  it("uses a neutral global refresh failure message", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(source).toContain('onDeliveryRefreshError={() => setError("数据刷新失败，请重新打开需求")}');
    expect(source).not.toContain("操作已成功，但刷新失败，请重新打开需求");
  });
});

describe("ApplicationRunsView", () => {
  it("keys repeated compact values by field identity and position instead of raw commit text", () => {
    const repeatedCommit = "a".repeat(40);
    const keys = [repeatedCommit, repeatedCommit].map((_value, index) => runValueKey("提交", index));
    expect(keys).toEqual(["提交-0", "提交-1"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("collapses loaded and error disclosures, then reloads only after returning to idle", async () => {
    const request = vi.fn(async () => ({ runs: [], retries: [] }));
    const loading = new Set<string>();
    let state: ApplicationRunsState = { state: "loaded", data: { runs: [], retries: [] } };
    const setState = (next: ApplicationRunsState) => { state = next; };

    expect(await toggleApplicationRuns("unit-frontend", state, loading, request, setState)).toBe(true);
    expect(state).toEqual({ state: "idle" });
    expect(request).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<ApplicationRunsView state={state}/>)).toBe("");

    expect(await toggleApplicationRuns("unit-frontend", state, loading, request, setState)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.state).toBe("loaded");

    state = { state: "error", error: "记录不存在" };
    expect(await toggleApplicationRuns("unit-frontend", state, loading, request, setState)).toBe(true);
    expect(state).toEqual({ state: "idle" });
  });

  it("renders accurate disclosure ARIA, labels, and Lucide direction icons", () => {
    const idle = renderToStaticMarkup(<ApplicationRunsToggle id="runs-unit" state={{ state: "idle" }}
      onToggle={() => undefined}/>);
    const loaded = renderToStaticMarkup(<ApplicationRunsToggle id="runs-unit"
      state={{ state: "loaded", data: { runs: [], retries: [] } }} onToggle={() => undefined}/>);
    const error = renderToStaticMarkup(<ApplicationRunsToggle id="runs-unit"
      state={{ state: "error", error: "offline" }} onToggle={() => undefined}/>);

    expect(idle).toContain('aria-expanded="false"');
    expect(idle).toContain('aria-controls="runs-unit"');
    expect(idle).toContain("lucide-chevron-down");
    expect(idle).toContain("应用记录");
    for (const open of [loaded, error]) {
      expect(open).toContain('aria-expanded="true"');
      expect(open).toContain("lucide-chevron-up");
      expect(open).toContain("收起记录");
    }
  });

  it("keeps an in-flight disclosure load guarded against duplicate toggles", async () => {
    const request = vi.fn(async () => ({ runs: [], retries: [] }));
    const loading = new Set(["unit-frontend"]);
    const setState = vi.fn();
    const result = await toggleApplicationRuns("unit-frontend", { state: "loading" }, loading,
      request, setState);
    expect(result).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("uses the shared friendly error mapper for application-runs failures", async () => {
    const states: ApplicationRunsState[] = [];
    await loadApplicationRuns("unit-frontend", new Set(), async () => {
      throw { status: 404, code: "NOT_FOUND", message: "NOT_FOUND" };
    }, (state) => states.push(state));

    expect(states.at(-1)).toEqual({ state: "error", error: "记录不存在或已变化，请刷新后重试" });
  });

  it("blocks duplicate lazy loads until the current application-runs request settles", async () => {
    let release!: (value: ApplicationRunsResponse) => void;
    const pending = new Promise<ApplicationRunsResponse>((resolve) => { release = resolve; });
    const loading = new Set<string>();
    const request = vi.fn(async () => pending);
    const states: string[] = [];
    const first = loadApplicationRuns("unit-frontend", loading, request, (state) => states.push(state.state));
    const duplicate = await loadApplicationRuns("unit-frontend", loading, request,
      (state) => states.push(state.state));
    release({ runs: [], retries: [] });
    await first;

    expect(duplicate).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["loading", "loaded"]);
    expect(loading.size).toBe(0);
  });

  it.each([
    [{ state: "loading" as const }, "正在读取应用记录"],
    [{ state: "loaded" as const, data: { runs: [], retries: [] } }, "暂无应用记录"],
    [{ state: "error" as const, error: "记录暂时不可用" }, "记录暂时不可用"]
  ])("renders the %s state", (state, label) => {
    expect(renderToStaticMarkup(<ApplicationRunsView state={state}/>)).toContain(label);
  });

  it("renders only approved audit fields and drops unexpected path and fencing fields", () => {
    const data = { runs: [{
      id: "run-1", deliveryUnitId: "unit-frontend", projectVersionId: "frontend-v1",
      evidenceVersion: 3, automationAttempt: 2, sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40), preApplyCommit: "c".repeat(40), evidenceHash: "d".repeat(64),
      preflight: { allowed: true, checks: [{ label: "Target identity", ok: true }] },
      commandResults: [{ command: "npm", args: ["test"], code: 0, stdout: "42 tests" }],
      conflictFiles: ["src/conflict.ts"], error: "APPLICATION_CONFLICT",
      status: "conflicted", resolutionStatus: "reverted",
      createdAt: "2026-07-23T01:00:00.000Z", updatedAt: "2026-07-23T01:01:00.000Z",
      completedAt: "2026-07-23T01:01:00.000Z", resolvedAt: "2026-07-23T01:02:00.000Z",
      worktreePath: "/private/target", fencingToken: "secret-fence"
    }], retries: [{ attempt: 2, reason: "conflict resolved", createdAt: "2026-07-23T01:03:00.000Z" }]
    } as unknown as ApplicationRunsResponse;
    const markup = renderToStaticMarkup(<ApplicationRunsView state={{ state: "loaded", data }}/>);

    for (const visible of ["尝试 2", "conflicted", "reverted", "Target identity", "npm test",
      "src/conflict.ts", "APPLICATION_CONFLICT", "conflict resolved", "aaaaaaaaaaaa"]) {
      expect(markup).toContain(visible);
    }
    expect(markup).not.toContain("/private/target");
    expect(markup).not.toContain("secret-fence");
  });
});
