import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ run: vi.fn() }));
const repository = vi.hoisted(() => ({ getWorktreeSnapshot: vi.fn() }));
vi.mock("./ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai.js")>();
  return { ...actual, runAgent: agent.run };
});
vi.mock("./codex-runner.js", () => ({ runCodexCoding: vi.fn() }));
vi.mock("./repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repository.js")>();
  return { ...actual, getWorktreeSnapshot: repository.getWorktreeSnapshot };
});

import { buildApp } from "./app.js";
import { runCodexCoding } from "./codex-runner.js";
import { WorkflowStore } from "./store.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { publishRequirementKnowledge } from "./project-memory-service.js";
import { buildAgentPrompt, runAgent } from "./ai.js";

const execFileAsync=promisify(execFile);const tempDirs:string[]=[];
const codingResult={runId:crypto.randomUUID(),branch:"ai/REQ-0001",worktreePath:"/tmp/requirements/REQ-0001",baseCommit:"version-head",reused:false,diff:"diff --git a/a.ts b/a.ts\n+change",files:["a.ts"],changedFiles:[{path:"a.ts",status:"modified" as const,kind:"text" as const,content:"change"}],additions:1,deletions:0,codexThreadId:"thread-1",events:[],diagnostics:[],summary:"implemented",evidenceSnapshot:{diff:"diff --git a/a.ts b/a.ts\n+change",files:["a.ts"],changedFiles:[{path:"a.ts",status:"modified" as const,kind:"text" as const,content:"change"}],additions:1,deletions:0,identity:{repositoryPath:"/tmp/repo",gitCommonDir:"/tmp/repo/.git",worktreePath:"/tmp/requirements/REQ-0001",branch:"ai/REQ-0001",headCommit:"version-head"},manifest:{version:1 as const,entries:[]},manifestHash:"manifest-hash",evidenceHash:"evidence-hash"}};
const genericResult={conclusion:"pass",confidence:0.99,summary:"ready",facts:[],assumptions:[],openQuestions:[],risks:[],findings:[]};
const definitionResult={...genericResult,underlyingGoal:"ship",targetUsers:["buyer"],productDecisions:[],assumptions:[],scope:{mvp:["checkout"],nonGoals:[]},flows:{primary:["order"],exceptions:[]},acceptanceCriteria:["order succeeds"],evidence:[],blockingQuestions:[]};
const solutionResult=(projectIds:string[])=>({...genericResult,deliveryPlan:{units:projectIds.map(projectId=>({projectId,moduleIds:[],acceptanceCriteria:[`${projectId} acceptance`]})),dependencies:projectIds.length>1?[{upstreamProjectId:projectIds[0]!,downstreamProjectId:projectIds[1]!,releaseCondition:"automated_testing_passed" as const}]:[]},contracts:[]});
beforeEach(()=>{vi.mocked(runCodexCoding).mockReset().mockResolvedValue(codingResult);agent.run.mockReset().mockResolvedValue(definitionResult);repository.getWorktreeSnapshot.mockReset();});

const stores: WorkflowStore[] = [];
const initialProjectContextBudget = process.env.AI_PROJECT_CONTEXT_MAX_CHARS;
let fixtureProjectSequence = 0;
function ensureProjectVersion(store: WorkflowStore, projectId: string) {
  const existing=store.listProjectVersions(projectId,"active")[0];if(existing)return existing;
  const project=store.getProject(projectId)!;
  return store.createProjectVersion({projectId,name:"fixture",branch:project.defaultBranch,baseBranch:project.defaultBranch,worktreePath:`/tmp/api-project-version-${projectId}`,headCommit:"fixture-head"});
}
function createRequirement(store: WorkflowStore, input: any) {
  if (input.primaryProjectId) return store.createRequirement({...input,primaryProjectVersionId:input.primaryProjectVersionId??ensureProjectVersion(store,input.primaryProjectId).id});
  fixtureProjectSequence += 1;
  const project = store.createProject({ name: `API fixture ${fixtureProjectSequence}`, repoPath: `/tmp/api-requirement-fixture-${fixtureProjectSequence}`, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
  return store.createRequirement({ ...input, primaryProjectId: project.id,primaryProjectVersionId:ensureProjectVersion(store,project.id).id });
}
afterEach(async() => {stores.splice(0).forEach((store) => store.close());for(const dir of tempDirs.splice(0))await rm(dir,{recursive:true,force:true});if(initialProjectContextBudget===undefined)delete process.env.AI_PROJECT_CONTEXT_MAX_CHARS;else process.env.AI_PROJECT_CONTEXT_MAX_CHARS=initialProjectContextBudget});

async function branchRepo(){const dir=await mkdtemp(join(tmpdir(),"workflow-api-branches-"));tempDirs.push(dir);await execFileAsync("git",["init","-b","main",dir]);await execFileAsync("git",["-C",dir,"config","user.email","test@example.com"]);await execFileAsync("git",["-C",dir,"config","user.name","Test"]);await writeFile(join(dir,"README.md"),"base\n");await execFileAsync("git",["-C",dir,"add","--all"]);await execFileAsync("git",["-C",dir,"commit","-m","base"]);await execFileAsync("git",["-C",dir,"switch","-c","feature/0710-test"]);return dir;}

async function projectRepo(name="workflow-api-project-") {
  const dir=await mkdtemp(join(tmpdir(),name));tempDirs.push(dir);
  await execFileAsync("git",["init","-b","main",dir]);
  await execFileAsync("git",["-C",dir,"config","user.email","test@example.com"]);
  await execFileAsync("git",["-C",dir,"config","user.name","Test"]);
  await writeFile(join(dir,"package.json"),JSON.stringify({dependencies:{fastify:"latest"}}));
  await execFileAsync("git",["-C",dir,"add","--all"]);await execFileAsync("git",["-C",dir,"commit","-m","base"]);
  return dir;
}


class RunPreparationRacingStore extends WorkflowStore {
  beforeRunCreate: (() => void) | undefined;
  override createStageRun(input: Parameters<WorkflowStore["createStageRun"]>[0]) {
    const race=this.beforeRunCreate;this.beforeRunCreate=undefined;race?.();
    return super.createStageRun(input);
  }
}

class FailingKnowledgeRefreshStore extends WorkflowStore {
  override replaceKnowledgeCandidates(): any[] {
    throw new Error("knowledge refresh failed");
  }
}

async function waitForRun(store: WorkflowStore, runId: string) {
  for (let attempt = 0; attempt < 50 && store.getStageRun(runId)?.status === "running"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.getStageRun(runId);
}


const projectPayload=(repoPath:string,extra:any={})=>({name:"API project",repoPath,defaultBranch:"main",allowedCommands:[],sensitivePatterns:[],...extra});

describe("project and requirement association APIs",()=>{
  it("runs definition immediately after creating a requirement through the API",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});const app=await buildApp(store);
    const created=await app.inject({method:"POST",url:"/api/requirements",payload:{title:"需求定义",businessProblem:"需要从新建需求直接开始定义",expectedOutcome:"无需修正阶段即可运行",priority:"medium",primaryProjectId:project.id,primaryProjectVersionId:version.id}});

    expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({stage:"definition",status:"ai_ready"});
    const response=await app.inject({method:"POST",url:`/api/requirements/${created.json().id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(response.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(runAgent).toHaveBeenCalledWith("definition",expect.any(Object),expect.any(Function));await app.close();
  });

  it("runs definition with product output and all active project context",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));
    const req=createRequirement(store,{title:"需求定义",businessProblem:"需要明确业务目标和验收标准",expectedOutcome:"形成定义",priority:"medium",primaryProjectId:project.id});
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"definition","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(response.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(runAgent).toHaveBeenCalledWith("definition",expect.objectContaining({projectContext:expect.objectContaining({projects:[expect.objectContaining({projectId:project.id})]})}),expect.any(Function));
    expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"ai_ready"});await app.close();
  });

  it("keeps an atomically completed auto-approved run successful when knowledge refresh fails", async () => {
    const store = new FailingKnowledgeRefreshStore(":memory:"); stores.push(store);
    const project = store.createProject(projectPayload(await projectRepo(), { name: "Refresh failure" }));
    const req = createRequirement(store, { title: "知识刷新故障", businessProblem: "提交后刷新可能失败", expectedOutcome: "运行结果保持成功", priority: "high", primaryProjectId: project.id });
    const knowledge = store.beginProjectKnowledge(project.id, "fixture-head", "test");
    store.completeProjectKnowledge(knowledge.id, { summary: "ready", entries: [] });
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} });
    const run = await waitForRun(store, response.json().id);

    expect(run).toMatchObject({ status: "completed", output: expect.objectContaining({ summary: "ready" }) });
    expect(store.getRequirement(req.id)).toMatchObject({ stage: "solution_design", status: "ai_ready" });
    expect(store.listArtifacts(req.id)).toHaveLength(1);
    expect(store.listApprovals(req.id)).toHaveLength(1);
    await app.close();
  });

  it.each([
    ["automatic approval", definitionResult],
    ["human review", { ...definitionResult, blockingQuestions: [{ question: "谁批准？", impact: "权限边界", options: ["负责人"] }] }],
    ["automatic return", { ...definitionResult, conclusion: "return" }]
  ])("rolls back the entire %s success commit when run completion fails", async (_case, result) => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject(projectPayload(await projectRepo(), { name: `Atomic ${_case}` }));
    const req = createRequirement(store, { title: `原子提交 ${_case}`, businessProblem: "后段写入可能失败", expectedOutcome: "不留下部分状态", priority: "high", primaryProjectId: project.id });
    const knowledge = store.beginProjectKnowledge(project.id, "fixture-head", "test");
    store.completeProjectKnowledge(knowledge.id, { summary: "ready", entries: [] });
    agent.run.mockResolvedValue(result);
    (store as any).db.exec(`CREATE TRIGGER fail_run_completion
      BEFORE UPDATE OF status ON stage_runs
      WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'RUN_COMPLETION_FAILED'); END;`);
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} });
    const run = await waitForRun(store, response.json().id);

    expect(run).toMatchObject({ status: "failed", error: "RUN_COMPLETION_FAILED" });
    expect(run?.events.some((event: any) => event.type === "gate.decided")).toBe(false);
    expect(store.getRequirement(req.id)).toMatchObject({ stage: "definition", status: "ai_ready" });
    expect(store.listArtifacts(req.id)).toEqual([]);
    expect(store.listApprovals(req.id)).toEqual([]);
    expect(store.getLatestReworkContext(req.id)).toBeNull();
    await app.close();
  });

  it("does not commit generated output after the claimed requirement becomes stale", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject(projectPayload(await projectRepo(), { name: "Stale success" }));
    const req = createRequirement(store, { title: "过期成功", businessProblem: "运行期间状态会变化", expectedOutcome: "拒绝过期输出", priority: "high", primaryProjectId: project.id });
    const knowledge = store.beginProjectKnowledge(project.id, "fixture-head", "test");
    store.completeProjectKnowledge(knowledge.id, { summary: "ready", entries: [] });
    let resolveAgent!: (value: any) => void;
    agent.run.mockImplementation(() => new Promise((resolve) => { resolveAgent = resolve; }));
    const app = await buildApp(store);
    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} });

    store.updateRequirementState(req.id, "definition", "awaiting_approval");
    resolveAgent(definitionResult);
    const run = await waitForRun(store, response.json().id);

    expect(run?.status).toBe("failed");
    expect(store.getRequirement(req.id)).toMatchObject({ stage: "definition", status: "awaiting_approval" });
    expect(store.listArtifacts(req.id)).toEqual([]);
    expect(store.listApprovals(req.id)).toEqual([]);
    await app.close();
  });

  it("keeps solution design on human review and creates its delivery plan only after approval", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject(projectPayload(await projectRepo(), { name: "Integrated plan" }));
    const req = createRequirement(store, { title: "集成交付计划", businessProblem: "方案需先审批再冻结", expectedOutcome: "审批后创建交付单元", priority: "high", primaryProjectId: project.id });
    const knowledge = store.beginProjectKnowledge(project.id, "fixture-head", "test");
    store.completeProjectKnowledge(knowledge.id, { summary: "ready", entries: [] });
    const definition = store.addArtifact(req.id, "definition", "Approved definition", definitionResult);
    store.addApproval(req.id, "definition", { decision: "approve", comment: "approved", artifactId: definition.id });
    store.updateRequirementState(req.id, "solution_design", "ai_ready");
    agent.run.mockResolvedValue(solutionResult([project.id]));
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} });
    const run = await waitForRun(store, response.json().id);

    expect(run?.status).toBe("completed");
    expect(store.getRequirement(req.id)).toMatchObject({ stage: "solution_design", status: "awaiting_approval" });
    expect(store.deliveryUnits.listForRequirement(req.id)).toEqual([]);
    const approval = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/approve`, payload: { decision: "approve", comment: "freeze plan" } });
    expect(approval.statusCode).toBe(200);
    expect(store.getRequirement(req.id)).toMatchObject({ stage: "implementation", status: "ai_ready" });
    expect(store.deliveryUnits.listForRequirement(req.id)).toHaveLength(1);
    await app.close();
  });

  it("keeps definition awaiting approval when product blockers remain",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));
    const req=createRequirement(store,{title:"阻塞定义",businessProblem:"权限边界需要业务负责人决定",expectedOutcome:"阻塞问题待审批",priority:"high",primaryProjectId:project.id});
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"definition","ai_ready");agent.run.mockResolvedValue({...definitionResult,blockingQuestions:[{question:"谁可批准退款？",impact:"决定权限边界",options:["财务主管","运营主管"]}]});const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(response.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(store.getRequirement(req.id)).toMatchObject({stage:"definition",status:"awaiting_approval"});expect(store.getStageRun(response.json().id)?.events.find((event:any)=>event.type==="gate.decided")?.payload).toMatchObject({decision:"human_review"});agent.run.mockClear();
    const repeated=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(repeated.statusCode).toBe(409);expect(repeated.json()).toMatchObject({error:"REQUIREMENT_RUN_NOT_READY"});expect(store.listStageRuns(req.id)).toHaveLength(1);expect(runAgent).not.toHaveBeenCalled();await app.close();
  });

  it.each(["state","association"] as const)("rejects a %s race after run context preparation without starting the agent",async(race)=>{
    const store=new RunPreparationRacingStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const replacement=store.createProject(projectPayload(await projectRepo(),{name:"Race replacement"}));const req=createRequirement(store,{title:"运行准备竞争",businessProblem:"上下文准备期间状态或关联可能变化",expectedOutcome:"拒绝过期上下文",priority:"high",primaryProjectId:project.id});
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"definition","ai_ready");
    const expectedUpdatedAt=store.getRequirement(req.id)!.updatedAt;store.beforeRunCreate=()=>{if(race==="state")store.updateRequirementState(req.id,"definition","awaiting_approval");else{store.replaceRequirementProjects(req.id,[{projectId:replacement.id,projectVersionId:ensureProjectVersion(store,replacement.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]);(store as any).db.prepare("UPDATE requirements SET updated_at = ? WHERE id = ?").run(expectedUpdatedAt,req.id);}};const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"REQUIREMENT_CHANGED_DURING_RUN_PREPARATION"});expect(store.listStageRuns(req.id)).toEqual([]);expect(runAgent).not.toHaveBeenCalled();await app.close();
  });

  it("atomically admits only one of two concurrent requirement runs",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const req=createRequirement(store,{title:"并发启动",businessProblem:"重复请求不能启动两个模型",expectedOutcome:"单一运行 claim",priority:"high",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"definition","ai_ready");let resolveAgent!:(value:any)=>void;agent.run.mockImplementation(()=>new Promise(resolve=>{resolveAgent=resolve}));const app=await buildApp(store);

    const responses=await Promise.all([app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}}),app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}})]);

    expect(responses.map(response=>response.statusCode).sort()).toEqual([202,409]);expect(responses.find(response=>response.statusCode===409)?.json()).toMatchObject({error:"RUN_ALREADY_ACTIVE"});expect(store.listStageRuns(req.id)).toHaveLength(1);expect(runAgent).toHaveBeenCalledTimes(1);resolveAgent(definitionResult);await app.close();
  });

  it("does not let a stale failed run restore an obsolete requirement state",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const req=createRequirement(store,{title:"过期失败恢复",businessProblem:"旧运行失败不能覆盖新状态",expectedOutcome:"CAS 保留新状态",priority:"high",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"definition","ai_ready");let rejectAgent!:(reason:Error)=>void;agent.run.mockImplementation(()=>new Promise((_resolve,reject)=>{rejectAgent=reject}));const app=await buildApp(store);
    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(response.statusCode).toBe(202);store.updateRequirementState(req.id,"solution_design","ai_ready");rejectAgent(new Error("stale failure"));for(let attempt=0;attempt<50&&store.getStageRun(response.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));

    expect(store.getStageRun(response.json().id)?.status).toBe("failed");expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"ai_ready"});await app.close();
  });

  it("binds the generated definition artifact before passing it to solution design",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});agent.run.mockResolvedValue({...definitionResult,summary:"approved generated definition",blockingQuestions:[{question:"谁可批准退款？",impact:"决定权限边界",options:["财务主管","运营主管"]}]});const app=await buildApp(store);
    const created=await app.inject({method:"POST",url:"/api/requirements",payload:{title:"方案输入链路",businessProblem:"方案必须使用服务端批准的定义成果",expectedOutcome:"定义与方案输入可追溯",priority:"high",primaryProjectId:project.id,primaryProjectVersionId:version.id}});const requirementId=created.json().id;

    const definitionRun=await app.inject({method:"POST",url:`/api/requirements/${requirementId}/run`,payload:{}});expect(definitionRun.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(definitionRun.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    const definition=store.getLatestArtifact(requirementId,"definition");expect(definition).toMatchObject({content:expect.objectContaining({summary:"approved generated definition"})});
    const approval=await app.inject({method:"POST",url:`/api/requirements/${requirementId}/approve`,payload:{decision:"approve",comment:"批准服务端定义",artifactId:"client-forged-artifact-id"}});

    expect(approval.statusCode).toBe(200);expect(store.listApprovals(requirementId)[0]).toMatchObject({stage:"definition",artifact_id:definition!.id});
    agent.run.mockClear();agent.run.mockResolvedValue(solutionResult([project.id]));
    const solutionRun=await app.inject({method:"POST",url:`/api/requirements/${requirementId}/run`,payload:{}});expect(solutionRun.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(solutionRun.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(runAgent).toHaveBeenCalledWith("solution_design",expect.objectContaining({approvedDefinition:{artifactId:definition!.id,content:expect.objectContaining({summary:"approved generated definition"})}}),expect.any(Function));await app.close();
  });

  it("exposes approved definition only through the dedicated solution-design context",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});const app=await buildApp(store);
    const created=await app.inject({method:"POST",url:"/api/requirements",payload:{title:"方案输入隔离",businessProblem:"未批准定义不能进入方案上下文",expectedOutcome:"只暴露批准定义",priority:"high",primaryProjectId:project.id,primaryProjectVersionId:version.id}});const requirementId=created.json().id;
    const approved=store.addArtifact(requirementId,"definition","Approved definition",{...definitionResult,summary:"current approved definition"});store.updateRequirementState(requirementId,"definition","awaiting_approval");
    const approval=await app.inject({method:"POST",url:`/api/requirements/${requirementId}/approve`,payload:{decision:"approve",comment:"批准当前定义"}});expect(approval.statusCode).toBe(200);
    store.addArtifact(requirementId,"definition","Unapproved definition",{summary:"unapproved definition secret"});
    const priorSolution=store.addArtifact(requirementId,"solution_design","Prior solution attempt",{summary:"retain prior solution context"});agent.run.mockClear();agent.run.mockResolvedValue(solutionResult([project.id]));

    const response=await app.inject({method:"POST",url:`/api/requirements/${requirementId}/run`,payload:{}});

    expect(response.statusCode).toBe(202);for(let attempt=0;attempt<50&&store.getStageRun(response.json().id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    const context=vi.mocked(runAgent).mock.calls[0]![1] as any;
    expect(context.approvedDefinition).toMatchObject({artifactId:approved.id,content:{summary:"current approved definition"}});
    expect(context.priorArtifacts).toEqual([expect.objectContaining({id:priorSolution.id,stage:"solution_design",content:{summary:"retain prior solution context"}})]);
    expect(JSON.stringify(context)).not.toContain("unapproved definition secret");await app.close();
  });

  it("uses the later positive approval when two definition approvals share one timestamp",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const req=createRequirement(store,{title:"稳定审批顺序",businessProblem:"同一时钟刻度可能写入两次审批",expectedOutcome:"后写审批获胜",priority:"high",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});const first=store.addArtifact(req.id,"definition","First definition",{...definitionResult,summary:"first approved definition"}),second=store.addArtifact(req.id,"definition","Second definition",{...definitionResult,summary:"later approved definition"}),now="2026-07-20T00:00:00.000Z";
    store.withImmediateTransaction(()=>{store.insertApprovalInTransaction(req.id,"definition",{decision:"approve",comment:"first",artifactId:first.id},now);store.insertApprovalInTransaction(req.id,"definition",{decision:"conditional",comment:"later",condition:"track",artifactId:second.id},now);});store.updateRequirementState(req.id,"solution_design","ai_ready");agent.run.mockResolvedValue(solutionResult([project.id]));const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);expect(store.listApprovals(req.id).filter((approval:any)=>approval.stage==="definition").map((approval:any)=>approval.artifact_id)).toEqual([second.id,first.id]);expect(vi.mocked(runAgent).mock.calls[0]![1]).toMatchObject({approvedDefinition:{artifactId:second.id,content:{summary:"later approved definition"}}});await app.close();
  });

  it("returns a stable budget error before creating a run",async()=>{
    process.env.AI_PROJECT_CONTEXT_MAX_CHARS="4000";
    const store=new WorkflowStore(":memory:");stores.push(store);
    const paths=["server","web","shared","docs","server/src","web/src","shared/src","docs/superpowers","docs/superpowers/specs","docs/superpowers/plans","web/node_modules","web/node_modules/lucide-react","web/node_modules/lucide-react/dist","web/node_modules/lucide-react/dist/esm","web/node_modules/lucide-react/dist/esm/shared","web/node_modules/lucide-react/dist/esm/icons"];
    const projects=paths.map((path,index)=>store.createProject(projectPayload(join(process.cwd(),path),{name:`Context ${index}`})));
    const req=createRequirement(store,{title:"预算约束",businessProblem:"项目上下文过多",expectedOutcome:"稳定拒绝",priority:"medium",primaryProjectId:projects[0]!.id});
    store.replaceRequirementProjects(req.id,projects.map((project,position)=>({projectId:project.id,role:position===0?"primary":"collaborator",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position})));
    for(const project of projects){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"",entries:[]});}
    store.updateRequirementState(req.id,"solution_design","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"PROJECT_CONTEXT_BUDGET_TOO_SMALL",details:{maxChars:4_000,projectCount:projects.length}});
    expect(store.listStageRuns(req.id)).toHaveLength(0);
    await app.close();
  });

  it("stores all solution-design project context and one retrieval event per project",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const primaryRepo=await projectRepo(),deliveryRepo=await projectRepo();
    const primary=store.createProject(projectPayload(primaryRepo,{name:"Architecture"})),delivery=store.createProject(projectPayload(deliveryRepo,{name:"Orders"}));
    const req=createRequirement(store,{title:"订单设计",businessProblem:"跨项目设计",expectedOutcome:"可执行设计",priority:"medium",primaryProjectId:primary.id});
    store.replaceRequirementProjects(req.id,[{projectId:primary.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:0},{projectId:delivery.id,projectVersionId:ensureProjectVersion(store,delivery.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:1}]);
    for(const project of [primary,delivery]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} knowledge`,entries:[{path:"src/orders",kind:"module",title:"Orders",content:"orders",tags:[]}]});}
    store.updateRequirementState(req.id,"solution_design","ai_ready");agent.run.mockResolvedValue(solutionResult([primary.id,delivery.id]));const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);const run=store.getStageRun(response.json().id) as any;
    expect(run.input.projectContext.projects.map((project:any)=>project.projectId)).toEqual([primary.id,delivery.id]);
    expect(run.input.projectContext).toMatchObject({budgetMaxChars:200_000,truncated:false});
    expect(run.events.filter((event:any)=>event.type==="knowledge.retrieved").map((event:any)=>event.payload)).toMatchObject([{projectId:primary.id,budgetMaxChars:200_000},{projectId:delivery.id,budgetMaxChars:200_000}]);
    for(let attempt=0;attempt<50&&store.getStageRun(run.id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(runAgent).toHaveBeenCalledWith("solution_design",expect.objectContaining({projectContext:expect.objectContaining({projects:[expect.objectContaining({projectId:primary.id}),expect.objectContaining({projectId:delivery.id})]})}),expect.any(Function));expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"awaiting_approval"});expect(store.deliveryUnits.listForRequirement(req.id)).toEqual([]);
    await app.close();
  });

  it("rejects implementation runs without starting requirement-level execution",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const primaryRepo=await projectRepo(),deliveryRepo=await projectRepo();
    const primary=store.createProject(projectPayload(primaryRepo,{name:"Architecture"})),delivery=store.createProject(projectPayload(deliveryRepo,{name:"Orders"}));
    const req=createRequirement(store,{title:"订单编码",businessProblem:"按设计编码",expectedOutcome:"交付订单",priority:"medium",primaryProjectId:primary.id});
    store.replaceRequirementProjects(req.id,[{projectId:primary.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:0},{projectId:delivery.id,projectVersionId:ensureProjectVersion(store,delivery.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:1}]);
    for(const project of [primary,delivery]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} knowledge`,entries:[]});}
    store.updateRequirementState(req.id,"implementation","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"DELIVERY_UNIT_AUTOMATION_OWNS_STAGE",stage:"implementation"});
    expect(runAgent).not.toHaveBeenCalled();expect(runCodexCoding).not.toHaveBeenCalled();expect(store.listStageRuns(req.id)).toEqual([]);expect(store.listExecutions(req.id)).toEqual([]);
    await app.close();
  });

  it("reports coding evidence validity from the complete evidence fingerprint", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject(projectPayload("/tmp/evidence-status-project", { sensitivePatterns: [".env*"] }));
    const version = ensureProjectVersion(store, project.id);
    const req = createRequirement(store, {
      title: "证据状态", businessProblem: "完整证据哈希需要正确展示", expectedOutcome: "有效证据不被误报", priority: "medium",
      primaryProjectId: project.id, primaryProjectVersionId: version.id
    });
    const unit = store.deliveryUnits.createPlan({
      requirementId: req.id,
      snapshot: store.createRequirementProjectSnapshot(req.id),
      plan: { units: [{ projectId: project.id, moduleIds: [], acceptanceCriteria: ["passes"] }], dependencies: [] }
    }).units[0]!;
    const execution = store.addExecution({
      requirementId: req.id, deliveryUnitId: unit.id, evidenceVersion: 1, stage: "implementation",
      projectId: project.id, projectVersionId: version.id, branch: "ai/REQ-0001",
      worktreePath: "/tmp/evidence-status-worktree", baseCommit: "base", status: "completed", diff: "legacy diff"
    });
    store.addCodingEvidence({
      executionId: execution.id, requirementId: req.id, deliveryUnitId: unit.id, evidenceVersion: 1,
      projectId: project.id, branch: "ai/REQ-0001", worktreePath: "/tmp/evidence-status-worktree",
      diffHash: "complete-evidence-fingerprint", diff: "legacy diff",
      sourceRepoPath: "/tmp/evidence-status-project", gitCommonDir: "/tmp/evidence-status-project/.git",
      sourceHead: "base", manifestHash: "manifest-hash", manifest: { version: 1, entries: [] },
      changedFiles: [], originalChars: 11, truncated: false
    });
    repository.getWorktreeSnapshot.mockResolvedValue({
      diff: "different diff-only hash", evidenceHash: "complete-evidence-fingerprint"
    });
    const app = await buildApp(store);

    const response = await app.inject({ method: "GET", url: `/api/requirements/${req.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().codingEvidence.status).toBe("valid");
    expect(repository.getWorktreeSnapshot).toHaveBeenCalledWith("/tmp/evidence-status-worktree", {
      sensitivePatterns: [".env*"]
    });
    await app.close();
  });

  it("validates without persistence and returns stable invalid repository errors",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const app=await buildApp(store);const repo=await projectRepo();
    const valid=await app.inject({method:"POST",url:"/api/projects/validate",payload:{repoPath:repo,defaultBranch:"main",name:"ignored"}});
    expect(valid.statusCode).toBe(200);expect(valid.json()).toMatchObject({valid:true,repoPath:await realpath(repo),category:"backend",technology:["node","fastify"]});expect(store.listProjects()).toHaveLength(0);
    const invalid=await app.inject({method:"POST",url:"/api/projects/validate",payload:{repoPath:repo,defaultBranch:"missing"}});
    expect(invalid.statusCode).toBe(400);expect(invalid.json()).toMatchObject({error:"PROJECT_REPOSITORY_INVALID",details:{valid:false}});
    await app.close();
  });

  it("creates detected projects, rejects duplicates, and validates repository edits before mutation",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const app=await buildApp(store);const first=await projectRepo();const second=await projectRepo();
    const created=await app.inject({method:"POST",url:"/api/projects",payload:projectPayload(first)});
    expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({repoPath:await realpath(first),category:"backend",technology:["node","fastify"]});
    expect((await app.inject({method:"POST",url:"/api/projects",payload:projectPayload(`${first}/.`)})).statusCode).toBe(409);
    const id=created.json().id;
    const invalid=await app.inject({method:"PATCH",url:`/api/projects/${id}`,payload:{repoPath:second,defaultBranch:"missing"}});
    expect(invalid.statusCode).toBe(400);expect(store.getProject(id)?.repoPath).toBe(await realpath(first));
    const updated=await app.inject({method:"PATCH",url:`/api/projects/${id}`,payload:{repoPath:second,category:null}});
    expect(updated.statusCode).toBe(200);expect(updated.json()).toMatchObject({repoPath:await realpath(second),category:null,technology:["node","fastify"]});
    const cleared=await app.inject({method:"PATCH",url:`/api/projects/${id}`,payload:{category:null}});
    expect(cleared.json().category).toBeNull();
    expect((await app.inject({method:"PATCH",url:`/api/projects/${id}`,payload:{}})).statusCode).toBe(400);
    await app.close();
  });

  it("preserves the project and active knowledge build when an identity update conflicts",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const first=await projectRepo(),second=await projectRepo();const project=store.createProject(projectPayload(first)),duplicate=store.createProject(projectPayload(second,{name:"Duplicate"}));const building=store.beginProjectKnowledge(project.id,"old-head","manual");const app=await buildApp(store);
    const response=await app.inject({method:"PATCH",url:`/api/projects/${project.id}`,payload:{repoPath:`${second}/.`}});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_REPO_PATH_EXISTS");expect(store.getProject(project.id)?.repoPath).toBe(await realpath(first));expect(store.getProjectKnowledgeVersion(building.id)).toMatchObject({status:"building"});expect(store.getProject(duplicate.id)?.repoPath).toBe(await realpath(second));await app.close();
  });

  it("filters and archives projects while blocking active delivery",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const other=await projectRepo();
    const project=store.createProject(projectPayload(repo));store.createProject(projectPayload(other,{name:"Other"}));
    const req=createRequirement(store,{title:"交付需求",businessProblem:"需要完成项目交付",expectedOutcome:"交付完成",priority:"medium",primaryProjectId:project.id});
    store.updateRequirementState(req.id,"implementation","ai_running");const app=await buildApp(store);
    const blocked=await app.inject({method:"POST",url:`/api/projects/${project.id}/archive`});expect(blocked.statusCode).toBe(409);expect(blocked.json().error).toBe("PROJECT_IN_ACTIVE_DELIVERY");
    store.updateRequirementState(req.id,"acceptance_delivery","completed");expect((await app.inject({method:"POST",url:`/api/projects/${project.id}/archive` })).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/api/projects/${project.id}/archive` })).json().status).toBe("archived");
    expect((await app.inject({method:"GET",url:"/api/projects?status=active"})).json()).toHaveLength(1);
    expect((await app.inject({method:"GET",url:"/api/projects?status=archived"})).json()).toHaveLength(1);
    expect((await app.inject({method:"GET",url:"/api/projects?status=all"})).json()).toHaveLength(2);
    expect((await app.inject({method:"GET",url:"/api/projects?status=nope"})).statusCode).toBe(400);await app.close();
  });

  it.each([["implementation","ai_ready"],["quality_verification","awaiting_approval"],["quality_verification","returned"],["acceptance_delivery","blocked"]] as const)("blocks archive during %s/%s delivery",async(stage,status)=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const req=createRequirement(store,{title:"活动交付",businessProblem:"项目仍有后续交付工作",expectedOutcome:"不能归档",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,stage,status);const app=await buildApp(store);
    const response=await app.inject({method:"POST",url:`/api/projects/${project.id}/archive`});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_IN_ACTIVE_DELIVERY");await app.close();
  });

  it("rejects new runs for a forcibly archived delivery project",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const req=createRequirement(store,{title:"归档保护",businessProblem:"归档项目不能启动新执行",expectedOutcome:"稳定拒绝",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"definition","ai_ready");store.archiveProject(project.id);const app=await buildApp(store);
    const run=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(run.statusCode).toBe(409);expect(run.json().error).toBe("PROJECT_ARCHIVED");await app.close();
  });

  it("cancels an old knowledge build before rebuilding after project identity edits",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const old=store.beginProjectKnowledge(project.id,"old-head","manual");await writeFile(join(repo,"next.txt"),"next\n");await execFileAsync("git",["-C",repo,"add","--all"]);await execFileAsync("git",["-C",repo,"commit","-m","next"]);const head=(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim();const app=await buildApp(store);
    expect((await app.inject({method:"PATCH",url:`/api/projects/${project.id}`,payload:{defaultBranch:"main"}})).statusCode).toBe(200);
    for(let i=0;i<40&&store.listProjectKnowledgeVersions(project.id).length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));const versions=store.listProjectKnowledgeVersions(project.id),latest=versions[0]!;expect(versions.find(item=>item.id===old.id)).toMatchObject({status:"canceled"});expect(latest).toMatchObject({sourceHead:head});expect(latest.id).not.toBe(old.id);await app.close();
  });

  it("gets and atomically replaces associations and keeps pre-design changes valid",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"关联需求",businessProblem:"需要多个项目上下文",expectedOutcome:"正确关联",priority:"medium",primaryProjectId:a.id});const app=await buildApp(store);
    const get=await app.inject({method:"GET",url:`/api/requirements/${req.id}/projects`});expect(get.json()).toMatchObject({projects:[{projectId:a.id}],snapshot:null});
    const replacement=[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0},{projectId:b.id,role:"collaborator",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:1}];
    expect((await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:replacement})).statusCode).toBe(200);expect(store.listRequirementProjects(req.id)).toHaveLength(2);expect(store.getRequirement(req.id)?.stage).toBe("definition");
    const bad=[...replacement,{...replacement[1],projectId:"missing",position:2}];expect((await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:bad})).statusCode).toBe(400);expect(store.listRequirementProjects(req.id)).toHaveLength(2);
    expect((await app.inject({method:"GET",url:"/api/requirements/missing/projects"})).statusCode).toBe(404);await app.close();
  });

  it("retains archived-project associations as read-only history after replacement",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const archived=store.createProject(projectPayload(await projectRepo(),{name:"Archived"}));const active=store.createProject(projectPayload(await projectRepo(),{name:"Active"}));
    const req=createRequirement(store,{title:"关联历史",businessProblem:"归档项目需要保留历史",expectedOutcome:"编辑后仍可追溯",priority:"medium",primaryProjectId:archived.id});store.replaceRequirementProjects(req.id,[{projectId:archived.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"auto",moduleIds:[],position:0}]);store.archiveProject(archived.id);const app=await buildApp(store);
    const payload=[{projectId:active.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"auto",moduleIds:[],position:0}];expect((await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:`/api/requirements/${req.id}/projects`})).json().projects).toMatchObject([{projectId:active.id,status:"active"},{projectId:archived.id,status:"archived",projectStatus:"archived"}]);await app.close();
  });

  it("returns bounded lightweight project modules and stable unavailable statuses",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const ready=store.createProject(projectPayload(await projectRepo(),{name:"Ready"}));const building=store.createProject(projectPayload(await projectRepo(),{name:"Building"}));
    const version=store.beginProjectKnowledge(ready.id,"head","test");store.completeProjectKnowledge(version.id,{summary:"modules",entries:[{id:"module:orders",kind:"module",moduleId:"orders",name:"Orders",path:"src/orders"},{id:"file:x",kind:"file",path:"src/x.ts"}]});store.beginProjectKnowledge(building.id,"head","test");const app=await buildApp(store);
    expect((await app.inject({method:"GET",url:`/api/projects/${ready.id}/modules`})).json()).toEqual({modules:[{id:"orders",name:"Orders",path:"src/orders"}],total:1,truncated:false});store.archiveProject(ready.id);expect((await app.inject({method:"GET",url:`/api/projects/${ready.id}/modules`})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:`/api/projects/${building.id}/modules`})).statusCode).toBe(409);expect((await app.inject({method:"GET",url:"/api/projects/missing/modules"})).statusCode).toBe(404);await app.close();
  });

  it("includes a valid selected module beyond the bounded module page",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo(),{name:"Paged"}));const version=store.beginProjectKnowledge(project.id,"head","test");store.completeProjectKnowledge(version.id,{summary:"many",entries:Array.from({length:401},(_,index)=>({id:`module:${index}`,kind:"module",moduleId:`module-${index}`,name:`Module ${index}`,path:`src/${index}`}))});const app=await buildApp(store);
    const response=await app.inject({method:"GET",url:`/api/projects/${project.id}/modules?include=module-300%2Cunknown&include=..%2Fbad`}),body=response.json();expect(body).toMatchObject({total:401,truncated:true});expect(body.modules).toHaveLength(257);expect(body.modules).toContainEqual({id:"module-300",name:"Module 300",path:"src/300"});expect(body.modules.some((item:any)=>item.id==="unknown"||item.id==="../bad")).toBe(false);const search=(await app.inject({method:"GET",url:`/api/projects/${project.id}/modules?q=Module%20400`})).json();expect(search).toMatchObject({total:1,truncated:false,modules:[{id:"module-400"}]});await app.close();
  });

  it("rejects project replacement while a solution-design snapshot is active",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"设计需求",businessProblem:"需要冻结项目设计上下文",expectedOutcome:"设计可追溯",priority:"medium",primaryProjectId:a.id});store.updateRequirementState(req.id,"solution_design","awaiting_approval");
    store.addArtifact(req.id,"solution_design","技术设计",{summary:"approved"});store.addApproval(req.id,"solution_design",{decision:"approve",comment:"通过"});store.createRequirementProjectSnapshot(req.id);const app=await buildApp(store);
    const payload=[{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}];
    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"REQUIREMENT_DELIVERY_PLAN_FROZEN"});expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"awaiting_approval",projects:[{projectId:a.id}]});
    expect(store.listApprovals(req.id)).toHaveLength(1);expect(store.listRequirementProjectSnapshots(req.id)).toMatchObject([{status:"active"}]);await app.close();
  });

  it("rejects delivery-version changes while a solution-design snapshot is active",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const first=ensureProjectVersion(store,project.id);const next=store.createProjectVersion({projectId:project.id,name:"next",branch:"release/next",baseBranch:"main",worktreePath:`/tmp/api-project-version-next-${project.id}`,headCommit:"next-head"});
    const req=createRequirement(store,{title:"旧接口变更",businessProblem:"旧接口也必须保持设计不变量",expectedOutcome:"统一失效行为",priority:"medium",primaryProjectId:project.id,primaryProjectVersionId:first.id});store.updateRequirementState(req.id,"solution_design","awaiting_approval");
    store.addArtifact(req.id,"solution_design","技术设计",{summary:"approved"});store.addApproval(req.id,"solution_design",{decision:"approve",comment:"通过"});store.createRequirementProjectSnapshot(req.id);const app=await buildApp(store);
    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:next.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"REQUIREMENT_DELIVERY_PLAN_FROZEN"});expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"awaiting_approval",projects:[{projectId:project.id,projectVersionId:first.id}]});
    expect(store.listApprovals(req.id)).toHaveLength(1);expect(store.listRequirementProjectSnapshots(req.id)[0]).toMatchObject({status:"active"});await app.close();
  });

  it("keeps frozen scope unchanged when the selected version HEAD advances",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const version=ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"版本推进",businessProblem:"同一版本会持续接收新的提交",expectedOutcome:"设计关联保持有效",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"solution_design","awaiting_approval");store.addArtifact(req.id,"solution_design","技术设计",{summary:"approved"});store.addApproval(req.id,"solution_design",{decision:"approve",comment:"通过"});const snapshot=store.createRequirementProjectSnapshot(req.id);store.updateProjectVersionHead(version.id,"advanced-head");const app=await buildApp(store);

    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:version.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"REQUIREMENT_DELIVERY_PLAN_FROZEN"});expect(store.getRequirementProjectSnapshot(req.id)?.id).toBe(snapshot.id);expect(store.getRequirement(req.id)).toMatchObject({stage:"solution_design",status:"awaiting_approval",projects:[{projectVersionId:version.id}]});await app.close();
  });

  it.each(["approve","conditional"] as const)("freezes every requirement project scope write after a %s delivery-plan approval",async(decision)=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo(),{name:"Frozen"}));const version=ensureProjectVersion(store,project.id);const nextVersion=store.createProjectVersion({projectId:project.id,name:"next",branch:"next",baseBranch:"main",worktreePath:`/tmp/frozen-next-${crypto.randomUUID()}`,headCommit:"next-head"});const replacement=store.createProject(projectPayload(await projectRepo(),{name:"Replacement"}));const replacementVersion=ensureProjectVersion(store,replacement.id);
    const knowledge=store.beginProjectKnowledge(project.id,"frozen-head","test");store.completeProjectKnowledge(knowledge.id,{summary:"modules",entries:[{id:"module:orders",kind:"module",moduleId:"orders",name:"Orders",path:"src/orders"}]});
    const req=createRequirement(store,{title:"冻结交付范围",businessProblem:"批准后不能改变项目版本或模块",expectedOutcome:"交付计划保持一致",priority:"high",primaryProjectId:project.id,primaryProjectVersionId:version.id});store.updateRequirementState(req.id,"solution_design","awaiting_approval");store.addArtifact(req.id,"solution_design","Solution design",solutionResult([project.id]));const app=await buildApp(store);
    const approval=await app.inject({method:"POST",url:`/api/requirements/${req.id}/approve`,payload:{decision,comment:"freeze scope",...(decision==="conditional"?{condition:"track condition"}:{})}});expect(approval.statusCode).toBe(200);
    const frozen=()=>structuredClone({requirement:store.getRequirement(req.id),projects:store.listRequirementProjects(req.id),snapshot:store.getRequirementProjectSnapshot(req.id),units:store.deliveryUnits.listForRequirement(req.id),dependencies:store.deliveryUnits.listDependencies(req.id)}),before=frozen();
    const writes=[
      {method:"PATCH",url:`/api/requirements/${req.id}/project`,payload:{projectId:replacement.id}},
      {method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:replacement.id,projectVersionId:replacementVersion.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]},
      {method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:nextVersion.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]},
      {method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:version.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"selected",moduleIds:["orders"],position:0}]}
    ] as const;
    for(const write of writes){const response=await app.inject(write);expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"REQUIREMENT_DELIVERY_PLAN_FROZEN"});expect(frozen()).toEqual(before);}
    expect(()=>store.replaceRequirementProjects(req.id,[{projectId:project.id,projectVersionId:nextVersion.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}])).toThrow("REQUIREMENT_DELIVERY_PLAN_FROZEN");expect(frozen()).toEqual(before);
    store.supersedeRequirementProjectSnapshot(req.id);const planOnly=structuredClone({requirement:store.getRequirement(req.id),projects:store.listRequirementProjects(req.id),units:store.deliveryUnits.listForRequirement(req.id)});expect(()=>store.replaceRequirementProjects(req.id,[{projectId:project.id,projectVersionId:nextVersion.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}])).toThrow("REQUIREMENT_DELIVERY_PLAN_FROZEN");expect({requirement:store.getRequirement(req.id),projects:store.listRequirementProjects(req.id),units:store.deliveryUnits.listForRequirement(req.id)}).toEqual(planOnly);await app.close();
  });

  it("maps invalid requirement primary projects without creating orphan requirements",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const archived=store.createProject(projectPayload(await projectRepo()));const archivedVersion=ensureProjectVersion(store,archived.id);store.archiveProject(archived.id);const app=await buildApp(store);
    const input={title:"无效项目",businessProblem:"项目不可用于新需求交付",expectedOutcome:"稳定拒绝",priority:"medium"};
    for(const [primaryProjectId,primaryProjectVersionId] of [["missing","missing"],[archived.id,archivedVersion.id]]){const response=await app.inject({method:"POST",url:"/api/requirements",payload:{...input,primaryProjectId,primaryProjectVersionId}});expect(response.statusCode).toBe(400);expect(response.json()).toMatchObject({error:"VALIDATION_ERROR",message:"PROJECT_NOT_ACTIVE"});}
    expect((await app.inject({method:"POST",url:"/api/requirements",payload:{title:"x"}})).statusCode).toBe(400);expect(store.listRequirements()).toHaveLength(0);await app.close();
  });

  it("creates a requirement without creating a Git branch or worktree",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);const app=await buildApp(store);
    const beforeBranches=(await execFileAsync("git",["-C",repo,"branch","--format=%(refname:short)"])).stdout;
    const beforeWorktrees=(await execFileAsync("git",["-C",repo,"worktree","list","--porcelain"])).stdout;

    const response=await app.inject({method:"POST",url:"/api/requirements",payload:{title:"延迟编码准备",businessProblem:"需求创建不能提前改变 Git",expectedOutcome:"编码时才创建分支",priority:"medium",primaryProjectId:project.id,primaryProjectVersionId:version.id}});

    expect(response.statusCode).toBe(201);expect((await execFileAsync("git",["-C",repo,"branch","--format=%(refname:short)"])).stdout).toBe(beforeBranches);expect((await execFileAsync("git",["-C",repo,"worktree","list","--porcelain"])).stdout).toBe(beforeWorktrees);await app.close();
  });

  it("rejects requirement runs when multiple delivery projects are associated",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"多项目交付",businessProblem:"需要多个项目共同交付",expectedOutcome:"明确阻止执行",priority:"medium",primaryProjectId:a.id});
    store.replaceRequirementProjects(req.id,[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0},{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:1}]);
    store.updateRequirementState(req.id,"implementation","ai_ready");
    const app=await buildApp(store);const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"DELIVERY_UNIT_AUTOMATION_OWNS_STAGE",stage:"implementation"});expect(store.listStageRuns(req.id)).toHaveLength(0);expect(runAgent).not.toHaveBeenCalled();expect(runCodexCoding).not.toHaveBeenCalled();await app.close();
  });

  it("uses all projects for solution design and rejects requirement-owned implementation",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo(),{name:"A"}));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const design=createRequirement(store,{title:"多项目设计",businessProblem:"设计需要两个交付项目",expectedOutcome:"完整上下文",priority:"medium",primaryProjectId:a.id});
    const associations=[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary" as const,usage:"delivery" as const,deliveryRequired:true,moduleMode:"all" as const,moduleIds:[],position:0},{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"collaborator" as const,usage:"delivery" as const,deliveryRequired:true,moduleMode:"all" as const,moduleIds:[],position:1}];
    store.replaceRequirementProjects(design.id,associations);
    for(const project of [a,b]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} fact`,entries:[]});}
    store.updateRequirementState(design.id,"solution_design","ai_ready");const coding=createRequirement(store,{title:"多项目编码",businessProblem:"一期不能执行",expectedOutcome:"稳定阻止",priority:"medium",primaryProjectId:a.id});store.replaceRequirementProjects(coding.id,associations);store.updateRequirementState(coding.id,"implementation","ai_ready");const app=await buildApp(store);

    const designResponse=await app.inject({method:"POST",url:`/api/requirements/${design.id}/run`,payload:{}});const codingResponse=await app.inject({method:"POST",url:`/api/requirements/${coding.id}/run`,payload:{}});

    expect(designResponse.statusCode).toBe(202);expect((store.getStageRun(designResponse.json().id) as any).input.projectContext.projects.map((project:any)=>project.projectId)).toEqual([a.id,b.id]);
    expect(codingResponse.statusCode).toBe(409);expect(codingResponse.json()).toMatchObject({error:"DELIVERY_UNIT_AUTOMATION_OWNS_STAGE",stage:"implementation"});await app.close();
  });

  it("redacts all associated project patterns from model-bound context and audit input",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo,{sensitivePatterns:["CUSTOM_SECRET"]}));
    const req=createRequirement(store,{title:"敏感上下文",businessProblem:"防止提示词泄漏",expectedOutcome:"脱敏",priority:"medium",primaryProjectId:project.id});
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"token=MODEL_TOKEN CUSTOM_SECRET",entries:[{path:"docs/info.md",kind:"overview",title:"Info",content:"Bearer MODEL_BEARER CUSTOM_SECRET",tags:[]}]});store.updateRequirementState(req.id,"solution_design","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{context:{note:"password=USER_PASSWORD CUSTOM_SECRET"}}});

    expect(response.statusCode).toBe(202);const runInput=(store.getStageRun(response.json().id) as any).input,input=JSON.stringify(runInput),prompt=buildAgentPrompt("solution_design",runInput);expect(input).not.toContain("MODEL_TOKEN");expect(input).not.toContain("MODEL_BEARER");expect(input).not.toContain("USER_PASSWORD");expect(input).not.toContain("CUSTOM_SECRET");expect(prompt).not.toContain("MODEL_TOKEN");expect(prompt).not.toContain("CUSTOM_SECRET");expect(input).toContain("[REDACTED]");expect(prompt).toContain("UNTRUSTED");await app.close();
  });

  it.each(["implementation", "quality_verification", "acceptance_delivery"] as const)("rejects requirement-owned %s automation",async(stage)=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const backend=store.createProject(projectPayload(`/tmp/app-plan-backend-${crypto.randomUUID()}`,{name:"Backend"}));
    const web=store.createProject(projectPayload(`/tmp/app-plan-web-${crypto.randomUUID()}`,{name:"Web"}));
    const backendVersion=ensureProjectVersion(store,backend.id),webVersion=ensureProjectVersion(store,web.id);
    const req=createRequirement(store,{title:"交付计划",businessProblem:"多个项目需要按依赖交付",expectedOutcome:"只返回交付单元",priority:"high",primaryProjectId:backend.id,primaryProjectVersionId:backendVersion.id});
    store.replaceRequirementProjects(req.id,[{projectId:backend.id,projectVersionId:backendVersion.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:0},{projectId:web.id,projectVersionId:webVersion.id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:1}]);
    for(const [project,head] of [[backend,backendVersion.headCommit],[web,webVersion.headCommit]] as const){const knowledge=store.beginProjectKnowledge(project.id,head,"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} ready`,entries:[]});}
    const snapshot=store.createRequirementProjectSnapshot(req.id);
    const plan=store.deliveryUnits.createPlan({requirementId:req.id,snapshot,plan:{units:[{projectId:backend.id,moduleIds:[],acceptanceCriteria:["后端验收通过"]},{projectId:web.id,moduleIds:[],acceptanceCriteria:["前端验收通过"]}],dependencies:[{upstreamProjectId:backend.id,downstreamProjectId:web.id,releaseCondition:"automated_testing_passed"}]}});
    store.updateRequirementState(req.id,stage,"ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"DELIVERY_UNIT_AUTOMATION_OWNS_STAGE",stage});
    expect(runAgent).not.toHaveBeenCalled();expect(runCodexCoding).not.toHaveBeenCalled();expect(store.listStageRuns(req.id)).toEqual([]);expect(store.listExecutions(req.id)).toEqual([]);await app.close();
  });
});

describe("live delivery unit detail", () => {
  function createDeliveryFixture(options: { optional?: boolean } = {}) {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const primary = store.createProject(projectPayload(`/tmp/live-unit-primary-${crypto.randomUUID()}`));
    const secondary = store.createProject(projectPayload(`/tmp/live-unit-secondary-${crypto.randomUUID()}`));
    const requirement = createRequirement(store, {
      title: "实时交付状态", businessProblem: "查看服务端权威动作", expectedOutcome: "只执行安全动作",
      priority: "medium", primaryProjectId: primary.id
    });
    store.replaceRequirementProjects(requirement.id, [{
      projectId: primary.id, projectVersionId: ensureProjectVersion(store, primary.id).id,
      role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    }, {
      projectId: secondary.id, projectVersionId: ensureProjectVersion(store, secondary.id).id,
      role: "collaborator", usage: "delivery", deliveryRequired: !options.optional,
      moduleMode: "all", moduleIds: [], position: 1
    }]);
    const snapshot = store.createRequirementProjectSnapshot(requirement.id);
    const plan = store.deliveryUnits.createPlan({ requirementId: requirement.id, snapshot, plan: {
      units: [
        { projectId: primary.id, moduleIds: [], acceptanceCriteria: ["primary passes"] },
        { projectId: secondary.id, moduleIds: [], acceptanceCriteria: ["secondary passes"] }
      ],
      dependencies: [{ upstreamProjectId: primary.id, downstreamProjectId: secondary.id,
        releaseCondition: "automated_testing_passed" }]
    } });
    return { store, requirement, plan, primary: plan.units[0]!, secondary: plan.units[1]! };
  }

  function completeImplementation(store: WorkflowStore, unitId: string) {
    const claim = store.deliveryExecutions.claimImplementation(unitId, "test-model");
    const evidenceVersion = claim.deliveryUnit.evidenceVersion;
    return store.deliveryExecutions.completeImplementation(claim, {
      branch: claim.version.branch, worktreePath: claim.version.worktreePath, baseCommit: claim.version.headCommit,
      commands: [], diff: `diff --git a/a.ts b/a.ts\n+change-v${evidenceVersion}`,
      diffHash: `hash-${unitId}-v${evidenceVersion}`,
      changedFiles: [{ path: "a.ts", status: "modified", kind: "text", content: "change" }],
      identity: { repositoryPath: claim.project.repoPath, gitCommonDir: `${claim.project.repoPath}/.git`,
        worktreePath: claim.version.worktreePath, branch: claim.version.branch, headCommit: claim.version.headCommit },
      manifest: { version: 1, entries: [] }, manifestHash: `manifest-${unitId}-v${evidenceVersion}`,
      originalChars: 42, truncated: false, files: ["a.ts"], additions: 1, deletions: 0,
      diagnostics: "", output: { summary: "implemented" }
    });
  }

  function passQuality(store: WorkflowStore, unitId: string, evidenceVersion: number) {
    for (const kind of ["code_review", "automated_testing"] as const) {
      const claim = store.deliveryQuality.claim(unitId, evidenceVersion, kind);
      expect(claim.status).toBe("running");
      if (claim.status === "running") store.deliveryQuality.complete(claim, {
        result: "passed", content: { summary: `${kind} passed` },
        commandResults: kind === "automated_testing" ? [{ command: "npm test", code: 0 }] : [],
        acceptanceTrace: kind === "automated_testing" ? [{ criterion: "primary passes", status: "passed" }] : []
      });
    }
  }

  it("rejects requirement-level runs for delivery stages without creating work", async () => {
    const { store, requirement } = createDeliveryFixture();
    store.updateRequirementState(requirement.id, "implementation", "ai_ready");
    const app = await buildApp(store);
    const pendingBefore = store.automationJobs.listPending().length;

    const response = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/run`,
      payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "DELIVERY_UNIT_AUTOMATION_OWNS_STAGE",
      stage: "implementation" });
    expect(store.listStageRuns(requirement.id)).toEqual([]);
    expect(store.listExecutions(requirement.id)).toEqual([]);
    expect(store.automationJobs.listPending()).toHaveLength(pendingBefore);
    expect(runAgent).not.toHaveBeenCalled();
    expect(runCodexCoding).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns current evidence, releases, pause state, blockers, and server-owned stale actions", async () => {
    const { store, requirement, primary, secondary } = createDeliveryFixture();
    completeImplementation(store, primary.id);
    passQuality(store, primary.id, 1);
    completeImplementation(store, secondary.id);
    const db = (store as any).db;
    db.prepare(`UPDATE delivery_units SET evidence_version = 2, phase = 'implementation', status = 'ready'
      WHERE id = ?`).run(primary.id);
    completeImplementation(store, primary.id);
    passQuality(store, primary.id, 2);
    const app = await buildApp(store);

    const response = await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.automation).toEqual({ status: "active", allowedActions: [{ type: "pause_automation", reasonRequired: true }] });
    expect(body.deliveryUnits.find((unit: any) => unit.id === primary.id)).toMatchObject({
      implementationEvidence: { deliveryUnitId: primary.id, evidenceVersion: 2, diffHash: `hash-${primary.id}-v2` },
      codeReviewEvidence: { kind: "code_review", result: "passed", inputEvidenceVersion: 2 },
      automatedTestingEvidence: { kind: "automated_testing", result: "passed", inputEvidenceVersion: 2 },
      blocker: null,
      dependencyReleases: [expect.objectContaining({ direction: "outgoing", downstreamUnitId: secondary.id,
        releasedByEvidenceVersion: 2, releasedAt: expect.any(String) })],
      automation: { status: "active" }, allowedActions: []
    });
    expect(body.deliveryUnits.find((unit: any) => unit.id === secondary.id)).toMatchObject({
      blocker: { code: "DELIVERY_EVIDENCE_POTENTIALLY_STALE", message: "上游证据已变化，需要确认复用或重新执行" },
      dependencyReleases: [expect.objectContaining({ direction: "incoming", upstreamUnitId: primary.id })],
      allowedActions: [
        { type: "reuse_evidence", reasonRequired: true },
        { type: "rerun", reasonRequired: true }
      ]
    });

    const paused = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/automation/pause`,
      payload: { reason: "人工检查依赖变化", actor: "spoofed-client" } });
    expect(paused.statusCode).toBe(200);
    const pausedDetail = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(pausedDetail.automation).toMatchObject({ status: "paused", actor: "local-human",
      reason: "人工检查依赖变化", allowedActions: [{ type: "resume_automation", reasonRequired: true }] });
    expect(pausedDetail.deliveryUnits.every((unit: any) => unit.allowedActions.length === 0)).toBe(true);
    expect(pausedDetail.deliveryUnits[0].automation).toMatchObject({ status: "paused", actor: "local-human" });
    await app.close();
  });

  it("does not expose superseded requirement evidence after a delivery unit rerun", async () => {
    const { store, requirement, primary, secondary } = createDeliveryFixture();
    store.updateRequirementState(requirement.id, "implementation", "ai_ready");
    completeImplementation(store, primary.id);
    passQuality(store, primary.id, 1);
    completeImplementation(store, secondary.id);
    const supersededHash = `hash-${secondary.id}-v1`;
    const db = (store as any).db;
    db.prepare(`UPDATE delivery_units SET evidence_version = 2, phase = 'implementation', status = 'ready'
      WHERE id = ?`).run(primary.id);
    completeImplementation(store, primary.id);
    passQuality(store, primary.id, 2);
    const app = await buildApp(store);

    const rerun = await app.inject({ method: "POST", url: `/api/delivery-units/${secondary.id}/stale-resolution`,
      payload: { decision: "rerun", reason: "上游实现变化，重新执行" } });
    expect(rerun.statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` });
    const body = response.json();

    expect(body).not.toHaveProperty("codingEvidence");
    expect(body).not.toHaveProperty("executions");
    expect(JSON.stringify(body)).not.toContain(supersededHash);
    expect(body.deliveryUnits.find((unit: any) => unit.id === secondary.id)).toMatchObject({
      evidenceVersion: 2,
      implementationEvidence: null,
      codeReviewEvidence: null,
      automatedTestingEvidence: null
    });
    await app.close();
  });

  it("uses current upstream evidence versions for stale reuse and retry authorization", async () => {
    const stale = createDeliveryFixture();
    completeImplementation(stale.store, stale.primary.id);
    passQuality(stale.store, stale.primary.id, 1);
    completeImplementation(stale.store, stale.secondary.id);
    const staleDb = (stale.store as any).db;
    staleDb.prepare(`UPDATE delivery_units SET evidence_version = 2, phase = 'implementation', status = 'ready'
      WHERE id = ?`).run(stale.primary.id);
    completeImplementation(stale.store, stale.primary.id);
    passQuality(stale.store, stale.primary.id, 2);
    staleDb.prepare(`UPDATE delivery_dependencies SET released_by_evidence_version = 1
      WHERE downstream_unit_id = ?`).run(stale.secondary.id);
    const staleApp = await buildApp(stale.store);

    const staleDetail = (await staleApp.inject({ method: "GET",
      url: `/api/requirements/${stale.requirement.id}` })).json();
    expect(staleDetail.deliveryUnits.find((unit: any) => unit.id === stale.secondary.id).allowedActions).toEqual([
      { type: "rerun", reasonRequired: true }
    ]);
    expect((await staleApp.inject({ method: "POST",
      url: `/api/delivery-units/${stale.secondary.id}/stale-resolution`,
      payload: { decision: "reuse", reason: "尝试复用旧依赖" } })).statusCode).toBe(409);
    expect((await staleApp.inject({ method: "POST",
      url: `/api/delivery-units/${stale.secondary.id}/stale-resolution`,
      payload: { decision: "rerun", reason: "重新执行以匹配当前依赖" } })).statusCode).toBe(200);
    await staleApp.close();

    for (const target of ["implementation", "code_review"] as const) {
      const fixture = createDeliveryFixture();
      completeImplementation(fixture.store, fixture.primary.id);
      passQuality(fixture.store, fixture.primary.id, 1);
      const db = (fixture.store as any).db;
      if (target === "implementation") {
        db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id = ?").run(fixture.secondary.id);
      } else {
        completeImplementation(fixture.store, fixture.secondary.id);
        fixture.store.automationJobs.cancelByOwnerVersion(fixture.secondary.id, 1);
      }
      const action = target === "implementation" ? "implement" : "review";
      fixture.store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: fixture.secondary.id,
        evidenceVersion: 1, action, payload: {}, maxAttempts: 1 });
      const job = fixture.store.automationJobs.leaseNext(`worker-${target}`, new Date(), 30_000)!;
      expect(fixture.store.automationJobs.fail(job.id, job.leaseOwner!, `${target} failed`, false)).toBe(true);
      db.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?").run(fixture.primary.id);
      const app = await buildApp(fixture.store);

      const detail = (await app.inject({ method: "GET",
        url: `/api/requirements/${fixture.requirement.id}` })).json();
      expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.secondary.id)).toMatchObject({
        allowedActions: [],
        blocker: { code: "DELIVERY_DEPENDENCY_PENDING", message: "等待上游依赖释放" }
      });
      expect((await app.inject({ method: "POST", url: `/api/delivery-units/${fixture.secondary.id}/retry`,
        payload: { target, reason: "依赖版本过期时不能重试" } })).statusCode).toBe(409);
      await app.close();
    }
  });

  it.each(["leased_job", "running_quality", "running_stage"] as const)(
    "keeps stale resolution unauthorized while %s remains active",
    async (activeKind) => {
      const fixture = createDeliveryFixture();
      completeImplementation(fixture.store, fixture.primary.id);
      passQuality(fixture.store, fixture.primary.id, 1);
      completeImplementation(fixture.store, fixture.secondary.id);
      const db = (fixture.store as any).db;

      if (activeKind === "running_quality") {
        const claim = fixture.store.deliveryQuality.claim(
          fixture.secondary.id, 1, "code_review", "stale-quality-active"
        );
        expect(claim.status).toBe("running");
      }
      if (activeKind === "running_stage") {
        db.prepare(`UPDATE stage_runs SET status = 'running', completed_at = NULL
          WHERE owner_type = 'delivery_unit' AND owner_id = ? AND evidence_version = 1
            AND stage = 'implementation'`).run(fixture.secondary.id);
        db.prepare(`UPDATE executions SET status = 'running', completed_at = NULL
          WHERE delivery_unit_id = ? AND evidence_version = 1`).run(fixture.secondary.id);
      }

      db.prepare(`UPDATE delivery_units SET evidence_version = 2, phase = 'implementation', status = 'ready'
        WHERE id = ?`).run(fixture.primary.id);
      completeImplementation(fixture.store, fixture.primary.id);
      passQuality(fixture.store, fixture.primary.id, 2);
      expect(fixture.store.deliveryUnits.get(fixture.secondary.id)).toMatchObject({
        status: "potentially_stale", evidenceVersion: 1
      });

      if (activeKind === "leased_job") {
        const job = db.prepare(`SELECT id FROM automation_jobs WHERE owner_type = 'delivery_unit'
          AND owner_id = ? AND evidence_version = 1 ORDER BY rowid LIMIT 1`).get(fixture.secondary.id) as { id: string };
        db.prepare(`UPDATE automation_jobs SET status = 'leased', attempt = 1,
          lease_owner = 'stale-active-worker', lease_expires_at = '2099-01-01T00:00:00.000Z',
          updated_at = ? WHERE id = ?`).run(new Date().toISOString(), job.id);
      }

      const app = await buildApp(fixture.store);
      const detail = (await app.inject({ method: "GET",
        url: `/api/requirements/${fixture.requirement.id}` })).json();
      expect(detail.deliveryUnits.find((unit: any) => unit.id === fixture.secondary.id).allowedActions).toEqual([]);
      expect((await app.inject({ method: "POST",
        url: `/api/delivery-units/${fixture.secondary.id}/stale-resolution`,
        payload: { decision: "rerun", reason: "active work must settle first" } })).statusCode).toBe(409);
      await app.close();
    }
  );

  it("keeps delivery detail query count constant as the unit count grows", () => {
    const queryCount = (unitCount: number) => {
      const store = new WorkflowStore(":memory:");
      stores.push(store);
      const projects = Array.from({ length: unitCount }, (_, index) => {
        const project = store.createProject({ name: `Batch ${unitCount}-${index}`,
          repoPath: `/tmp/batch-detail-${unitCount}-${index}`, defaultBranch: "main",
          allowedCommands: [], sensitivePatterns: [] });
        const version = store.createProjectVersion({ projectId: project.id, name: "v1",
          branch: `feature/batch-${index}`, baseBranch: "main",
          worktreePath: `/tmp/batch-detail-${unitCount}-${index}-worktree`, headCommit: "head" });
        return { project, version };
      });
      const requirement = store.createRequirement({ title: `Batch detail ${unitCount}`,
        businessProblem: "Detail query count must remain bounded as delivery units grow",
        expectedOutcome: "One fixed batch of detail queries", priority: "medium",
        primaryProjectId: projects[0]!.project.id, primaryProjectVersionId: projects[0]!.version.id });
      store.replaceRequirementProjects(requirement.id, projects.map(({ project, version }, index) => ({
        projectId: project.id, projectVersionId: version.id,
        role: index === 0 ? "primary" as const : "collaborator" as const,
        usage: "delivery" as const, deliveryRequired: true, moduleMode: "all" as const,
        moduleIds: [], position: index
      })));
      store.deliveryUnits.createPlan({ requirementId: requirement.id,
        snapshot: store.createRequirementProjectSnapshot(requirement.id), plan: {
          units: projects.map(({ project }) => ({ projectId: project.id, moduleIds: [], acceptanceCriteria: ["done"] })),
          dependencies: []
        } });
      const db = (store as any).db;
      const originalPrepare = db.prepare;
      let prepares = 0;
      db.prepare = function(this: any, ...args: any[]) {
        prepares += 1;
        return originalPrepare.apply(this, args);
      };
      try {
        expect(store.deliveryUnitDetails.getForRequirement(requirement.id).units).toHaveLength(unitCount);
      } finally {
        db.prepare = originalPrepare;
      }
      return prepares;
    };

    const small = queryCount(2);
    const large = queryCount(16);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(10);
  });

  it("exposes only the failed job retry and optional skip, then enforces reason and fixed actor", async () => {
    const { store, requirement, primary, secondary } = createDeliveryFixture({ optional: true });
    const db = (store as any).db;
    db.prepare("UPDATE delivery_units SET status = 'failed' WHERE id IN (?, ?)").run(primary.id, secondary.id);
    for (const unit of [primary, secondary]) {
      store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: unit.id, evidenceVersion: 1,
        action: "implement", payload: {}, maxAttempts: 1 });
      const job = store.automationJobs.leaseNext(`worker-${unit.id.slice(0, 8)}`, new Date(), 30_000)!;
      expect(store.automationJobs.fail(job.id, job.leaseOwner!, "terminal implementation failure", false)).toBe(true);
    }
    const app = await buildApp(store);

    const detail = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(detail.deliveryUnits.find((unit: any) => unit.id === primary.id).allowedActions).toEqual([
      { type: "retry_implementation", reasonRequired: true }
    ]);
    expect(detail.deliveryUnits.find((unit: any) => unit.id === secondary.id).allowedActions).toEqual([
      { type: "skip_optional", reasonRequired: true }
    ]);
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${primary.id}/retry`,
      payload: { target: "implementation", reason: " " } })).statusCode).toBe(400);
    const retried = await app.inject({ method: "POST", url: `/api/delivery-units/${primary.id}/retry`,
      payload: { target: "implementation", reason: "服务恢复后重试", actor: "spoofed-client" } });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ deliveryUnitId: primary.id, target: "implementation",
      actor: "local-human", reason: "服务恢复后重试" });
    expect(store.automationJobs.byDedupe(`implement:${primary.id}:v1`)).toMatchObject({ status: "pending", attempt: 0 });
    expect(db.prepare(`SELECT actor, reason, target FROM delivery_unit_retry_audit
      WHERE delivery_unit_id = ?`).get(primary.id)).toEqual({
      actor: "local-human", reason: "服务恢复后重试", target: "implementation"
    });
    expect(() => db.prepare("UPDATE delivery_unit_retry_audit SET reason = 'rewritten' WHERE delivery_unit_id = ?")
      .run(primary.id)).toThrow("DELIVERY_UNIT_RETRY_AUDIT_IMMUTABLE");
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${secondary.id}/skip`,
      payload: { reason: "" } })).statusCode).toBe(400);
    const skipped = await app.inject({ method: "POST", url: `/api/delivery-units/${secondary.id}/skip`,
      payload: { reason: "本版本不交付可选项目", actor: "spoofed-client" } });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({ deliveryUnitId: secondary.id, actor: "local-human",
      reason: "本版本不交付可选项目" });
    const afterSkip = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(afterSkip.deliveryUnits.find((unit: any) => unit.id === secondary.id).allowedActions).toEqual([]);
    await app.close();
  });

  it("keeps waiting and terminal units actionless and retries only the failed quality job", async () => {
    const { store, requirement, primary, secondary } = createDeliveryFixture();
    const app = await buildApp(store);
    const initial = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(initial.deliveryUnits.find((unit: any) => unit.id === primary.id).allowedActions).toEqual([]);
    expect(initial.deliveryUnits.find((unit: any) => unit.id === secondary.id)).toMatchObject({
      status: "waiting_dependency", allowedActions: []
    });

    completeImplementation(store, primary.id);
    store.automationJobs.cancelByOwnerVersion(primary.id, 1);
    store.automationJobs.enqueue({ ownerType: "delivery_unit", ownerId: primary.id, evidenceVersion: 1,
      action: "review", payload: {}, maxAttempts: 1 });
    const reviewJob = store.automationJobs.leaseNext("quality-worker", new Date(), 30_000)!;
    expect(reviewJob.action).toBe("review");
    expect(store.automationJobs.fail(reviewJob.id, "quality-worker", "review provider unavailable", false)).toBe(true);
    const failedReview = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(failedReview.deliveryUnits.find((unit: any) => unit.id === primary.id).allowedActions).toEqual([
      { type: "retry_code_review", reasonRequired: true }
    ]);
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${primary.id}/retry`,
      payload: { target: "automated_testing", reason: "wrong target" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/delivery-units/${primary.id}/retry`,
      payload: { target: "code_review", reason: "review service recovered" } })).statusCode).toBe(200);

    const db = (store as any).db;
    store.automationJobs.cancelByOwnerVersion(primary.id, 1);
    db.prepare("UPDATE delivery_units SET phase = 'acceptance_delivery', status = 'applied' WHERE id = ?")
      .run(primary.id);
    db.prepare("UPDATE delivery_units SET phase = 'acceptance_delivery', status = 'skipped' WHERE id = ?")
      .run(secondary.id);
    const terminal = (await app.inject({ method: "GET", url: `/api/requirements/${requirement.id}` })).json();
    expect(terminal.deliveryUnits.map((unit: any) => unit.allowedActions)).toEqual([[], []]);
    await app.close();
  });
});

describe("stage run API", () => {
  it("exposes project memory and requirement knowledge changes",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Memory",repoPath:"/tmp/api-memory",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=createRequirement(store, {title:"用户规则",businessProblem:"缺少",expectedOutcome:"明确",priority:"medium",primaryProjectId:project.id});
    const artifact=store.addArtifact(req.id,"definition","Product definition",{productDecisions:[{decision:"用户名唯一",rationale:"登录标识",evidence:"User.java"}]});store.addApproval(req.id,"definition",{decision:"approve",comment:"通过",artifactId:artifact.id});publishRequirementKnowledge(store,req.id);
    const app=await buildApp(store);
    expect((await app.inject({method:"GET",url:`/api/projects/${project.id}/memory`})).json()).toMatchObject({total:1});
    expect((await app.inject({method:"GET",url:`/api/requirements/${req.id}/knowledge-changes`})).json()).toMatchObject({publishedCount:1});
    await app.close();
  });


  it("lists runs by stage and returns a run snapshot", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: { prompt: "safe" } });
    const app = await buildApp(store);
    const list = await app.inject({ method: "GET", url: `/api/requirements/${req.id}/runs?stage=definition` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: run.id, stage: "definition" })]);
    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(detail.json().events[0].type).toBe("run.started");
    await app.close();
  });

  it("rejects starting a duplicate active stage run", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
    store.updateRequirementState(req.id,"definition","ai_ready");
    store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: {} });
    const app = await buildApp(store);
    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("RUN_ALREADY_ACTIVE");
    await app.close();
  });

  it("reads and updates risk-based gate configuration", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const app = await buildApp(store);
    const defaults = await app.inject({ method: "GET", url: "/api/settings/gates" });
    expect(defaults.json().confidenceThreshold).toBe(0.85);
    const updated = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload: { autoTransitionEnabled: false, confidenceThreshold: 0.9, mandatoryHumanStages: ["definition"] } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ autoTransitionEnabled: false, mandatoryHumanStages: ["definition"] });
    const invalid = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload: { autoTransitionEnabled: true, confidenceThreshold: 2, mandatoryHumanStages: [] } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it.each([
    ["wrong boolean type", { autoTransitionEnabled: "true", confidenceThreshold: 0.85, mandatoryHumanStages: [] }],
    ["string threshold", { autoTransitionEnabled: true, confidenceThreshold: "0.85", mandatoryHumanStages: [] }],
    ["non-finite threshold", { autoTransitionEnabled: true, confidenceThreshold: Number.NaN, mandatoryHumanStages: [] }],
    ["unknown property", { autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: [], unexpected: true }]
  ])("rejects gate configuration with %s", async (_name, payload) => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const app = await buildApp(store);

    const response = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload });

    expect(response.statusCode).toBe(400);
    expect(store.getGateConfig()).toEqual({ autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: [] });
    await app.close();
  });

  it.each(["solution_design", "implementation", "quality_verification", "acceptance_delivery"] as const)("rejects %s as a configurable gate stage", async (stage) => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const app = await buildApp(store);

    const response = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload: { autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: [stage] } });

    expect(response.statusCode).toBe(400);
    expect(store.getGateConfig().mandatoryHumanStages).toEqual([]);
    await app.close();
  });

});
