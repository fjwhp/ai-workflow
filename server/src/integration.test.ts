import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const repo = join(root, "repo"), targetWorktree = join(root, "version"), sourceWorktree = join(root, "requirement");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Flowgate Test"]);
  await writeFile(join(repo, "value.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "--all"]); await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "release/1.0", targetWorktree, "main"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "ai/req-1", sourceWorktree, "main"]);
  await writeFile(join(sourceWorktree, "feature.txt"), "implemented\n");
  const snapshot = await getWorktreeSnapshot(sourceWorktree);
  return { repo, targetWorktree, sourceWorktree, diffHash: hashDiff(snapshot.diff) };
}

function integrationInput(item: Awaited<ReturnType<typeof fixture>>) {
  return {
    targetWorktreePath: item.targetWorktree,
    targetBranch: "release/1.0",
    sourceWorktreePath: item.sourceWorktree,
    sourceBranch: "ai/req-1",
    evidenceDiffHash: item.diffHash
  };
}

describe("local integration", () => {
  it("returns the calculated verification plan in preflight", async () => {
    const item=await fixture(),fallbackCommands=[{command:"mvn",argsPrefix:["test"]}];
    const check=await preflightLocalIntegration({...integrationInput(item),changedFiles:["README.md"],fallbackCommands});
    expect(check).toMatchObject({changedModules:[],plannedCommands:fallbackCommands,commandSource:"project_fallback"});
  });

  it("accepts a matching committed source patch after the worktree becomes clean", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.sourceWorktree, "add", "--all"]);
    await exec("git", ["-C", item.sourceWorktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();

    const withoutCommit = await preflightLocalIntegration(integrationInput(item));
    expect(withoutCommit.allowed).toBe(false);
    const withCommit = await preflightLocalIntegration({ ...integrationInput(item), sourceCommit });
    expect(withCommit.allowed, JSON.stringify(withCommit.checks)).toBe(true);
    expect(withCommit.evidenceMode).toBe("commit");
    expect(withCommit.sourceCommit).toBe(sourceCommit);
  });

  it("rejects a committed source patch that does not match coding evidence", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.sourceWorktree, "add", "--all"]);
    await exec("git", ["-C", item.sourceWorktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const check = await preflightLocalIntegration({ ...integrationInput(item), evidenceDiffHash: hashDiff("different"), sourceCommit });
    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "evidence_valid")?.ok).toBe(false);
  });

  it("applies one local source commit without committing the target branch", async () => {
    const item = await fixture();
    const check = await preflightLocalIntegration(integrationInput(item));
    expect(check.allowed, JSON.stringify(check.checks)).toBe(true);

    const beforeHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const mainBefore = (await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout;
    const result = await executeLocalIntegration({ ...integrationInput(item), commitMessage: "REQ-0001 feature", commands: [] });
    expect(result.status).toBe("completed");
    expect(result.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.preApplyHead).toBe(beforeHead);
    expect(result.statusPorcelain).toContain("A  feature.txt");
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(beforeHead);
    expect((await exec("git", ["-C", item.targetWorktree, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toContain("A  feature.txt");
    expect((await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout).toBe(mainBefore);
  });

  it("rejects a dirty target worktree", async () => {
    const item = await fixture(); await writeFile(join(item.targetWorktree, "dirty.txt"), "dirty\n");
    const check = await preflightLocalIntegration(integrationInput(item));
    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "target_clean")?.ok).toBe(false);
  });

  it("aborts a conflicting cherry-pick and keeps the target branch clean", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
    await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]); await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target"]);
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ ...integrationInput(item), evidenceDiffHash: hashDiff(sourceSnapshot.diff), commitMessage: "REQ-0001 conflict", commands: [] });
    expect(result.status).toBe("conflict");
    expect(result.conflictFiles).toEqual(["value.txt"]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect(await readFile(join(item.targetWorktree, "value.txt"), "utf8")).toBe("target\n");
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "--verify", "CHERRY_PICK_HEAD"]).catch(() => ({ stdout: "" }))).stdout).toBe("");
  });

  it("reuses the source commit on retry instead of creating another commit", async () => {
    const item = await fixture();
    await exec("git", ["-C", item.sourceWorktree, "add", "--all"]);
    await exec("git", ["-C", item.sourceWorktree, "commit", "-m", "source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ ...integrationInput(item), sourceCommit, commitMessage: "must not be created", commands: [] });
    expect(result.status).toBe("completed");
    expect(result.sourceCommit).toBe(sourceCommit);
    expect((await exec("git", ["-C", item.sourceWorktree, "log", "-1", "--format=%s"])).stdout.trim()).toBe("source evidence");
  });

  it("keeps staged local changes when verification fails", async () => {
    const item = await fixture();
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const result = await executeLocalIntegration({ ...integrationInput(item), commitMessage: "REQ-0001 feature", commands: [{ command: process.execPath, argsPrefix: ["-e", "process.exit(7)"] }] });
    expect(result.status).toBe("test_failed");
    expect(result.preApplyHead).toBe(targetHead);
    expect(result.statusPorcelain).toContain("A  feature.txt");
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.targetWorktree, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
  });
});
