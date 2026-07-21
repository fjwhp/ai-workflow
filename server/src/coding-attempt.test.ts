import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareDeliveryImplementationAttempt,
  type CodingAgentInput,
  type CodingAgentResult
} from "./coding-agent.js";
import { DeliveryExecutionService } from "./delivery-execution-service.js";
import { getWorktreeSnapshot } from "./repository.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("delivery implementation attempt workspace", () => {
  it("publishes from an isolated worktree and can roll authoritative state back", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-attempt-real-"));
    directories.push(root);
    const repo = join(root, "repo");
    await exec("git", ["init", "-b", "main", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "base.txt"), "base\n");
    await exec("git", ["-C", repo, "add", "--all"]);
    await exec("git", ["-C", repo, "commit", "-m", "base"]);
    const head = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const input: CodingAgentInput = {
      requirement: { id: "requirement-1", code: "REQ-0001" }, artifacts: [],
      project: { id: "project-1", repoPath: repo, defaultBranch: "main", allowedCommands: [] },
      version: {
        id: "version-1", projectId: "project-1", branch: "main",
        worktreePath: repo, status: "active", headCommit: head
      },
      deliveryContext: {
        deliveryUnitId: "unit-1", requirementId: "requirement-1", evidenceVersion: 1,
        moduleIds: [], acceptanceCriteria: [], sensitivePatterns: [], allowedCommands: [],
        projectKnowledgeVersionId: null
      }
    };
    const attempt = await prepareDeliveryImplementationAttempt(input);
    await writeFile(join(attempt.workspace.worktreePath, "implemented.txt"), "attempt result\n");
    const snapshot = await getWorktreeSnapshot(attempt.workspace.worktreePath);
    const result: CodingAgentResult = {
      runId: "attempt-run", ...attempt.workspace, summary: "implemented",
      diff: snapshot.diff, commands: [], files: snapshot.files,
      additions: snapshot.additions, deletions: snapshot.deletions, evidenceSnapshot: snapshot
    };

    const published = await attempt.publish(result);

    expect(published.worktreePath).not.toBe(attempt.workspace.worktreePath);
    expect(await readFile(join(published.worktreePath, "implemented.txt"), "utf8")).toBe("attempt result\n");
    expect(existsSync(join(repo, "implemented.txt"))).toBe(false);
    await attempt.rollback();
    expect(existsSync(join(published.worktreePath, "implemented.txt"))).toBe(false);
    await attempt.cleanup();
    expect(existsSync(attempt.workspace.worktreePath)).toBe(false);
  });

  it("creates an owner-only attempt directory", async () => {
    const { attempt } = await createAttemptFixture();

    expect((await lstat(attempt.workspace.worktreePath)).mode & 0o777).toBe(0o700);

    await attempt.cleanup();
  });

  it("fails closed without deleting a replacement at the attempt path", async () => {
    const { attempt } = await createAttemptFixture();
    const original = `${attempt.workspace.worktreePath}.original`;
    await rename(attempt.workspace.worktreePath, original);
    await mkdir(attempt.workspace.worktreePath, { mode: 0o700 });
    await writeFile(join(attempt.workspace.worktreePath, "important.txt"), "keep\n");

    await expect(attempt.cleanup()).rejects.toThrow("IMPLEMENTATION_ATTEMPT_CLEANUP_PATH_INVALID");

    expect(await readFile(join(attempt.workspace.worktreePath, "important.txt"), "utf8")).toBe("keep\n");
  });

  it("isolates a custom coding agent by default", async () => {
    const { input, repo } = await createCodingInputFixture();
    const completeImplementation = vi.fn((_claim, evidence) => evidence);
    const persistence = {
      claimImplementation: vi.fn(() => ({ ...input, deliveryContext: input.deliveryContext })),
      assertImplementationLease: vi.fn(),
      failImplementation: vi.fn(),
      completeImplementation
    } as any;
    const codingAgent = vi.fn(async (agentInput: CodingAgentInput) => {
      expect(agentInput.attemptWorkspace).toBeDefined();
      await writeFile(join(agentInput.attemptWorkspace!.worktreePath, "custom.txt"), "isolated\n");
      const snapshot = await getWorktreeSnapshot(agentInput.attemptWorkspace!.worktreePath);
      return {
        runId: "custom-agent", ...agentInput.attemptWorkspace!, summary: "implemented", commands: [] as const,
        diff: snapshot.diff, files: snapshot.files, additions: snapshot.additions,
        deletions: snapshot.deletions, evidenceSnapshot: snapshot
      };
    });

    await new DeliveryExecutionService(persistence, codingAgent).implement("unit-1");

    const evidence = completeImplementation.mock.calls[0]![1];
    expect(evidence.worktreePath).not.toBe(repo);
    expect(await readFile(join(evidence.worktreePath, "custom.txt"), "utf8")).toBe("isolated\n");
    expect(existsSync(join(repo, "custom.txt"))).toBe(false);
  });
});

async function createAttemptFixture() {
  const { root, repo, input } = await createCodingInputFixture();
  return { root, repo, attempt: await prepareDeliveryImplementationAttempt(input) };
}

async function createCodingInputFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "delivery-attempt-real-")));
  directories.push(root);
  const repo = join(root, "repo");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "--all"]);
  await exec("git", ["-C", repo, "commit", "-m", "base"]);
  const head = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const input: CodingAgentInput = {
    requirement: { id: "requirement-1", code: "REQ-0001" }, artifacts: [],
    project: { id: "project-1", repoPath: repo, defaultBranch: "main", allowedCommands: [] },
    version: {
      id: "version-1", projectId: "project-1", branch: "main",
      worktreePath: repo, status: "active", headCommit: head
    },
    deliveryContext: {
      deliveryUnitId: "unit-1", requirementId: "requirement-1", evidenceVersion: 1,
      moduleIds: [], acceptanceCriteria: [], sensitivePatterns: [], allowedCommands: [],
      projectKnowledgeVersionId: null
    }
  };
  return { root, repo, input };
}
