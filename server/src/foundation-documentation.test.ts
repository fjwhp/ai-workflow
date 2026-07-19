import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 2 foundation documentation contract", () => {
  const root = resolve(import.meta.dirname, "../..");
  const documentationFiles = ["README.md", "docs/states-and-gates.md", "docs/workflow-sop.md", "docs/getting-started.md"];
  const documentation = documentationFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

  it("documents the v2 fresh reset and the staged delivery roadmap", () => {
    for (const file of documentationFiles) {
      expect(readFileSync(join(root, file), "utf8"), file).toContain("phase-2-five-stage-v2");
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
