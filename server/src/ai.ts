import OpenAI from "openai";
import { aiArtifactSchema, productArtifactSchema, stageLabels, type WorkflowStage } from "@ai-workflow/shared";

export type AgentEventHandler = (type: string, payload: unknown) => void;

export function buildAgentPrompt(stage:WorkflowStage,context:unknown){
  if(stage==="prd")return `你是高自主产品经理 AI（策略 product-v1）。默认自主推进，不把普通问题转给人工。
先按顺序检索输入中的 projectContext.projects 项目知识块并保留项目边界，再区分事实、证据缺口、可逆假设和高风险阻塞决策。对可逆假设采用行业常规默认值并说明理由与验证方式；不得因普通实现细节要求人工决定。
只有权限、资金、合规、隐私、永久删除、不可逆兼容或互斥核心业务规则才写入 blockingQuestions。仅剩可逆假设时 conclusion 必须为 pass。
识别表面需求背后的业务目标，并从产品、用户、研发、测试四个视角自检。输出工程可执行的 MVP、非目标、主流程、异常流程和可观察验收标准。
只输出 JSON：conclusion、confidence、summary、facts、openQuestions、risks、findings、underlyingGoal、targetUsers、productDecisions[{decision,rationale,evidence(单个依据字符串)}]、assumptions[{assumption,rationale,validation,impactIfWrong}]、scope{mvp,nonGoals}、flows{primary,exceptions}、acceptanceCriteria、evidence[{source,fact}]、blockingQuestions[{question,impact,options}]。
findings 字段为 title、severity(S0/S1/S2/S3)、evidence、impact、recommendation、targetStage(${Object.keys(stageLabels).join("/")})。
输入：${JSON.stringify(context)}`;
  return `你是${stageLabels[stage]}执行 AI。基于输入生成结构化评审结果。严格区分事实、假设和待确认项。
只输出 JSON 对象，字段必须为：conclusion(pass/conditional/return)、confidence(0到1)、summary、facts(字符串数组)、assumptions(字符串数组)、openQuestions(字符串数组)、risks(字符串数组)、findings(数组)。
findings 每项字段为 title、severity(S0/S1/S2/S3)、evidence、impact、recommendation、targetStage(${Object.keys(stageLabels).join("/")})。
输入：${JSON.stringify(context)}`;
}

export async function runAgent(stage: WorkflowStage, context: unknown, onEvent: AgentEventHandler = () => {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("未配置 OPENAI_API_KEY");
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined
  });
  const prompt = buildAgentPrompt(stage,context);
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const mode = resolveApiMode(process.env.OPENAI_API_MODE);
  let outputText: string;
  onEvent("request.sent", { model, mode });
  if (mode === "chat") {
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      stream: true
    });
    outputText = "";
    let pending = "";
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta.content || "";
      if (text) {
        outputText += text; pending += text;
        if (pending.length >= 160 || pending.includes("\n")) { onEvent("output.delta", { text: pending }); pending = ""; }
      }
    }
    if (pending) onEvent("output.delta", { text: pending });
  } else {
    const response = await client.responses.create({
      model,
      input: prompt,
      text: { format: { type: "json_object" } }
    });
    outputText = response.output_text;
    if (outputText) onEvent("output.delta", { text: outputText });
  }
  if (!outputText) throw new Error("模型未返回可解析内容");
  const parsed = JSON.parse(outputText);
  const result = stage==="prd"?productArtifactSchema.parse(parsed):aiArtifactSchema.parse(parsed);
  onEvent("result.parsed", result);
  return result;
}

export function resolveApiMode(value: string | undefined): "responses" | "chat" {
  if (!value || value === "responses") return "responses";
  if (value === "chat") return "chat";
  throw new Error("OPENAI_API_MODE 仅支持 responses 或 chat");
}
