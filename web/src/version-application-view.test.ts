import { describe, expect, it } from "vitest";
import { requirementApplicationContext, versionApplicationView } from "./version-application-view.js";

describe("version application view", () => {
  const currentVersion = { projectId: "api", usage: "delivery", status: "active", projectVersionId: "current-version" };
  const frozenVersion = { projectId: "api", usage: "delivery", status: "active", projectVersionId: "frozen-version", projectVersionName: "2.2.1" };

  it("keeps a requirement without a snapshot on the legacy path when current projects have no version", () => {
    expect(requirementApplicationContext({ projects: [{ projectId: "api", usage: "delivery", status: "active" }] })).toEqual({ mode: "legacy", target: null });
  });

  it("keeps a requirement without a snapshot on the legacy path even when current projects have a version", () => {
    expect(requirementApplicationContext({ projects: [currentVersion] })).toEqual({ mode: "legacy", target: null });
  });

  it("uses only the active snapshot association as the frozen version target", () => {
    expect(requirementApplicationContext({ projectSnapshot: { associations: [frozenVersion] }, projects: [currentVersion] })).toEqual({ mode: "versioned", target: frozenVersion });
  });

  it("blocks requirements behind the queue owner and shows their position", () => {
    expect(versionApplicationView({ status: "awaiting_merge", queuePosition: 2, preflightAllowed: true })).toMatchObject({
      label: "队列第 2 位",
      canApply: false,
      showRecheck: false,
      queueLabel: "应用队列第 2 位"
    });
  });

  it("allows only the first queued requirement with a successful preflight", () => {
    expect(versionApplicationView({ status: "awaiting_merge", queuePosition: 1, preflightAllowed: true })).toMatchObject({
      label: "待应用",
      canApply: true,
      queueLabel: "应用队列第 1 位"
    });
  });

  it("renders the local-resolution state", () => {
    expect(versionApplicationView({ status: "awaiting_local_resolution", queuePosition: 1 })).toMatchObject({
      label: "等待本地提交或撤销",
      canApply: false,
      showRecheck: true
    });
  });

  it("renders the manual-resolution state", () => {
    expect(versionApplicationView({ status: "manual_resolution_required", queuePosition: 1 })).toMatchObject({
      label: "需要人工处理本地状态",
      canApply: false,
      showRecheck: true
    });
  });
});
