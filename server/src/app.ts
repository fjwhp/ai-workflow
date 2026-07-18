import Fastify from "fastify";
import cors from "@fastify/cors";
import { approvalInputSchema, evaluateGate, projectInputSchema, projectUpdateSchema, requirementInputSchema, requirementProjectsInputSchema, returnStage, workflowStages } from "@ai-workflow/shared";
import { WorkflowStore } from "./store.js";
import { runAgent } from "./ai.js";
import { getLocalBranches, isProtectedBranch } from "./repository.js";
import { createBackup } from "./backup.js";
import { runCodexCoding } from "./codex-runner.js";
import { redactSensitive } from "./redaction.js";
import { buildCodingEvidence, hashDiff } from "./coding-evidence.js";
import { getWorktreeSnapshot } from "./repository.js";
import { buildReworkContext } from "./rework-context.js";
import { buildHumanOverrideEligibility } from "./human-override.js";
import { executeLocalIntegration, preflightLocalIntegration, rerunIntegrationTests } from "./integration.js";
import { ensureProjectKnowledge } from "./knowledge-service.js";
import { getRepositoryHead } from "./project-knowledge.js";
import { buildVerificationPlan } from "./verification-plan.js";
import { publishRequirementKnowledge, refreshRequirementKnowledge } from "./project-memory-service.js";
import { inspectProjectRepository } from "./project-service.js";
import { hasMaterialAssociationChange, resolveSoleDeliveryProject } from "./requirement-projects.js";
import { buildRequirementProjectContext, ProjectContextError } from "./project-context.js";

const requirementRevisionSchema = requirementInputSchema.extend({
  clarifications: requirementInputSchema.shape.businessProblem,
  changeSummary: requirementInputSchema.shape.expectedOutcome.optional()
});

export async function buildApp(store: WorkflowStore) {
  const app = Fastify({ logger: true });
  for(const item of store.listRequirements())if(item.status==="completed"&&item.projectId&&!store.getKnowledgeChangeSet(item.id).id){try{publishRequirementKnowledge(store,item.id)}catch{/* Existing completed data remains usable if backfill fails. */}}
  await app.register(cors, { origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
  app.get("/api/health", async () => ({
    ok: true,
    openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    apiMode: process.env.OPENAI_API_MODE || "responses",
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    codingModel: process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL || "gpt-5.5"
  }));
  app.get("/api/requirements", async () => store.listRequirements());
  app.post("/api/requirements", async (req, reply) => {
    const parsed = requirementInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    try{return reply.code(201).send(store.createRequirement(parsed.data));}catch(error){return sendDomainError(reply,error);}
  });
  app.get("/api/requirements/:id", async (req: any, reply) => {
    const item = store.getRequirement(req.params.id);
    if (!item) return reply.code(404).send({ error: "NOT_FOUND" });
    const codingEvidence: any = store.getLatestCodingEvidence(item.id);
    if (codingEvidence) {
      try { codingEvidence.status = hashDiff((await getWorktreeSnapshot(codingEvidence.worktreePath)).diff) === codingEvidence.diffHash ? (codingEvidence.truncated ? "truncated" : "valid") : "stale"; }
      catch { codingEvidence.status = "unverifiable"; }
    }
    const artifacts=store.listArtifacts(item.id),approvals=store.listApprovals(item.id);
    let reworkContext:any=store.getLatestReworkContext(item.id);
    if(!reworkContext){
      const approval:any=approvals.find((entry:any)=>entry.decision==="return");
      if(approval){const artifact=artifacts.find((entry:any)=>entry.stage===approval.stage);reworkContext={id:`legacy-${approval.id}`,...buildReworkContext({approval,artifact})};}
    }
    const overrideArtifact=artifacts.find((entry:any)=>entry.stage===item.stage);
    const overrideEligibility=buildHumanOverrideEligibility({stage:item.stage,status:item.status,artifact:overrideArtifact});
    const humanOverride={visible:["code_review","testing"].includes(item.stage),...overrideEligibility,
      targetStage:item.stage==="code_review"?"testing":item.stage==="testing"?"acceptance":null,
      returnCount:approvals.filter((entry:any)=>entry.stage===item.stage&&entry.decision==="return").length};
    return { ...item, artifacts, approvals, executions: store.listExecutions(item.id), revisions: store.listRequirementRevisions(item.id), runs: store.listStageRuns(item.id), codingEvidence, reworkContext, humanOverride, integrationRun:store.getLatestIntegrationRun(item.id),knowledgeChanges:store.getKnowledgeChangeSet(item.id) };
  });
  app.patch("/api/requirements/:id", async (req: any, reply) => {
    const input = requirementRevisionSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: "VALIDATION_ERROR", issues: input.error.issues });
    const item = store.reviseRequirement(req.params.id, input.data);
    if (!item) return reply.code(409).send({ error: "REQUIREMENT_NOT_EDITABLE", message: "只有草稿、已打回或已阻塞的需求可以纠正" });
    return item;
  });
  app.patch("/api/requirements/:id/project", async (req: any, reply) => {
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : null;
    if (!store.getRequirement(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!projectId) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "必须选择项目" });
    try {
      return applyRequirementProjects(store,req.params.id,[{projectId,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]);
    } catch (error) { return sendDomainError(reply,error); }
  });
  app.get("/api/requirements/:id/projects",async(req:any,reply)=>{
    if(!store.getRequirement(req.params.id))return reply.code(404).send({error:"NOT_FOUND"});
    return {projects:store.listRequirementProjects(req.params.id),snapshot:store.getRequirementProjectSnapshot(req.params.id),snapshots:store.listRequirementProjectSnapshots(req.params.id)};
  });
  app.put("/api/requirements/:id/projects",async(req:any,reply)=>{
    if(!store.getRequirement(req.params.id))return reply.code(404).send({error:"NOT_FOUND"});
    const parsed=requirementProjectsInputSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"VALIDATION_ERROR",issues:parsed.error.issues});
    try{
      return applyRequirementProjects(store,req.params.id,parsed.data);
    }catch(error){return sendDomainError(reply,error);}
  });
  app.post("/api/requirements/:id/run", async (req: any, reply) => {
    const item = store.getRequirement(req.params.id);
    if (!item) return reply.code(404).send({ error: "NOT_FOUND" });
    let deliveryProject:any;try{deliveryProject=resolveSoleDeliveryProject(item.projects);}catch(error){return sendDomainError(reply,error);}
    if(deliveryProject?.projectStatus==="archived")return reply.code(409).send({error:"PROJECT_ARCHIVED",message:"归档项目不能启动新执行"});
    if(item.stage==="integration")return reply.code(409).send({error:"INTEGRATION_REQUIRES_MANUAL_ACTION",message:"代码应用节点不会启动 AI，请执行应用预检"});
    const existing = store.listStageRuns(item.id, item.stage).find((run: any) => run.status === "running");
    if (existing) return reply.code(409).send({ error: "RUN_ALREADY_ACTIVE", message: "当前阶段已有 AI 正在执行" });
    const project = deliveryProject ? store.getProject(deliveryProject.projectId) : null;
    const reworkContext=item.status==="returned"?store.getLatestReworkContext(item.id):null;
    let projectContext:any=undefined;
    if(["prd","requirement_review","technical_design","coding","code_review","testing","acceptance"].includes(item.stage)){
      try{projectContext=await buildRequirementProjectContext(store,item.id,item.stage);}
      catch(error){return sendProjectContextError(reply,error);}
    }
    const context = { requirement: item, priorArtifacts: store.listArtifacts(item.id), approvalHistory: store.listApprovals(item.id), projectContext, reworkRequired:Boolean(reworkContext), reworkContext, userContext: req.body?.context };
    const model = item.stage === "coding" ? (process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL || "gpt-5.5") : (process.env.OPENAI_MODEL || "gpt-5.5");
    const run = store.createStageRun({ requirementId: item.id, stage: item.stage, model, input: redactSensitive(context, project?.sensitivePatterns || []) });
    for(const block of projectContext?.projects??[])store.appendStageRunEvent(run.id,"knowledge.retrieved",{projectId:block.projectId,version:block.version,sourceHead:block.sourceHead,paths:block.entries.map((entry:any)=>entry.path),totalAvailable:block.totalAvailable,truncated:block.truncated});
    store.updateRequirementState(item.id, item.stage, "ai_running");
    void executeRun(run.id, item, context, project);
    return reply.code(202).send(run);

    async function executeRun(runId: string, runItem: any, runContext: any, runProject: any) {
      const emit = (type: string, payload: unknown) => store.appendStageRunEvent(runId, type, redactSensitive(payload, runProject?.sensitivePatterns || []));
    try {
      if (runItem.stage === "coding") {
        if (!runItem.projectId) throw new Error("编码阶段必须先关联本地项目");
        if (!runProject) throw new Error("关联项目不存在");
        const projectContext = runContext.projectContext?.projects?.[0];
        if (!projectContext) throw new Error("编码阶段缺少交付项目上下文");
        const coding = await runCodexCoding({ requirement: runItem, artifacts: store.listArtifacts(runItem.id), project: runProject, projectContext, reworkContext: runContext.reworkContext, onEvent: emit });
        const conclusion = coding.diff ? "pass" : "return";
        const execution = store.addExecution({ requirementId: runItem.id, stage: runItem.stage, projectId: runProject.id, branch: coding.branch, worktreePath: coding.worktreePath, status: conclusion === "pass" ? "completed" : "needs_review", commands: [], diff: coding.diff, codexThreadId: coding.codexThreadId, events: coding.events, diagnostics: coding.diagnostics.join("\n"), completedAt: new Date().toISOString() });
        const snapshot = buildCodingEvidence({ diff: coding.diff, files: coding.files, additions: coding.additions, deletions: coding.deletions });
        const evidence = store.addCodingEvidence({ ...snapshot, executionId: execution.id, requirementId: runItem.id, projectId: runProject.id,
          branch: coding.branch, worktreePath: coding.worktreePath, diagnostics: coding.diagnostics.join("\n") });
        const content = {
          conclusion, confidence: coding.diff ? 0.88 : 0.4, summary: coding.summary,
          facts: [`Codex 会话：${coding.codexThreadId}`, `分支：${coding.branch}`, `worktree：${coding.worktreePath}`, `变更字符数：${coding.diff.length}`],
          assumptions: [], openQuestions: [], risks: coding.diff ? [] : ["Codex 未产生文件差异"], findings: [],
          evidenceId: evidence.id, evidenceExecutionId: execution.id, evidenceDiffHash: evidence.diffHash
        };
        const artifact = store.addArtifact(runItem.id, runItem.stage, "coding AI 成果", content);
        const gate = evaluateGate(runItem.stage, content, store.getGateConfig());
        emit("gate.decided", gate);
        store.applyGateDecision({ requirementId: runItem.id, stage: runItem.stage, artifactId: artifact.id, ...gate });
        refreshRequirementKnowledge(store,runItem.id);
        store.completeStageRun(runId, redactSensitive(content));
        return;
      }
      let evidence: any = null;
      let evidenceStatus = "not_required";
      const needsEvidence = ["code_review", "testing", "acceptance"].includes(runItem.stage);
      if (needsEvidence) {
        evidence = store.getLatestCodingEvidence(runItem.id);
        if (!evidence) evidenceStatus = "missing";
        else {
          try { evidenceStatus = hashDiff((await getWorktreeSnapshot(evidence.worktreePath)).diff) === evidence.diffHash ? (evidence.truncated ? "truncated" : "valid") : "stale"; }
          catch { evidenceStatus = "unverifiable"; }
        }
      }
      const result = needsEvidence && !["valid", "truncated"].includes(evidenceStatus)
        ? { conclusion: "conditional", confidence: 0, summary: `编码证据状态为 ${evidenceStatus}，无法自动执行${stageLabel(runItem.stage)}。`, facts: [], assumptions: [], openQuestions: ["请重新执行编码自测生成有效证据"], risks: ["缺少可验证的真实代码证据"], findings: [] }
        : await runAgent(runItem.stage, { ...runContext, codingEvidence: evidence ? { ...evidence, status: evidenceStatus } : undefined }, emit);
      const content = evidence ? { ...result, evidenceId: evidence.id, evidenceExecutionId: evidence.executionId, evidenceDiffHash: evidence.diffHash, evidenceStatus } : result;
      const artifact = store.addArtifact(runItem.id, runItem.stage, `${stageLabel(runItem.stage)} AI 成果`, content);
      let gate = evaluateGate(runItem.stage, content, store.getGateConfig());
      if (needsEvidence && evidenceStatus !== "valid") gate = { decision: "human_review" as const, reasons: [`编码证据状态为 ${evidenceStatus}`] };
      emit("gate.decided", gate);
      const applied=store.applyGateDecision({ requirementId: runItem.id, stage: runItem.stage, artifactId: artifact.id, ...gate });
      refreshRequirementKnowledge(store,runItem.id);
      if(gate.decision==="auto_return"&&applied.approval){store.addReworkContext(runItem.id,buildReworkContext({approval:applied.approval,artifact}));}
      store.completeStageRun(runId, redactSensitive(content));
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 执行失败";
      store.failStageRun(runId, redactSensitive(message));
      store.updateRequirementState(runItem.id, runItem.stage, "ai_ready");
    }
    }
  });
  app.get("/api/requirements/:id/runs", async (req: any, reply) => {
    if (!store.getRequirement(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    return store.listStageRuns(req.params.id, req.query?.stage);
  });
  app.get("/api/runs/:runId", async (req: any, reply) => {
    const run = store.getStageRun(req.params.runId);
    return run || reply.code(404).send({ error: "NOT_FOUND" });
  });
  app.get("/api/runs/:runId/events", async (req: any, reply) => {
    if (!store.getStageRun(req.params.runId)) return reply.code(404).send({ error: "NOT_FOUND" });
    const last = Number(req.headers["last-event-id"] || req.query?.after || 0);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": req.headers.origin || "*" });
    let sequence = last;
    const flush = () => {
      const run = store.getStageRun(req.params.runId);
      for (const event of run?.events || []) if (event.sequence > sequence) {
        reply.raw.write(`id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`); sequence = event.sequence;
      }
      if (run && run.status !== "running") { clearInterval(timer); reply.raw.end(); }
    };
    const timer = setInterval(flush, 500); flush();
    req.raw.on("close", () => clearInterval(timer));
  });
  app.post("/api/requirements/:id/approve", async (req: any, reply) => {
    const input = approvalInputSchema.safeParse(req.body);
    const item = store.getRequirement(req.params.id);
    if (!input.success) return reply.code(400).send({ error: "VALIDATION_ERROR", issues: input.error.issues });
    if (!item) return reply.code(404).send({ error: "NOT_FOUND" });
    const approval = input.data.decision === "return" ? { ...input.data, targetStage: returnStage(item.stage) } : input.data;
    const approvalRecord=store.addApproval(item.id, item.stage, approval);
    if(item.stage==="technical_design"&&input.data.decision!=="return"&&!store.getRequirementProjectSnapshot(item.id))store.createRequirementProjectSnapshot(item.id);
    refreshRequirementKnowledge(store,item.id);
    if (input.data.decision === "return") {const artifact=store.listArtifacts(item.id).find((entry:any)=>entry.stage===item.stage);store.addReworkContext(item.id,buildReworkContext({approval:approvalRecord,artifact}));return store.updateRequirementState(item.id, returnStage(item.stage), "returned");}
    const index = workflowStages.indexOf(item.stage);
    if(item.stage==="acceptance")return store.updateRequirementState(item.id,"integration","awaiting_merge");
    if (index === workflowStages.length - 1) return store.updateRequirementState(item.id, item.stage, "completed");
    return store.updateRequirementState(item.id, workflowStages[index + 1]!, "ai_ready");
  });
  app.post("/api/requirements/:id/human-override", async (req: any, reply) => {
    const comment=typeof req.body?.comment==="string"?req.body.comment.trim():"";
    if(!comment)return reply.code(400).send({error:"VALIDATION_ERROR",message:"必须填写人工审核意见"});
    const item=store.getRequirement(req.params.id);
    if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    const stage=item.stage as "code_review"|"testing";
    const artifact=store.listArtifacts(item.id).find((entry:any)=>entry.stage===item.stage);
    const eligibility=buildHumanOverrideEligibility({stage:item.stage,status:item.status,artifact});
    if(!eligibility.allowed)return reply.code(409).send({error:"HUMAN_OVERRIDE_NOT_ALLOWED",message:eligibility.reason});
    try{const result=store.applyHumanOverride(item.id,stage,comment);refreshRequirementKnowledge(store,item.id);return result;}
    catch(error){return reply.code(409).send({error:"HUMAN_OVERRIDE_NOT_ALLOWED",message:error instanceof Error?error.message:"当前状态已变化，请刷新后重试"});}
  });
  app.get("/api/requirements/:id/integration-branches",async(req:any,reply)=>{
    const item=store.getRequirement(req.params.id);
    if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    if(item.stage!=="integration")return reply.code(409).send({error:"INTEGRATION_TARGET_NOT_ALLOWED",message:"只有代码合并阶段可以选择目标分支"});
    const project=item.projectId?store.getProject(item.projectId):null;
    if(!project)return reply.code(409).send({error:"PROJECT_NOT_FOUND",message:"需求尚未关联有效项目"});
    try{
      const result=await getLocalBranches(project.repoPath);
      return {...result,selectedTarget:item.integrationTargetBranch||result.currentBranch};
    }catch(error){return reply.code(409).send({error:"BRANCH_DISCOVERY_FAILED",message:error instanceof Error?error.message:"无法读取本地分支"});}
  });
  app.patch("/api/requirements/:id/integration-target",async(req:any,reply)=>{
    const item=store.getRequirement(req.params.id);
    if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    if(item.stage!=="integration")return reply.code(409).send({error:"INTEGRATION_TARGET_NOT_ALLOWED",message:"只有代码合并阶段可以选择目标分支"});
    const branch=typeof req.body?.branch==="string"?req.body.branch.trim():"";
    if(!branch)return reply.code(400).send({error:"VALIDATION_ERROR",message:"请选择目标分支"});
    const project=item.projectId?store.getProject(item.projectId):null;
    if(!project)return reply.code(409).send({error:"PROJECT_NOT_FOUND",message:"需求尚未关联有效项目"});
    try{
      const {branches}=await getLocalBranches(project.repoPath);
      if(!branches.some(entry=>entry.name===branch))return reply.code(400).send({error:"BRANCH_NOT_FOUND",message:"目标分支不是仓库中的本地分支"});
      return store.setIntegrationTarget(item.id,branch);
    }catch(error){return reply.code(409).send({error:"BRANCH_DISCOVERY_FAILED",message:error instanceof Error?error.message:"无法读取本地分支"});}
  });
  app.get("/api/requirements/:id/integration-check",async(req:any,reply)=>{
    const context=integrationContext(store,req.params.id);
    if(!context.item)return reply.code(404).send({error:"NOT_FOUND"});
    if(!context.allowed)return reply.code(409).send({error:context.error??"INTEGRATION_NOT_ALLOWED",message:context.reason,allowed:false,checks:[]});
    try{return await preflightLocalIntegration(context.input!);}catch(error){return reply.code(409).send({error:"INTEGRATION_PREFLIGHT_FAILED",message:error instanceof Error?error.message:"预检失败",allowed:false,checks:[]});}
  });
  app.post("/api/requirements/:id/integrate",async(req:any,reply)=>{
    const context=integrationContext(store,req.params.id);
    if(!context.item)return reply.code(404).send({error:"NOT_FOUND"});
    if(!context.allowed)return reply.code(409).send({error:context.error??"INTEGRATION_NOT_ALLOWED",message:context.reason});
    const targetBranch=context.item.integrationTargetBranch;
    if(isProtectedBranch(targetBranch)&&req.body?.protectedBranchConfirmation!==targetBranch)return reply.code(409).send({error:"PROTECTED_BRANCH_CONFIRMATION_REQUIRED",message:`请输入目标分支名称 ${targetBranch} 以确认应用改动`});
    const preflight=await preflightLocalIntegration(context.input!);
    if(!preflight.allowed)return reply.code(409).send({error:"INTEGRATION_PREFLIGHT_FAILED",...preflight});
    const project=context.project!,evidence=context.evidence!;
    let run:any;
    try{run=store.createIntegrationRun({requirementId:context.item.id,projectId:project.id,executionId:evidence.executionId,evidenceId:evidence.id,sourceBranch:evidence.branch,worktreePath:evidence.worktreePath,targetBranch,preflight:{...preflight,applicationMode:"worktree"}});}
    catch{return reply.code(409).send({error:"INTEGRATION_ALREADY_ACTIVE",message:"当前需求已有本地应用操作正在执行"});}
    const result=await executeLocalIntegration({...context.input!,commitMessage:`${context.item.code} ${context.item.title}`,commands:project.allowedCommands||[]});
    const completed=store.completeIntegrationRun(run.id,result);
    store.updateRequirementState(context.item.id,"integration",result.status==="completed"?"completed":result.status==="test_failed"?"merge_test_failed":"awaiting_merge");
    if(result.status==="completed")publishRequirementKnowledge(store,context.item.id);
    return completed;
  });
  app.post("/api/requirements/:id/integration-test",async(req:any,reply)=>{
    const item=store.getRequirement(req.params.id);if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    if(item.stage!=="integration"||item.status!=="merge_test_failed")return reply.code(409).send({error:"INTEGRATION_TEST_NOT_ALLOWED",message:"只有本地应用后测试失败时才能重新运行"});
    const project=item.projectId?store.getProject(item.projectId):null,previous=store.getLatestIntegrationRun(item.id),evidence:any=store.getLatestCodingEvidence(item.id);
    if(project?.status==="archived")return reply.code(409).send({error:"PROJECT_ARCHIVED",message:"归档项目不能启动新的集成操作"});
    if(!project||!previous||!evidence)return reply.code(409).send({error:"INTEGRATION_CONTEXT_MISSING"});
    const plan=await buildVerificationPlan({repoPath:project.repoPath,changedFiles:evidence.files||[],fallbackCommands:project.allowedCommands||[]});
    if(!plan.plannedCommands.length)return reply.code(409).send({error:"VERIFICATION_PLAN_UNAVAILABLE",message:"未识别到安全测试命令"});
    const run=store.createIntegrationRun({requirementId:item.id,projectId:project.id,executionId:previous.executionId,evidenceId:previous.evidenceId,sourceBranch:previous.sourceBranch,worktreePath:previous.worktreePath,targetBranch:previous.targetBranch,preflight:{rerun:true,...plan}});
    const result=await rerunIntegrationTests(project.repoPath,plan.plannedCommands);
    const completed=store.completeIntegrationRun(run!.id,{...result,sourceCommit:previous.sourceCommit,targetCommit:previous.targetCommit,error:result.status==="completed"?null:"本地应用后测试失败"});
    store.updateRequirementState(item.id,"integration",result.status==="completed"?"completed":"merge_test_failed");if(result.status==="completed")publishRequirementKnowledge(store,item.id);return completed;
  });
  app.get("/api/projects", async (req:any,reply) => {
    const status=req.query?.status??"all";
    if(!["active","archived","all"].includes(status))return reply.code(400).send({error:"VALIDATION_ERROR",message:"项目状态筛选无效"});
    const projects=store.listProjects();return status==="all"?projects:projects.filter(project=>project.status===status);
  });
  app.get("/api/projects/:id/knowledge",async(req:any,reply)=>{
    const project=store.getProject(req.params.id);if(!project)return reply.code(404).send({error:"NOT_FOUND"});
    const status:any=store.getProjectKnowledgeStatus(project.id);
    if(status.status==="ready"){try{const head=await getRepositoryHead(project.repoPath);return {...status,currentHead:head,status:head===status.sourceHead?"ready":"stale"};}catch{return status;}}
    return status;
  });
  app.get("/api/projects/:id/memory",async(req:any,reply)=>{const project=store.getProject(req.params.id);if(!project)return reply.code(404).send({error:"NOT_FOUND"});return store.listProjectMemory(project.id);});
  app.get("/api/requirements/:id/knowledge-changes",async(req:any,reply)=>{if(!store.getRequirement(req.params.id))return reply.code(404).send({error:"NOT_FOUND"});return store.getKnowledgeChangeSet(req.params.id);});
  app.post("/api/projects/:id/knowledge/rebuild",async(req:any,reply)=>{
    const project=store.getProject(req.params.id);if(!project)return reply.code(404).send({error:"NOT_FOUND"});
    if(store.getProjectKnowledgeStatus(project.id).status==="building")return reply.code(409).send({error:"KNOWLEDGE_ALREADY_BUILDING"});
    void ensureProjectKnowledge(store,project,"manual",true).catch(()=>{});return reply.code(202).send({status:"building"});
  });
  app.get("/api/settings/gates", async () => store.getGateConfig());
  app.patch("/api/settings/gates", async (req: any, reply) => {
    const body = req.body;
    const validStages = Array.isArray(body?.mandatoryHumanStages) && body.mandatoryHumanStages.every((stage: string) => workflowStages.includes(stage as any));
    if (typeof body?.autoTransitionEnabled !== "boolean" || typeof body?.confidenceThreshold !== "number" || body.confidenceThreshold < 0 || body.confidenceThreshold > 1 || !validStages) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", message: "门禁配置无效" });
    }
    return store.updateGateConfig(body);
  });
  app.post("/api/projects", async (req: any, reply) => {
    const parsed=projectInputSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"VALIDATION_ERROR",issues:parsed.error.issues});
    const inspection=await inspectProjectRepository(parsed.data.repoPath,parsed.data.defaultBranch);if(!inspection.valid)return invalidRepository(reply,inspection);
    try{const project=store.createProject({...parsed.data,repoPath:inspection.repoPath,category:parsed.data.category??inspection.category,technology:inspection.technology});void ensureProjectKnowledge(store,project,"project_created").catch(()=>{});return reply.code(201).send(project);}
    catch(error){return sendDomainError(reply,error);}
  });
  app.post("/api/projects/validate",async(req:any,reply)=>{
    const repoPath=typeof req.body?.repoPath==="string"?req.body.repoPath.trim():"",defaultBranch=typeof req.body?.defaultBranch==="string"?req.body.defaultBranch.trim():"";
    if(!repoPath||!defaultBranch)return reply.code(400).send({error:"VALIDATION_ERROR",message:"仓库路径和默认分支不能为空"});
    const inspection=await inspectProjectRepository(repoPath,defaultBranch);return inspection.valid?inspection:invalidRepository(reply,inspection);
  });
  app.patch("/api/projects/:id",async(req:any,reply)=>{
    const current=store.getProject(req.params.id);if(!current)return reply.code(404).send({error:"NOT_FOUND"});
    const parsed=projectUpdateSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"VALIDATION_ERROR",issues:parsed.error.issues});
    let update:any={...parsed.data};
    if(parsed.data.repoPath!==undefined||parsed.data.defaultBranch!==undefined){const inspection=await inspectProjectRepository(parsed.data.repoPath??current.repoPath,parsed.data.defaultBranch??current.defaultBranch);if(!inspection.valid)return invalidRepository(reply,inspection);update={...update,repoPath:inspection.repoPath,technology:inspection.technology,category:parsed.data.category===undefined?inspection.category:parsed.data.category};}
    try{const identityChanged=parsed.data.repoPath!==undefined||parsed.data.defaultBranch!==undefined,project=store.updateProject(current.id,update);if(identityChanged){store.cancelBuildingProjectKnowledge(current.id,"项目仓库配置已变更");void ensureProjectKnowledge(store,project!,"project_updated",true).catch(()=>{});}return project;}
    catch(error){return sendDomainError(reply,error);}
  });
  app.post("/api/projects/:id/archive",async(req:any,reply)=>{const project=store.getProject(req.params.id);if(!project)return reply.code(404).send({error:"NOT_FOUND"});if(store.projectHasActiveDelivery(project.id))return reply.code(409).send({error:"PROJECT_IN_ACTIVE_DELIVERY",message:"项目正在用于活动交付"});return store.archiveProject(project.id);});
  app.post("/api/backups", async (_req, reply) => {
    const databasePath = process.env.DATABASE_PATH;
    if (!databasePath) return reply.code(400).send({ error: "BACKUP_UNAVAILABLE", message: "未配置 DATABASE_PATH" });
    return createBackup(databasePath, process.env.BACKUP_DIR || "data/backups");
  });
  return app;
}

function stageLabel(stage: string) { return stage.replaceAll("_", " "); }

function invalidRepository(reply:any,details:any){return reply.code(400).send({error:"PROJECT_REPOSITORY_INVALID",message:details.warnings?.[0]||"项目仓库无效",details});}
function applyRequirementProjects(store:WorkflowStore,requirementId:string,inputs:any[]){
  const before=store.listRequirementProjects(requirementId),projects=store.replaceRequirementProjects(requirementId,inputs);
  const materialChange=hasMaterialAssociationChange(before,projects);
  const technicalDesignInvalidated=materialChange&&store.invalidateTechnicalDesignForProjectChange(requirementId);
  return {requirement:store.getRequirement(requirementId),projects,snapshot:store.getRequirementProjectSnapshot(requirementId),materialChange,technicalDesignInvalidated:Boolean(technicalDesignInvalidated)};
}
function sendDomainError(reply:any,error:unknown){const message=error instanceof Error?error.message:"VALIDATION_ERROR";if(message==="PROJECT_REPO_PATH_EXISTS")return reply.code(409).send({error:message,message:"仓库路径已被其他项目使用"});if(message==="REQUIREMENT_NOT_FOUND")return reply.code(404).send({error:"NOT_FOUND"});if(["PROJECT_NOT_FOUND","PROJECT_NOT_ACTIVE","MODULE_NOT_FOUND","MODULE_INDEX_REQUIRED","MODULE_ID_INVALID"].includes(message))return reply.code(400).send({error:"VALIDATION_ERROR",message});if(message==="MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED")return reply.code(409).send({error:message,message:"多项目交付执行将在第二阶段提供"});return reply.code(400).send({error:"VALIDATION_ERROR",message});}
function sendProjectContextError(reply:any,error:unknown){
  if(!(error instanceof ProjectContextError))return reply.code(409).send({error:"PROJECT_KNOWLEDGE_UNAVAILABLE",message:error instanceof Error?error.message:"项目知识库不可用"});
  const messages:Record<string,string>={PROJECT_REQUIRED:"当前阶段必须关联一个交付项目",PROJECT_ARCHIVED:"归档项目不能启动新执行",MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED:"多项目交付执行将在第二阶段提供",PROJECT_KNOWLEDGE_BUILDING:"项目知识库正在生成，请稍后重试",PROJECT_KNOWLEDGE_UNAVAILABLE:"项目知识库不可用"};
  return reply.code(error.code==="REQUIREMENT_NOT_FOUND"?404:409).send({error:error.code,message:messages[error.code]??error.code,projects:error.projects});
}

export function resolveReusableSourceCommit(run:any,evidence:any,targetBranch:string){
  if(!run||run.status!=="conflict"||!run.sourceCommit)return undefined;
  return run.evidenceId===evidence.id&&run.executionId===evidence.executionId&&run.sourceBranch===evidence.branch&&run.worktreePath===evidence.worktreePath&&run.targetBranch===targetBranch?run.sourceCommit:undefined;
}

function integrationContext(store:WorkflowStore,id:string){
  const item:any=store.getRequirement(id);
  if(!item)return {item:null,allowed:false,reason:"需求不存在"};
  if(item.stage!=="integration"||item.status!=="awaiting_merge")return {item,allowed:false,reason:"需求当前不处于待应用状态"};
  const project=item.projectId?store.getProject(item.projectId):null,evidence:any=store.getLatestCodingEvidence(item.id);
  if(!project)return {item,allowed:false,reason:"需求尚未关联有效项目"};
  if(project.status==="archived")return {item,project,allowed:false,error:"PROJECT_ARCHIVED",reason:"归档项目不能启动新的集成操作"};
  if(!evidence)return {item,project,allowed:false,reason:"缺少编码证据"};
  if(!item.integrationTargetBranch)return {item,project,evidence,allowed:false,reason:"尚未选择本次需求的目标分支"};
  const latestRun=store.getLatestIntegrationRun(item.id);
  if(latestRun?.status==="running")return {item,project,evidence,allowed:false,reason:"已有本地应用操作正在执行"};
  const sourceCommit=resolveReusableSourceCommit(latestRun,evidence,item.integrationTargetBranch);
  return {item,project,evidence,allowed:true,input:{repoPath:project.repoPath,defaultBranch:item.integrationTargetBranch,worktreePath:evidence.worktreePath,sourceBranch:evidence.branch,evidenceDiffHash:evidence.diffHash,sourceCommit,changedFiles:evidence.files,fallbackCommands:project.allowedCommands||[]}};
}
