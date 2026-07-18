import { execFile } from "node:child_process";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_WORKSPACE_ENTRIES = 100;

export interface ProjectModule { id: string; name: string; path: string }
export interface ProjectInspection {
  valid: boolean;
  repoPath: string;
  defaultBranch: string;
  category: "frontend" | "backend" | "other";
  technology: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "maven" | "gradle" | null;
  modules: ProjectModule[];
  warnings: string[];
}

interface KnowledgeEntry { path: string; kind: string; title?: string }

function invalid(repoPath: string, defaultBranch: string, warning: string): ProjectInspection {
  return { valid: false, repoPath, defaultBranch, category: "other", technology: [], packageManager: null, modules: [{ id: "root", name: "root", path: "." }], warnings: [warning] };
}

export async function readBoundedFile(path: string, maxBytes = MAX_METADATA_BYTES, onRead?: (bytesRead: number) => void) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await stat(path);
    if (!before.isFile() || before.size > maxBytes) return null;
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    onRead?.(bytesRead);
    const after = await handle.stat();
    if (after.size > maxBytes || bytesRead < after.size) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

async function exists(path: string) { return (await readBoundedFile(path)) !== null; }

function moduleFromPath(path: string, name?: string): ProjectModule {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return normalized === "." ? { id: "root", name: "root", path: "." } : { id: normalized, name: name || basename(normalized), path: normalized };
}

async function detectWorkspaceModules(repoPath: string, packageJson: any): Promise<ProjectModule[]> {
  const patterns = Array.isArray(packageJson?.workspaces) ? packageJson.workspaces : packageJson?.workspaces?.packages;
  if (!Array.isArray(patterns)) return [];
  const modules: ProjectModule[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns.filter((item: unknown): item is string => typeof item === "string").sort()) {
    if (modules.length >= MAX_WORKSPACE_ENTRIES - 1) break;
    if (typeof pattern !== "string") continue;
    if (!pattern.includes("*")) {
      const module = moduleFromPath(pattern);
      if (!seen.has(module.id)) { seen.add(module.id); modules.push(module); }
      continue;
    }
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) continue;
    const parent = pattern.slice(0, -2);
    const entries: string[] = [];
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      directory = await opendir(resolve(repoPath, parent));
      for await (const entry of directory) {
        if (entry.isDirectory()) entries.push(entry.name);
        if (entries.length >= MAX_WORKSPACE_ENTRIES - 1 - modules.length) break;
      }
    } catch { /* optional workspace hint */ }
    finally { await directory?.close().catch(() => undefined); }
    for (const name of entries.sort()) {
      const module = moduleFromPath(`${parent}/${name}`);
      if (!seen.has(module.id)) { seen.add(module.id); modules.push(module); }
    }
  }
  return modules;
}

export async function inspectProjectRepository(repoPath: string, defaultBranch: string, knowledgeEntries: KnowledgeEntry[] = []): Promise<ProjectInspection> {
  const requestedPath = resolve(repoPath);
  let normalizedPath: string;
  try { normalizedPath = await realpath(requestedPath); }
  catch { return invalid(requestedPath, defaultBranch, "Repository path does not exist"); }

  let gitRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["-C", normalizedPath, "rev-parse", "--show-toplevel"]);
    gitRoot = await realpath(stdout.trim());
  } catch { return invalid(normalizedPath, defaultBranch, "Path is not a Git repository"); }
  if (gitRoot !== normalizedPath) return invalid(normalizedPath, defaultBranch, "Path must be the Git repository root");
  try { await execFileAsync("git", ["-C", normalizedPath, "show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`]); }
  catch { return invalid(normalizedPath, defaultBranch, "Default branch does not exist locally"); }

  const [packageText, hasNpmLock, hasPnpmLock, hasYarnLock, hasPom, hasGradle, hasGradleKts] = await Promise.all([
    readBoundedFile(resolve(normalizedPath, "package.json")), exists(resolve(normalizedPath, "package-lock.json")),
    exists(resolve(normalizedPath, "pnpm-lock.yaml")), exists(resolve(normalizedPath, "yarn.lock")),
    exists(resolve(normalizedPath, "pom.xml")), exists(resolve(normalizedPath, "build.gradle")), exists(resolve(normalizedPath, "build.gradle.kts"))
  ]);
  let packageJson: any = null;
  const warnings: string[] = [];
  if (packageText) try { packageJson = JSON.parse(packageText); } catch { warnings.push("package.json could not be parsed"); }
  const technology: string[] = [];
  if (packageText) technology.push("node");
  if (hasPom || hasGradle || hasGradleKts) technology.push("java");
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  for (const framework of ["react", "vue", "svelte", "angular", "express", "fastify", "nestjs"]) if (dependencies?.[framework]) technology.push(framework);
  const frontend = ["react", "vue", "svelte", "angular"].some((item) => technology.includes(item));
  const backend = hasPom || hasGradle || hasGradleKts || ["express", "fastify", "nestjs"].some((item) => technology.includes(item));
  const category = frontend && !backend ? "frontend" : backend && !frontend ? "backend" : "other";
  const declaredManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager.split("@")[0] : null;
  const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasNpmLock ? "npm" : hasPom ? "maven" : (hasGradle || hasGradleKts) ? "gradle" : (["npm", "pnpm", "yarn"].includes(declaredManager) ? declaredManager : null);
  const knowledgeModules = knowledgeEntries.filter((entry) => entry.kind === "module").slice(0, MAX_WORKSPACE_ENTRIES - 1).map((entry) => moduleFromPath(entry.path, entry.title));
  const detectedModules = knowledgeModules.length ? knowledgeModules : await detectWorkspaceModules(normalizedPath, packageJson);
  const modules = [...new Map([{ id: "root", name: "root", path: "." }, ...detectedModules].map((item) => [item.id, item])).values()].slice(0, MAX_WORKSPACE_ENTRIES);
  return { valid: true, repoPath: normalizedPath, defaultBranch, category, technology: [...new Set(technology)], packageManager: packageManager as ProjectInspection["packageManager"], modules, warnings };
}
