import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 2 foundation documentation contract", () => {
  const root = resolve(import.meta.dirname, "../..");
  const documentationFiles = ["README.md", "docs/states-and-gates.md", "docs/workflow-sop.md", "docs/getting-started.md"];
  const documentation = documentationFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

  it("documents the automation fresh reset and the staged delivery roadmap", () => {
    for (const file of documentationFiles) {
      expect(readFileSync(join(root, file), "utf8"), file).toContain("phase-2-automation-v2");
    }
    expect(documentation).toContain("definition");
    expect(documentation).toContain("solution_design");
    expect(documentation).toContain("implementation");
    expect(documentation).toContain("quality_verification");
    expect(documentation).toContain("acceptance_delivery");
    expect(documentation).toContain("Phase 1");
    expect(documentation).toContain("Phase 2");
    expect(documentation).toContain("Phase 3");
    expect(documentation).toContain("dual read/write");
    expect(documentation).toContain("no-commit");
  });

  it("documents downstream runs as an automatic read-only view", () => {
    const gettingStarted = readFileSync(join(root, "docs/getting-started.md"), "utf8");
    expect(gettingStarted).toContain("自动显示只读交付矩阵");
    expect(gettingStarted).not.toMatch(/点击 `\/run`/);
    expect(gettingStarted).toContain("phase-2-automation-v2");
    expect(gettingStarted).not.toMatch(/\bv3\b/i);
  });

  it("assigns Phase 3 application orchestration to delivery units and retained primitives", () => {
    const plan = readFileSync(join(root, "docs/superpowers/plans/2026-07-19-phase-2-acceptance-application.md"), "utf8");
    expect(plan).not.toContain("server/src/version-application.ts");
    expect(plan).not.toContain("server/src/version-application.test.ts");
    expect(plan).toContain("server/src/integration.ts");
    expect(plan).toContain("delivery-unit-owned");
  });

  it("contains no banned legacy token outside historical superpowers material", () => {
    const banned = [
      ["requirement", "review"].join("_"),
      ["technical", "design"].join("_"),
      ["test", "design"].join("_"),
      ["code", "review"].join("_"),
      ["awaiting", "merge"].join("_"),
      ["MULTI", "PROJECT", "EXECUTION", "PHASE", "2", "REQUIRED"].join("_"),
      ["human", "override"].join("-")
    ];
    const matches: string[] = [];

    for (const file of currentTreeFiles(root)) {
      const content = readFileSync(file, "utf8");
      if (banned.some((token) => content.includes(token))) matches.push(file.slice(root.length + 1));
    }

    expect(matches).toEqual([]);
  });
});

function currentTreeFiles(root: string): string[] {
  const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || relative === "docs/superpowers") return [];
      return walk(path);
    }
    return entry.isFile() && statSync(path).size < 1_000_000 ? [path] : [];
  });
  return walk(root);
}
