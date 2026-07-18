import Fastify from "fastify";
import cors from "@fastify/cors";
import { approvalInputSchema, evaluateGate, projectInputSchema, projectUpdateSchema, requirementInputSchema, requirementProjectsInputSchema, returnStage, workflowStages } from "@ai-workflow/shared";
import { WorkflowStore } from "./store.js";
import { runAgent } from "./ai.js";
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
import { normalizeModuleId, resolveSoleDeliveryProject } from "./requirement-projects.js";
import { buildRequirementProjectContext, ProjectContextError, resolveProjectContextBudget } from "./project-context.js";
import { recheckVersionApplication, registerProjectVersionRoutes } from "./project-version-routes.js";
import { inspectVersionWorktree } from "./project-version-service.js";

const requirementRevisionSchema = requirementInputSchema.extend({
  clarifications: requirementInputSchema.shape.businessProblem,
  changeSummary: requirementInputSchema.shape.expectedOutcome.optional()
});

export async function buildApp(store: WorkflowStore) {
  const app = Fastify({ logger: true });
  store.recoverInterruptedVersionApplicationRetests();
  for (const pending of store.listPendingVersionApplications()) {
    try { await recheckVersionApplication(store, pending.version.id, { allowInterruptedRun: true }); }
    catch (error) { app.log.error({ err: error, versionId: pending.version.id }, "Version application recovery failed"); }
  }
  for(const item of store.listRequirements())if(item.status==="completed"&&item.projectId&&!store.getKnowledgeChangeSet(item.id).id){try{publishRequirementKnowledge(store,item.id)}catch{/* Existing completed data remains usable if backfill fails. */}}
  await app.register(cors, { origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
  await registerProjectVersionRoutes(app, { store });
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
    try {
      const item = store.reviseRequirement(req.params.id, input.data);
      if (!item) return reply.code(409).send({ error: "REQUIREMENT_NOT_EDITABLE", message: "只有草稿、已打回或已阻塞的需求可以纠正" });
      return item;
    } catch (error) { return sendDomainError(reply, error); }
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
    return {projects:[...store.listRequirementProjects(req.params.id),...store.listArchivedRequirementProjectHistory(req.params.id)],snapshot:store.getRequirementProjectSnapshot(req.params.id),snapshots:store.listRequirementProjectSnapshots(req.params.id)};
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
    if(store.hasPendingVersionApplication(item.id))return sendDomainError(reply,new Error("PROJECT_VERSION_APPLICATION_PENDING"));
    const executionStage=["coding","code_review","testing","acceptance","integration"].includes(item.stage);
    let deliveryProject:any,deliveryVersion:any;
    if(executionStage){try{deliveryProject=resolveSoleDeliveryProject(item.projects);}catch(error){return sendDomainError(reply,error);}}
    if(deliveryProject?.projectStatus==="archived")return reply.code(409).send({error:"PROJECT_ARCHIVED",message:"归档项目不能启动新执行"});
    if(executionStage){try{deliveryVersion=resolveDeliveryVersion(store,deliveryProject);}catch(error){return sendDomainError(reply,error);}}
    if(item.stage==="integration")return reply.code(409).send({error:"INTEGRATION_REQUIRES_MANUAL_ACTION",message:"代码应用节点不会启动 AI，请执行应用预检"});
    const existing = store.listStageRuns(item.id, item.stage).find((run: any) => run.status === "running");
    if (existing) return reply.code(409).send({ error: "RUN_ALREADY_ACTIVE", message: "当前阶段已有 AI 正在执行" });
    const associatedProjects=(item.projects??[]).map((association:any)=>store.getProject(association.projectId)).filter(Boolean);
    const sensitivePatterns=[...new Set(associatedProjects.flatMap((associated:any)=>associated.sensitivePatterns??[]))] as string[];
    const project = deliveryProject ? store.getProject(deliveryProject.projectId) : null;
    const reworkContext=item.status==="returned"?store.getLatestReworkContext(item.id):null;
    let projectContext:any=undefined;
    if(["prd","requirement_review","technical_design","coding","code_review","testing","acceptance"].includes(item.stage)){
      const projectContextBudget=resolveProjectContextBudget(process.env.AI_PROJECT_CONTEXT_MAX_CHARS);
      try{projectContext=await buildRequirementProjectContext(store,item.id,item.stage,projectContextBudget);}
      catch(error){return sendProjectContextError(reply,error);}
    }
    const context = redactSensitive({ requirement: item, priorArtifacts: store.listArtifacts(item.id), approvalHistory: store.listApprovals(item.id), projectContext, reworkRequired:Boolean(reworkContext), reworkContext, userContext: req.body?.context },sensitivePatterns);
    if(context.projectContext){
      for(const block of context.projectContext.projects){do{block.totalChars=JSON.stringify(block).length;}while(block.totalChars!==JSON.stringify(block).length);}
      context.projectContext.totalChars=JSON.stringify(context.projectContext.projects).length;
      if(context.projectContext.totalChars>context.projectContext.budgetMaxChars)return sendProjectContextError(reply,new ProjectContextError("PROJECT_CONTEXT_BUDGET_TOO_SMALL",[],{maxChars:context.projectContext.budgetMaxChars,minimumRequiredChars:context.projectContext.totalChars,projectCount:context.projectContext.projects.length}));
    }
    const model = item.stage === "coding" ? (process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL || "gpt-5.5") : (process.env.OPENAI_MODEL || "gpt-5.5");
    let run:any;
    try{run=store.createStageRun({ requirementId: item.id, stage: item.stage, model, input: context,
      ...(executionStage?{projectId:deliveryProject.projectId,projectVersionId:deliveryVersion.id,expectedRequirementUpdatedAt:item.updatedAt,expectedProjectUpdatedAt:project!.updatedAt}:{}) });}
    catch(error){return sendDomainError(reply,error);}
    for(const block of context.projectContext?.projects??[])store.appendStageRunEvent(run.id,"knowledge.retrieved",{projectId:block.projectId,version:block.version,sourceHead:block.sourceHead,paths:block.entries.map((entry:any)=>entry.path),totalAvailable:block.totalAvailable,budgetMaxChars:context.projectContext.budgetMaxChars,totalChars:block.totalChars,contextTotalChars:context.projectContext.totalChars,truncated:block.truncated});
    store.updateRequirementState(item.id, item.stage, "ai_running");
    void executeRun(run.id, item, context, project, deliveryVersion, sensitivePatterns);
    return reply.code(202).send(run);

    async function executeRun(runId: string, runItem: any, runContext: any, runProject: any, runVersion:any, patterns:string[]) {
      const emit = (type: string, payload: unknown) => store.appendStageRunEvent(runId, type, redactSensitive(payload, patterns));
    try {
      if (runItem.stage === "coding") {
        if (!runItem.projectId) throw new Error("编码阶段必须先关联本地项目");
        if (!runProject) throw new Error("关联项目不存在");
        const projectContext = runContext.projectContext?.projects?.[0];
        if (!projectContext) throw new Error("编码阶段缺少交付项目上下文");
        const coding = await runCodexCoding({ requirement: runContext.requirement, artifacts: runContext.priorArtifacts, project: runProject, version: runVersion, projectContext, reworkContext: runContext.reworkContext, onEvent: emit });
        const conclusion = coding.diff ? "pass" : "return";
        const execution = store.addExecution({ requirementId: runItem.id, stage: runItem.stage, projectId: runProject.id, projectVersionId: runVersion.id, branch: coding.branch, worktreePath: coding.worktreePath, baseCommit: coding.baseCommit, status: conclusion === "pass" ? "completed" : "needs_review", commands: [], diff: coding.diff, codexThreadId: coding.codexThreadId, events: coding.events, diagnostics: coding.diagnostics.join("\n"), completedAt: new Date().toISOString() });
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
        store.completeStageRun(runId, redactSensitive(content,patterns));
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
        : await runAgent(runItem.stage, redactSensitive({ ...runContext, codingEvidence: evidence ? { ...evidence, status: evidenceStatus } : undefined },patterns), emit);
      const content = evidence ? { ...result, evidenceId: evidence.id, evidenceExecutionId: evidence.executionId, evidenceDiffHash: evidence.diffHash, evidenceStatus } : result;
      const artifact = store.addArtifact(runItem.id, runItem.stage, `${stageLabel(runItem.stage)} AI 成果`, content);
      let gate = evaluateGate(runItem.stage, content, store.getGateConfig());
      if (needsEvidence && evidenceStatus !== "valid") gate = { decision: "human_review" as const, reasons: [`编码证据状态为 ${evidenceStatus}`] };
      emit("gate.decided", gate);
      const applied=store.applyGateDecision({ requirementId: runItem.id, stage: runItem.stage, artifactId: artifact.id, ...gate });
      refreshRequirementKnowledge(store,runItem.id);
      if(gate.decision==="auto_return"&&applied.approval){store.addReworkContext(runItem.id,buildReworkContext({approval:applied.approval,artifact}));}
      store.completeStageRun(runId, redactSensitive(content,patterns));
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 执行失败";
      store.failStageRun(runId, redactSensitive(message,patterns));
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
    try {
      const result = store.applyRequirementApproval({ requirementId: item.id, expectedStage: item.stage, approval });
      refreshRequirementKnowledge(store,item.id);
      return result;
    } catch (error) { return sendDomainError(reply, error); }
  });
  app.post("/api/requirements/:id/human-override", async (req: any, reply) => {
    const comment=typeof req.body?.comment==="string"?req.body.comment.trim():"";
    if(!comment)return reply.code(400).send({error:"VALIDATION_ERROR",message:"必须填写人工审核意见"});
    const item=store.getRequirement(req.params.id);
    if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    if(store.hasPendingVersionApplication(item.id))return sendDomainError(reply,new Error("PROJECT_VERSION_APPLICATION_PENDING"));
    const stage=item.stage as "code_review"|"testing";
    const artifact=store.listArtifacts(item.id).find((entry:any)=>entry.stage===item.stage);
    const eligibility=buildHumanOverrideEligibility({stage:item.stage,status:item.status,artifact});
    if(!eligibility.allowed)return reply.code(409).send({error:"HUMAN_OVERRIDE_NOT_ALLOWED",message:eligibility.reason});
    try{const result=store.applyHumanOverride(item.id,stage,comment);refreshRequirementKnowledge(store,item.id);return result;}
    catch(error){return error instanceof Error&&error.message==="PROJECT_VERSION_APPLICATION_PENDING"?sendDomainError(reply,error):reply.code(409).send({error:"HUMAN_OVERRIDE_NOT_ALLOWED",message:error instanceof Error?error.message:"当前状态已变化，请刷新后重试"});}
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
    const preflight=await preflightLocalIntegration(context.input!);
    if(!preflight.allowed)return reply.code(409).send({error:"INTEGRATION_PREFLIGHT_FAILED",...preflight});
    const project=context.project!,version=context.version!,evidence=context.evidence!;
    let run:any;
    try{({run}=store.beginVersionApplication({versionId:version.id,requirementId:context.item.id,run:{projectId:project.id,executionId:evidence.executionId,evidenceId:evidence.id,sourceBranch:evidence.branch,worktreePath:evidence.worktreePath,targetBranch:version.branch,preflight:{...preflight,applicationMode:"version_worktree"}}}));}
    catch(error){return sendDomainError(reply,error);}
    const markAmbiguous=async(error:unknown)=>{
      const message=error instanceof Error?error.message:String(error||"无法确认本地应用状态");
      const inspection=await inspectVersionWorktree({repoPath:project.repoPath,worktreePath:version.worktreePath,branch:version.branch});
      let settled:any;
      try{settled=store.markVersionResolutionAmbiguous({versionId:version.id,runId:run.id,currentHead:inspection.valid?inspection.headCommit:inspection.status,allowRunning:true,error:message});}
      catch{/* A failed CAS must never trigger lease release or target rollback. */}
      return reply.code(409).send({error:"INTEGRATION_APPLICATION_AMBIGUOUS",message,run:settled});
    };
    let result:any;
    try{result=await executeLocalIntegration({...context.input!,expectedTargetHead:preflight.targetHead,commitMessage:`${context.item.code} ${context.item.title}`,commands:project.allowedCommands||[]});}
    catch(error){
      const inspection=await inspectVersionWorktree({repoPath:project.repoPath,worktreePath:version.worktreePath,branch:version.branch});
      if(inspection.valid&&inspection.clean&&inspection.headCommit===preflight.targetHead){
        try{
          const failed=store.releaseFailedVersionApplication({versionId:version.id,runId:run.id,status:"failed",error:error instanceof Error?error.message:"本地应用失败"});
          return reply.code(409).send({error:"INTEGRATION_APPLICATION_FAILED",message:failed.error,run:failed});
        }catch(settlementError){return markAmbiguous(settlementError);}
      }
      return markAmbiguous(error);
    }
    if(result.status==="completed"||result.status==="test_failed"){
      try{return store.completeVersionApplicationApply({runId:run.id,sourceCommit:result.sourceCommit!,preApplyHead:result.preApplyHead,status:result.status==="completed"?"awaiting_local_resolution":"merge_test_failed"});}
      catch(error){return markAmbiguous(error);}
    }
    if(result.status==="conflict"&&result.targetState==="rolled_back_clean"){
      try{return store.releaseFailedVersionApplication({versionId:version.id,runId:run.id,status:"conflict",sourceCommit:result.sourceCommit,conflictFiles:result.conflictFiles,error:result.error});}
      catch(error){return markAmbiguous(error);}
    }
    if(result.status==="failed"&&result.targetState==="untouched_clean"){
      try{
        const failed=store.releaseFailedVersionApplication({versionId:version.id,runId:run.id,status:"failed",sourceCommit:result.sourceCommit,error:result.error});
        return reply.code(409).send({error:"INTEGRATION_APPLICATION_FAILED",message:result.error,run:failed});
      }catch(error){return markAmbiguous(error);}
    }
    return markAmbiguous(result.error);
  });
  app.post("/api/requirements/:id/integration-test",async(req:any,reply)=>{
    const item=store.getRequirement(req.params.id);if(!item)return reply.code(404).send({error:"NOT_FOUND"});
    if(item.stage!=="integration"||item.status!=="merge_test_failed")return reply.code(409).send({error:"INTEGRATION_TEST_NOT_ALLOWED",message:"只有本地应用后测试失败时才能重新运行"});
    let deliveryProject:any,version:any;
    try{deliveryProject=resolveSoleDeliveryProject(item.projects);version=resolveDeliveryVersion(store,deliveryProject);}
    catch(error){return sendDomainError(reply,error);}
    const project=store.getProject(deliveryProject.projectId),previous=store.getLatestIntegrationRun(item.id),evidence:any=store.getLatestCodingEvidence(item.id);
    if(project?.status==="archived")return reply.code(409).send({error:"PROJECT_ARCHIVED",message:"归档项目不能启动新的集成操作"});
    if(!project||!previous||!evidence||previous.id!==version.pendingIntegrationRunId)return reply.code(409).send({error:"INTEGRATION_CONTEXT_MISSING"});
    const inspectTarget=()=>inspectVersionWorktree({repoPath:project.repoPath,worktreePath:version.worktreePath,branch:version.branch});
    const rejectInvalidTarget=(inspection:any,allowRetesting=false)=>{
      store.markVersionResolutionAmbiguous({versionId:version.id,runId:previous.id,currentHead:inspection.valid?inspection.headCommit:inspection.status,allowRetesting,error:"重新测试前目标工作树身份或 HEAD 已变化"});
      return reply.code(409).send({error:"INTEGRATION_TARGET_IDENTITY_INVALID",message:"目标版本工作树身份或 HEAD 已变化"});
    };
    const beforeClaim=await inspectTarget();
    if(!beforeClaim.valid||beforeClaim.headCommit!==previous.preApplyHead)return rejectInvalidTarget(beforeClaim);
    const plan=await buildVerificationPlan({repoPath:version.worktreePath,changedFiles:evidence.files||[],fallbackCommands:project.allowedCommands||[]});
    if(!plan.plannedCommands.length)return reply.code(409).send({error:"VERIFICATION_PLAN_UNAVAILABLE",message:"未识别到安全测试命令"});
    try{store.beginVersionApplicationRetest({versionId:version.id,runId:previous.id});}
    catch(error){return sendDomainError(reply,error);}
    const afterClaim=await inspectTarget();
    if(!afterClaim.valid||afterClaim.headCommit!==previous.preApplyHead)return rejectInvalidTarget(afterClaim,true);
    const result=await rerunIntegrationTests(version.worktreePath,plan.plannedCommands);
    try{return store.completeVersionApplicationRetest({versionId:version.id,runId:previous.id,status:result.status==="completed"?"awaiting_local_resolution":"merge_test_failed",commandResults:result.commandResults,error:result.status==="completed"?undefined:"本地应用后测试失败"});}
    catch(error){return sendDomainError(reply,error);}
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
  app.get("/api/projects/:id/modules",async(req:any,reply)=>{
    const project=store.getProject(req.params.id);if(!project)return reply.code(404).send({error:"NOT_FOUND"});
    const knowledge:any=store.getProjectKnowledgeStatus(project.id);if(knowledge.status!=="ready")return reply.code(409).send({error:"PROJECT_MODULES_UNAVAILABLE",message:knowledge.status==="building"?"项目知识库正在生成":"项目模块索引不可用"});
    const all=[] as Array<{id:string;name:string;path:string}>,seen=new Set<string>();for(const entry of knowledge.entries??[]){if(entry.kind!=="module")continue;const id=normalizeModuleId(String(entry.moduleId||entry.id||entry.path||"")),path=normalizeModuleId(String(entry.path||id));if(!id||seen.has(id))continue;seen.add(id);all.push({id,name:String(entry.name||entry.title||id).slice(0,256),path});}
    const q=typeof req.query?.q==="string"?req.query.q.trim().toLowerCase().slice(0,128):"",filtered=q?all.filter(module=>`${module.id}\n${module.name}\n${module.path}`.toLowerCase().includes(q)):all,modules=filtered.slice(0,256),included=new Set(modules.map(module=>module.id));const rawIncludes=Array.isArray(req.query?.include)?req.query.include:[req.query?.include];const requested:string[]=rawIncludes.flatMap((value:unknown)=>typeof value==="string"?value.split(","):[]).map((value:string)=>normalizeModuleId(value)).filter((value:string)=>value&&value.length<=256&&!value.startsWith("/")&&!value.split("/").some((part:string)=>part==="."||part===".."));for(const include of requested){const module=all.find(item=>item.id===include||item.path===include);if(module&&!included.has(module.id)){included.add(module.id);modules.push(module);}}return {modules,total:filtered.length,truncated:filtered.length>256};
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
  const result=store.replaceRequirementProjectsAndInvalidate(requirementId,inputs);
  return {requirement:store.getRequirement(requirementId),...result,snapshot:store.getRequirementProjectSnapshot(requirementId)};
}
function sendDomainError(reply:any,error:unknown){const message=error instanceof Error?error.message:"VALIDATION_ERROR";if(message==="PROJECT_VERSION_APPLICATION_PENDING")return reply.code(409).send({error:message,message:"版本应用处理中，不能修改需求或项目关联"});if(message==="PROJECT_REPO_PATH_EXISTS")return reply.code(409).send({error:message,message:"仓库路径已被其他项目使用"});if(message==="REQUIREMENT_NOT_FOUND")return reply.code(404).send({error:"NOT_FOUND"});if(["PROJECT_NOT_FOUND","PROJECT_NOT_ACTIVE","MODULE_NOT_FOUND","MODULE_INDEX_REQUIRED","MODULE_ID_INVALID"].includes(message))return reply.code(400).send({error:"VALIDATION_ERROR",message});if(message==="MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED")return reply.code(409).send({error:message,message:"多项目交付执行将在第二阶段提供"});if(["RUN_ALREADY_ACTIVE","REQUIREMENT_CHANGED_DURING_RUN_PREPARATION","PROJECT_CHANGED_DURING_RUN_PREPARATION","PROJECT_IN_ACTIVE_EXECUTION","REQUIREMENT_VERSION_REQUIRED","REQUIREMENT_VERSION_PROJECT_MISMATCH","PROJECT_VERSION_NOT_ACTIVE","PROJECT_ARCHIVED","PROJECT_VERSION_APPLICATION_BUSY","VERSION_APPLICATION_NOT_ALLOWED","PROJECT_VERSION_APPLICATION_FAILED","VERSION_APPLICATION_RETEST_BUSY","PROJECT_VERSION_APPLICATION_MISMATCH","REQUIREMENT_APPROVAL_STATE_CHANGED"].includes(message))return reply.code(409).send({error:message,message});return reply.code(400).send({error:"VALIDATION_ERROR",message});}

export function resolveDeliveryVersion(store:WorkflowStore,deliveryProject:any){
  if(!deliveryProject?.projectVersionId)throw new Error("REQUIREMENT_VERSION_REQUIRED");
  const version=store.getProjectVersion(deliveryProject.projectVersionId);
  if(!version||version.projectId!==deliveryProject.projectId)throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
  if(version.status!=="active")throw new Error("PROJECT_VERSION_NOT_ACTIVE");
  return version;
}
function sendProjectContextError(reply:any,error:unknown){
  if(!(error instanceof ProjectContextError))return reply.code(409).send({error:"PROJECT_KNOWLEDGE_UNAVAILABLE",message:error instanceof Error?error.message:"项目知识库不可用"});
  const messages:Record<string,string>={PROJECT_REQUIRED:"当前阶段必须关联一个交付项目",PROJECT_ARCHIVED:"归档项目不能启动新执行",MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED:"多项目交付执行将在第二阶段提供",PROJECT_KNOWLEDGE_BUILDING:"项目知识库正在生成，请稍后重试",PROJECT_KNOWLEDGE_UNAVAILABLE:"项目知识库不可用",PROJECT_CONTEXT_BUDGET_TOO_SMALL:"项目上下文预算不足，请提高配置或减少关联项目"};
  return reply.code(error.code==="REQUIREMENT_NOT_FOUND"?404:409).send({error:error.code,message:messages[error.code]??error.code,projects:error.projects,details:error.details});
}

export function resolveReusableSourceCommit(run:any,evidence:any,targetBranch:string){
  if(!run||run.status!=="conflict"||!run.sourceCommit)return undefined;
  return run.evidenceId===evidence.id&&run.executionId===evidence.executionId&&run.sourceBranch===evidence.branch&&run.worktreePath===evidence.worktreePath&&run.targetBranch===targetBranch?run.sourceCommit:undefined;
}

function integrationContext(store:WorkflowStore,id:string){
  const item:any=store.getRequirement(id);
  if(!item)return {item:null,allowed:false,reason:"需求不存在"};
  if(item.stage!=="integration"||item.status!=="awaiting_merge")return {item,allowed:false,reason:"需求当前不处于待应用状态"};
  let deliveryProject:any,version:any;
  try{deliveryProject=resolveSoleDeliveryProject(item.projects);version=resolveDeliveryVersion(store,deliveryProject);}
  catch(error){return {item,allowed:false,error:error instanceof Error?error.message:"INTEGRATION_NOT_ALLOWED",reason:"需求缺少唯一有效的交付版本"};}
  const project=store.getProject(deliveryProject.projectId),evidence:any=store.getLatestCodingEvidence(item.id);
  if(!project)return {item,allowed:false,reason:"需求尚未关联有效项目"};
  if(project.status==="archived")return {item,project,allowed:false,error:"PROJECT_ARCHIVED",reason:"归档项目不能启动新的集成操作"};
  if(!evidence)return {item,project,allowed:false,reason:"缺少编码证据"};
  if(version.pendingRequirementId)return {item,project,version,evidence,allowed:false,error:"PROJECT_VERSION_APPLICATION_BUSY",reason:"目标版本正在等待本地提交或撤销"};
  const latestRun=store.getLatestIntegrationRun(item.id);
  if(latestRun?.status==="running")return {item,project,evidence,allowed:false,reason:"已有本地应用操作正在执行"};
  const sourceCommit=resolveReusableSourceCommit(latestRun,evidence,version.branch);
  return {item,project,version,evidence,allowed:true,input:{projectRepoPath:project.repoPath,targetWorktreePath:version.worktreePath,targetBranch:version.branch,sourceWorktreePath:evidence.worktreePath,sourceBranch:evidence.branch,evidenceDiffHash:evidence.diffHash,sourceCommit,changedFiles:evidence.files,fallbackCommands:project.allowedCommands||[]}};
}
