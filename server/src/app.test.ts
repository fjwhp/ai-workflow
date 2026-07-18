import { afterEach, describe, expect, it } from "vitest";
import { buildApp, resolveReusableSourceCommit } from "./app.js";
import { WorkflowStore } from "./store.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { publishRequirementKnowledge } from "./project-memory-service.js";

const execFileAsync=promisify(execFile);const tempDirs:string[]=[];

const stores: WorkflowStore[] = [];
afterEach(async() => {stores.splice(0).forEach((store) => store.close());for(const dir of tempDirs.splice(0))await rm(dir,{recursive:true,force:true})});

async function branchRepo(){const dir=await mkdtemp(join(tmpdir(),"workflow-api-branches-"));tempDirs.push(dir);await execFileAsync("git",["init","-b","main",dir]);await execFileAsync("git",["-C",dir,"config","user.email","test@example.com"]);await execFileAsync("git",["-C",dir,"config","user.name","Test"]);await writeFile(join(dir,"README.md"),"base\n");await execFileAsync("git",["-C",dir,"add","--all"]);await execFileAsync("git",["-C",dir,"commit","-m","base"]);await execFileAsync("git",["-C",dir,"switch","-c","feature/0710-test"]);return dir;}

describe("stage run API", () => {
  it("exposes project memory and requirement knowledge changes",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Memory",repoPath:"/tmp/api-memory",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"用户规则",businessProblem:"缺少",expectedOutcome:"明确",priority:"medium",primaryProjectId:project.id});
    const artifact=store.addArtifact(req.id,"prd","PRD",{productDecisions:[{decision:"用户名唯一",rationale:"登录标识",evidence:"User.java"}]});store.addApproval(req.id,"prd",{decision:"approve",comment:"通过",artifactId:artifact.id});publishRequirementKnowledge(store,req.id);
    const app=await buildApp(store);
    expect((await app.inject({method:"GET",url:`/api/projects/${project.id}/memory`})).json()).toMatchObject({total:1});
    expect((await app.inject({method:"GET",url:`/api/requirements/${req.id}/knowledge-changes`})).json()).toMatchObject({publishedCount:1});
    await app.close();
  });

  it("reuses only a matching conflict source commit", () => {
    const evidence = { id: "evidence-1", executionId: "execution-1", branch: "ai/req-1", worktreePath: "/tmp/worktree" };
    const run = { status: "conflict", evidenceId: "evidence-1", executionId: "execution-1", sourceBranch: "ai/req-1", worktreePath: "/tmp/worktree", targetBranch: "feature/target", sourceCommit: "abc123" };
    expect(resolveReusableSourceCommit(run, evidence, "feature/target")).toBe("abc123");
    expect(resolveReusableSourceCommit({ ...run, targetBranch: "main" }, evidence, "feature/target")).toBeUndefined();
    expect(resolveReusableSourceCommit({ ...run, evidenceId: "other" }, evidence, "feature/target")).toBeUndefined();
    expect(resolveReusableSourceCommit({ ...run, status: "completed" }, evidence, "feature/target")).toBeUndefined();
  });

  it("lists runs by stage and returns a run snapshot", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "prd", model: "gpt-5.5", input: { prompt: "safe" } });
    const app = await buildApp(store);
    const list = await app.inject({ method: "GET", url: `/api/requirements/${req.id}/runs?stage=prd` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: run.id, stage: "prd" })]);
    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(detail.json().events[0].type).toBe("run.started");
    await app.close();
  });

  it("rejects starting a duplicate active stage run", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
    store.createStageRun({ requirementId: req.id, stage: "prd", model: "gpt-5.5", input: {} });
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
    const updated = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload: { autoTransitionEnabled: false, confidenceThreshold: 0.9, mandatoryHumanStages: ["coding", "acceptance"] } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().autoTransitionEnabled).toBe(false);
    const invalid = await app.inject({ method: "PATCH", url: "/api/settings/gates", payload: { autoTransitionEnabled: true, confidenceThreshold: 2, mandatoryHumanStages: [] } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it.each([["code_review", "testing"], ["testing", "acceptance"]] as const)("allows a human override from %s to %s", async (stage, target) => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少", expectedOutcome: "增加", priority: "medium" });
    store.updateRequirementState(req.id, stage, "awaiting_approval");
    store.addArtifact(req.id, stage, "AI 成果", { summary: "需要人工判断", risks: ["风险一"], openQuestions: ["问题一"] });
    const app = await buildApp(store);

    const detail = await app.inject({ method: "GET", url: `/api/requirements/${req.id}` });
    expect(detail.json().humanOverride).toMatchObject({ visible: true, allowed: true, targetStage: target, returnCount: 0 });
    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "人工已核查并接受风险" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().requirement).toMatchObject({ stage: target, status: "ai_ready" });
    expect(response.json().approval.actor_type).toBe("human_override");
    await app.close();
  });

  it("rejects invalid human overrides without changing state", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少", expectedOutcome: "增加", priority: "medium" });
    const app = await buildApp(store);
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "已核查" } })).statusCode).toBe(409);
    store.updateRequirementState(req.id, "code_review", "awaiting_approval");
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "已核查" } })).statusCode).toBe(409);
    store.addArtifact(req.id, "code_review", "AI 成果", { risks: [] });
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "   " } })).statusCode).toBe(400);
    store.updateRequirementState(req.id, "code_review", "ai_running");
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "已核查" } })).statusCode).toBe(409);
    store.updateRequirementState(req.id, "code_review", "awaiting_approval");
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "已核查" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/human-override`, payload: { comment: "重复" } })).statusCode).toBe(409);
    await app.close();
  });

  it("moves approved acceptance into the manual integration stage", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少接口能力", expectedOutcome: "增加接口", priority: "medium" });
    store.updateRequirementState(req.id, "acceptance", "awaiting_approval");
    const app = await buildApp(store);
    const approved = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/approve`, payload: { decision: "approve", comment: "验收通过" } });
    expect(approved.json()).toMatchObject({ stage: "integration", status: "awaiting_merge" });
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} })).statusCode).toBe(409);
    await app.close();
  });

  it("rejects integration outside the awaiting-merge state", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少接口能力", expectedOutcome: "增加接口", priority: "medium" });
    const app = await buildApp(store);
    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/integrate`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("INTEGRATION_NOT_ALLOWED");
    await app.close();
  });

  it("lists and saves a requirement-local integration target branch",async()=>{
    const repo=await branchRepo(),store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:repo,defaultBranch:"prod",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"接口",businessProblem:"缺少接口能力",expectedOutcome:"增加接口",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"integration","awaiting_merge");
    const app=await buildApp(store);
    const list=await app.inject({method:"GET",url:`/api/requirements/${req.id}/integration-branches`});
    expect(list.json()).toMatchObject({currentBranch:"feature/0710-test",selectedTarget:"feature/0710-test"});
    const saved=await app.inject({method:"PATCH",url:`/api/requirements/${req.id}/integration-target`,payload:{branch:"feature/0710-test"}});
    expect(saved.statusCode).toBe(200);expect(saved.json().integrationTargetBranch).toBe("feature/0710-test");
    expect((await app.inject({method:"PATCH",url:`/api/requirements/${req.id}/integration-target`,payload:{branch:"missing"}})).statusCode).toBe(400);
    store.updateRequirementState(req.id,"coding","ai_ready");
    expect((await app.inject({method:"PATCH",url:`/api/requirements/${req.id}/integration-target`,payload:{branch:"feature/0710-test"}})).statusCode).toBe(409);
    await app.close();
  });

  it("requires exact confirmation before integrating into a protected branch",async()=>{
    const repo=await branchRepo(),store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:repo,defaultBranch:"prod",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"接口",businessProblem:"缺少接口能力",expectedOutcome:"增加接口",priority:"medium",primaryProjectId:project.id});
    const execution=store.addExecution({requirementId:req.id,stage:"coding",projectId:project.id,branch:"ai/req",worktreePath:repo,status:"completed",diff:"diff",events:[]});
    store.addCodingEvidence({executionId:execution.id,requirementId:req.id,projectId:project.id,branch:"ai/req",worktreePath:repo,diffHash:"abc",diff:"diff",originalChars:4,truncated:false,files:["README.md"],additions:1,deletions:0,diagnostics:""});
    store.updateRequirementState(req.id,"integration","awaiting_merge");store.setIntegrationTarget(req.id,"main");
    const app=await buildApp(store);
    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/integrate`,payload:{}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PROTECTED_BRANCH_CONFIRMATION_REQUIRED");
    expect(store.getLatestIntegrationRun(req.id)).toBeNull();
    await app.close();
  });
});
