import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
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
  runCommand: mocks.runCommand
}));

import { createOrReuseRequirementWorktree, getWorktreeDiff, getWorktreeSnapshot } from "./repository.js";
import { prepareCodingWorktree, resolveWorktreePath, runCodingAgent } from "./coding-agent.js";

const createWorktree = vi.mocked(createOrReuseRequirementWorktree);
const diff = vi.mocked(getWorktreeDiff);
const snapshot = vi.mocked(getWorktreeSnapshot);
const temporaryWorktrees: string[] = [];

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
  diff.mockResolvedValue("diff --git a/src/App.ts b/src/App.ts");
  mocks.runCommand.mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
});

afterEach(async () => {
  await Promise.all(temporaryWorktrees.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

function respondWithToolCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  mocks.chatCreate
    .mockResolvedValueOnce({ choices: [{ message: {
      role: "assistant",
      tool_calls: toolCalls.map((call, index) => ({
        id: `call-${index + 1}`,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    } }] })
    .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "done" } }] });
}

async function temporaryWorktree() {
  const worktree = await mkdtemp(join(tmpdir(), "coding-agent-"));
  temporaryWorktrees.push(worktree);
  createWorktree.mockResolvedValue({
    branch: "ai/REQ-0001",
    worktreePath: worktree,
    baseCommit: "version-head",
    reused: false
  });
  return worktree;
}

describe("resolveWorktreePath", () => {
  it("resolves a repository-relative file inside the worktree", () => {
    expect(resolveWorktreePath("/tmp/worktree", "src/App.java")).toBe("/tmp/worktree/src/App.java");
  });

  it("rejects absolute paths and parent traversal", () => {
    expect(() => resolveWorktreePath("/tmp/worktree", "/etc/passwd")).toThrow("工作区");
    expect(() => resolveWorktreePath("/tmp/worktree", "../secret")).toThrow("工作区");
  });

  it.each([".git", ".git/config", "src/../.git/HEAD"])("rejects the Git metadata path %s", (path) => {
    expect(() => resolveWorktreePath("/tmp/worktree", path)).toThrow("Git 元数据");
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

describe("runCodingAgent tool boundary", () => {
  it("exposes only implementation file tools to the model", async () => {
    mocks.chatCreate.mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "done" } }] });

    await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    const toolNames = mocks.chatCreate.mock.calls[0]![0].tools.map((item: any) => item.function.name);
    expect(toolNames).toEqual(["search_code", "read_file", "write_file", "git_diff"]);
  });

  it("returns an unknown-tool result for a forged run_command call without invoking a process", async () => {
    respondWithToolCalls([{ name: "run_command", arguments: { command: "npm", args: ["test"] } }]);

    const result = await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(result.commands).toEqual([]);
    const toolMessage = mocks.chatCreate.mock.calls[1]![0].messages.find((message: any) => message.tool_call_id === "call-1");
    expect(JSON.parse(toolMessage.content)).toEqual({ error: "未知工具" });
  });

  it("does not execute a frozen command after the model rewrites package.json", async () => {
    const worktree = await temporaryWorktree();
    await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
    respondWithToolCalls([
      { name: "write_file", arguments: { path: "package.json", content: JSON.stringify({ scripts: { test: "git push origin HEAD" } }) } },
      { name: "run_command", arguments: { command: "npm", args: ["test"] } }
    ]);

    const result = await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    expect(JSON.parse(await readFile(join(worktree, "package.json"), "utf8"))).toEqual({ scripts: { test: "git push origin HEAD" } });
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(result.commands).toEqual([]);
  });

  it.each([
    [".GIT", ".git"],
    [".Git/config", ".git/config"],
    ["src/.GIT/config", "src/.git/config"]
  ])("rejects the case-variant Git metadata path %s through write_file", async (requestedPath, protectedPath) => {
    const worktree = await temporaryWorktree();
    const protectedTarget = join(worktree, protectedPath);
    await mkdir(dirname(protectedTarget), { recursive: true });
    await writeFile(protectedTarget, "protected-git-metadata", "utf8");
    respondWithToolCalls([
      { name: "write_file", arguments: { path: requestedPath, content: "overwritten" } }
    ]);

    const result = await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    const toolMessage = mocks.chatCreate.mock.calls[1]![0].messages.find((message: any) => message.tool_call_id === "call-1");
    expect(JSON.parse(toolMessage.content)).toEqual({ error: "禁止访问工作区 Git 元数据" });
    expect(await readFile(protectedTarget, "utf8")).toBe("protected-git-metadata");
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(result.commands).toEqual([]);
  });

  it.each([".github/workflows/ci.yml", "foo.gitignore"])("allows the non-metadata path %s through write_file", async (path) => {
    const worktree = await temporaryWorktree();
    respondWithToolCalls([
      { name: "write_file", arguments: { path, content: "allowed" } }
    ]);

    const result = await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    const toolMessage = mocks.chatCreate.mock.calls[1]![0].messages.find((message: any) => message.tool_call_id === "call-1");
    expect(JSON.parse(toolMessage.content)).toEqual({ written: path });
    expect(await readFile(join(worktree, path), "utf8")).toBe("allowed");
    expect(result.commands).toEqual([]);
  });

  it("keeps search, read, write, and diff tools available", async () => {
    const worktree = await temporaryWorktree();
    await writeFile(join(worktree, "App.ts"), "export const before = '--version';\n", "utf8");
    respondWithToolCalls([
      { name: "search_code", arguments: { query: "--version" } },
      { name: "read_file", arguments: { path: "App.ts" } },
      { name: "write_file", arguments: { path: "App.ts", content: "export const after = true;\n" } },
      { name: "git_diff", arguments: {} }
    ]);

    const result = await runCodingAgent(codingInput([{ command: "npm", argsPrefix: ["test"] }]));

    expect(await readFile(join(worktree, "App.ts"), "utf8")).toBe("export const after = true;\n");
    expect(diff).toHaveBeenCalledWith(worktree);
    const searchMessage = mocks.chatCreate.mock.calls[1]![0].messages.find((message: any) => message.tool_call_id === "call-1");
    expect(JSON.parse(searchMessage.content)).toContain("App.ts:1:export const before = '--version';");
    expect(result.commands).toEqual([]);
  });
});
