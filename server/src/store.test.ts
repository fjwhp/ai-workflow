import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

const stores: WorkflowStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("WorkflowStore", () => {
  it("persists candidates and publishes only safe non-conflicting knowledge",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Memory Repo",repoPath:"/tmp/repo-memory",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"用户规则",businessProblem:"缺少规则",expectedOutcome:"形成规则",priority:"medium",projectId:project.id});
    const base={projectId:project.id,requirementId:req.id,layer:"decision",type:"product_decision",modules:[],tags:[],sourceStage:"prd",confidence:0.9,riskLevel:"normal",publishDecision:"auto_publish",evidence:[{artifactId:"a1",stage:"prd",version:1}]};
    store.replaceKnowledgeCandidates(req.id,project.id,[{...base,subjectKey:"subject-1",title:"用户名唯一",content:"用户名必须唯一"},{...base,subjectKey:"subject-2",title:"权限规则",content:"仅管理员可创建",riskLevel:"high",publishDecision:"human_review"}]);
    expect(store.listKnowledgeCandidates(req.id)).toHaveLength(2);
    expect(store.publishKnowledgeCandidates(req.id)).toMatchObject({publishedCount:1,reviewCount:1,conflictCount:0});
    expect(store.listProjectMemory(project.id).records).toHaveLength(1);
    store.replaceKnowledgeCandidates(req.id,project.id,[{...base,subjectKey:"subject-1",title:"用户名唯一",content:"用户名允许重复"}]);
    expect(store.publishKnowledgeCandidates(req.id)).toMatchObject({publishedCount:0,conflictCount:1});
  });

  it("persists immutable project knowledge versions",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:"/tmp/repo",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const building=store.beginProjectKnowledge(project.id,"abc123","manual");
    expect(store.getProjectKnowledgeStatus(project.id)).toMatchObject({status:"building",sourceHead:"abc123"});
    const ready=store.completeProjectKnowledge(building.id,{summary:"点餐平台",entries:[{path:"README.md",kind:"overview",title:"项目介绍",content:"内容",tags:["overview"]}]});
    expect(ready).toMatchObject({version:1,status:"ready",sourceHead:"abc123",summary:"点餐平台"});
    expect(store.listProjectKnowledgeVersions(project.id)).toHaveLength(1);
  });
  it("creates a requirement with a stable sequential code", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const first = store.createRequirement({ title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险", expectedOutcome: "所有下单入口行为一致", priority: "medium" });
    const second = store.createRequirement({ title: "门店筛选优化", businessProblem: "运营查找目标门店需要花费较多时间", expectedOutcome: "可以快速筛选门店", priority: "low" });
    expect(first.code).toBe("REQ-0001");
    expect(second.code).toBe("REQ-0002");
    expect(first.status).toBe("ai_ready");
  });

  it("keeps artifact versions immutable", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险", expectedOutcome: "所有下单入口行为一致", priority: "medium" });
    const a = store.addArtifact(req.id, "prd", "第一版", { conclusion: "pass" });
    const b = store.addArtifact(req.id, "prd", "第二版", { conclusion: "pass" });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(store.listArtifacts(req.id)).toHaveLength(2);
  });

  it("associates an existing requirement with a registered project", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({
      name: "Soto Dine", repoPath: "/tmp/soto-dine", defaultBranch: "prod",
      allowedCommands: [], sensitivePatterns: []
    });
    const req = store.createRequirement({
      title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险",
      expectedOutcome: "所有下单入口行为一致", priority: "medium"
    });
    const updated = store.setRequirementProject(req.id, project.id);
    expect(updated?.projectId).toBe(project.id);
    expect(updated?.projectName).toBe("Soto Dine");
  });

  it("creates an immutable revision when a returned requirement is clarified", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({
      title: "订单备注规则统一", businessProblem: "三个入口规则不一致",
      expectedOutcome: "入口行为一致", priority: "medium"
    });
    store.updateRequirementState(req.id, "prd", "returned");
    const updated = store.reviseRequirement(req.id, {
      title: req.title,
      businessProblem: "H5、普通下单和开放接口的备注规则不一致",
      expectedOutcome: "三个入口统一执行50字符限制和trim规则",
      priority: "medium",
      clarifications: "允许为空；trim后最多50字符；只影响新订单。"
    });
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("ai_ready");
    expect(updated?.stage).toBe("prd");
    expect(updated?.clarifications).toContain("最多50字符");
    expect(store.listRequirementRevisions(req.id).map((revision) => revision.version)).toEqual([2, 1]);
  });

  it("resumes the returned stage instead of forcing every correction to PRD", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口实现", businessProblem: "现有接口缺少创建能力", expectedOutcome: "新增创建接口", priority: "medium" });
    store.updateRequirementState(req.id, "technical_design", "returned");
    const updated = store.reviseRequirement(req.id, { ...req, clarifications: "补充接口契约、错误码和回滚策略。" });
    expect(updated?.stage).toBe("technical_design");
  });

  it("persists an ordered stage run and prevents duplicate active runs", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "prd", model: "gpt-5.5", input: { prompt: "hello" } });
    expect(() => store.createStageRun({ requirementId: req.id, stage: "prd", model: "gpt-5.5", input: {} })).toThrow("RUN_ALREADY_ACTIVE");
    store.appendStageRunEvent(run.id, "request.sent", { ok: true });
    store.appendStageRunEvent(run.id, "output.delta", { text: "done" });
    expect(store.getStageRun(run.id)?.events.map((event: any) => event.sequence)).toEqual([1, 2, 3]);
    store.completeStageRun(run.id, { conclusion: "pass" });
    expect(store.getStageRun(run.id)?.status).toBe("completed");
  });

  it("marks abandoned active runs as interrupted", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "prd", model: "gpt-5.5", input: {} });
    expect(store.interruptActiveStageRuns()).toBe(1);
    expect(store.getStageRun(run.id)?.status).toBe("interrupted");
  });

  it("recovers requirements left in ai_running without an active run", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    store.updateRequirementState(req.id, "prd", "ai_running");
    expect(store.recoverInterruptedRequirements()).toBe(1);
    expect(store.getRequirement(req.id)?.status).toBe("ai_ready");
  });

  it("persists gate configuration with defaults", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    expect(store.getGateConfig()).toEqual({ autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: ["coding", "acceptance"] });
    store.updateGateConfig({ autoTransitionEnabled: false, confidenceThreshold: 0.9, mandatoryHumanStages: ["coding"] });
    expect(store.getGateConfig().confidenceThreshold).toBe(0.9);
    expect(store.getGateConfig().autoTransitionEnabled).toBe(false);
  });

  it("applies one automatic gate decision per artifact", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const artifact = store.addArtifact(req.id, "prd", "PRD", { conclusion: "pass" });
    const first = store.applyGateDecision({ requirementId: req.id, stage: "prd", artifactId: artifact.id, decision: "auto_approve", reasons: ["安全通过"] });
    const second = store.applyGateDecision({ requirementId: req.id, stage: "prd", artifactId: artifact.id, decision: "auto_approve", reasons: ["安全通过"] });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(store.getRequirement(req.id)?.stage).toBe("requirement_review");
    expect(store.listApprovals(req.id)).toHaveLength(1);
  });

  it("stores one immutable coding evidence snapshot per execution", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Repo", repoPath: "/tmp/repo", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少", expectedOutcome: "新增", priority: "medium", projectId: project.id });
    const execution = store.addExecution({ requirementId: req.id, stage: "coding", projectId: project.id, branch: "ai/one", worktreePath: "/tmp/wt", status: "completed", diff: "diff", events: [] });
    const evidence = store.addCodingEvidence({ executionId: execution.id, requirementId: req.id, projectId: project.id, branch: "ai/one", worktreePath: "/tmp/wt", diffHash: "abc", diff: "diff", originalChars: 4, truncated: false, files: ["a.ts"], additions: 1, deletions: 0, diagnostics: "" });
    expect(store.getLatestCodingEvidence(req.id)?.id).toBe(evidence.id);
    expect(() => store.addCodingEvidence({ ...evidence, id: undefined })).toThrow();
  });

  it("stores one immutable rework context per return approval",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const req=store.createRequirement({title:"接口",businessProblem:"缺少",expectedOutcome:"新增",priority:"medium"});
    const approval=store.addApproval(req.id,"code_review",{decision:"return",comment:"修复权限",targetStage:"coding"});
    const context=store.addReworkContext(req.id,{approvalId:approval.id,artifactId:null,sourceStage:"code_review",targetStage:"coding",actorType:"human",decisionAt:approval.created_at,unstructured:true,items:[{id:"i1",title:"修复权限"}],risks:[],openQuestions:[]});
    expect(store.getLatestReworkContext(req.id)?.id).toBe(context.id);
    expect(()=>store.addReworkContext(req.id,{...context,id:undefined})).toThrow();
  });

  it("atomically records a human override and advances code review", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少", expectedOutcome: "新增", priority: "medium" });
    store.updateRequirementState(req.id, "code_review", "awaiting_approval");
    const artifact = store.addArtifact(req.id, "code_review", "Review", { risks: ["权限风险"], openQuestions: ["兼容旧数据？"] });
    store.addApproval(req.id, "code_review", { decision: "return", comment: "修复权限", targetStage: "coding" });
    store.addApproval(req.id, "code_review", { decision: "return", comment: "补充测试", targetStage: "coding" });

    const result = store.applyHumanOverride(req.id, "code_review", "人工确认风险可接受");

    expect(result.requirement?.stage).toBe("testing");
    expect(result.requirement?.status).toBe("ai_ready");
    expect(result.approval).toMatchObject({ actor_type: "human_override", artifact_id: artifact.id, return_count: 2 });
    expect(result.approval.override).toMatchObject({ risks: ["权限风险"], openQuestions: ["兼容旧数据？"], targetStage: "testing" });
  });

  it("persists one active local integration and its terminal evidence", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = store.createRequirement({ title: "接口", businessProblem: "缺少接口能力", expectedOutcome: "新增接口", priority: "medium" });
    store.updateRequirementState(req.id, "integration", "awaiting_merge");
    const run = store.createIntegrationRun({ requirementId: req.id, projectId: "project-1", executionId: "execution-1", evidenceId: "evidence-1", sourceBranch: "ai/req", worktreePath: "/tmp/wt", targetBranch: "main", preflight: { allowed: true } });
    expect(() => store.createIntegrationRun({ requirementId: req.id, projectId: "project-1", sourceBranch: "ai/req", worktreePath: "/tmp/wt", targetBranch: "main", preflight: {} })).toThrow("INTEGRATION_ALREADY_ACTIVE");
    const completed = store.completeIntegrationRun(run!.id, { status: "completed", sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40), commandResults: [], error: null });
    expect(completed).toMatchObject({ status: "completed", sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40) });
    expect(store.getLatestIntegrationRun(req.id)?.id).toBe(run!.id);
  });

  it("stores an integration target on the requirement without changing the project default",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Repo",repoPath:"/tmp/repo-target",defaultBranch:"prod",allowedCommands:[],sensitivePatterns:[]});
    const req=store.createRequirement({title:"接口",businessProblem:"缺少接口能力",expectedOutcome:"新增接口",priority:"medium",projectId:project.id});
    store.updateRequirementState(req.id,"integration","awaiting_merge");
    const updated=store.setIntegrationTarget(req.id,"feature/0710-test");
    expect(updated?.integrationTargetBranch).toBe("feature/0710-test");
    expect(store.getProject(project.id)?.defaultBranch).toBe("prod");
  });
});
