import { describe, expect, it } from "vitest";
import {
  deliveryActionSubmission,
  deliveryActionRequest,
  deliveryUnitView,
  type LiveDeliveryUnit
} from "./delivery-unit-view.js";

function unit(overrides: Partial<LiveDeliveryUnit> = {}): LiveDeliveryUnit {
  return {
    id: "unit-web", projectId: "web", projectVersionId: "web-v1", required: true,
    phase: "implementation", status: "potentially_stale", evidenceVersion: 2,
    implementationEvidence: null, codeReviewEvidence: null, automatedTestingEvidence: null,
    blocker: null, dependencyReleases: [], automation: { status: "active" }, allowedActions: [],
    ...overrides
  };
}

describe("deliveryUnitView", () => {
  it("maps evidence, blocker, and tone without inventing actions from a stale status", () => {
    const view = deliveryUnitView(unit({
      implementationEvidence: { id: "implementation-2", evidenceVersion: 2, diffHash: "abcdef1234567890",
        fileCount: 3, additions: 14, deletions: 2 },
      codeReviewEvidence: { id: "review-2", kind: "code_review", result: "failed", inputEvidenceVersion: 2 },
      automatedTestingEvidence: { id: "test-2", kind: "automated_testing", result: "passed", inputEvidenceVersion: 2 },
      blocker: { code: "DELIVERY_EVIDENCE_POTENTIALLY_STALE", message: "上游证据已变化" },
      allowedActions: []
    }));

    expect(view).toMatchObject({
      implementation: { label: "3 个文件 · +14 / -2", tone: "neutral" },
      review: { label: "未通过", tone: "danger" },
      testing: { label: "已通过", tone: "success" },
      blocker: "上游证据已变化", actions: []
    });
  });

  it("maps exactly the server whitelist even when status would normally allow no action", () => {
    const allowedActions = [{ type: "rerun", reasonRequired: true }] as const;
    const view = deliveryUnitView(unit({ status: "waiting_dependency", allowedActions }));

    expect(view.actions).toEqual([{ type: "rerun", label: "重新执行", reasonRequired: true }]);
  });

  it("keeps a paused unit actionless when the API sends no unit action", () => {
    expect(deliveryUnitView(unit({ automation: { status: "paused", actor: "local-human", reason: "检查中",
      updatedAt: "2026-07-22T00:00:00.000Z" }, allowedActions: [] }))).toMatchObject({
      automationLabel: "自动化已暂停 · 检查中", actions: []
    });
  });
});

describe("deliveryActionSubmission", () => {
  it("rejects a blank reason and trims a valid reason without losing the selected action", () => {
    const action = { type: "skip_optional", reasonRequired: true } as const;
    expect(deliveryActionSubmission(action, "  ")).toEqual({ ok: false, error: "请填写操作原因" });
    expect(deliveryActionSubmission(action, "  本版本不交付  ")).toEqual({
      ok: true, value: { type: "skip_optional", reason: "本版本不交付" }
    });
  });

  it.each([
    ["retry_code_review", "/delivery-units/unit-web/retry", { target: "code_review", reason: "manual retry" }],
    ["reuse_evidence", "/delivery-units/unit-web/stale-resolution", { decision: "reuse", reason: "manual retry" }],
    ["rerun", "/delivery-units/unit-web/stale-resolution", { decision: "rerun", reason: "manual retry" }],
    ["skip_optional", "/delivery-units/unit-web/skip", { reason: "manual retry" }],
    ["pause_automation", "/requirements/requirement-1/automation/pause", { reason: "manual retry" }],
    ["resume_automation", "/requirements/requirement-1/automation/resume", { reason: "manual retry" }]
  ] as const)("maps %s without adding a client actor", (type, path, body) => {
    expect(deliveryActionRequest("requirement-1", { type, unitId: type.includes("automation") ? undefined : "unit-web",
      reason: "manual retry" })).toEqual({ path, body });
  });
});
