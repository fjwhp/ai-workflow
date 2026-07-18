import { describe, expect, it } from "vitest";
import { buildHumanOverrideEligibility, buildHumanOverrideSnapshot } from "./human-override.js";

describe("human override", () => {
  const artifact = { id: "artifact-1", content: { summary: "仍有风险", risks: ["权限边界待确认"], openQuestions: ["是否兼容旧数据"] } };

  it.each(["code_review", "testing"])("allows %s when its AI artifact exists", (stage) => {
    expect(buildHumanOverrideEligibility({ stage, status: "awaiting_approval", artifact })).toEqual({ allowed: true, reason: null });
  });

  it("rejects unsupported, running, and artifact-free states", () => {
    expect(buildHumanOverrideEligibility({ stage: "coding", status: "awaiting_approval", artifact }).allowed).toBe(false);
    expect(buildHumanOverrideEligibility({ stage: "code_review", status: "ai_running", artifact }).reason).toContain("处理中");
    expect(buildHumanOverrideEligibility({ stage: "testing", status: "returned", artifact: null }).reason).toContain("AI 成果");
  });

  it("builds an immutable audit snapshot from the latest artifact", () => {
    expect(buildHumanOverrideSnapshot({ stage: "code_review", comment: "  人工已核查权限  ", artifact, returnCount: 2 })).toEqual({
      artifactId: "artifact-1", comment: "人工已核查权限", returnCount: 2,
      risks: ["权限边界待确认"], openQuestions: ["是否兼容旧数据"], targetStage: "testing"
    });
  });

  it("requires a non-empty trimmed comment", () => {
    expect(() => buildHumanOverrideSnapshot({ stage: "testing", comment: "   ", artifact, returnCount: 0 })).toThrow("COMMENT_REQUIRED");
  });
});
