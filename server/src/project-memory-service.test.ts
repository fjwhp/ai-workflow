import { afterEach,describe,expect,it } from "vitest";
import { WorkflowStore } from "./store.js";
import { publishRequirementKnowledge,refreshRequirementKnowledge } from "./project-memory-service.js";

const stores:WorkflowStore[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
describe("project memory service",()=>{
  it("refreshes approved candidates and publishes them idempotently",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:"/tmp/memory-service",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"用户规则",businessProblem:"缺少",expectedOutcome:"明确",priority:"medium",primaryProjectId:project.id});
    const artifact=store.addArtifact(req.id,"prd","PRD",{confidence:0.9,productDecisions:[{decision:"用户名唯一",rationale:"登录标识",evidence:"User.java"}]});
    store.addApproval(req.id,"prd",{decision:"approve",comment:"通过",artifactId:artifact.id});
    expect(refreshRequirementKnowledge(store,req.id)).toHaveLength(1);
    expect(publishRequirementKnowledge(store,req.id).publishedCount).toBe(1);
    expect(publishRequirementKnowledge(store,req.id).publishedCount).toBe(0);
    expect(store.listProjectMemory(project.id).records).toHaveLength(1);
  });
});
