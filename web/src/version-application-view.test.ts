import { describe, expect, it } from "vitest";
import {
  initialVersionApplicationRequestState,
  requirementApplicationContext,
  versionApplicationRequestReducer,
  versionApplicationView
} from "./version-application-view.js";

describe("version application view", () => {
  const currentVersion = { projectId: "api", usage: "delivery", status: "active", projectVersionId: "current-version" };
  const frozenVersion = { projectId: "api", usage: "delivery", status: "active", projectVersionId: "frozen-version", projectVersionName: "2.2.1" };

  it("requires a frozen snapshot when current projects have no version", () => {
    expect(requirementApplicationContext({ projects: [{ projectId: "api", usage: "delivery", status: "active" }] })).toEqual({ mode: "versioned", target: null });
  });

  it("does not fall back to mutable projects when a snapshot is missing", () => {
    expect(requirementApplicationContext({ projects: [currentVersion] })).toEqual({ mode: "versioned", target: null });
  });

  it("uses only the active snapshot association as the frozen version target", () => {
    expect(requirementApplicationContext({ projectSnapshot: { associations: [frozenVersion] }, projects: [currentVersion] })).toEqual({ mode: "versioned", target: frozenVersion });
  });

  it("ignores stale queue and check success or error after the requirement identity changes", () => {
    const first = versionApplicationRequestReducer(initialVersionApplicationRequestState, { type: "start", generation: 1, identity: "REQ-1:v1:awaiting_merge" });
    const second = versionApplicationRequestReducer(first, { type: "start", generation: 2, identity: "REQ-2:v2:awaiting_merge" });
    expect(versionApplicationRequestReducer(second, { type: "patch", generation: 1, identity: "REQ-1:v1:awaiting_merge", patch: { queue: [{ requirementId: "REQ-1" }], check: { allowed: true }, loading: false } })).toBe(second);
    expect(versionApplicationRequestReducer(second, { type: "patch", generation: 1, identity: "REQ-1:v1:awaiting_merge", patch: { error: "old failure", loading: false } })).toBe(second);
    expect(versionApplicationRequestReducer(second, { type: "patch", generation: 2, identity: "REQ-2:v2:awaiting_merge", patch: { queue: [{ requirementId: "REQ-2" }], check: { allowed: false }, loading: false } })).toMatchObject({
      generation: 2, identity: "REQ-2:v2:awaiting_merge", queue: [{ requirementId: "REQ-2" }], check: { allowed: false }, error: "", loading: false
    });
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
