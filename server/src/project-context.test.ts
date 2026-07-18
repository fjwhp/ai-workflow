import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";
import { buildRequirementProjectContext } from "./project-context.js";
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
  const requirement = store.createRequirement({ title: "Orders", businessProblem: "Share design context", expectedOutcome: "Implement orders", priority: "medium", primaryProjectId: primary.id });
  store.replaceRequirementProjects(requirement.id, [
    { projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 },
    { projectId: delivery.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 1 }
  ]);
  return { store, primary, delivery, requirement };
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

  it("enforces entry, project, and aggregate caps with truthful truncation", async () => {
    const { store, primary, delivery, requirement } = fixture();
    const third = store.createProject({ name: "Ledger", repoPath: join(process.cwd(), "shared"), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    store.replaceRequirementProjects(requirement.id, [
      { projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 },
      { projectId: delivery.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 },
      { projectId: third.id, role: "collaborator", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 2 }
    ]);
    for (const project of [primary, delivery, third]) ready(store, project.id, `${project.name} summary`, Array.from({ length: 30 }, (_, index) => ({ path: `src/${index}`, kind: "module", title: `Module ${index}`, content: "x".repeat(1500), tags: [] })));

    const context = await buildRequirementProjectContext(store, requirement.id, "technical_design");

    expect(context.projects).toHaveLength(3);
    expect(context.projects.every((project) => project.entries.length <= 24 && project.totalChars <= 20_000)).toBe(true);
    expect(context.projects.every((project) => JSON.stringify(project).length <= 20_000)).toBe(true);
    expect(context.projects.every((project) => project.truncated && project.totalAvailable === 30)).toBe(true);
    expect(context.totalChars).toBeLessThanOrEqual(60_000);
    expect(context.projects.reduce((sum, project) => sum + JSON.stringify(project).length, 0)).toBeLessThanOrEqual(60_000);
    expect(JSON.stringify(context.projects).length).toBeLessThanOrEqual(60_000);
    expect(context.truncated).toBe(true);
  });

  it("uses only the sole delivery project for coding", async () => {
    const { store, primary, delivery, requirement } = fixture();
    ready(store, primary.id, "Architecture", []); ready(store, delivery.id, "Orders", []);

    const context = await buildRequirementProjectContext(store, requirement.id, "coding");

    expect(context.projects.map((project) => project.projectId)).toEqual([delivery.id]);
  });

  it("rejects zero, multiple, and archived delivery projects with stable codes", async () => {
    const { store, primary, delivery, requirement } = fixture(); ready(store, primary.id, "Architecture", []); ready(store, delivery.id, "Orders", []);
    store.replaceRequirementProjects(requirement.id, [{ projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 }]);
    await expect(buildRequirementProjectContext(store, requirement.id, "coding")).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
    store.replaceRequirementProjects(requirement.id, [
      { projectId: primary.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 },
      { projectId: delivery.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 }
    ]);
    await expect(buildRequirementProjectContext(store, requirement.id, "coding")).rejects.toMatchObject({ code: "MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED" });
    store.replaceRequirementProjects(requirement.id, [{ projectId: delivery.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0 }]);
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
    const requirement = store.createRequirement({ title: "Context", businessProblem: "Need both", expectedOutcome: "Design", priority: "medium", primaryProjectId: primary.id });
    store.replaceRequirementProjects(requirement.id, [{ projectId: primary.id, role: "primary", usage: "context", deliveryRequired: false, moduleMode: "all", moduleIds: [], position: 0 }, { projectId: delivery.id, role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1 }]);
    store.beginProjectKnowledge(delivery.id, "head-delivery", "test");

    await expect(buildRequirementProjectContext(store, requirement.id, "technical_design")).rejects.toMatchObject({ code: "PROJECT_KNOWLEDGE_BUILDING", projects: [{ projectId: primary.id, name: "Primary" }, { projectId: delivery.id, name: "Delivery" }] });
    for (let attempt = 0; attempt < 20 && !store.getLatestProjectKnowledge(primary.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getLatestProjectKnowledge(primary.id)).not.toBeNull();
  });

  it("strictly bounds metadata-heavy blocks using their actual serialized size", async () => {
    const store = new WorkflowStore(":memory:"); stores.push(store);
    const project = store.createProject({ name: "Project".repeat(8_000), repoPath: process.cwd(), defaultBranch: "main", allowedCommands: [], sensitivePatterns: [] });
    const requirement = store.createRequirement({ title: "Metadata", businessProblem: "Bound all project metadata", expectedOutcome: "Safe prompt", priority: "medium", primaryProjectId: project.id });
    const moduleIds = Array.from({ length: 400 }, (_, index) => `src/${index}-${"m".repeat(120)}`);
    ready(store, project.id, "summary".repeat(8_000), moduleIds.map((path, index) => ({ path, kind: "module", title: `Title-${index}-${"t".repeat(1_000)}`, content: "content".repeat(1_000), tags: Array.from({ length: 50 }, (_, tag) => `tag-${tag}-${"z".repeat(100)}`) })));
    store.replaceRequirementProjects(requirement.id, [{ projectId: project.id, role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds, position: 0 }]);

    const context = await buildRequirementProjectContext(store, requirement.id, "coding");
    const block = context.projects[0]!;
    expect(block.projectId).toBe(project.id); expect(block.name.length).toBeGreaterThan(0); expect(block.truncated).toBe(true);
    expect(JSON.stringify(block).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(context.projects).length).toBeLessThanOrEqual(60_000);
    expect(context.totalChars).toBe(JSON.stringify(block).length);
  });
});
