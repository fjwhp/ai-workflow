import { describe, expect, it } from "vitest";
import { buildAgentPrompt, resolveApiMode } from "./ai.js";

describe("resolveApiMode", () => {
  it("uses chat completions when configured for a compatible relay", () => {
    expect(resolveApiMode("chat")).toBe("chat");
  });
  it("defaults to the responses API", () => {
    expect(resolveApiMode(undefined)).toBe("responses");
  });
  it("rejects unsupported modes", () => {
    expect(() => resolveApiMode("auto")).toThrow("OPENAI_API_MODE");
  });
  it("builds a high-autonomy product role prompt",()=>{
    const prompt=buildAgentPrompt("prd",{projectKnowledge:{summary:"点餐平台",entries:[]}});
    expect(prompt).toContain("默认自主推进");expect(prompt).toContain("projectKnowledge");expect(prompt).toContain("可逆假设");expect(prompt).toContain("blockingQuestions");expect(prompt).toContain("不得因普通实现细节要求人工决定");
  });
  it("keeps non-product stages on the common artifact contract",()=>{const prompt=buildAgentPrompt("technical_design",{});expect(prompt).toContain("openQuestions");expect(prompt).not.toContain("blockingQuestions");});
  it("directs agents to consume structured multi-project blocks",()=>{const prompt=buildAgentPrompt("prd",{projectContext:{projects:[{projectId:"architecture",name:"Architecture"},{projectId:"orders",name:"Orders"}]}});expect(prompt).toContain("projectContext.projects");expect(prompt).toContain("Architecture");expect(prompt).toContain("Orders");});
});
