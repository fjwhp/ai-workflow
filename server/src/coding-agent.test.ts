import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./repository.js", () => ({
  createOrReuseRequirementWorktree: vi.fn(),
  getWorktreeDiff: vi.fn()
}));

import { createOrReuseRequirementWorktree } from "./repository.js";
import { prepareCodingWorktree, resolveWorktreePath } from "./coding-agent.js";

const createWorktree = vi.mocked(createOrReuseRequirementWorktree);

beforeEach(() => vi.clearAllMocks());

describe("resolveWorktreePath", () => {
  it("resolves a repository-relative file inside the worktree", () => {
    expect(resolveWorktreePath("/tmp/worktree", "src/App.java")).toBe("/tmp/worktree/src/App.java");
  });

  it("rejects absolute paths and parent traversal", () => {
    expect(() => resolveWorktreePath("/tmp/worktree", "/etc/passwd")).toThrow("工作区");
    expect(() => resolveWorktreePath("/tmp/worktree", "../secret")).toThrow("工作区");
  });
});

describe("prepareCodingWorktree", () => {
  it("creates or reuses the requirement worktree from the selected active version branch", async () => {
    createWorktree.mockResolvedValue({ branch: "ai/REQ-0001", worktreePath: "/tmp/requirements/REQ-0001", baseCommit: "version-head", reused: false });

    await expect(prepareCodingWorktree(
      { id: "project-1", repoPath: "/tmp/project", defaultBranch: "main", allowedCommands: [] },
      { id: "version-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "active" },
      "REQ-0001"
    )).resolves.toEqual({ branch: "ai/REQ-0001", worktreePath: "/tmp/requirements/REQ-0001", baseCommit: "version-head", reused: false });
    expect(createWorktree).toHaveBeenCalledWith("/tmp/project", "release/2.2.1", "REQ-0001");
  });

  it("rejects a closed version before touching Git", async () => {
    await expect(prepareCodingWorktree(
      { id: "project-1", repoPath: "/tmp/project", defaultBranch: "main", allowedCommands: [] },
      { id: "version-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "closed" },
      "REQ-0001"
    )).rejects.toThrow("PROJECT_VERSION_NOT_ACTIVE");
    expect(createWorktree).not.toHaveBeenCalled();
  });
});
