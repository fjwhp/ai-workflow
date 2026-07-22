import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { executeLocalIntegration, preflightLocalIntegration } from "./integration.js";
import { getWorktreeSnapshot } from "./repository.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flowgate-integration-")); roots.push(root);
  const repo = join(root, "repo"), targetWorktree = join(root, "version");
  const sourceWorktree = join(root, ".ai-workflow-worktrees", "repo", "requirements", "REQ-0001");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Flowgate Test"]);
  await writeFile(join(repo, "value.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "--all"]); await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "release/1.0", targetWorktree, "main"]);
  await mkdir(dirname(sourceWorktree), { recursive: true });
  await exec("git", ["-C", repo, "worktree", "add", "-b", "ai/REQ-0001", sourceWorktree, "main"]);
  await writeFile(join(sourceWorktree, "feature.txt"), "implemented\n");
  const snapshot = await getWorktreeSnapshot(sourceWorktree);
  return { root, repo, targetWorktree, sourceWorktree, evidenceHash: snapshot.evidenceHash };
}

function integrationInput(item: Awaited<ReturnType<typeof fixture>>) {
  return {
    projectRepoPath: item.repo,
    targetWorktreePath: item.targetWorktree,
    targetBranch: "release/1.0",
    sourceWorktreePath: item.sourceWorktree,
    sourceBranch: "ai/REQ-0001",
    evidenceHash: item.evidenceHash,
    sensitivePatterns: []
  };
}

describe("local integration", () => {
  it("rejects the registered project root as an integration target", async () => {
    const item = await fixture();
    const check = await preflightLocalIntegration({
      ...integrationInput(item), targetWorktreePath: item.repo, targetBranch: "main"
    });

    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "target_identity")?.ok).toBe(false);
  });

  it("rejects a source path replaced by a worktree from another repository", async () => {
    const item = await fixture();
    const impostor = join(item.root, "impostor");
    await exec("git", ["init", "-b", "ai/REQ-0001", impostor]);
    await exec("git", ["-C", impostor, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", impostor, "config", "user.name", "Impostor"]);
    await writeFile(join(impostor, "value.txt"), "base\n");
    await exec("git", ["-C", impostor, "add", "--all"]);
    await exec("git", ["-C", impostor, "commit", "-m", "base"]);
    await writeFile(join(impostor, "feature.txt"), "implemented\n");
    await rm(item.sourceWorktree, { recursive: true, force: true });
    await symlink(impostor, item.sourceWorktree);

    const check = await preflightLocalIntegration(integrationInput(item));

    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "source_identity")?.ok).toBe(false);
  });

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
    const check = await preflightLocalIntegration({ ...integrationInput(item), evidenceHash: "0".repeat(64), sourceCommit });
    expect(check.allowed).toBe(false);
    expect(check.checks.find((entry) => entry.id === "evidence_valid")?.ok).toBe(false);
  });

  it("applies one local source commit without committing the target branch", async () => {
    const item = await fixture();
    const remote = join(item.root, "remote.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["-C", item.repo, "remote", "add", "origin", remote]);
    const remoteRefsBefore = (await exec("git", ["-C", remote, "for-each-ref", "--format=%(refname)"])).stdout;
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
    expect((await exec("git", ["-C", item.repo, "for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"])).stdout).toBe("");
    expect((await exec("git", ["-C", remote, "for-each-ref", "--format=%(refname)"])).stdout).toBe(remoteRefsBefore);
  });

  it("does not execute repository hooks that can create refs", async () => {
    const item = await fixture();
    const hook = join(item.repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, ["#!/bin/sh", "git tag forbidden-hook-ref"].join("\n"));
    await chmod(hook, 0o755);

    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 safe hook boundary", commands: []
    });

    expect(result.status).toBe("completed");
    expect((await exec("git", ["-C", item.repo, "for-each-ref", "--format=%(refname)", "refs/tags"])).stdout).toBe("");
  });

  it("excludes an untracked sensitive file from the prepared commit and target", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, ".env"), "TOKEN=do-not-commit\n");

    const result = await executeLocalIntegration({
      ...integrationInput(item), sensitivePatterns: [".env"],
      commitMessage: "REQ-0001 excludes sensitive files", commands: []
    });

    expect(result.status).toBe("completed");
    await expect(exec("git", ["-C", item.sourceWorktree, "cat-file", "-e", `${result.sourceCommit}:.env`]))
      .rejects.toThrow();
    await expect(readFile(join(item.targetWorktree, ".env"), "utf8")).rejects.toThrow();
    expect(await readFile(join(item.sourceWorktree, ".env"), "utf8")).toContain("do-not-commit");
  });

  it("preserves a pre-staged excluded file without adding it to the prepared commit", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "credentials.json"), "{\"token\":\"private\"}\n");
    await exec("git", ["-C", item.sourceWorktree, "add", "credentials.json"]);

    const result = await executeLocalIntegration({
      ...integrationInput(item), sensitivePatterns: ["credentials.json"],
      commitMessage: "REQ-0001 preserves staged exclusions", commands: []
    });

    expect(result.status).toBe("completed");
    await expect(exec("git", ["-C", item.sourceWorktree, "cat-file", "-e",
      `${result.sourceCommit}:credentials.json`])).rejects.toThrow();
    expect((await exec("git", ["-C", item.sourceWorktree, "diff", "--cached", "--name-only"])).stdout)
      .toContain("credentials.json");
    await expect(readFile(join(item.targetWorktree, "credentials.json"), "utf8")).rejects.toThrow();
  });

  it("does not add a file created after source evidence is frozen", async () => {
    const item = await fixture();
    let frozen = false;

    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 freezes exact paths", commands: [],
      onSourceFrozen: async () => {
        frozen = true;
        await writeFile(join(item.sourceWorktree, "race-added.txt"), "late content\n");
        await exec("git", ["-C", item.sourceWorktree, "add", "race-added.txt"]);
      }
    } as Parameters<typeof executeLocalIntegration>[0]);

    expect(frozen).toBe(true);
    expect(result.status).toBe("completed");
    await expect(exec("git", ["-C", item.sourceWorktree, "cat-file", "-e",
      `${result.sourceCommit}:race-added.txt`])).rejects.toThrow();
    expect((await exec("git", ["-C", item.sourceWorktree, "diff", "--cached", "--name-only"])).stdout)
      .toContain("race-added.txt");
    await expect(readFile(join(item.targetWorktree, "race-added.txt"), "utf8")).rejects.toThrow();
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
    const result = await executeLocalIntegration({ ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash, commitMessage: "REQ-0001 conflict", commands: [] });
    expect(result.status, JSON.stringify(result)).toBe("conflict");
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

  it("bounds verification output so application evidence remains persistable", async () => {
    const item = await fixture();
    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 bounded output",
      commands: [{ command: process.execPath, argsPrefix: ["-e", "process.stdout.write('x'.repeat(2_000_000))"] }]
    });

    expect(result.status).toBe("completed");
    expect(Buffer.byteLength(JSON.stringify(result.commandResults))).toBeLessThan(1_048_576);
    expect(result.commandResults[0]?.stdout.length).toBeLessThan(2_000_000);
  });

  it("ignores a pre-commit hook that attempts to change source evidence", async () => {
    const item = await fixture();
    const hook = join(item.repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, [
      "#!/bin/sh",
      "printf 'hook-added\\n' > hook-added.txt",
      "git add hook-added.txt"
    ].join("\n"));
    await chmod(hook, 0o755);
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();

    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 hook", commands: []
    });

    expect(result.status).toBe("completed");
    expect((await exec("git", ["-C", item.sourceWorktree, "status", "--porcelain"])).stdout).toBe("");
    await expect(readFile(join(item.sourceWorktree, "hook-added.txt"), "utf8")).rejects.toThrow();
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toContain("feature.txt");
  });

  it("preserves a tracked target edit injected after preflight without applying evidence", async () => {
    const item = await fixture();
    const snapshot = await getWorktreeSnapshot(item.sourceWorktree);
    const result = await executeLocalIntegration({
      ...integrationInput(item), evidenceHash: snapshot.evidenceHash,
      commitMessage: "REQ-0001 target race", commands: [],
      onSourcePrepared: async () => {
        await writeFile(join(item.targetWorktree, "human.txt"), "human after preflight\n");
      }
    });

    expect(result.status).toBe("ambiguous");
    expect(await readFile(join(item.targetWorktree, "human.txt"), "utf8")).toBe("human after preflight\n");
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).not.toContain("feature.txt");
  });
});
