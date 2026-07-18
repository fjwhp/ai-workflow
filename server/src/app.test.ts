import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./codex-runner.js", () => ({ runCodexCoding: vi.fn() }));

import { buildApp, resolveReusableSourceCommit } from "./app.js";
import { runCodexCoding } from "./codex-runner.js";
import { WorkflowStore } from "./store.js";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { publishRequirementKnowledge } from "./project-memory-service.js";
import { buildAgentPrompt } from "./ai.js";

const execFileAsync=promisify(execFile);const tempDirs:string[]=[];
const codingResult={runId:crypto.randomUUID(),branch:"ai/REQ-0001",worktreePath:"/tmp/requirements/REQ-0001",baseCommit:"version-head",reused:false,diff:"diff --git a/a.ts b/a.ts\n+change",files:["a.ts"],additions:1,deletions:0,codexThreadId:"thread-1",events:[],diagnostics:[],summary:"implemented"};
beforeEach(()=>vi.mocked(runCodexCoding).mockReset().mockResolvedValue(codingResult));

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

const projectPayload=(repoPath:string,extra:any={})=>({name:"API project",repoPath,defaultBranch:"main",allowedCommands:[],sensitivePatterns:[],...extra});

describe("project and requirement association APIs",()=>{
  it("returns a stable budget error before creating a run",async()=>{
    process.env.AI_PROJECT_CONTEXT_MAX_CHARS="4000";
    const store=new WorkflowStore(":memory:");stores.push(store);
    const paths=["server","web","shared","docs","server/src","web/src","shared/src","docs/superpowers","docs/superpowers/specs","docs/superpowers/plans","web/node_modules","web/node_modules/lucide-react","web/node_modules/lucide-react/dist","web/node_modules/lucide-react/dist/esm","web/node_modules/lucide-react/dist/esm/shared","web/node_modules/lucide-react/dist/esm/icons"];
    const projects=paths.map((path,index)=>store.createProject(projectPayload(join(process.cwd(),path),{name:`Context ${index}`})));
    const req=createRequirement(store,{title:"预算约束",businessProblem:"项目上下文过多",expectedOutcome:"稳定拒绝",priority:"medium",primaryProjectId:projects[0]!.id});
    store.replaceRequirementProjects(req.id,projects.map((project,position)=>({projectId:project.id,role:position===0?"primary":"collaborator",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position})));
    for(const project of projects){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"",entries:[]});}
    store.updateRequirementState(req.id,"technical_design","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"PROJECT_CONTEXT_BUDGET_TOO_SMALL",details:{maxChars:4_000,projectCount:projects.length}});
    expect(store.listStageRuns(req.id)).toHaveLength(0);
    await app.close();
  });

  it("stores all technical-design project context and one retrieval event per project",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const primaryRepo=await projectRepo(),deliveryRepo=await projectRepo();
    const primary=store.createProject(projectPayload(primaryRepo,{name:"Architecture"})),delivery=store.createProject(projectPayload(deliveryRepo,{name:"Orders"}));
    const req=createRequirement(store,{title:"订单设计",businessProblem:"跨项目设计",expectedOutcome:"可执行设计",priority:"medium",primaryProjectId:primary.id});
    store.replaceRequirementProjects(req.id,[{projectId:primary.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:0},{projectId:delivery.id,projectVersionId:ensureProjectVersion(store,delivery.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:1}]);
    for(const project of [primary,delivery]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} knowledge`,entries:[{path:"src/orders",kind:"module",title:"Orders",content:"orders",tags:[]}]});}
    store.updateRequirementState(req.id,"technical_design","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);const run=store.getStageRun(response.json().id) as any;
    expect(run.input.projectContext.projects.map((project:any)=>project.projectId)).toEqual([primary.id,delivery.id]);
    expect(run.input.projectContext).toMatchObject({budgetMaxChars:200_000,truncated:false});
    expect(run.events.filter((event:any)=>event.type==="knowledge.retrieved").map((event:any)=>event.payload)).toMatchObject([{projectId:primary.id,budgetMaxChars:200_000},{projectId:delivery.id,budgetMaxChars:200_000}]);
    for(let attempt=0;attempt<50&&store.getStageRun(run.id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    await app.close();
  });

  it("stores only sole-delivery knowledge and repository scope for coding",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const primaryRepo=await projectRepo(),deliveryRepo=await projectRepo();
    const primary=store.createProject(projectPayload(primaryRepo,{name:"Architecture"})),delivery=store.createProject(projectPayload(deliveryRepo,{name:"Orders"}));
    const req=createRequirement(store,{title:"订单编码",businessProblem:"按设计编码",expectedOutcome:"交付订单",priority:"medium",primaryProjectId:primary.id});
    store.replaceRequirementProjects(req.id,[{projectId:primary.id,role:"primary",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:0},{projectId:delivery.id,projectVersionId:ensureProjectVersion(store,delivery.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"all",moduleIds:[],position:1}]);
    for(const project of [primary,delivery]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} knowledge`,entries:[]});}
    store.updateRequirementState(req.id,"coding","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(202);const run=store.getStageRun(response.json().id) as any;
    expect(run.input.projectContext.projects.map((project:any)=>project.projectId)).toEqual([delivery.id]);
    expect(JSON.stringify(run.input)).not.toContain(primaryRepo);expect(run.events.filter((event:any)=>event.type==="knowledge.retrieved").map((event:any)=>event.payload.projectId)).toEqual([delivery.id]);
    for(let attempt=0;attempt<50&&store.getStageRun(run.id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));
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
    store.updateRequirementState(req.id,"coding","ai_running");const app=await buildApp(store);
    const blocked=await app.inject({method:"POST",url:`/api/projects/${project.id}/archive`});expect(blocked.statusCode).toBe(409);expect(blocked.json().error).toBe("PROJECT_IN_ACTIVE_DELIVERY");
    store.updateRequirementState(req.id,"acceptance","completed");expect((await app.inject({method:"POST",url:`/api/projects/${project.id}/archive` })).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/api/projects/${project.id}/archive` })).json().status).toBe("archived");
    expect((await app.inject({method:"GET",url:"/api/projects?status=active"})).json()).toHaveLength(1);
    expect((await app.inject({method:"GET",url:"/api/projects?status=archived"})).json()).toHaveLength(1);
    expect((await app.inject({method:"GET",url:"/api/projects?status=all"})).json()).toHaveLength(2);
    expect((await app.inject({method:"GET",url:"/api/projects?status=nope"})).statusCode).toBe(400);await app.close();
  });

  it.each([["coding","ai_ready"],["code_review","awaiting_approval"],["testing","returned"],["acceptance","blocked"]] as const)("blocks archive during %s/%s delivery",async(stage,status)=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const req=createRequirement(store,{title:"活动交付",businessProblem:"项目仍有后续交付工作",expectedOutcome:"不能归档",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,stage,status);const app=await buildApp(store);
    const response=await app.inject({method:"POST",url:`/api/projects/${project.id}/archive`});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_IN_ACTIVE_DELIVERY");await app.close();
  });

  it("rejects new runs and integration actions for a forcibly archived delivery project",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const req=createRequirement(store,{title:"归档保护",businessProblem:"归档项目不能启动新执行",expectedOutcome:"稳定拒绝",priority:"medium",primaryProjectId:project.id});store.archiveProject(project.id);const app=await buildApp(store);
    const run=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(run.statusCode).toBe(409);expect(run.json().error).toBe("PROJECT_ARCHIVED");
    store.updateRequirementState(req.id,"integration","awaiting_merge");for(const [method,url] of [["GET",`/api/requirements/${req.id}/integration-check`],["POST",`/api/requirements/${req.id}/integrate`]] as const){const response=await app.inject({method,url,payload:method==="POST"?{}:undefined});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_ARCHIVED");}await app.close();
  });

  it("rejects integration test reruns for archived projects before creating a run",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const req=createRequirement(store,{title:"归档重测",businessProblem:"归档项目不能重新执行测试命令",expectedOutcome:"不创建执行记录",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"integration","merge_test_failed");store.archiveProject(project.id);const app=await buildApp(store);
    expect(store.getLatestIntegrationRun(req.id)).toBeNull();const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/integration-test`,payload:{}});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_ARCHIVED");expect(store.getLatestIntegrationRun(req.id)).toBeNull();await app.close();
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
    expect((await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:replacement})).statusCode).toBe(200);expect(store.listRequirementProjects(req.id)).toHaveLength(2);expect(store.getRequirement(req.id)?.stage).toBe("prd");
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

  it("invalidates approved technical design and supersedes its project snapshot on material change",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"设计需求",businessProblem:"需要冻结项目设计上下文",expectedOutcome:"设计可追溯",priority:"medium",primaryProjectId:a.id});store.updateRequirementState(req.id,"technical_design","awaiting_approval");
    store.addArtifact(req.id,"technical_design","技术设计",{summary:"approved"});store.addApproval(req.id,"technical_design",{decision:"approve",comment:"通过"});store.createRequirementProjectSnapshot(req.id);const app=await buildApp(store);
    const payload=[{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}];
    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload});expect(response.statusCode).toBe(200);expect(response.json().requirement).toMatchObject({stage:"technical_design",status:"ai_ready",projects:[{projectId:b.id}]});expect(store.getRequirement(req.id)).toMatchObject({stage:"technical_design",status:"ai_ready"});
    expect(store.listApprovals(req.id)[0]).toMatchObject({actor_type:"system",comment:"项目关联或模块范围发生变化"});expect(store.listRequirementProjectSnapshots(req.id)).toMatchObject([{status:"superseded"}]);await app.close();
  });

  it("invalidates technical design when the selected delivery version changes",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const first=ensureProjectVersion(store,project.id);const next=store.createProjectVersion({projectId:project.id,name:"next",branch:"release/next",baseBranch:"main",worktreePath:`/tmp/api-project-version-next-${project.id}`,headCommit:"next-head"});
    const req=createRequirement(store,{title:"旧接口变更",businessProblem:"旧接口也必须保持设计不变量",expectedOutcome:"统一失效行为",priority:"medium",primaryProjectId:project.id,primaryProjectVersionId:first.id});store.updateRequirementState(req.id,"technical_design","awaiting_approval");
    store.addArtifact(req.id,"technical_design","技术设计",{summary:"approved"});store.addApproval(req.id,"technical_design",{decision:"approve",comment:"通过"});store.createRequirementProjectSnapshot(req.id);const app=await buildApp(store);
    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:next.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]});expect(response.statusCode).toBe(200);expect(response.json().requirement).toMatchObject({stage:"technical_design",status:"ai_ready",projects:[{projectId:project.id,projectVersionId:next.id}]});
    expect(store.listApprovals(req.id)[0]).toMatchObject({actor_type:"system",comment:"项目关联或模块范围发生变化"});expect(store.listRequirementProjectSnapshots(req.id)[0]).toMatchObject({status:"superseded"});await app.close();
  });

  it("does not invalidate technical design when only the selected version HEAD advances",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo()));const version=ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"版本推进",businessProblem:"同一版本会持续接收新的提交",expectedOutcome:"设计关联保持有效",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"technical_design","awaiting_approval");store.addArtifact(req.id,"technical_design","技术设计",{summary:"approved"});store.addApproval(req.id,"technical_design",{decision:"approve",comment:"通过"});const snapshot=store.createRequirementProjectSnapshot(req.id);store.updateProjectVersionHead(version.id,"advanced-head");const app=await buildApp(store);

    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:[{projectId:project.id,projectVersionId:version.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]});

    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({materialChange:false,technicalDesignInvalidated:false});expect(store.getRequirementProjectSnapshot(req.id)?.id).toBe(snapshot.id);expect(store.getRequirement(req.id)).toMatchObject({stage:"technical_design",status:"awaiting_approval"});await app.close();
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

  it.each([
    ["missing","REQUIREMENT_VERSION_REQUIRED"],
    ["mismatch","REQUIREMENT_VERSION_PROJECT_MISMATCH"],
    ["closed","PROJECT_VERSION_NOT_ACTIVE"]
  ] as const)("rejects a %s coding delivery version before creating a run",async(scenario,errorCode)=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject(projectPayload(await projectRepo(),{name:"Delivery"}));const version=ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"版本门禁",businessProblem:"编码必须使用有效交付版本",expectedOutcome:"运行前稳定拒绝",priority:"medium",primaryProjectId:project.id});
    if(scenario==="missing")(store as any).db.prepare("UPDATE requirement_projects SET project_version_id = NULL WHERE requirement_id = ? AND status = 'active'").run(req.id);
    if(scenario==="mismatch"){const other=store.createProject(projectPayload(await projectRepo(),{name:"Other"}));const otherVersion=ensureProjectVersion(store,other.id);(store as any).db.prepare("UPDATE requirement_projects SET project_version_id = ? WHERE requirement_id = ? AND status = 'active'").run(otherVersion.id,req.id);}
    if(scenario==="closed")(store as any).db.prepare("UPDATE project_versions SET status = 'closed' WHERE id = ?").run(version.id);
    store.updateRequirementState(req.id,"coding","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json().error).toBe(errorCode);expect(store.listStageRuns(req.id)).toHaveLength(0);await app.close();
  });

  it("passes the selected version to Codex and persists its execution base",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"版本编码",businessProblem:"编码必须从所选版本开始",expectedOutcome:"执行记录可追溯",priority:"medium",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"coding","ai_ready");const app=await buildApp(store);vi.mocked(runCodexCoding).mockClear();

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});
    for(let attempt=0;attempt<50&&!store.listExecutions(req.id).length;attempt++)await new Promise(resolve=>setTimeout(resolve,10));

    expect(response.statusCode).toBe(202);expect(runCodexCoding).toHaveBeenCalledWith(expect.objectContaining({project:expect.objectContaining({id:project.id}),version:expect.objectContaining({id:version.id,branch:version.branch,status:"active"})}));expect(store.listExecutions(req.id)[0]).toMatchObject({projectVersionId:version.id,baseCommit:"version-head"});await app.close();
  });

  it("maps a requirement change during context preparation to 409 without creating a run",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));const version=ensureProjectVersion(store,project.id);const next=store.createProjectVersion({projectId:project.id,name:"next",branch:"release/next",baseBranch:"main",worktreePath:`/tmp/api-run-next-${project.id}`,headCommit:"next-head"});const req=createRequirement(store,{title:"准备竞态",businessProblem:"上下文准备期间版本可能变化",expectedOutcome:"拒绝过期运行",priority:"medium",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"coding","ai_ready");const reserve=store.createStageRun.bind(store);store.createStageRun=((input:any)=>{store.replaceRequirementProjects(req.id,[{projectId:project.id,projectVersionId:next.id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0}]);return reserve(input);}) as any;const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json().error).toBe("REQUIREMENT_CHANGED_DURING_RUN_PREPARATION");expect(store.listStageRuns(req.id)).toHaveLength(0);expect(version.id).not.toBe(next.id);await app.close();
  });

  it("maps a project identity change during context preparation to 409 without creating a run",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"项目准备竞态",businessProblem:"上下文准备期间项目身份可能变化",expectedOutcome:"拒绝过期项目",priority:"medium",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"coding","ai_ready");const reserve=store.createStageRun.bind(store);store.createStageRun=((input:any)=>{store.updateProject(project.id,{allowedCommands:[{command:"npm",argsPrefix:["test"]}]});return reserve(input);}) as any;const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});

    expect(response.statusCode).toBe(409);expect(response.json().error).toBe("PROJECT_CHANGED_DURING_RUN_PREPARATION");expect(store.listStageRuns(req.id)).toHaveLength(0);await app.close();
  });

  it("atomically allows only one of two concurrent coding run requests",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo));ensureProjectVersion(store,project.id);const req=createRequirement(store,{title:"并发运行",businessProblem:"两个请求可能同时完成上下文准备",expectedOutcome:"只创建一个运行",priority:"medium",primaryProjectId:project.id});const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"ready",entries:[]});store.updateRequirementState(req.id,"coding","ai_ready");let release!:(value:any)=>void;const pending=new Promise(resolve=>{release=resolve});vi.mocked(runCodexCoding).mockImplementation(()=>pending as any);const app=await buildApp(store);

    const responses=await Promise.all([app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}}),app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}})]);

    expect(responses.map((response)=>response.statusCode).sort()).toEqual([202,409]);expect(responses.find((response)=>response.statusCode===409)?.json().error).toBe("RUN_ALREADY_ACTIVE");expect(store.listStageRuns(req.id)).toHaveLength(1);
    const blocked=await app.inject({method:"PATCH",url:`/api/projects/${project.id}`,payload:{allowedCommands:[{command:"npm",argsPrefix:["test"]}]}});release(codingResult);expect(blocked.statusCode).toBe(409);expect(blocked.json().error).toBe("PROJECT_IN_ACTIVE_EXECUTION");expect(runCodexCoding).toHaveBeenCalledWith(expect.objectContaining({project:expect.objectContaining({id:project.id,allowedCommands:[]})}));
    for(let attempt=0;attempt<50&&store.getStageRun(store.listStageRuns(req.id)[0]!.id)?.status==="running";attempt++)await new Promise(resolve=>setTimeout(resolve,10));const updated=await app.inject({method:"PATCH",url:`/api/projects/${project.id}`,payload:{allowedCommands:[{command:"npm",argsPrefix:["test"]}]}});expect(updated.statusCode).toBe(200);expect(updated.json().allowedCommands).toEqual([{command:"npm",argsPrefix:["test"]}]);await app.close();
  });

  it("rejects phase-one execution when multiple delivery projects are associated",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"多项目交付",businessProblem:"需要多个项目共同交付",expectedOutcome:"明确阻止执行",priority:"medium",primaryProjectId:a.id});
    store.replaceRequirementProjects(req.id,[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0},{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"collaborator",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:1}]);
    store.updateRequirementState(req.id,"coding","ai_ready");
    const app=await buildApp(store);const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{}});expect(response.statusCode).toBe(409);expect(response.json().error).toBe("MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED");expect(store.listStageRuns(req.id)).toHaveLength(0);await app.close();
  });

  it("allows multi-delivery technical design but keeps the coding phase-two guard",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo(),{name:"A"}));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const design=createRequirement(store,{title:"多项目设计",businessProblem:"设计需要两个交付项目",expectedOutcome:"完整上下文",priority:"medium",primaryProjectId:a.id});
    const associations=[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary" as const,usage:"delivery" as const,deliveryRequired:true,moduleMode:"all" as const,moduleIds:[],position:0},{projectId:b.id,projectVersionId:ensureProjectVersion(store,b.id).id,role:"collaborator" as const,usage:"delivery" as const,deliveryRequired:true,moduleMode:"all" as const,moduleIds:[],position:1}];
    store.replaceRequirementProjects(design.id,associations);
    for(const project of [a,b]){const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",project.repoPath,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:`${project.name} fact`,entries:[]});}
    store.updateRequirementState(design.id,"technical_design","ai_ready");const coding=createRequirement(store,{title:"多项目编码",businessProblem:"一期不能执行",expectedOutcome:"稳定阻止",priority:"medium",primaryProjectId:a.id});store.replaceRequirementProjects(coding.id,associations);store.updateRequirementState(coding.id,"coding","ai_ready");const app=await buildApp(store);

    const designResponse=await app.inject({method:"POST",url:`/api/requirements/${design.id}/run`,payload:{}});const codingResponse=await app.inject({method:"POST",url:`/api/requirements/${coding.id}/run`,payload:{}});

    expect(designResponse.statusCode).toBe(202);expect((store.getStageRun(designResponse.json().id) as any).input.projectContext.projects.map((project:any)=>project.projectId)).toEqual([a.id,b.id]);
    expect(codingResponse.statusCode).toBe(409);expect(codingResponse.json().error).toBe("MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED");await app.close();
  });

  it("redacts all associated project patterns from model-bound context and audit input",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const repo=await projectRepo();const project=store.createProject(projectPayload(repo,{sensitivePatterns:["CUSTOM_SECRET"]}));
    const req=createRequirement(store,{title:"敏感上下文",businessProblem:"防止提示词泄漏",expectedOutcome:"脱敏",priority:"medium",primaryProjectId:project.id});
    const knowledge=store.beginProjectKnowledge(project.id,(await execFileAsync("git",["-C",repo,"rev-parse","HEAD"])).stdout.trim(),"test");store.completeProjectKnowledge(knowledge.id,{summary:"token=MODEL_TOKEN CUSTOM_SECRET",entries:[{path:"docs/info.md",kind:"overview",title:"Info",content:"Bearer MODEL_BEARER CUSTOM_SECRET",tags:[]}]});store.updateRequirementState(req.id,"technical_design","ai_ready");const app=await buildApp(store);

    const response=await app.inject({method:"POST",url:`/api/requirements/${req.id}/run`,payload:{context:{note:"password=USER_PASSWORD CUSTOM_SECRET"}}});

    expect(response.statusCode).toBe(202);const runInput=(store.getStageRun(response.json().id) as any).input,input=JSON.stringify(runInput),prompt=buildAgentPrompt("technical_design",runInput);expect(input).not.toContain("MODEL_TOKEN");expect(input).not.toContain("MODEL_BEARER");expect(input).not.toContain("USER_PASSWORD");expect(input).not.toContain("CUSTOM_SECRET");expect(prompt).not.toContain("MODEL_TOKEN");expect(prompt).not.toContain("CUSTOM_SECRET");expect(input).toContain("[REDACTED]");expect(prompt).toContain("UNTRUSTED");await app.close();
  });

  it("snapshots technical-design approval and does not invalidate for ordering alone",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const a=store.createProject(projectPayload(await projectRepo()));const b=store.createProject(projectPayload(await projectRepo(),{name:"B"}));
    const req=createRequirement(store,{title:"设计快照",businessProblem:"需要稳定记录设计项目范围",expectedOutcome:"快照可追溯",priority:"medium",primaryProjectId:a.id});
    store.replaceRequirementProjects(req.id,[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:0},{projectId:b.id,role:"collaborator",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:1}]);
    store.updateRequirementState(req.id,"technical_design","awaiting_approval");const app=await buildApp(store);
    expect((await app.inject({method:"POST",url:`/api/requirements/${req.id}/approve`,payload:{decision:"approve",comment:"设计通过"}})).statusCode).toBe(200);expect(store.getRequirementProjectSnapshot(req.id)).not.toBeNull();
    const reordered=[{projectId:a.id,projectVersionId:ensureProjectVersion(store,a.id).id,role:"primary",usage:"delivery",deliveryRequired:true,moduleMode:"auto",moduleIds:[],position:1},{projectId:b.id,role:"collaborator",usage:"context",deliveryRequired:false,moduleMode:"all",moduleIds:[],position:0}];
    const response=await app.inject({method:"PUT",url:`/api/requirements/${req.id}/projects`,payload:reordered});expect(response.json()).toMatchObject({materialChange:false,technicalDesignInvalidated:false});expect(store.getRequirement(req.id)?.stage).toBe("coding");await app.close();
  });
});

describe("stage run API", () => {
  it("exposes project memory and requirement knowledge changes",async()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Memory",repoPath:"/tmp/api-memory",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=createRequirement(store, {title:"用户规则",businessProblem:"缺少",expectedOutcome:"明确",priority:"medium",primaryProjectId:project.id});
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
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
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
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口", expectedOutcome: "增加接口", priority: "medium" });
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
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少", expectedOutcome: "增加", priority: "medium" });
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
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少", expectedOutcome: "增加", priority: "medium" });
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
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口能力", expectedOutcome: "增加接口", priority: "medium" });
    store.updateRequirementState(req.id, "acceptance", "awaiting_approval");
    const app = await buildApp(store);
    const approved = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/approve`, payload: { decision: "approve", comment: "验收通过" } });
    expect(approved.json()).toMatchObject({ stage: "integration", status: "awaiting_merge" });
    expect((await app.inject({ method: "POST", url: `/api/requirements/${req.id}/run`, payload: {} })).statusCode).toBe(409);
    await app.close();
  });

  it("rejects integration outside the awaiting-merge state", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少接口能力", expectedOutcome: "增加接口", priority: "medium" });
    const app = await buildApp(store);
    const response = await app.inject({ method: "POST", url: `/api/requirements/${req.id}/integrate`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("INTEGRATION_NOT_ALLOWED");
    await app.close();
  });

  it("lists and saves a requirement-local integration target branch",async()=>{
    const repo=await branchRepo(),store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:repo,defaultBranch:"prod",allowedCommands:[],sensitivePatterns:[]});
    const req=createRequirement(store, {title:"接口",businessProblem:"缺少接口能力",expectedOutcome:"增加接口",priority:"medium",primaryProjectId:project.id});store.updateRequirementState(req.id,"integration","awaiting_merge");
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
    const req=createRequirement(store, {title:"接口",businessProblem:"缺少接口能力",expectedOutcome:"增加接口",priority:"medium",primaryProjectId:project.id});
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
