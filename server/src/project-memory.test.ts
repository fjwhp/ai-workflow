import { describe,expect,it } from "vitest";
import { extractKnowledgeCandidates } from "./project-memory.js";

const artifact={id:"artifact-1",stage:"definition",version:1,content:{productDecisions:[{decision:"用户名必须唯一",rationale:"用于登录",evidence:"SysUser.java"}],facts:["系统用户由后台管理"],risks:["权限配置错误会造成越权"],acceptanceCriteria:["重复用户名创建失败"]}};

describe("project memory extraction",()=>{
  it("extracts only approved artifacts with evidence links",()=>{
    expect(extractKnowledgeCandidates({projectId:"p1",requirement:{id:"r1",code:"REQ-1",title:"批量建用户"},artifacts:[artifact],approvals:[]})).toEqual([]);
    const result=extractKnowledgeCandidates({projectId:"p1",requirement:{id:"r1",code:"REQ-1",title:"批量建用户"},artifacts:[artifact],approvals:[{decision:"approve",artifact_id:"artifact-1"}]});
    expect(result.some(item=>item.type==="product_decision"&&item.title==="用户名必须唯一")).toBe(true);
    expect(result.every(item=>item.evidence.some(link=>link.artifactId==="artifact-1"&&link.stage==="definition"))).toBe(true);
  });

  it("marks sensitive knowledge for human review",()=>{
    const result=extractKnowledgeCandidates({projectId:"p1",requirement:{id:"r1",code:"REQ-1",title:"批量建用户"},artifacts:[artifact],approvals:[{decision:"approve",artifact_id:"artifact-1"}]});
    expect(result.find(item=>item.content.includes("越权"))).toMatchObject({riskLevel:"high",publishDecision:"human_review"});
    expect(result.find(item=>item.title==="用户名必须唯一")).toMatchObject({publishDecision:"auto_publish"});
  });

  it("deduplicates the same subject across approved artifacts",()=>{
    const second={...artifact,id:"artifact-2",stage:"solution_design"};
    const result=extractKnowledgeCandidates({projectId:"p1",requirement:{id:"r1",code:"REQ-1",title:"批量建用户"},artifacts:[artifact,second],approvals:[{decision:"approve",artifact_id:"artifact-1"},{decision:"approve",artifact_id:"artifact-2"}]});
    expect(result.filter(item=>item.title==="用户名必须唯一")).toHaveLength(1);
  });
});
