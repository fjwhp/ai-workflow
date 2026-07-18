import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProjectRepository } from "./project-service.js";

const exec = promisify(execFile);
const directories: string[] = [];

async function createRepo(files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "project-inspection-"));
  directories.push(directory);
  await exec("git", ["init", "-b", "main", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", directory, "config", "user.name", "Test"]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await writeFile(join(directory, "README.md"), "test repository\n");
  await exec("git", ["-C", directory, "add", "--all"]);
  await exec("git", ["-C", directory, "commit", "-m", "initial"]);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("inspectProjectRepository", () => {
  it.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"]
  ])("detects a Node repository using %s", async (lockfile, packageManager) => {
    const repo = await createRepo({
      "package.json": JSON.stringify({ scripts: { build: "touch BUILD_RAN" } }),
      [lockfile]: "lock data"
    });
    const result = await inspectProjectRepository(repo, "main");
    expect(result).toMatchObject({ valid: true, repoPath: await realpath(repo), defaultBranch: "main", packageManager });
    expect(result.technology).toContain("node");
    expect(result.modules).toContainEqual({ id: "root", name: "root", path: "." });
    await expect(writeFile(join(repo, "probe"), "ok")).resolves.toBeUndefined();
    await expect(import("node:fs/promises").then(({ access }) => access(join(repo, "BUILD_RAN")))).rejects.toThrow();
  });

  it.each([
    [{ "pom.xml": "<project></project>" }, "maven", "java"],
    [{ "build.gradle.kts": "plugins { java }" }, "gradle", "java"]
  ])("detects bounded JVM build metadata", async (files, packageManager, technology) => {
    const repo = await createRepo(files);
    const result = await inspectProjectRepository(repo, "main");
    expect(result).toMatchObject({ valid: true, packageManager });
    expect(result.technology).toContain(technology);
  });

  it("uses knowledge module entries when supplied", async () => {
    const repo = await createRepo({ "package.json": JSON.stringify({ workspaces: ["apps/*"] }), "apps/web/package.json": "{}" });
    const result = await inspectProjectRepository(repo, "main", [
      { path: "services/api", kind: "module", title: "API service" },
      { path: "README.md", kind: "overview", title: "Overview" }
    ]);
    expect(result.modules).toEqual([
      { id: "root", name: "root", path: "." },
      { id: "services/api", name: "API service", path: "services/api" }
    ]);
  });

  it("returns structured invalid results for missing, nested, and branchless paths", async () => {
    const missing = join(tmpdir(), `missing-${Date.now()}`);
    const repo = await createRepo({ "nested/file.txt": "nested" });
    const missingResult = await inspectProjectRepository(missing, "main");
    const nestedResult = await inspectProjectRepository(join(repo, "nested"), "main");
    const branchResult = await inspectProjectRepository(repo, "absent");
    expect(missingResult.valid).toBe(false);
    expect(missingResult.warnings).toContain("Repository path does not exist");
    expect(nestedResult.valid).toBe(false);
    expect(nestedResult.warnings).toContain("Path must be the Git repository root");
    expect(branchResult.valid).toBe(false);
    expect(branchResult.warnings).toContain("Default branch does not exist locally");
  });
});
