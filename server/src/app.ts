import Fastify from "fastify";
import cors from "@fastify/cors";
import { evaluateGate, gateConfigSchema, projectInputSchema, projectUpdateSchema, requirementInputSchema, requirementProjectsInputSchema } from "@ai-workflow/shared";
import { WorkflowStore } from "./store.js";
import { runAgent } from "./ai.js";
import { createBackup } from "./backup.js";
import { redactSensitive } from "./redaction.js";
import { getWorktreeSnapshot } from "./repository.js";
import { ensureProjectKnowledge } from "./knowledge-service.js";
import { getRepositoryHead } from "./project-knowledge.js";
import { publishRequirementKnowledge, refreshRequirementKnowledge } from "./project-memory-service.js";
import { inspectProjectRepository } from "./project-service.js";
import { normalizeModuleId } from "./requirement-projects.js";
import { buildRequirementProjectContext, ProjectContextError, resolveProjectContextBudget } from "./project-context.js";
import { registerProjectVersionRoutes } from "./project-version-routes.js";
import { registerRequirementRoutes } from "./requirement-routes.js";
import { registerDeliveryUnitRoutes } from "./delivery-unit-routes.js";

const requirementRevisionSchema = requirementInputSchema.extend({
  clarifications: requirementInputSchema.shape.businessProblem,
  changeSummary: requirementInputSchema.shape.expectedOutcome.optional()
});

export async function buildApp(store: WorkflowStore) {
  const app = Fastify({ logger: true });
  for(const item of store.listRequirements())if(item.status==="completed"&&item.projectId&&!store.getKnowledgeChangeSet(item.id).id){try{publishRequirementKnowledge(store,item.id)}catch{/* Existing completed data remains usable if backfill fails. */}}
  await app.register(cors, { origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
  await registerProjectVersionRoutes(app, { store });
  await registerDeliveryUnitRoutes(app, { store });
  await registerRequirementRoutes(app, {
    store,
    onApproved: (requirementId) => { refreshRequirementKnowledge(store, requirementId); }
  });
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
      try { codingEvidence.status = (await getWorktreeSnapshot(codingEvidence.worktreePath, {
        sensitivePatterns: codingEvidence.sensitivePatterns
      })).evidenceHash === codingEvidence.diffHash ? (codingEvidence.truncated ? "truncated" : "valid") : "stale"; }
      catch { codingEvidence.status = "unverifiable"; }
    }
    const artifacts=store.listArtifacts(item.id),approvals=store.listApprovals(item.id);
    const reworkContext=store.getLatestReworkContext(item.id);
    return { ...item, artifacts, approvals, executions: store.listExecutions(item.id), revisions: store.listRequirementRevisions(item.id), runs: store.listStageRuns(item.id), codingEvidence, reworkContext, knowledgeChanges:store.getKnowledgeChangeSet(item.id),deliveryUnits:store.deliveryUnits.listForRequirement(item.id),deliveryDependencies:store.deliveryUnits.listDependencies(item.id) };
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
    if (["implementation", "quality_verification", "acceptance_delivery"].includes(item.stage)) {
      return {
        requirement: item,
        stage: item.stage,
        deliveryUnits: store.deliveryUnits.listForRequirement(item.id),
        deliveryDependencies: store.deliveryUnits.listDependencies(item.id),
        automationPending: true
      };
    }
    if (item.stage !== "definition" && item.stage !== "solution_design") {
      return reply.code(409).send({ error: "REQUIREMENT_AI_STAGE_UNSUPPORTED", stage: item.stage });
    }
    const existing = store.listStageRuns(item.id, item.stage).find((run: any) => run.status === "running");
    if (existing) return reply.code(409).send({ error: "RUN_ALREADY_ACTIVE", message: "当前阶段已有 AI 正在执行" });
    if(item.status!=="ai_ready")return reply.code(409).send({error:"REQUIREMENT_RUN_NOT_READY",message:"当前需求状态不能启动 AI"});
    const associatedProjects=(item.projects??[]).map((association:any)=>store.getProject(association.projectId)).filter(Boolean);
    const sensitivePatterns=[...new Set(associatedProjects.flatMap((associated:any)=>associated.sensitivePatterns??[]))] as string[];
    const reworkContext=item.status==="returned"?store.getLatestReworkContext(item.id):null;
    const projectContextBudget=resolveProjectContextBudget(process.env.AI_PROJECT_CONTEXT_MAX_CHARS);
    let projectContext:any;
    try{projectContext=await buildRequirementProjectContext(store,item.id,item.stage,projectContextBudget);}
    catch(error){return sendProjectContextError(reply,error);}
    const allPriorArtifacts=store.listArtifacts(item.id),approvalHistory=store.listApprovals(item.id);
    const approvedDefinition=item.stage==="solution_design"?approvedDefinitionFrom(allPriorArtifacts,approvalHistory):undefined;
    const priorArtifacts=item.stage==="solution_design"?allPriorArtifacts.filter((artifact:any)=>artifact.stage!=="definition"):allPriorArtifacts;
    const context = redactSensitive({ requirement: item, priorArtifacts, approvalHistory, approvedDefinition, projectContext, reworkRequired:Boolean(reworkContext), reworkContext, userContext: req.body?.context },sensitivePatterns);
    if(context.projectContext){
      for(const block of context.projectContext.projects){do{block.totalChars=JSON.stringify(block).length;}while(block.totalChars!==JSON.stringify(block).length);}
      context.projectContext.totalChars=JSON.stringify(context.projectContext.projects).length;
      if(context.projectContext.totalChars>context.projectContext.budgetMaxChars)return sendProjectContextError(reply,new ProjectContextError("PROJECT_CONTEXT_BUDGET_TOO_SMALL",[],{maxChars:context.projectContext.budgetMaxChars,minimumRequiredChars:context.projectContext.totalChars,projectCount:context.projectContext.projects.length}));
    }
    const model = process.env.OPENAI_MODEL || "gpt-5.5";
    let run:any;
    try{run=store.createStageRun({ requirementId: item.id, stage: item.stage, model, input: context, expectedRequirementUpdatedAt:item.updatedAt, expectedRequirementStatus:item.status, expectedRequirementProjectIds:(item.projects??[]).map((project:any)=>project.id) });}
    catch(error){return sendDomainError(reply,error);}
    for(const block of context.projectContext?.projects??[])store.appendStageRunEvent(run.id,"knowledge.retrieved",{projectId:block.projectId,version:block.version,sourceHead:block.sourceHead,paths:block.entries.map((entry:any)=>entry.path),totalAvailable:block.totalAvailable,budgetMaxChars:context.projectContext.budgetMaxChars,totalChars:block.totalChars,contextTotalChars:context.projectContext.totalChars,truncated:block.truncated});
    void executeRun(run.id, item, context, sensitivePatterns);
    return reply.code(202).send(run);

    async function executeRun(runId: string, runItem: any, runContext: any, patterns:string[]) {
      const emit = (type: string, payload: unknown) => store.appendStageRunEvent(runId, type, redactSensitive(payload, patterns));
    try {
      const content = await runAgent(runItem.stage, runContext, emit);
      let gate = evaluateGate(runItem.stage, content, store.getGateConfig());
      const blockingQuestions=runItem.stage==="definition"&&"blockingQuestions" in content&&Array.isArray(content.blockingQuestions)?content.blockingQuestions:[];
      if (blockingQuestions.length) {
        gate = {
          decision: "human_review" as const,
          reasons: [`存在 ${blockingQuestions.length} 个高风险阻塞问题`]
        };
      } else if (runItem.stage === "solution_design") {
        gate = {
          decision: "human_review" as const,
          reasons: ["方案设计必须经人工审批，审批将冻结项目关联并创建交付计划"]
        };
      }
      store.commitStageRunSuccess({
        runId,
        requirementId: runItem.id,
        stage: runItem.stage,
        title: `${stageLabel(runItem.stage)} AI 成果`,
        content,
        output: redactSensitive(content, patterns),
        gate
      });
      try { refreshRequirementKnowledge(store, runItem.id); }
      catch { /* The run is committed; knowledge extraction remains best effort. */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 执行失败";
      store.failStageRun(runId, redactSensitive(message,patterns));
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
    const parsed = gateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", message: "门禁配置无效" });
    }
    return store.updateGateConfig(parsed.data);
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

function approvedDefinitionFrom(artifacts:any[],approvals:any[]){
  const approval=approvals.find((entry:any)=>entry.stage==="definition"&&["approve","conditional"].includes(entry.decision)&&entry.artifact_id);
  if(!approval)return undefined;
  const artifact=artifacts.find((entry:any)=>entry.id===approval.artifact_id);
  return artifact?{artifactId:artifact.id,content:artifact.content}:undefined;
}

function invalidRepository(reply:any,details:any){return reply.code(400).send({error:"PROJECT_REPOSITORY_INVALID",message:details.warnings?.[0]||"项目仓库无效",details});}
function applyRequirementProjects(store:WorkflowStore,requirementId:string,inputs:any[]){
  const result=store.replaceRequirementProjectsAndInvalidate(requirementId,inputs);
  return {requirement:store.getRequirement(requirementId),...result,snapshot:store.getRequirementProjectSnapshot(requirementId)};
}
function sendDomainError(reply:any,error:unknown){const message=error instanceof Error?error.message:"VALIDATION_ERROR";if(message==="PROJECT_REPO_PATH_EXISTS")return reply.code(409).send({error:message,message:"仓库路径已被其他项目使用"});if(message==="REQUIREMENT_NOT_FOUND")return reply.code(404).send({error:"NOT_FOUND"});if(["PROJECT_NOT_FOUND","PROJECT_NOT_ACTIVE","MODULE_NOT_FOUND","MODULE_INDEX_REQUIRED","MODULE_ID_INVALID"].includes(message))return reply.code(400).send({error:"VALIDATION_ERROR",message});if(message==="REQUIREMENT_DELIVERY_PLAN_FROZEN")return reply.code(409).send({error:message,message:"交付计划已冻结，不能修改项目、版本或模块范围"});if(["RUN_ALREADY_ACTIVE","REQUIREMENT_RUN_NOT_READY","REQUIREMENT_AI_STAGE_UNSUPPORTED","REQUIREMENT_CHANGED_DURING_RUN_PREPARATION","PROJECT_CHANGED_DURING_RUN_PREPARATION","PROJECT_IN_ACTIVE_EXECUTION","REQUIREMENT_VERSION_REQUIRED","REQUIREMENT_VERSION_PROJECT_MISMATCH","PROJECT_VERSION_NOT_ACTIVE","PROJECT_ARCHIVED","REQUIREMENT_APPROVAL_STATE_CHANGED","REQUIREMENT_APPROVAL_NOT_READY"].includes(message))return reply.code(409).send({error:message,message});return reply.code(400).send({error:"VALIDATION_ERROR",message});}
function sendProjectContextError(reply:any,error:unknown){
  if(!(error instanceof ProjectContextError))return reply.code(409).send({error:"PROJECT_KNOWLEDGE_UNAVAILABLE",message:error instanceof Error?error.message:"项目知识库不可用"});
  const messages:Record<string,string>={PROJECT_REQUIRED:"当前阶段必须关联一个交付项目",PROJECT_ARCHIVED:"归档项目不能启动新执行",PROJECT_KNOWLEDGE_BUILDING:"项目知识库正在生成，请稍后重试",PROJECT_KNOWLEDGE_UNAVAILABLE:"项目知识库不可用",PROJECT_CONTEXT_BUDGET_TOO_SMALL:"项目上下文预算不足，请提高配置或减少关联项目"};
  return reply.code(error.code==="REQUIREMENT_NOT_FOUND"?404:409).send({error:error.code,message:messages[error.code]??error.code,projects:error.projects,details:error.details});
}
