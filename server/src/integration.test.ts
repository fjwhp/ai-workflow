import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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

  it("does not execute repository clean or process filters that can create refs", async () => {
    const item = await fixture();
    const cleanFilter = join(item.root, "clean-filter.sh");
    const processFilter = join(item.root, "process-filter.sh");
    await writeFile(cleanFilter, ["#!/bin/sh", "git tag forbidden-clean-filter", "cat"].join("\n"));
    await writeFile(processFilter, ["#!/bin/sh", "git tag forbidden-process-filter", "exit 1"].join("\n"));
    await chmod(cleanFilter, 0o755);
    await chmod(processFilter, 0o755);
    await writeFile(join(item.repo, ".git", "info", "attributes"), "feature.txt filter=hostile\n");
    await exec("git", ["-C", item.repo, "config", "filter.hostile.clean", cleanFilter]);
    await exec("git", ["-C", item.repo, "config", "filter.hostile.process", processFilter]);

    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 ignores filters", commands: []
    });

    expect(result.status).toBe("completed");
    expect((await exec("git", ["-C", item.repo, "for-each-ref", "--format=%(refname)", "refs/tags"])).stdout)
      .toBe("");
  });

  it("ignores an inherited GIT_DIR that redirects Git outside the selected repository", async () => {
    const item = await fixture();
    const impostor = join(item.root, "redirected.git");
    await exec("git", ["init", "--bare", impostor]);
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = impostor;
    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 ignores GIT_DIR", commands: []
      });
      expect(result.status).toBe("completed");
      expect((await exec("git", ["-C", impostor, "for-each-ref", "--format=%(refname)"])).stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("ignores inherited GIT_CONFIG_COUNT filter injection", async () => {
    const item = await fixture();
    const filter = join(item.root, "injected-filter.sh");
    await writeFile(filter, ["#!/bin/sh", "git tag forbidden-injected-filter", "cat"].join("\n"));
    await chmod(filter, 0o755);
    await writeFile(join(item.repo, ".git", "info", "attributes"), "feature.txt filter=injected\n");
    const inherited = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.injected.clean";
    process.env.GIT_CONFIG_VALUE_0 = filter;
    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 ignores injected config", commands: []
      });
      expect(result.status).toBe("completed");
      expect((await exec("git", ["-C", item.repo, "for-each-ref", "--format=%(refname)", "refs/tags"])).stdout)
        .toBe("");
    } finally {
      if (inherited.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = inherited.count;
      if (inherited.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = inherited.key;
      if (inherited.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = inherited.value;
    }
  });

  it("does not inherit Git trace destinations outside the selected repository", async () => {
    const item = await fixture();
    const trace = join(item.root, "outside-git-trace.log");
    const previous = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 ignores Git trace", commands: []
      });
      expect(result.status).toBe("completed");
      await expect(readFile(trace, "utf8")).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previous;
    }
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

  it("propagates a source-frozen ownership callback error unchanged", async () => {
    const item = await fixture();
    const callbackError = new Error("SOURCE_FROZEN_LEASE_LOOKUP_FAILED");
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();

    await expect(executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 source-frozen callback", commands: [],
      onSourceFrozen: async () => { throw callbackError; }
    })).rejects.toBe(callbackError);

    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
  });

  it("propagates a source-prepared ownership callback error unchanged", async () => {
    const item = await fixture();
    const callbackError = new Error("SOURCE_PREPARED_LEASE_LOOKUP_FAILED");
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();

    await expect(executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 source-prepared callback", commands: [],
      onSourcePrepared: async () => { throw callbackError; }
    })).rejects.toBe(callbackError);

    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
  });

  it("propagates a pre-mutation ownership callback error unchanged", async () => {
    const item = await fixture();
    const callbackError = new Error("TARGET_OWNERSHIP_LOOKUP_FAILED");
    const targetHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();

    await expect(executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 ownership callback", commands: [],
      assertTargetOwnership: async () => { throw callbackError; }
    })).rejects.toBe(callbackError);

    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
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

  it("preserves a foreign conflict created immediately before target mutation", async () => {
    const item = await fixture();
    await rm(join(item.sourceWorktree, "feature.txt"));
    await writeFile(join(item.sourceWorktree, "value.txt"), "delivery source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);

    await writeFile(join(item.targetWorktree, "value.txt"), "target version\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target version"]);
    await writeFile(join(item.repo, "value.txt"), "foreign source\n");
    await exec("git", ["-C", item.repo, "add", "--all"]);
    await exec("git", ["-C", item.repo, "commit", "-m", "foreign source"]);
    const foreignCommit = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();

    const captureConflictState = async () => {
      const cherryPickHeadPath = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "--git-path", "CHERRY_PICK_HEAD"])).stdout.trim();
      const indexPath = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "--git-path", "index"])).stdout.trim();
      return {
        cherryPickHead: await readFile(cherryPickHeadPath).catch(() => Buffer.alloc(0)),
        index: await readFile(indexPath),
        value: await readFile(join(item.targetWorktree, "value.txt")),
        status: (await exec("git", ["-C", item.targetWorktree, "status", "--porcelain=v1"])).stdout
      };
    };
    let foreignState: Awaited<ReturnType<typeof captureConflictState>> | undefined;
    const result = await executeLocalIntegration({
      ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
      commitMessage: "REQ-0001 preserves foreign conflict", commands: [],
      onBeforeTargetMutation: async () => {
        await exec("git", ["-C", item.targetWorktree, "cherry-pick", foreignCommit]).catch(() => undefined);
        foreignState = await captureConflictState();
      }
    });

    expect(result.status).toBe("ambiguous");
    expect(foreignState).toBeDefined();
    expect(await captureConflictState()).toEqual(foreignState);
  });

  it("preserves an owned conflict after another actor starts resolving it", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "value.txt"), "delivery source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
    await writeFile(join(item.targetWorktree, "value.txt"), "target version\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target version"]);

    const wrapperDirectory = join(item.root, "git-foreign-resolution-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const indexPath = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "--git-path", "index"])).stdout.trim();
    const cherryPickHeadPath = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "--git-path", "CHERRY_PICK_HEAD"])).stdout.trim();
    const savedIndex = join(item.root, "foreign-resolution.index");
    const savedCherryPickHead = join(item.root, "foreign-resolution.cherry-pick-head");
    const savedValue = join(item.root, "foreign-resolution.value");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "is_target=",
      "is_cherry_pick=",
      "source_commit=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
      "  if [ \"$argument\" = \"cherry-pick\" ]; then is_cherry_pick=1; fi",
      "  source_commit=$argument",
      "done",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_cherry_pick\" = \"1\" ]; then",
      `  ${JSON.stringify(realGit)} -C ${JSON.stringify(item.targetWorktree)} cherry-pick \"$source_commit\"`,
      "  status=$?",
      `  printf 'foreign resolution\\n' > ${JSON.stringify(join(item.targetWorktree, "value.txt"))}`,
      `  ${JSON.stringify(realGit)} -C ${JSON.stringify(item.targetWorktree)} add -- value.txt`,
      `  /bin/cp ${JSON.stringify(indexPath)} ${JSON.stringify(savedIndex)}`,
      `  /bin/cp ${JSON.stringify(cherryPickHeadPath)} ${JSON.stringify(savedCherryPickHead)}`,
      `  /bin/cp ${JSON.stringify(join(item.targetWorktree, "value.txt"))} ${JSON.stringify(savedValue)}`,
      "  exit $status",
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
        commitMessage: "REQ-0001 foreign resolution", commands: []
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(result!.status).toBe("ambiguous");
    expect(await readFile(indexPath)).toEqual(await readFile(savedIndex));
    expect(await readFile(cherryPickHeadPath)).toEqual(await readFile(savedCherryPickHead));
    expect(await readFile(join(item.targetWorktree, "value.txt"))).toEqual(await readFile(savedValue));
  });

  it("rolls back a wildcard filename without touching a matching sibling path", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "new?.txt"), "source wildcard\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);

    await writeFile(join(item.targetWorktree, "new?.txt"), "target wildcard\n");
    await writeFile(join(item.targetWorktree, "new1.txt"), "committed sibling\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target wildcard"]);
    await exec("git", ["-C", item.targetWorktree, "update-index", "--assume-unchanged", "new1.txt"]);
    await writeFile(join(item.targetWorktree, "new1.txt"), "hidden sibling edit\n");

    const result = await executeLocalIntegration({
      ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
      commitMessage: "REQ-0001 wildcard conflict", commands: []
    });

    expect(result.status, JSON.stringify(result)).toBe("conflict");
    expect(result.conflictFiles).toEqual(["new?.txt"]);
    expect(await readFile(join(item.targetWorktree, "new1.txt"), "utf8")).toBe("hidden sibling edit\n");
  });

  it("aborts a running Git cherry-pick without waiting for the subprocess timeout", async () => {
    const item = await fixture();
    const wrapperDirectory = join(item.root, "git-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const marker = join(item.root, "cherry-pick-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = \"cherry-pick\" ]; then",
      `    : > ${JSON.stringify(marker)}`,
      "    exec /bin/sleep 2",
      "  fi",
      "done",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    const controller = new AbortController();
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 abort cherry-pick", commands: [],
        signal: controller.signal
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await readFile(marker, "utf8").then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(readFile(marker, "utf8")).resolves.toBe("");
      const abortedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("does not start the primary cherry-pick after lease loss during filter lookup", async () => {
    const item = await fixture();
    const wrapperDirectory = join(item.root, "git-primary-lease-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const mutationArmed = join(item.root, "primary-mutation-armed");
    const filterLookupFinished = join(item.root, "primary-filter-lookup-finished");
    const cherryPickStarted = join(item.root, "primary-cherry-pick-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "is_target=",
      "is_config=",
      "is_cherry_pick=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
      "  if [ \"$argument\" = \"config\" ]; then is_config=1; fi",
      "  if [ \"$argument\" = \"cherry-pick\" ]; then is_cherry_pick=1; fi",
      "done",
      `if [ \"$is_target\" = \"1\" ] && [ \"$is_config\" = \"1\" ] && [ -f ${JSON.stringify(mutationArmed)} ]; then`,
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      `  : > ${JSON.stringify(filterLookupFinished)}`,
      "  exit $status",
      "fi",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_cherry_pick\" = \"1\" ]; then",
      `  : > ${JSON.stringify(cherryPickStarted)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      const callbackError = new Error("DELIVERY_APPLICATION_CLAIM_LOST");
      const pending = executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 primary fence", commands: [],
        onBeforeTargetMutation: async () => { await writeFile(mutationArmed, ""); },
        assertTargetOwnership: async () => {
          if (await readFile(filterLookupFinished).then(() => true, () => false)) throw callbackError;
        }
      });

      await expect(pending).rejects.toBe(callbackError);
      await expect(readFile(cherryPickStarted, "utf8")).rejects.toThrow();
      expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("does not swallow cancellation while inspecting an owned cherry-pick conflict", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
    await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target conflict"]);

    const wrapperDirectory = join(item.root, "git-cleanup-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const marker = join(item.root, "cleanup-inspection-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = \"CHERRY_PICK_HEAD\" ]; then",
      `    : > ${JSON.stringify(marker)}`,
      "    exec /bin/sleep 2",
      "  fi",
      "done",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    const controller = new AbortController();
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
        commitMessage: "REQ-0001 abort cleanup", commands: [], signal: controller.signal
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await readFile(marker, "utf8").then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(readFile(marker, "utf8")).resolves.toBe("");
      controller.abort();
      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("does not start destructive cleanup after the target lease is lost during diagnostics", async () => {
    const item = await fixture();
    await rm(join(item.sourceWorktree, "feature.txt"));
    await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
    await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target conflict"]);

    const wrapperDirectory = join(item.root, "git-cleanup-lease-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const diagnosticsFinished = join(item.root, "cleanup-diagnostics-finished");
    const destructiveCommandStarted = join(item.root, "destructive-cleanup-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "is_target=",
      "is_ls_tree=",
      "is_destructive=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
      "  if [ \"$argument\" = \"ls-tree\" ]; then is_ls_tree=1; fi",
      "  if [ \"$argument\" = \"restore\" ] || [ \"$argument\" = \"rm\" ] || [ \"$argument\" = \"--quit\" ]; then is_destructive=1; fi",
      "done",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_ls_tree\" = \"1\" ]; then",
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      `  : > ${JSON.stringify(diagnosticsFinished)}`,
      "  exit $status",
      "fi",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_destructive\" = \"1\" ]; then",
      `  : > ${JSON.stringify(destructiveCommandStarted)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
        commitMessage: "REQ-0001 fenced cleanup", commands: [],
        assertTargetOwnership: async () => {
          if (await readFile(diagnosticsFinished).then(() => true, () => false)) {
            throw new Error("DELIVERY_APPLICATION_CLAIM_LOST");
          }
        }
      });

      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_CLAIM_LOST");
      await expect(readFile(destructiveCommandStarted, "utf8")).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("stops immediately when the target lease is lost as restore completes", async () => {
    const item = await fixture();
    await rm(join(item.sourceWorktree, "feature.txt"));
    await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
    await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
    await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target conflict"]);

    const wrapperDirectory = join(item.root, "git-cleanup-after-lease-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const restoreFinished = join(item.root, "cleanup-restore-finished");
    const subsequentCleanupPreparation = join(item.root, "subsequent-cleanup-preparation");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "is_target=",
      "is_restore=",
      "is_config=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
      "  if [ \"$argument\" = \"restore\" ]; then is_restore=1; fi",
      "  if [ \"$argument\" = \"config\" ]; then is_config=1; fi",
      "done",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_restore\" = \"1\" ]; then",
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      `  : > ${JSON.stringify(restoreFinished)}`,
      "  exit $status",
      "fi",
      `if [ \"$is_target\" = \"1\" ] && [ \"$is_config\" = \"1\" ] && [ -f ${JSON.stringify(restoreFinished)} ]; then`,
      `  : > ${JSON.stringify(subsequentCleanupPreparation)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      const callbackError = new Error("DELIVERY_APPLICATION_CLAIM_LOST_AFTER_RESTORE");
      const pending = executeLocalIntegration({
        ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
        commitMessage: "REQ-0001 after-fenced cleanup", commands: [],
        assertTargetOwnership: async () => {
          if (await readFile(restoreFinished).then(() => true, () => false)) throw callbackError;
        }
      });

      await expect(pending).rejects.toBe(callbackError);
      await expect(readFile(subsequentCleanupPreparation, "utf8")).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it.each([
    ["worktree identity", "rev-parse", "--show-toplevel"],
    ["source evidence", "ls-files", "--ignored"]
  ])("aborts Git promptly while reading %s", async (_label, firstArgument, secondArgument) => {
    const item = await fixture();
    const wrapperDirectory = join(item.root, "git-read-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const marker = join(item.root, "git-read-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "has_first=",
      "has_second=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(firstArgument)} ]; then has_first=1; fi`,
      `  if [ \"$argument\" = ${JSON.stringify(secondArgument)} ]; then has_second=1; fi`,
      "done",
      "if [ \"$has_first\" = \"1\" ] && [ \"$has_second\" = \"1\" ]; then",
      `  : > ${JSON.stringify(marker)}`,
      "  exec /bin/sleep 2",
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    const controller = new AbortController();
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 abort Git read", commands: [],
        signal: controller.signal
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await readFile(marker, "utf8").then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(readFile(marker, "utf8")).resolves.toBe("");
      const abortedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
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

  it("checks the live target lease before and after a trusted index verification command", async () => {
    const item = await fixture();
    let assertions = 0;
    const pending = executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 fenced trusted check",
      commands: [{ command: "git", argsPrefix: ["diff", "--cached", "--check"] }],
      assertTargetOwnership: async () => {
        assertions += 1;
        if (assertions === 4) throw new Error("DELIVERY_APPLICATION_CLAIM_LOST");
      }
    } as Parameters<typeof executeLocalIntegration>[0]);

    await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_CLAIM_LOST");
    expect(assertions).toBe(4);
  });

  it("does not start trusted verification after the target lease is lost during filter lookup", async () => {
    const item = await fixture();
    const wrapperDirectory = join(item.root, "git-trusted-lease-wrapper");
    const wrapper = join(wrapperDirectory, "git");
    const cherryPickFinished = join(item.root, "cherry-pick-finished");
    const filterLookupFinished = join(item.root, "filter-lookup-finished");
    const verificationStarted = join(item.root, "trusted-verification-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapper, [
      "#!/bin/sh",
      "is_target=",
      "is_cherry_pick=",
      "is_config=",
      "is_diff=",
      "is_cached=",
      "is_check=",
      "for argument in \"$@\"; do",
      `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
      "  if [ \"$argument\" = \"cherry-pick\" ]; then is_cherry_pick=1; fi",
      "  if [ \"$argument\" = \"config\" ]; then is_config=1; fi",
      "  if [ \"$argument\" = \"diff\" ]; then is_diff=1; fi",
      "  if [ \"$argument\" = \"--cached\" ]; then is_cached=1; fi",
      "  if [ \"$argument\" = \"--check\" ]; then is_check=1; fi",
      "done",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_cherry_pick\" = \"1\" ]; then",
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      `  : > ${JSON.stringify(cherryPickFinished)}`,
      "  exit $status",
      "fi",
      `if [ \"$is_target\" = \"1\" ] && [ \"$is_config\" = \"1\" ] && [ -f ${JSON.stringify(cherryPickFinished)} ]; then`,
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      `  : > ${JSON.stringify(filterLookupFinished)}`,
      "  exit $status",
      "fi",
      "if [ \"$is_target\" = \"1\" ] && [ \"$is_diff\" = \"1\" ] && [ \"$is_cached\" = \"1\" ] && [ \"$is_check\" = \"1\" ]; then",
      `  : > ${JSON.stringify(verificationStarted)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 fenced trusted lookup",
        commands: [{ command: "git", argsPrefix: ["diff", "--cached", "--check"] }],
        assertTargetOwnership: async () => {
          if (await readFile(filterLookupFinished).then(() => true, () => false)) {
            throw new Error("DELIVERY_APPLICATION_CLAIM_LOST");
          }
        }
      });

      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_CLAIM_LOST");
      await expect(readFile(verificationStarted, "utf8")).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("does not expose inherited credentials to post-application verification", async () => {
    const item = await fixture();
    const previous = process.env.DELIVERY_TEST_SECRET;
    process.env.DELIVERY_TEST_SECRET = "must-not-reach-verification";
    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 sanitized verification",
        commands: [{
          command: process.execPath,
          argsPrefix: ["-e", "process.exit(process.env.DELIVERY_TEST_SECRET ? 23 : 0)"]
        }]
      });

      expect(result.status).toBe("completed");
      expect(result.commandResults).toMatchObject([{ code: 0 }]);
    } finally {
      if (previous === undefined) delete process.env.DELIVERY_TEST_SECRET;
      else process.env.DELIVERY_TEST_SECRET = previous;
    }
  });

  it("contains post-application verification writes outside its frozen workspace", async () => {
    const item = await fixture();
    const marker = join(item.root, "verification-escaped");
    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 contained verification",
      commands: [{
        command: process.execPath,
        argsPrefix: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')`]
      }]
    });

    expect(result.status).toBe("test_failed");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("bounds verification output so application evidence remains persistable", async () => {
    const item = await fixture();
    const result = await executeLocalIntegration({
      ...integrationInput(item), commitMessage: "REQ-0001 bounded output",
      commands: [{ command: process.execPath, argsPrefix: ["-e", "process.stdout.write('x'.repeat(2_000_000))"] }]
    });

    expect(result.status).toBe("test_failed");
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

  it("does not clean another actor's conflict when source binding fails before target mutation", async () => {
    const item = await fixture();
    await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
    const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);

    await exec("git", ["-C", item.repo, "switch", "-c", "other-application", "main"]);
    await writeFile(join(item.repo, "value.txt"), "other\n");
    await exec("git", ["-C", item.repo, "add", "value.txt"]);
    await exec("git", ["-C", item.repo, "commit", "-m", "other application"]);
    const otherCommit = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", item.repo, "switch", "main"]);

    await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
    await exec("git", ["-C", item.targetWorktree, "add", "value.txt"]);
    await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target change"]);

    let conflictState: Record<string, string> | undefined;
    const callbackError = new Error("DELIVERY_APPLICATION_CLAIM_LOST");
    const pending = executeLocalIntegration({
      ...integrationInput(item), evidenceHash: sourceSnapshot.evidenceHash,
      commitMessage: "REQ-0001 stale source binding", commands: [],
      onSourcePrepared: async () => {
        await expect(exec("git", ["-C", item.targetWorktree, "cherry-pick", otherCommit])).rejects.toThrow();
        conflictState = {
          head: (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout,
          cherryPickHead: (await exec("git", ["-C", item.targetWorktree, "rev-parse", "CHERRY_PICK_HEAD"])).stdout,
          index: (await exec("git", ["-C", item.targetWorktree, "ls-files", "-u", "-z"])).stdout,
          status: (await exec("git", ["-C", item.targetWorktree, "status", "--porcelain=v2", "-z"])).stdout,
          value: await readFile(join(item.targetWorktree, "value.txt"), "utf8")
        };
        throw callbackError;
      }
    });

    await expect(pending).rejects.toBe(callbackError);
    expect(conflictState).toBeDefined();
    await expect(Promise.all([
      exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"]).then(({ stdout }) => stdout),
      exec("git", ["-C", item.targetWorktree, "rev-parse", "CHERRY_PICK_HEAD"]).then(({ stdout }) => stdout),
      exec("git", ["-C", item.targetWorktree, "ls-files", "-u", "-z"]).then(({ stdout }) => stdout),
      exec("git", ["-C", item.targetWorktree, "status", "--porcelain=v2", "-z"]).then(({ stdout }) => stdout),
      readFile(join(item.targetWorktree, "value.txt"), "utf8")
    ])).resolves.toEqual([
      conflictState!.head, conflictState!.cherryPickHead, conflictState!.index,
      conflictState!.status, conflictState!.value
    ]);
  });
});
