import { describe, expect, it } from "vitest";
import { resolveWorktreePath } from "./coding-agent.js";

describe("resolveWorktreePath", () => {
  it("resolves a repository-relative file inside the worktree", () => {
    expect(resolveWorktreePath("/tmp/worktree", "src/App.java")).toBe("/tmp/worktree/src/App.java");
  });

  it("rejects absolute paths and parent traversal", () => {
    expect(() => resolveWorktreePath("/tmp/worktree", "/etc/passwd")).toThrow("工作区");
    expect(() => resolveWorktreePath("/tmp/worktree", "../secret")).toThrow("工作区");
  });
});
