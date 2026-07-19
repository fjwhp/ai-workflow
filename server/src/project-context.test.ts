import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";
import { DEFAULT_PROJECT_CONTEXT_MAX_CHARS, MAX_PROJECT_CONTEXT_MAX_CHARS, buildRequirementProjectContext, resolveProjectContextBudget } from "./project-context.js";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const stores: WorkflowStore[] = [];
const dirs: string[] = []; const exec = promisify(execFile);
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function fixture() {
  const store = new WorkflowStore(":memory:"); stores.push(store);
  const primary = store.createProject({ name: "Architecture", repoPath: process.cwd(), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
  const delivery = store.createProject({ name: "Orders API", repoPath: join(process.cwd(), "server"), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
  const primaryVersion = store.createProjectVersion({ projectId: primary.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: process.cwd(), headCommit: "fixture-head" });
  const deliveryVersion = store.createProjectVersion({ projectId: delivery.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: join(process.cwd(), "server"), headCommit: "fixture-head" });
  const requirement = store.createRequirement({ title: "Orders", businessProblem: "Share design context", expectedOutcome: "Implement orders", priority: "medium", primaryProjectId: primary.id, primaryProjectVersionId: primaryVersion.id });
  store.replaceRequirementProjects(requirement.id, [
    { projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 },
    { projectId: delivery.id, projectVersionId: deliveryVersion.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 1 }
  ]);
  return { store, primary, primaryVersion, delivery, deliveryVersion, requirement };
}

function ready(store: WorkflowStore, projectId: string, summary: string, entries: any[]) {
  const project = store.getProject(projectId)!; const head = execFileSync("git", ["-C", project.repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const build = store.beginProjectKnowledge(projectId, head, "test");
  return store.completeProjectKnowledge(build.id, { summary, entries });
}

describe("buildRequirementProjectContext", () => {
  it("returns context primary and delivery collaborator in position order for technical design", async () => {
    const { store, primary, delivery, requirement } = fixture();
    ready(store, primary.id, "Architecture summary", [{ path: "docs/architecture.md", kind: "overview", title: "Architecture", content: "boundaries", tags: [] }]);
    ready(store, delivery.id, "Orders summary", [{ path: "src/orders", kind: "module", title: "Orders", content: "handlers", tags: [] }]);

    const context = await buildRequirementProjectContext(store, requirement.id, "technical_design");

    expect(context.projects.map((project) => project.projectId)).toEqual([primary.id, delivery.id]);
    expect(context.projects).toMatchObject([
      { name: "Architecture", role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", status: "ready" },
      { name: "Orders API", role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "auto", moduleIds: [], status: "ready" }
    ]);
  });

  it("fairly shares a custom aggregate budget with truthful truncation", async () => {
    const { store, primary, delivery, deliveryVersion, requirement } = fixture();
    const third = store.createProject({ name: "Ledger", repoPath: join(process.cwd(), "shared"), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    store.replaceRequirementProjects(requirement.id, [
      { projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 },
      { projectId: delivery.id, projectVersionId: deliveryVersion.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 },
      { projectId: third.id, role: "collaborator", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 2 }
    ]);
    for (const project of [primary, delivery, third]) ready(store, project.id, `${project.name} summary`, Array.from({ length: 30 }, (_, index) => ({ path: `src/${index}`, kind: "module", title: `Module ${index}`, content: "x".repeat(1500), tags: [] })));

    const context = await buildRequirementProjectContext(store, requirement.id, "technical_design", { maxChars: 12_000 });

    expect(context.projects).toHaveLength(3);
    expect(context.projects.every((project) => project.entries.length > 0 && project.totalChars <= 4_000)).toBe(true);
    expect(context.projects.every((project) => project.truncated && project.totalAvailable === 30)).toBe(true);
    expect(context.budgetMaxChars).toBe(12_000);
    expect(JSON.stringify(context.projects).length).toBeLessThanOrEqual(12_000);
    expect(context.truncated).toBe(true);
  });

  it("uses a 200k default that permits more than 60k of useful coding context", async () => {
    const { store, delivery, requirement } = fixture();
    ready(store, delivery.id, "Orders", Array.from({ length: 24 }, (_, index) => ({ path: `src/orders/${index}`, kind: "module", title: `Orders ${index}`, content: `order ${"x".repeat(3_900)}`, tags: ["order"] })));

    const context = await buildRequirementProjectContext(store, requirement.id, "coding");

    expect(context.budgetMaxChars).toBe(DEFAULT_PROJECT_CONTEXT_MAX_CHARS);
    expect(JSON.stringify(context.projects).length).toBeGreaterThan(60_000);
    expect(JSON.stringify(context.projects).length).toBeLessThanOrEqual(DEFAULT_PROJECT_CONTEXT_MAX_CHARS);
  });

  it("resolves invalid, too-small, and excessive configured budgets safely", () => {
    expect(resolveProjectContextBudget(undefined).maxChars).toBe(DEFAULT_PROJECT_CONTEXT_MAX_CHARS);
    expect(resolveProjectContextBudget("nope").maxChars).toBe(DEFAULT_PROJECT_CONTEXT_MAX_CHARS);
    expect(resolveProjectContextBudget("100").maxChars).toBe(DEFAULT_PROJECT_CONTEXT_MAX_CHARS);
    expect(resolveProjectContextBudget("20000").maxChars).toBe(20_000);
    expect(resolveProjectContextBudget("2000000").maxChars).toBe(MAX_PROJECT_CONTEXT_MAX_CHARS);
  });

  it("uses only the sole delivery project for coding", async () => {
    const { store, primary, delivery, requirement } = fixture();
    ready(store, primary.id, "Architecture", []); ready(store, delivery.id, "Orders", []);

    const context = await buildRequirementProjectContext(store, requirement.id, "coding", { maxChars: 20_000 });

    expect(context.projects.map((project) => project.projectId)).toEqual([delivery.id]);
  });

  it("rejects zero, multiple, and archived delivery projects with stable codes", async () => {
    const { store, primary, primaryVersion, delivery, deliveryVersion, requirement } = fixture(); ready(store, primary.id, "Architecture", []); ready(store, delivery.id, "Orders", []);
    store.replaceRequirementProjects(requirement.id, [{ projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 }]);
    await expect(buildRequirementProjectContext(store, requirement.id, "coding")).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
    store.replaceRequirementProjects(requirement.id, [
      { projectId: primary.id, projectVersionId: primaryVersion.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 },
      { projectId: delivery.id, projectVersionId: deliveryVersion.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 }
    ]);
    await expect(buildRequirementProjectContext(store, requirement.id, "coding")).rejects.toMatchObject({ code: "MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED" });
    store.replaceRequirementProjects(requirement.id, [{ projectId: delivery.id, projectVersionId: deliveryVersion.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 }]);
    store.archiveProject(delivery.id);
    await expect(buildRequirementProjectContext(store, requirement.id, "coding")).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
  });

  it("reports every unready project in order and starts missing builds", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const repos = await Promise.all(["primary", "delivery"].map(async (name) => {
      const dir = await mkdtemp(join(tmpdir(), `context-${name}-`)); dirs.push(dir);
      await exec("git", ["init", "-b", "main", dir]); await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]); await exec("git", ["-C", dir, "config", "user.name", "Test"]);
      await writeFile(join(dir, "README.md"), name); await exec("git", ["-C", dir, "add", "--all"]); await exec("git", ["-C", dir, "commit", "-m", "base"]); return dir;
    }));
    const primary = store.createProject({ name: "Primary", repoPath: repos[0]!, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const delivery = store.createProject({ name: "Delivery", repoPath: repos[1]!, defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = store.createProjectVersion({ projectId: primary.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: repos[0]!, headCommit: "fixture-head" });
    const deliveryVersion = store.createProjectVersion({ projectId: delivery.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: repos[1]!, headCommit: "fixture-head" });
    const requirement = store.createRequirement({ title: "Context", businessProblem: "Need both", expectedOutcome: "Design", priority: "medium", primaryProjectId: primary.id, primaryProjectVersionId: version.id });
    store.replaceRequirementProjects(requirement.id, [{ projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 }, { projectId: delivery.id, projectVersionId: deliveryVersion.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 }]);
    store.beginProjectKnowledge(delivery.id, "head-delivery", "test");

    await expect(buildRequirementProjectContext(store, requirement.id, "technical_design")).rejects.toMatchObject({ code: "PROJECT_KNOWLEDGE_BUILDING", projects: [{ projectId: primary.id, name: "Primary" }, { projectId: delivery.id, name: "Delivery" }] });
    for (let attempt = 0; attempt < 20 && !store.getLatestProjectKnowledge(primary.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getLatestProjectKnowledge(primary.id)).not.toBeNull();
  });

  it("strictly bounds metadata-heavy blocks using their actual serialized size", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Project".repeat(8_000), repoPath: process.cwd(), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = store.createProjectVersion({ projectId: project.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: process.cwd(), headCommit: "fixture-head" });
    const requirement = store.createRequirement({ title: "Metadata", businessProblem: "Bound all project metadata", expectedOutcome: "Safe prompt", priority: "medium", primaryProjectId: project.id, primaryProjectVersionId: version.id });
    const moduleIds = Array.from({ length: 400 }, (_, index) => `src/${index}-${"m".repeat(120)}`);
    ready(store, project.id, "summary".repeat(8_000), moduleIds.map((path, index) => ({ path, kind: "module", title: `Title-${index}-${"t".repeat(1_000)}`, content: "content".repeat(1_000), tags: Array.from({ length: 50 }, (_, tag) => `tag-${tag}-${"z".repeat(100)}`) })));
    store.replaceRequirementProjects(requirement.id, [{ projectId: project.id, projectVersionId: version.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds, position: 0 }]);

    const context = await buildRequirementProjectContext(store, requirement.id, "coding", { maxChars: 20_000 });
    const block = context.projects[0]!;
    expect(block.projectId).toBe(project.id); expect(block.name.length).toBeGreaterThan(0); expect(block.truncated).toBe(true);
    expect(JSON.stringify(block).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(context.projects).length).toBeLessThanOrEqual(20_000);
    expect(context.totalChars).toBe(JSON.stringify(context.projects).length);
  });

  it("rejects an infeasible budget and succeeds at the reported minimum boundary", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const paths = ["server", "web", "shared", "docs", "server/src", "web/src", "shared/src", "docs/superpowers", "docs/superpowers/specs", "docs/superpowers/plans", "web/node_modules", "web/node_modules/lucide-react", "web/node_modules/lucide-react/dist", "web/node_modules/lucide-react/dist/esm", "web/node_modules/lucide-react/dist/esm/shared", "web/node_modules/lucide-react/dist/esm/icons"];
    const projects = paths.map((path, index) => store.createProject({ name: `Context ${index}`, repoPath: join(process.cwd(), path), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] }));
    const version = store.createProjectVersion({ projectId: projects[0]!.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: process.cwd(), headCommit: "fixture-head" });
    const requirement = store.createRequirement({ title: "Many contexts", businessProblem: "Fit identity metadata", expectedOutcome: "Stable budget failure", priority: "medium", primaryProjectId: projects[0]!.id, primaryProjectVersionId: version.id });
    store.replaceRequirementProjects(requirement.id, projects.map((project, position) => ({ projectId: project.id, role: position === 0 ? "primary" : "collaborator", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position })));
    for (const project of projects) ready(store, project.id, "", []);

    let minimumRequiredChars = 0;
    try { await buildRequirementProjectContext(store, requirement.id, "technical_design", { maxChars: 4_000 }); }
    catch (error: any) {
      expect(error).toMatchObject({ code: "PROJECT_CONTEXT_BUDGET_TOO_SMALL", details: { maxChars: 4_000, projectCount: projects.length } });
      minimumRequiredChars = error.details.minimumRequiredChars;
    }
    expect(minimumRequiredChars).toBeGreaterThan(4_000);
    const context = await buildRequirementProjectContext(store, requirement.id, "technical_design", { maxChars: minimumRequiredChars });
    expect(context.totalChars).toBe(minimumRequiredChars);
  });

  it("truncates non-BMP metadata without producing lone surrogates", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const emoji = "\u{1F680}";
    const project = store.createProject({ name: emoji.repeat(800), repoPath: process.cwd(), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const version = store.createProjectVersion({ projectId: project.id, name: "fixture", branch: "main", baseBranch: "main", worktreePath: process.cwd(), headCommit: "fixture-head" });
    const requirement = store.createRequirement({ title: "Unicode", businessProblem: "Keep emoji valid", expectedOutcome: "Safe JSON", priority: "medium", primaryProjectId: project.id, primaryProjectVersionId: version.id });
    const moduleIds = [emoji.repeat(700)];
    ready(store, project.id, emoji.repeat(2_000), [{ path: moduleIds[0], kind: "module", title: emoji.repeat(700), content: emoji.repeat(5_000), tags: [emoji.repeat(300)] }]);
    store.replaceRequirementProjects(requirement.id, [{ projectId: project.id, projectVersionId: version.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds, position: 0 }]);

    const context = await buildRequirementProjectContext(store, requirement.id, "coding", { maxChars: 4_000 });
    const serialized = JSON.stringify(context.projects);
    const hasLoneSurrogate = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
    expect(serialized.length).toBeLessThanOrEqual(4_000);
    expect(hasLoneSurrogate(serialized)).toBe(false);
  });
});
