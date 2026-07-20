import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  WorkflowStore,
  type ExecutionInput,
  type RequirementProjectSnapshot,
  type RequirementProjectWithVersionMetadata
} from "./store.js";
import { evaluateGate, failClosedGateConfig } from "@ai-workflow/shared";

const stores: WorkflowStore[] = [];
const directories: string[] = [];
let fixtureProjectSequence = 0;
function ensureProjectVersion(store: WorkflowStore, projectId: string) {
  const existing = store.listProjectVersions(projectId, "active")[0];
  if (existing) return existing;
  const project = store.getProject(projectId);
  if (!project || project.status !== "active") return null;
  return store.createProjectVersion({
    projectId, name: "fixture", branch: `fixture/${projectId}`, baseBranch: project.defaultBranch,
    worktreePath: `/tmp/requirement-version-${projectId}`, headCommit: "fixture-head"
  });
}
function createRequirement(store: WorkflowStore, input: any) {
  if (input.primaryProjectId) {
    const version = input.primaryProjectVersionId ? null : ensureProjectVersion(store, input.primaryProjectId);
    return store.createRequirement({ ...input, primaryProjectVersionId: input.primaryProjectVersionId ?? version?.id ?? "missing-version" });
  }
  fixtureProjectSequence += 1;
  const project = store.createProject({
    name: `Fixture ${fixtureProjectSequence}`, repoPath: `/tmp/requirement-fixture-${fixtureProjectSequence}`,
    defaultBranch: "main", allowedCommands: [], sensitivePatterns: []
  });
  const version = ensureProjectVersion(store, project.id)!;
  return store.createRequirement({ ...input, primaryProjectId: project.id, primaryProjectVersionId: version.id });
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("WorkflowStore", () => {
  it("opens with an empty fresh schema", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    expect(store.listRequirements()).toEqual([]);
    expect(store.listProjects()).toEqual([]);
  });

  it("creates and lists project metadata", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({
      name: "Storefront", repoPath: "/tmp/storefront", defaultBranch: "main",
      category: "frontend", technology: ["node", "react"], allowedCommands: [], sensitivePatterns: []
    });
    expect(project).toMatchObject({ category: "frontend", technology: ["node", "react"], status: "active" });
    expect(project.updatedAt).toBe(project.createdAt);
    expect(store.listProjects({ activeOnly: true })).toEqual([project]);
    expect(store.findProjectByRepoPath("/tmp/storefront/../storefront")?.id).toBe(project.id);
  });

  it("updates only specified project fields and supports category clearing", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Old", repoPath: "/tmp/update-project", defaultBranch: "main", category: "other", technology: ["node"], allowedCommands: [], sensitivePatterns: [] });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.updateProject(project.id, { name: "New", category: "backend", defaultBranch: "prod" });
    expect(updated).toMatchObject({ name: "New", category: "backend", defaultBranch: "prod", technology: ["node"] });
    expect(updated!.updatedAt > project.updatedAt).toBe(true);
    expect(store.updateProject(project.id, { category: null })?.category).toBeNull();
  });

  it("rejects normalized duplicate repository paths, including archived projects", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const original = store.createProject({ name: "One", repoPath: "/tmp/identity/repo", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    expect(() => store.createProject({ name: "Two", repoPath: "/tmp/identity/child/../repo", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] })).toThrow("PROJECT_REPO_PATH_EXISTS");
    store.archiveProject(original.id);
    expect(() => store.createProject({ name: "Replacement", repoPath: "/tmp/identity/repo", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] })).toThrow("PROJECT_REPO_PATH_EXISTS");
    const other = store.createProject({ name: "Other", repoPath: "/tmp/identity/other", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    expect(() => store.updateProject(other.id, { repoPath: "/tmp/identity/repo" })).toThrow("PROJECT_REPO_PATH_EXISTS");
  });

  it("uses canonical repository identity for existing paths and symlink aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-identity-")); directories.push(directory);
    const firstRepo = join(directory, "first");
    const secondRepo = join(directory, "second");
    mkdirSync(firstRepo); mkdirSync(secondRepo);
    const firstAlias = join(directory, "first-alias");
    const secondAlias = join(directory, "second-alias");
    symlinkSync(firstRepo, firstAlias); symlinkSync(secondRepo, secondAlias);
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const first = store.createProject({ name: "First", repoPath: firstAlias, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    expect(first.repoPath).toBe(realpathSync(firstRepo));
    expect(store.findProjectByRepoPath(firstAlias)?.id).toBe(first.id);
    expect(() => store.createProject({ name: "Duplicate", repoPath: firstRepo, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] })).toThrow("PROJECT_REPO_PATH_EXISTS");
    const second = store.createProject({ name: "Second", repoPath: secondRepo, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    expect(() => store.updateProject(second.id, { repoPath: firstAlias })).toThrow("PROJECT_REPO_PATH_EXISTS");
    expect(store.findProjectByRepoPath(secondAlias)?.id).toBe(second.id);
  });

  it("archives idempotently, keeps projects readable, and blocks new primary associations", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Old", repoPath: "/tmp/archived", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const requirement = createRequirement(store, { title: "Existing", businessProblem: "Existing business issue", expectedOutcome: "Resolved", priority: "medium", primaryProjectId: project.id });
    expect(store.archiveProject(project.id)?.status).toBe("archived");
    expect(store.archiveProject(project.id)?.status).toBe("archived");
    expect(store.listProjects({ activeOnly: true })).toEqual([]);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.getProject(project.id)?.status).toBe("archived");
    expect(store.listRequirementProjects(requirement.id)[0]).toMatchObject({ status: "active", projectStatus: "archived" });
    expect(store.setRequirementProject(requirement.id, project.id)).toBeNull();
    expect(() => createRequirement(store, { title: "New association", businessProblem: "Archived project cannot be selected", expectedOutcome: "Selection rejected", priority: "medium", primaryProjectId: project.id })).toThrow("PROJECT_NOT_ACTIVE");
    expect(store.archiveProject("missing")).toBeNull();
  });

  it("blocks archiving delivery projects throughout unfinished delivery stages",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject({name:"Delivery",repoPath:"/tmp/archive-lifecycle",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=createRequirement(store,{title:"交付生命周期",businessProblem:"需要保护活动项目交付",expectedOutcome:"阻止错误归档",priority:"medium",primaryProjectId:project.id});
    for(const [stage,status] of [["implementation","ai_ready"],["quality_verification","awaiting_approval"],["quality_verification","returned"],["acceptance_delivery","blocked"]] as const){store.updateRequirementState(req.id,stage,status);expect(store.projectHasActiveDelivery(project.id)).toBe(true);}
    store.updateRequirementState(req.id,"acceptance_delivery","completed");expect(store.projectHasActiveDelivery(project.id)).toBe(false);
  });

  it("cancels building knowledge and ignores its late completion",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject({name:"Race",repoPath:"/tmp/knowledge-race",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const old=store.beginProjectKnowledge(project.id,"old-head","project_created");expect(store.cancelBuildingProjectKnowledge(project.id,"项目仓库配置已变更")).toBe(1);expect(store.getProjectKnowledgeVersion(old.id)).toMatchObject({status:"canceled",error:"项目仓库配置已变更"});
    const next=store.beginProjectKnowledge(project.id,"new-head","project_updated");expect(store.completeProjectKnowledge(old.id,{summary:"stale",entries:[]})).toMatchObject({status:"canceled"});expect(store.failProjectKnowledge(old.id,"late failure")).toMatchObject({status:"canceled"});
    expect(store.completeProjectKnowledge(next.id,{summary:"fresh",entries:[]})).toMatchObject({status:"ready",sourceHead:"new-head"});expect(store.getLatestProjectKnowledge(project.id)?.id).toBe(next.id);
  });

  it("creates the multi-project tables without legacy requirement columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-store-")); directories.push(directory);
    const path = join(directory, "workflow.db");
    const store = new WorkflowStore(path); store.close();
    const db = new DatabaseSync(path);
    const requirementColumns = (db.prepare("PRAGMA table_info(requirements)").all() as { name: string }[]).map(({ name }) => name);
    expect(requirementColumns).not.toContain("project_id");
    expect(requirementColumns).not.toContain("integration_target_branch");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requirement_projects'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requirement_project_snapshots'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_requirement_projects_active_primary'").get()).toBeTruthy();
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_unit_active_run'").get())
      .toMatchObject({ sql: expect.stringMatching(/UNIQUE[\s\S]*owner_type,\s*owner_id,\s*stage[\s\S]*WHERE status = 'running'/i) });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_requirement_projects_active_project'").get())
      .toMatchObject({ sql: expect.stringMatching(/UNIQUE[\s\S]*requirement_id,\s*project_id[\s\S]*WHERE status = 'active'/i) });
    db.close();
  });

  it("rejects a second active primary project for one requirement", () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-store-")); directories.push(directory);
    const path = join(directory, "workflow.db");
    const store = new WorkflowStore(path); store.close();
    const db = new DatabaseSync(path);
    const now = new Date().toISOString();
    const insertProject = db.prepare("INSERT INTO projects (id,name,repo_path,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?)");
    insertProject.run("p1", "One", "/tmp/one", "main", now, now);
    insertProject.run("p2", "Two", "/tmp/two", "main", now, now);
    db.prepare("INSERT INTO requirements (id,code,title,business_problem,expected_outcome,priority,stage,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("r1", "REQ-0001", "Title", "Business problem", "Outcome", "medium", "definition", "ai_ready", now, now);
    const insertAssociation = db.prepare("INSERT INTO requirement_projects (id,requirement_id,project_id,role,usage,delivery_required,module_mode,module_ids_json,position,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    insertAssociation.run("rp1", "r1", "p1", "primary", "delivery", 1, "all", "[]", 0, "active", now, now);
    expect(() => insertAssociation.run("rp2", "r1", "p2", "primary", "delivery", 1, "all", "[]", 1, "active", now, now)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("persists candidates and publishes only safe non-conflicting knowledge",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const project=store.createProject({name:"Memory Repo",repoPath:"/tmp/repo-memory",defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
    const req=createRequirement(store, {title:"用户规则",businessProblem:"缺少规则",expectedOutcome:"形成规则",priority:"medium",primaryProjectId:project.id});
    const base={projectId:project.id,requirementId:req.id,layer:"decision",type:"product_decision",modules:[],tags:[],sourceStage:"definition",confidence:0.9,riskLevel:"normal",publishDecision:"auto_publish",evidence:[{artifactId:"a1",stage:"definition",version:1}]};
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
    const first = createRequirement(store, { title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险", expectedOutcome: "所有下单入口行为一致", priority: "medium" });
    const second = createRequirement(store, { title: "门店筛选优化", businessProblem: "运营查找目标门店需要花费较多时间", expectedOutcome: "可以快速筛选门店", priority: "low" });
    expect(first.code).toBe("REQ-0001");
    expect(second.code).toBe("REQ-0002");
    expect(first).toMatchObject({ stage: "definition", status: "ai_ready" });
  });

  it("keeps artifact versions immutable", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险", expectedOutcome: "所有下单入口行为一致", priority: "medium" });
    const a = store.addArtifact(req.id, "definition", "第一版", { conclusion: "pass" });
    const b = store.addArtifact(req.id, "definition", "第二版", { conclusion: "pass" });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(store.listArtifacts(req.id)).toHaveLength(2);
  });

  it("creates and replaces the interim primary project association", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({
      name: "Soto Dine", repoPath: "/tmp/soto-dine", defaultBranch: "prod",
      allowedCommands: [], sensitivePatterns: []
    });
    const req = createRequirement(store, {
      title: "订单备注规则统一", businessProblem: "三个入口的备注规则存在不一致风险",
      expectedOutcome: "所有下单入口行为一致", priority: "medium", primaryProjectId: project.id
    });
    expect(req).toMatchObject({ projectId: project.id, projectName: "Soto Dine" });
    const replacement = store.createProject({
      name: "Admin", repoPath: "/tmp/admin", defaultBranch: "main",
      allowedCommands: [], sensitivePatterns: []
    });
    const replacementVersion = ensureProjectVersion(store, replacement.id)!;
    expect(store.setRequirementProject(req.id, replacement.id, replacementVersion.id)).toMatchObject({ projectId: replacement.id, projectName: "Admin" });
  });

  it("persists ordered joined requirement project associations atomically", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const primary = store.createProject({ name: "Web", repoPath: "/tmp/rp-web", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const collaborator = store.createProject({ name: "API", repoPath: "/tmp/rp-api", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const req = createRequirement(store, { title: "Cross project", businessProblem: "Behavior differs between applications", expectedOutcome: "Consistent behavior", priority: "high", primaryProjectId: primary.id });
    const collaboratorVersion = ensureProjectVersion(store, collaborator.id)!;
    const inputs = [
      { projectId: primary.id, role: "primary" as const, usage: "context" as const, deliveryRequired: false, moduleMode: "auto" as const, moduleIds: [], position: 0 },
      { projectId: collaborator.id, projectVersionId: collaboratorVersion.id, role: "collaborator" as const, usage: "delivery" as const, deliveryRequired: true, moduleMode: "all" as const, moduleIds: [], position: 1 }
    ];
    expect(store.replaceRequirementProjects(req.id, inputs).map((item) => item.projectName)).toEqual(["Web", "API"]);
    expect(store.listRequirementProjects(req.id)[1]).toMatchObject({
      projectVersionId: collaboratorVersion.id, projectVersionName: "fixture",
      projectVersionBranch: `fixture/${collaborator.id}`, projectVersionStatus: "active"
    });
    expect(store.getRequirement(req.id)).toMatchObject({ primaryProjectId: primary.id, primaryProjectName: "Web", projectId: collaborator.id, projectName: "API" });
    expect(store.getRequirement(req.id)?.projects).toHaveLength(2);

    expect(() => store.replaceRequirementProjects(req.id, [inputs[0]!, { ...inputs[1]!, projectId: "missing" }])).toThrow("PROJECT_NOT_ACTIVE");
    expect(store.listRequirementProjects(req.id).map((item) => item.projectId)).toEqual([primary.id, collaborator.id]);

    const primaryVersion = ensureProjectVersion(store, primary.id)!;
    expect(() => store.replaceRequirementProjects(req.id, [inputs[0]!, { ...inputs[1]!, projectVersionId: primaryVersion.id }]))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    const closedVersion = store.createProjectVersion({
      projectId: collaborator.id, name: "closed", branch: "feature/closed", baseBranch: "main",
      worktreePath: "/tmp/rp-api-closed", headCommit: "closed-head"
    });
    store.closeProjectVersion(closedVersion.id);
    expect(() => store.replaceRequirementProjects(req.id, [inputs[0]!, { ...inputs[1]!, projectVersionId: closedVersion.id }]))
      .toThrow("PROJECT_VERSION_NOT_ACTIVE");
    expect(store.listRequirementProjects(req.id).map((item) => item.projectVersionId)).toEqual([undefined, collaboratorVersion.id]);
  });

  it("omits archived project history when the same project remains actively associated", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Archived active", repoPath: "/tmp/archived-active", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const firstVersion = ensureProjectVersion(store, project.id)!;
    const secondVersion = store.createProjectVersion({
      projectId: project.id, name: "v2", branch: "feature/v2", baseBranch: "main",
      worktreePath: "/tmp/archived-active-v2", headCommit: "v2-head"
    });
    const requirement = createRequirement(store, {
      title: "Archived active history", businessProblem: "Active and archived rows duplicate projects",
      expectedOutcome: "One project entry", priority: "medium", primaryProjectId: project.id,
      primaryProjectVersionId: firstVersion.id
    });
    store.replaceRequirementProjects(requirement.id, [{
      projectId: project.id, projectVersionId: secondVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    }]);
    store.archiveProject(project.id);

    const active = store.listRequirementProjects(requirement.id);
    const archived = store.listArchivedRequirementProjectHistory(requirement.id);
    expect(active[0]).toMatchObject({ projectId: project.id, projectVersionId: secondVersion.id, projectStatus: "archived" });
    expect(archived).toEqual([]);
    expect(new Set([...active, ...archived].map((item) => item.projectId)).size).toBe(active.length + archived.length);
  });

  it("returns only the latest archived association per removed project", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const removed = store.createProject({ name: "Removed", repoPath: "/tmp/removed-history", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const replacement = store.createProject({ name: "Replacement", repoPath: "/tmp/replacement-history", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const firstVersion = ensureProjectVersion(store, removed.id)!;
    const secondVersion = store.createProjectVersion({
      projectId: removed.id, name: "v2", branch: "feature/v2", baseBranch: "main",
      worktreePath: "/tmp/removed-history-v2", headCommit: "v2-head"
    });
    const replacementVersion = ensureProjectVersion(store, replacement.id)!;
    const requirement = createRequirement(store, {
      title: "Latest archived history", businessProblem: "Version changes create duplicate project history",
      expectedOutcome: "Latest project history only", priority: "medium", primaryProjectId: removed.id,
      primaryProjectVersionId: firstVersion.id
    });
    for (const projectVersionId of [secondVersion.id, firstVersion.id, secondVersion.id]) {
      store.replaceRequirementProjects(requirement.id, [{
        projectId: removed.id, projectVersionId, role: "primary", usage: "delivery",
        deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
      }]);
    }
    store.replaceRequirementProjects(requirement.id, [{
      projectId: replacement.id, projectVersionId: replacementVersion.id, role: "primary", usage: "delivery",
      deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
    }]);
    store.archiveProject(removed.id);

    const active = store.listRequirementProjects(requirement.id);
    const archived = store.listArchivedRequirementProjectHistory(requirement.id);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      projectId: removed.id, projectVersionId: secondVersion.id, status: "archived", projectStatus: "archived"
    });
    expect(new Set([...active, ...archived].map((item) => item.projectId)).size).toBe(active.length + archived.length);
  });

  it("validates selected modules against the latest ready knowledge index", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Modules", repoPath: "/tmp/rp-modules", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const req = createRequirement(store, { title: "Module change", businessProblem: "Module behavior needs correction", expectedOutcome: "Correct module", priority: "medium", primaryProjectId: project.id });
    const version = ensureProjectVersion(store, project.id)!;
    const selected = [{ projectId: project.id, projectVersionId: version.id, role: "primary" as const, usage: "delivery" as const, deliveryRequired: true, moduleMode: "selected" as const, moduleIds: ["src/orders"], position: 0 }];
    expect(() => store.replaceRequirementProjects(req.id, selected)).toThrow("MODULE_INDEX_REQUIRED");
    const knowledge = store.beginProjectKnowledge(project.id, "head", "manual");
    store.completeProjectKnowledge(knowledge.id, { summary: "modules", entries: [{ path: "src/orders", kind: "module", title: "Orders", content: "", tags: [] }] });
    expect(store.replaceRequirementProjects(req.id, selected)[0]!.moduleIds).toEqual(["src/orders"]);
    expect(() => store.replaceRequirementProjects(req.id, [{ ...selected[0]!, moduleIds: ["src/missing"] }])).toThrow("MODULE_NOT_FOUND");
  });

  it("creates immutable versioned association snapshots and supersedes the prior active version", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Snapshot", repoPath: "/tmp/rp-snapshot", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const req = createRequirement(store, { title: "Snapshot associations", businessProblem: "Execution needs frozen project configuration", expectedOutcome: "Immutable evidence", priority: "medium", primaryProjectId: project.id });
    const version = ensureProjectVersion(store, project.id)!;
    const first = store.createRequirementProjectSnapshot(req.id);
    expectTypeOf(first).toEqualTypeOf<RequirementProjectSnapshot>();
    expectTypeOf(first.associations).toEqualTypeOf<RequirementProjectWithVersionMetadata[]>();
    expect(first.associations[0]!.projectVersionHead).toBe("fixture-head");
    expect(first.associations[0]!.projectVersionWorktreePath).toBe(`/tmp/requirement-version-${project.id}`);
    store.updateProjectVersionHead(version.id, "new-head");
    store.supersedeRequirementProjectSnapshot(req.id);
    store.replaceRequirementProjects(req.id, [{ projectId: project.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "auto", moduleIds: [], position: 4 }]);
    const second = store.createRequirementProjectSnapshot(req.id);
    expect(first).toMatchObject({ version: 1, status: "active" });
    expect(second).toMatchObject({ version: 2, status: "active" });
    expect(store.getRequirementProjectSnapshot(req.id)?.id).toBe(second.id);
    expect(store.listRequirementProjectSnapshots(req.id).map((item) => item.status)).toEqual(["active", "superseded"]);
    expect(first.associations[0]!.usage).toBe("delivery");
    expect(first.associations[0]).toMatchObject({
      projectVersionId: version.id, projectVersionName: "fixture", projectVersionBranch: `fixture/${project.id}`,
      projectVersionWorktreePath: `/tmp/requirement-version-${project.id}`, projectVersionHead: "fixture-head"
    });
    expect(store.listRequirementProjectSnapshots(req.id)[1]!.associations[0]!.projectVersionHead).toBe("fixture-head");
    expect(second.associations[0]!.usage).toBe("context");
    expect(second.associations[0]!.projectVersionId).toBeUndefined();
  });

  it("rolls back requirement creation when the required primary project is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-atomic-")); directories.push(directory);
    const path = join(directory, "workflow.db");
    const store = new WorkflowStore(path); stores.push(store);
    expect(() => createRequirement(store, { title: "Atomic create", businessProblem: "A missing project must not leave data", expectedOutcome: "No orphan", priority: "medium", primaryProjectId: "missing" })).toThrow("PROJECT_NOT_ACTIVE");
    const project = store.createProject({ name: "Archived", repoPath: "/tmp/rp-archived", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    store.archiveProject(project.id);
    expect(() => createRequirement(store, { title: "Atomic archived", businessProblem: "An archived project must not leave data", expectedOutcome: "No orphan", priority: "medium", primaryProjectId: project.id })).toThrow("PROJECT_NOT_ACTIVE");
    expect(store.listRequirements()).toEqual([]);
    const available = store.createProject({ name: "Available", repoPath: "/tmp/rp-available", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    expect(createRequirement(store, { title: "Atomic success", businessProblem: "A valid project creates data", expectedOutcome: "One requirement", priority: "medium", primaryProjectId: available.id }).code).toBe("REQ-0001");
  });

  it("creates an immutable revision when a returned requirement is clarified", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, {
      title: "订单备注规则统一", businessProblem: "三个入口规则不一致",
      expectedOutcome: "入口行为一致", priority: "medium"
    });
    store.updateRequirementState(req.id, "definition", "returned");
    const updated = store.reviseRequirement(req.id, {
      title: req.title,
      businessProblem: "H5、普通下单和开放接口的备注规则不一致",
      expectedOutcome: "三个入口统一执行50字符限制和trim规则",
      priority: "medium",
      clarifications: "允许为空；trim后最多50字符；只影响新订单。"
    });
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("ai_ready");
    expect(updated?.stage).toBe("definition");
    expect(updated?.clarifications).toContain("最多50字符");
    expect(store.listRequirementRevisions(req.id).map((revision) => revision.version)).toEqual([2, 1]);
  });

  it("resumes the returned stage instead of forcing every correction to definition", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口实现", businessProblem: "现有接口缺少创建能力", expectedOutcome: "新增创建接口", priority: "medium" });
    store.updateRequirementState(req.id, "solution_design", "returned");
    const updated = store.reviseRequirement(req.id, { ...req, clarifications: "补充接口契约、错误码和回滚策略。" });
    expect(updated?.stage).toBe("solution_design");
  });

  it("persists an ordered stage run and prevents duplicate active runs", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: { prompt: "hello" } });
    expect((store as any).db.prepare("SELECT owner_type, owner_id FROM stage_runs WHERE id = ?").get(run.id))
      .toEqual({ owner_type: "requirement", owner_id: req.id });
    expect(() => store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: {} })).toThrow("RUN_ALREADY_ACTIVE");
    store.appendStageRunEvent(run.id, "request.sent", { ok: true });
    store.appendStageRunEvent(run.id, "output.delta", { text: "done" });
    expect(store.getStageRun(run.id)?.events.map((event: any) => event.sequence)).toEqual([1, 2, 3]);
    store.completeStageRun(run.id, { conclusion: "pass" });
    expect(store.getStageRun(run.id)?.status).toBe("completed");
  });

  it("prevents association replacement while any stage run is active", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Guard", repoPath: "/tmp/run-association-guard", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = ensureProjectVersion(store, project.id)!;
    const req = createRequirement(store, { title: "运行关联", businessProblem: "运行期间关联必须稳定", expectedOutcome: "拒绝关联改写", priority: "medium", primaryProjectId: project.id });
    store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: {} });

    expect(() => store.replaceRequirementProjects(req.id, [{ projectId: project.id, projectVersionId: version.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 }]))
      .toThrow("RUN_ALREADY_ACTIVE");
  });

  it("marks abandoned active runs as interrupted", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const run = store.createStageRun({ requirementId: req.id, stage: "definition", model: "gpt-5.5", input: {} });
    expect(store.interruptActiveStageRuns()).toBe(1);
    expect(store.getStageRun(run.id)?.status).toBe("interrupted");
  });

  it("recovers requirements left in ai_running without an active run", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    store.updateRequirementState(req.id, "definition", "ai_running");
    expect(store.recoverInterruptedRequirements()).toBe(1);
    expect(store.getRequirement(req.id)?.status).toBe("ai_ready");
  });

  it("persists valid gate configuration and fails closed for invalid internal writes", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    expect(store.getGateConfig()).toEqual({ autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: [] });
    store.updateGateConfig({ autoTransitionEnabled: false, confidenceThreshold: 0.9, mandatoryHumanStages: ["definition"] });
    expect(store.getGateConfig().confidenceThreshold).toBe(0.9);
    expect(store.getGateConfig().autoTransitionEnabled).toBe(false);
    store.updateGateConfig({ autoTransitionEnabled: true, confidenceThreshold: 0.8, mandatoryHumanStages: ["implementation", "definition"] } as any);
    expect(store.getGateConfig()).toEqual(failClosedGateConfig);
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong boolean", JSON.stringify({ autoTransitionEnabled: "true", confidenceThreshold: 0.85, mandatoryHumanStages: [] })],
    ["string threshold", JSON.stringify({ autoTransitionEnabled: true, confidenceThreshold: "0.85", mandatoryHumanStages: [] })],
    ["out of range threshold", JSON.stringify({ autoTransitionEnabled: true, confidenceThreshold: 2, mandatoryHumanStages: [] })],
    ["downstream stage", JSON.stringify({ autoTransitionEnabled: true, confidenceThreshold: 0.85, mandatoryHumanStages: ["implementation"] })]
  ])("fails closed for persisted %s", (_name, valueJson) => {
    const directory = mkdtempSync(join(tmpdir(), "gate-config-")); directories.push(directory);
    const path = join(directory, "workflow.db");
    const store = new WorkflowStore(path); stores.push(store);
    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('gate_config', ?, ?)")
      .run(valueJson, "2026-07-20T00:00:00.000Z");
    database.close();

    expect(() => store.getGateConfig()).not.toThrow();
    const config = store.getGateConfig();
    expect(config).toEqual(failClosedGateConfig);
    expect(evaluateGate("definition", { conclusion: "pass", confidence: 0.1, findings: [], risks: [] }, config).decision).toBe("human_review");
  });

  it("applies one automatic gate decision per artifact", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const req = createRequirement(store, { title: "接口实现", businessProblem: "缺少接口", expectedOutcome: "新增接口", priority: "medium" });
    const artifact = store.addArtifact(req.id, "definition", "Definition", { conclusion: "pass" });
    const first = store.applyGateDecision({ requirementId: req.id, stage: "definition", artifactId: artifact.id, decision: "auto_approve", reasons: ["安全通过"] });
    const second = store.applyGateDecision({ requirementId: req.id, stage: "definition", artifactId: artifact.id, decision: "auto_approve", reasons: ["安全通过"] });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(store.getRequirement(req.id)?.stage).toBe("solution_design");
    expect(store.listApprovals(req.id)).toHaveLength(1);
  });

  it("stores one immutable coding evidence snapshot per execution", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Repo", repoPath: "/tmp/repo", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = ensureProjectVersion(store, project.id)!;
    const req = createRequirement(store, { title: "接口", businessProblem: "缺少", expectedOutcome: "新增", priority: "medium", primaryProjectId: project.id });
    const execution = store.addExecution({ requirementId: req.id, stage: "implementation", projectId: project.id, projectVersionId: version.id, branch: "ai/one", worktreePath: "/tmp/wt", baseCommit: "version-head", status: "completed", diff: "diff", events: [] });
    expect(store.listExecutions(req.id)[0]).toMatchObject({ projectVersionId: version.id, baseCommit: "version-head" });
    const evidence = store.addCodingEvidence({ executionId: execution.id, requirementId: req.id, projectId: project.id, branch: "ai/one", worktreePath: "/tmp/wt", diffHash: "abc", diff: "diff", originalChars: 4, truncated: false, files: ["a.ts"], additions: 1, deletions: 0, diagnostics: "" });
    expect(store.getLatestCodingEvidence(req.id)?.id).toBe(evidence.id);
    expect(() => store.addCodingEvidence({ ...evidence, id: undefined })).toThrow();
  });

  it("validates execution project version provenance before inserting", () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Execution", repoPath: "/tmp/execution-project", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const other = store.createProject({ name: "Other execution", repoPath: "/tmp/execution-other", defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = ensureProjectVersion(store, project.id)!;
    const otherVersion = ensureProjectVersion(store, other.id)!;
    const req = createRequirement(store, { title: "执行来源", businessProblem: "执行来源必须与项目匹配", expectedOutcome: "拒绝无效来源", priority: "medium", primaryProjectId: project.id });
    const base: ExecutionInput = { requirementId: req.id, stage: "implementation", projectId: project.id, projectVersionId: version.id, branch: "ai/REQ-0001", worktreePath: "/tmp/execution-wt", baseCommit: "base", status: "completed", commands: [], diff: "", events: [] };

    expect(() => store.addExecution({ ...base, baseCommit: undefined })).toThrow("REQUIREMENT_VERSION_REQUIRED");
    expect(() => store.addExecution({ ...base, projectVersionId: otherVersion.id })).toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(store.listExecutions(req.id)).toHaveLength(0);
  });

  it("stores one immutable rework context per return approval",()=>{
    const store=new WorkflowStore(":memory:");stores.push(store);
    const req=createRequirement(store, {title:"接口",businessProblem:"缺少",expectedOutcome:"新增",priority:"medium"});
    const approval=store.addApproval(req.id,"quality_verification",{decision:"return",comment:"修复权限",targetStage:"implementation"});
    const context=store.addReworkContext(req.id,{approvalId:approval.id,artifactId:null,sourceStage:"quality_verification",targetStage:"implementation",actorType:"human",decisionAt:approval.created_at,unstructured:true,items:[{id:"i1",title:"修复权限"}],risks:[],openQuestions:[]});
    expect(store.getLatestReworkContext(req.id)?.id).toBe(context.id);
    expect(()=>store.addReworkContext(req.id,{...context,id:undefined})).toThrow();
  });


});
