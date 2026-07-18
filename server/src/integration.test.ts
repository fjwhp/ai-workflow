import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { executeLocalIntegration, preflightLocalIntegration } from "./integration.js";
import { getWorktreeSnapshot } from "./repository.js";
import { hashDiff } from "./coding-evidence.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flowgate-integration-")); roots.push(root);
  const repo = join(root, "repo"), worktree = join(root, "worktree");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Flowgate Test"]);
  await writeFile(join(repo, "value.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "--all"]); await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "ai/req-1", worktree, "main"]);
  await writeFile(join(worktree, "feature.txt"), "implemented\n");
  const snapshot = await getWorktreeSnapshot(worktree);
  return { repo, worktree, diffHash: hashDiff(snapshot.diff) };
}

describe("local integration", () => {
  it("returns the calculated verification plan in preflight", async () => {
    const item=await fixture(),fallbackCommands=[{command:"mvn",argsPrefix:["test"]}];
    const check=await preflightLocalIntegration({repoPath:item.repo,defaultBranch:"main",worktreePath:item.worktree,sourceBranch:"ai/req-1",evidenceDiffHash:item.diffHash,changedFiles:["README.md"],fallbackCommands});
    expect(check).toMatchObject({changedModules:[],plannedCommands:fallbackCommands,commandSource:"project_fallback"});
  });

  it("accepts a matching committed source patch after the worktree becomes clean", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.worktree, "add", "--all"]);
    await exec("git", ["-C", item.worktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.worktree, "rev-parse", "HEAD"])).stdout.trim();

    const withoutCommit = await preflightLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash });
    expect(withoutCommit.allowed).toBe(false);
    const withCommit = await preflightLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash, sourceCommit });
    expect(withCommit.allowed, JSON.stringify(withCommit.checks)).toBe(true);
    expect(withCommit.evidenceMode).toBe("commit");
    expect(withCommit.sourceCommit).toBe(sourceCommit);
  });

  it("rejects a committed source patch that does not match coding evidence", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.worktree, "add", "--all"]);
    await exec("git", ["-C", item.worktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.worktree, "rev-parse", "HEAD"])).stdout.trim();
    const check = await preflightLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: hashDiff("different"), sourceCommit });
    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "evidence_valid")?.ok).toBe(false);
  });

  it("applies one local source commit without committing the target branch", async () => {
    const item = await fixture();
    const check = await preflightLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash });
    expect(check.allowed, JSON.stringify(check.checks)).toBe(true);

    const beforeHead = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ ...item, repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash, commitMessage: "REQ-0001 feature", commands: [] });
    expect(result.status).toBe("completed");
    expect(result.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.targetCommit).toBe(beforeHead);
    expect((await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(beforeHead);
    expect((await exec("git", ["-C", item.repo, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
    expect((await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout).toContain("A  feature.txt");
  });

  it("rejects a dirty target worktree", async () => {
    const item = await fixture(); await writeFile(join(item.repo, "dirty.txt"), "dirty\n");
    const check = await preflightLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash });
    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "target_clean")?.ok).toBe(false);
  });

  it("aborts a conflicting cherry-pick and keeps the target branch clean", async () => {
    const item = await fixture();
    await writeFile(join(item.worktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.worktree);
    await writeFile(join(item.repo, "value.txt"), "target\n");
    await exec("git", ["-C", item.repo, "add", "--all"]); await exec("git", ["-C", item.repo, "commit", "-m", "target"]);
    const targetHead = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: hashDiff(sourceSnapshot.diff), commitMessage: "REQ-0001 conflict", commands: [] });
    expect(result.status).toBe("conflict");
    expect(result.conflictFiles).toEqual(["value.txt"]);
    expect((await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect(await readFile(join(item.repo, "value.txt"), "utf8")).toBe("target\n");
    expect((await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout).toBe("");
    await expect(stat(join(item.repo, ".git", "CHERRY_PICK_HEAD"))).rejects.toThrow();
  });

  it("reuses the source commit on retry instead of creating another commit", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.worktree, "add", "--all"]);
    await exec("git", ["-C", item.worktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.worktree, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash, sourceCommit, commitMessage: "must not be created", commands: [] });
    expect(result.status).toBe("completed");
    expect(result.sourceCommit).toBe(sourceCommit);
    expect((await exec("git", ["-C", item.worktree, "log", "-1", "--format=%s"])).stdout.trim()).toBe("source evidence");
  });

  it("keeps staged local changes when verification fails", async () => {
    const item = await fixture();
    const targetHead = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ ...item, repoPath: item.repo, defaultBranch: "main", worktreePath: item.worktree, sourceBranch: "ai/req-1", evidenceDiffHash: item.diffHash, commitMessage: "REQ-0001 feature", commands: [{ command: process.execPath, argsPrefix: ["-e", "process.exit(7)"] }] });
    expect(result.status).toBe("test_failed");
    expect(result.targetCommit).toBe(targetHead);
    expect((await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.repo, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
  });
});
