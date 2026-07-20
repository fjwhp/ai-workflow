import { isRequirementAiStage, type RequirementAiStage, type WorkflowStage } from "./domain.js";

export type GateDecision = "auto_approve" | "auto_return" | "human_review";
export const configurableMandatoryHumanStages = ["definition"] as const satisfies readonly WorkflowStage[];
export type ConfigurableMandatoryHumanStage = typeof configurableMandatoryHumanStages[number];
export type GateConfig = { autoTransitionEnabled: boolean; confidenceThreshold: number; mandatoryHumanStages: ConfigurableMandatoryHumanStage[] };
export type GateResult = { decision: GateDecision; reasons: string[] };

export const defaultGateConfig: GateConfig = {
  autoTransitionEnabled: true,
  confidenceThreshold: 0.85,
  mandatoryHumanStages: []
};

export function evaluateGate(stage: RequirementAiStage, artifact: any, config: GateConfig): GateResult {
  if (!isRequirementAiStage(stage)) throw new Error("REQUIREMENT_AI_STAGE_UNSUPPORTED");
  // Overall acceptance is a separate server workflow; acceptance_delivery is only a delivery-unit phase.
  if (stage === "solution_design") return { decision: "human_review", reasons: ["solution_design 是不可配置的人工阶段"] };
  if (!config.autoTransitionEnabled) return { decision: "human_review", reasons: ["自动流转已关闭"] };
  if (stage === "definition" && config.mandatoryHumanStages.includes(stage)) return { decision: "human_review", reasons: [`${stage} 是强制人工阶段`] };
  const findings = Array.isArray(artifact?.findings) ? artifact.findings : [];
  const s0 = findings.filter((finding: any) => finding?.severity === "S0").length;
  if (artifact?.conclusion === "return") return { decision: "auto_return", reasons: ["AI 结论要求退回"] };
  if (s0) return { decision: "auto_return", reasons: [`存在 ${s0} 个 S0 发现`] };
  const reasons: string[] = [];
  if (artifact?.conclusion === "conditional") reasons.push("AI 结论为条件通过");
  if (artifact?.conclusion !== "pass" && artifact?.conclusion !== "conditional") reasons.push("AI 结论不是明确通过");
  if (typeof artifact?.confidence !== "number" || artifact.confidence < config.confidenceThreshold) reasons.push(`置信度 ${artifact?.confidence ?? "缺失"}，低于阈值 ${config.confidenceThreshold}`);
  const s1 = findings.filter((finding: any) => finding?.severity === "S1").length;
  if (s1) reasons.push(`存在 ${s1} 个 S1 发现`);
  const risks = Array.isArray(artifact?.risks) ? artifact.risks.length : 0;
  if (risks) reasons.push(`存在 ${risks} 项风险`);
  if (stage === "definition") {
    const blockers = Array.isArray(artifact?.blockingQuestions) ? artifact.blockingQuestions.length : 0;
    if (blockers) reasons.push(`存在 ${blockers} 个高风险阻塞问题`);
  } else {
    const questions = Array.isArray(artifact?.openQuestions) ? artifact.openQuestions.length : 0;
    if (questions) reasons.push(`存在 ${questions} 个待确认问题`);
  }
  return reasons.length ? { decision: "human_review", reasons } : { decision: "auto_approve", reasons: ["结论明确、置信度达标且无关键风险"] };
}
