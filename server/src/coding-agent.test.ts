import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  isAllowedCommand: vi.fn(),
  runCommand: vi.fn()
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.chatCreate } };
  }
}));

vi.mock("./repository.js", () => ({
  createOrReuseRequirementWorktree: vi.fn(),
  getWorktreeDiff: vi.fn(),
  getWorktreeSnapshot: vi.fn()
}));

vi.mock("./command-policy.js", () => ({
  isAllowedCommand: mocks.isAllowedCommand,
  runCommand: mocks.runCommand
}));

import { createOrReuseRequirementWorktree, getWorktreeSnapshot } from "./repository.js";
import { prepareCodingWorktree, resolveWorktreePath, runCodingAgent } from "./coding-agent.js";

const createWorktree = vi.mocked(createOrReuseRequirementWorktree);
const snapshot = vi.mocked(getWorktreeSnapshot);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_API_MODE = "chat";
  process.env.OPENAI_MODEL = "test-model";
  createWorktree.mockResolvedValue({
    branch: "ai/REQ-0001",
    worktreePath: "/tmp/requirements/REQ-0001",
    baseCommit: "version-head",
    reused: false
  });
  snapshot.mockResolvedValue({ diff: "", files: [], additions: 0, deletions: 0 });
  mocks.isAllowedCommand.mockReturnValue(true);
  mocks.runCommand.mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
});

function codingInput(allowedCommands: Array<{ command: string; argsPrefix?: string[] }>) {
  return {
    requirement: { id: "requirement-1", code: "REQ-0001" },
    artifacts: [],
    project: { id: "project-1", repoPath: "/tmp/project", defaultBranch: "main", allowedCommands },
    version: {
      id: "version-1", projectId: "project-1", branch: "release/2.2.1",
      worktreePath: "/tmp/version", status: "active" as const, headCommit: "version-head"
    },
    deliveryContext: {
      deliveryUnitId: "unit-1", requirementId: "requirement-1", evidenceVersion: 1,
      moduleIds: [], acceptanceCriteria: ["passes"], sensitivePatterns: [],
      allowedCommands, projectKnowledgeVersionId: null
    }
  };
}

function respondWithCommand(command: string, args: string[]) {
  mocks.chatCreate
    .mockResolvedValueOnce({ choices: [{ message: {
      role: "assistant",
      tool_calls: [{ id: "call-1", function: { name: "run_command", arguments: JSON.stringify({ command, args }) } }]
    } }] })
    .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "done" } }] });
}

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
      { id: "version-1", projectId: "project-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "active", headCommit: "version-head" },
      "REQ-0001"
    )).resolves.toEqual({ branch: "ai/REQ-0001", worktreePath: "/tmp/requirements/REQ-0001", baseCommit: "version-head", reused: false });
    expect(createWorktree).toHaveBeenCalledWith("/tmp/project", "release/2.2.1", "REQ-0001", "version-head");
  });

  it("rejects a closed version before touching Git", async () => {
    await expect(prepareCodingWorktree(
      { id: "project-1", repoPath: "/tmp/project", defaultBranch: "main", allowedCommands: [] },
      { id: "version-1", projectId: "project-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "closed" },
      "REQ-0001"
    )).rejects.toThrow("PROJECT_VERSION_NOT_ACTIVE");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("rejects a version owned by another project before touching Git", async () => {
    await expect(prepareCodingWorktree(
      { id: "project-1", repoPath: "/tmp/project", defaultBranch: "main", allowedCommands: [] },
      { id: "version-1", projectId: "project-2", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "active" },
      "REQ-0001"
    )).rejects.toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

describe("runCodingAgent command boundary", () => {
  it.each([
    ["git commit", "git", ["commit", "-m", "forbidden"]],
    ["git push", "git", ["push", "origin", "HEAD"]],
    ["git tag", "git", ["tag", "v1.0.0"]],
    ["gh pr create", "gh", ["pr", "create"]],
    ["absolute git path", "/usr/bin/git", ["commit", "-m", "forbidden"]],
    ["Windows git path", "C:\\Program Files\\Git\\bin\\git.exe", ["push"]],
    ["env git commit", "/usr/bin/env", ["git", "commit", "-m", "forbidden"]],
    ["env gh pr create", "env", ["gh", "pr", "create"]],
    ["git.cmd", "git.cmd", ["push"]],
    ["gh.bat", "gh.bat", ["pr", "create"]],
    ["npm exec git", "npm", ["exec", "git", "commit"]],
    ["pnpm dlx gh", "pnpm", ["dlx", "gh", "pr", "create"]],
    ["node child_process git", "node", ["-e", "require('node:child_process').spawnSync('git',['commit'])"]]
  ])("blocks %s before invoking the process runner", async (_name, command, args) => {
    respondWithCommand(command, args);

    await runCodingAgent(codingInput([{ command, argsPrefix: args }]));

    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("rejects model arguments appended to a frozen command", async () => {
    respondWithCommand("npm", ["test", "--", "--watch"]);

    await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["npm test", "npm", ["test"]],
    ["mvn module test", "mvn", ["test", "-pl", "module"]]
  ])("runs the exact frozen verification command %s", async (_name, command, args) => {
    respondWithCommand(command, args);

    await runCodingAgent(codingInput([{ command, argsPrefix: args }]));

    expect(mocks.runCommand).toHaveBeenCalledWith("/tmp/requirements/REQ-0001", command, args);
  });
});
