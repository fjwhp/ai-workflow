import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function document(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

function expectTerms(content: string, terms: string[]) {
  for (const term of terms) expect(content, `missing documentation term: ${term}`).toContain(term);
}

describe("continuous delivery documentation", () => {
  it("records the automation, evidence, recovery, and human safety invariants", () => {
    const states = document("docs/states-and-gates.md");
    const sop = document("docs/workflow-sop.md");
    const combined = `${states}\n${sop}`;

    expectTerms(combined, [
      "持久化 lease", "fencing token", "周期恢复", "claim generation", "不可变证据",
      "Review 与自动化测试均通过", "fan-in", "契约失效", "reuse", "rerun",
      "pause", "resume", "optional skip", "override", "retry", "applied", "skipped",
      "allowedActions", "SSE generation", "轮询 fallback", "总体业务验收必须由人工完成",
      "不得在目标项目自动 commit、merge、push"
    ]);
  });

  it("does not describe live delivery automation as a future read-only handoff", () => {
    const currentGuides = [
      document("README.md"), document("docs/getting-started.md"),
      document("docs/states-and-gates.md"), document("docs/workflow-sop.md")
    ].join("\n");

    expect(currentGuides).not.toContain("Phase 1（当前）");
    expect(currentGuides).not.toContain("Phase 2 才激活 queue、worker、Review 和测试");
    expect(currentGuides).not.toContain("Phase 1 对所有下游交付都保持只读");
    expect(currentGuides).not.toContain("Phase 2 才能推进实现、独立 Review 和自动化测试");
  });

  it("documents atomic pilot publication and stable CLI failures", () => {
    const pilotGuides = `${document("docs/getting-started.md")}\n${document("docs/workflow-sop.md")}`;
    expectTerms(pilotGuides, [
      "sibling staging", "原子发布", "RENAME_EXCL", "RENAME_NOREPLACE",
      "PILOT_ATOMIC_PUBLISH_UNAVAILABLE", "FLOWGATE_PILOT_ERROR"
    ]);
  });
});
