import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodingEvidence } from "./coding-evidence.js";
import {
  classifyGitFailure,
  cleanupFailedManagedWorktreeCreation,
  createOrReuseRequirementWorktree,
  getLocalBranches,
  getWorktreeDiff,
  getWorktreeSnapshot,
  isProtectedBranch
} from "./repository.js";

const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});

describe("getWorktreeSnapshot",()=>{
  it("includes files nested inside an untracked directory",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-git-"));dirs.push(dir);
    await exec("git",["init",dir]);
    await mkdir(join(dir,"src","test"),{recursive:true});
    await writeFile(join(dir,"src","test","new.txt"),"hello\n");
    const snapshot=await getWorktreeSnapshot(dir);
    expect(snapshot.files).toContain("src/test/new.txt");
    expect(snapshot.diff).toContain("+hello");
    expect(snapshot.changedFiles).toContainEqual({
      path: "src/test/new.txt", status: "added", kind: "text", content: "hello\n"
    });
  });

  it("keeps invalid UTF-8 binary bytes distinct in snapshot and evidence hashes", async () => {
    const snapshotFor = async (byte: number) => {
      const dir = await mkdtemp(join(tmpdir(), "workflow-binary-snapshot-")); dirs.push(dir);
      await exec("git", ["init", dir]);
      await writeFile(join(dir, "payload.bin"), Buffer.from([byte]));
      return getWorktreeSnapshot(dir);
    };
    const firstBytes = Buffer.from([0x80]);
    const secondBytes = Buffer.from([0x81]);

    const [first, second] = await Promise.all([snapshotFor(firstBytes[0]!), snapshotFor(secondBytes[0]!)]);

    expect(first.diff).not.toBe(second.diff);
    expect(buildCodingEvidence({ diff: first.diff }).diffHash)
      .not.toBe(buildCodingEvidence({ diff: second.diff }).diffHash);
    for (const [snapshot, bytes] of [[first, firstBytes], [second, secondBytes]] as const) {
      expect(snapshot.files).toContain("payload.bin");
      expect(snapshot.diff).toContain("Binary files /dev/null and b/payload.bin differ");
      expect(snapshot.diff).toContain(`binary-size: ${bytes.length}`);
      expect(snapshot.diff).toContain(`binary-sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
      expect(snapshot.diff).not.toContain("\uFFFD");
      expect(snapshot.changedFiles).toContainEqual({
        path: "payload.bin", status: "added", kind: "binary",
        size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  });

  it("returns complete modified content and an explicit deleted marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-changed-files-")); dirs.push(dir);
    await exec("git", ["init", dir]);
    await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", dir, "config", "user.name", "Test"]);
    await writeFile(join(dir, "modified.txt"), "before\n");
    await writeFile(join(dir, "deleted.txt"), "remove\n");
    await exec("git", ["-C", dir, "add", "--all"]);
    await exec("git", ["-C", dir, "commit", "-m", "base"]);
    await writeFile(join(dir, "modified.txt"), "after\n");
    await rm(join(dir, "deleted.txt"));

    const snapshot = await getWorktreeSnapshot(dir);

    expect(snapshot.changedFiles).toContainEqual({
      path: "modified.txt", status: "modified", kind: "text", content: "after\n"
    });
    expect(snapshot.changedFiles).toContainEqual({ path: "deleted.txt", status: "deleted" });
  });

  it("treats NUL-containing untracked content as binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-nul-snapshot-")); dirs.push(dir);
    await exec("git", ["init", dir]);
    const bytes = Buffer.from("prefix\0suffix", "utf8");
    await writeFile(join(dir, "nul.dat"), bytes);

    const snapshot = await getWorktreeSnapshot(dir);

    expect(snapshot.diff).toContain("Binary files /dev/null and b/nul.dat differ");
    expect(snapshot.diff).toContain(`binary-size: ${bytes.length}`);
    expect(snapshot.diff).toContain(`binary-sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("keeps valid Unicode untracked content as a text patch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-unicode-snapshot-")); dirs.push(dir);
    await exec("git", ["init", dir]);
    await writeFile(join(dir, "unicode.txt"), "你好，世界 😀\n", "utf8");

    const snapshot = await getWorktreeSnapshot(dir);

    expect(snapshot.diff).toContain("+你好，世界 😀");
    expect(snapshot.diff).not.toContain("binary-sha256:");
  });

  it("rejects an untracked final symlink instead of reading its outside target", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-snapshot-link-")); dirs.push(root);
    const repoPath = join(root, "repo");
    const secretPath = join(root, "outside-secret.txt");
    await exec("git", ["init", repoPath]);
    await writeFile(secretPath, "OUTSIDE_SECRET\n");
    await symlink(secretPath, join(repoPath, "linked-secret.txt"));

    await expect(getWorktreeSnapshot(repoPath)).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
  });

  it("rejects an untracked symlink to an outside parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-snapshot-parent-link-")); dirs.push(root);
    const repoPath = join(root, "repo");
    const outside = join(root, "outside");
    await exec("git", ["init", repoPath]);
    await mkdir(outside);
    await writeFile(join(outside, "nested-secret.txt"), "OUTSIDE_PARENT_SECRET\n");
    await symlink(outside, join(repoPath, "linked-directory"));

    await expect(getWorktreeSnapshot(repoPath)).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
  });

  it("rejects an untracked symlink to the repository Git common directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-snapshot-git-link-")); dirs.push(root);
    const repoPath = join(root, "repo");
    await exec("git", ["init", repoPath]);
    const commonDir = resolve(repoPath, await git(repoPath, "rev-parse", "--git-common-dir"));
    await symlink(commonDir, join(repoPath, "metadata-link"));

    await expect(getWorktreeSnapshot(repoPath)).rejects.toThrow("CODING_FILE_PATH_UNSAFE");
  });

});

describe("local integration branches",()=>{
  it("lists local branches and marks the current and protected branches",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-branches-"));dirs.push(dir);
    await exec("git",["init","-b","main",dir]);
    await exec("git",["-C",dir,"config","user.email","test@example.com"]);await exec("git",["-C",dir,"config","user.name","Test"]);
    await writeFile(join(dir,"README.md"),"base\n");await exec("git",["-C",dir,"add","--all"]);await exec("git",["-C",dir,"commit","-m","base"]);
    await exec("git",["-C",dir,"branch","feature/0710-test"]);await exec("git",["-C",dir,"switch","feature/0710-test"]);
    const result=await getLocalBranches(dir);
    expect(result.currentBranch).toBe("feature/0710-test");
    expect(result.branches).toEqual([
      {name:"feature/0710-test",current:true,protected:false},
      {name:"main",current:false,protected:true}
    ]);
    expect(isProtectedBranch("prod")).toBe(true);expect(isProtectedBranch("feature/prod-fix")).toBe(false);
  });
});

async function git(path: string, ...args: string[]) { return (await exec("git", ["-C", path, ...args])).stdout.trim(); }

async function replaceWithForeignRepository(path: string, branch: string) {
  await rm(path, { recursive: true, force: true });
  await exec("git", ["init", "-b", branch, path]);
  await git(path, "config", "user.email", "foreign@example.com"); await git(path, "config", "user.name", "Foreign");
  await writeFile(join(path, "FOREIGN.md"), "foreign\n"); await git(path, "add", "--all"); await git(path, "commit", "-m", "foreign");
}

async function registeredPaths(repoPath: string, branch: string) {
  const output = (await exec("git", ["-C", repoPath, "worktree", "list", "--porcelain"])).stdout;
  return output.trim().split("\n\n").map((record) => ({
    path: record.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length),
    branch: record.split("\n").find((line) => line.startsWith("branch "))?.slice("branch ".length)
  })).filter((item) => item.branch === `refs/heads/${branch}`).map((item) => item.path);
}

async function pathExists(path: string) {
  try { await lstat(path); return true; } catch { return false; }
}

async function localBranchExistsForTest(repoPath: string, branch: string) {
  try { await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; }
  catch { return false; }
}

async function configureFailingSmudge(repoPath: string) {
  await writeFile(join(repoPath, ".gitattributes"), "failure.txt filter=required-fail\n");
  await writeFile(join(repoPath, "failure.txt"), "checkout must fail\n");
  await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add required filter file");
  await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
  await git(repoPath, "config", "filter.required-fail.clean", "cat");
  await git(repoPath, "config", "filter.required-fail.smudge", "false");
  await git(repoPath, "config", "filter.required-fail.required", "true");
}

async function setupVersionRepository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-requirements-")); dirs.push(root);
  const repoPath = join(root, "project");
  await exec("git", ["init", "-b", "prod", repoPath]);
  await git(repoPath, "config", "user.email", "test@example.com"); await git(repoPath, "config", "user.name", "Test");
  await writeFile(join(repoPath, "README.md"), "base\n"); await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "base");
  await git(repoPath, "branch", "feature/2.2.1");
  return { root, repoPath };
}

async function executableMarkerScript(path: string, marker: string, body = "exit 0") {
  await writeFile(path, `#!/bin/sh\nprintf marker > "${marker}"\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

async function mainState(repoPath: string) {
  return {
    branch: await git(repoPath, "branch", "--show-current"),
    head: await git(repoPath, "rev-parse", "HEAD"),
    status: await git(repoPath, "status", "--porcelain=v1", "--untracked-files=all")
  };
}

describe("requirement worktree lifecycle", () => {
  it("does not execute a repository post-checkout hook while creating a coding worktree", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "post-checkout-marker");
    const hook = resolve(repoPath, await git(repoPath, "rev-parse", "--git-path", "hooks/post-checkout"));
    await executableMarkerScript(hook, marker);

    await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0030");

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute a configured smudge filter while creating a coding worktree", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "smudge-marker");
    const script = join(root, "smudge-filter.sh");
    await executableMarkerScript(script, marker, "cat");
    await writeFile(join(repoPath, ".gitattributes"), "payload.txt filter=marker-smudge\n");
    await writeFile(join(repoPath, "payload.txt"), "payload\n");
    await git(repoPath, "config", "filter.marker-smudge.clean", "cat");
    await git(repoPath, "config", "filter.marker-smudge.smudge", script);
    await git(repoPath, "config", "filter.marker-smudge.required", "true");
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add smudge payload");
    await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");

    await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0031");

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute a configured process filter while creating a coding worktree", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "process-marker");
    const script = join(root, "process-filter.sh");
    await executableMarkerScript(script, marker, "exit 1");
    await writeFile(join(repoPath, ".gitattributes"), "payload.txt filter=marker-process\n");
    await writeFile(join(repoPath, "payload.txt"), "payload\n");
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add process payload");
    await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
    await git(repoPath, "config", "filter.marker-process.process", script);
    await git(repoPath, "config", "filter.marker-process.required", "false");

    let failure: unknown;
    try { await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0032"); }
    catch (error) { failure = error; }
    expect(await pathExists(marker)).toBe(false);
    expect(failure).toBeUndefined();
  });

  it("does not execute a smudge filter whose configured name contains an equals sign", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "equals-smudge-marker");
    const script = join(root, "equals-smudge-filter.sh");
    await executableMarkerScript(script, marker, "cat");
    await writeFile(join(repoPath, ".gitattributes"), "payload.txt filter=has=equals\n");
    await writeFile(join(repoPath, "payload.txt"), "payload\n");
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add equals smudge payload");
    await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
    await git(repoPath, "config", "filter.has=equals.smudge", script);
    await git(repoPath, "config", "filter.has=equals.required", "true");

    await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0033");

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute a process filter whose configured name contains an equals sign", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "equals-process-marker");
    const script = join(root, "equals-process-filter.sh");
    await executableMarkerScript(script, marker, "exit 1");
    await writeFile(join(repoPath, ".gitattributes"), "payload.txt filter=has=equals\n");
    await writeFile(join(repoPath, "payload.txt"), "payload\n");
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add equals process payload");
    await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
    await git(repoPath, "config", "filter.has=equals.process", script);
    await git(repoPath, "config", "filter.has=equals.required", "false");

    let failure: unknown;
    try { await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0034"); }
    catch (error) { failure = error; }

    expect(await pathExists(marker)).toBe(false);
    expect(failure).toBeUndefined();
  });

  it("transports filter names containing spaces and backslashes as exact config keys", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const spaceKey = "filter.has space.smudge";
    const backslashKey = "filter.has\\backslash.smudge";
    await git(repoPath, "config", spaceKey, "cat");
    await git(repoPath, "config", backslashKey, "cat");
    expect(await git(repoPath, "config", "--get", spaceKey)).toBe("cat");
    expect(await git(repoPath, "config", "--get", backslashKey)).toBe("cat");

    const wrapperDir = join(root, "git-wrapper");
    const wrapper = join(wrapperDir, "git");
    const environmentMarker = join(root, "filter-environment");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDir);
    await writeFile(wrapper, `#!/bin/sh
has_worktree=
has_add=
for argument in "$@"; do
  if [ "$argument" = "worktree" ]; then has_worktree=1; fi
  if [ "$argument" = "add" ]; then has_add=1; fi
done
if [ "$has_worktree" = "1" ] && [ "$has_add" = "1" ]; then
  env > "$FILTER_ENVIRONMENT_MARKER"
fi
exec "$FILTER_REAL_GIT" "$@"
`, "utf8");
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    const previousConfigCount = process.env.GIT_CONFIG_COUNT;
    const previousConfigKey = process.env.GIT_CONFIG_KEY_0;
    const previousConfigValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.PATH = `${wrapperDir}${delimiter}${previousPath ?? ""}`;
    process.env.FILTER_REAL_GIT = realGit;
    process.env.FILTER_ENVIRONMENT_MARKER = environmentMarker;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.injected.smudge";
    process.env.GIT_CONFIG_VALUE_0 = "unsafe-driver";
    try {
      await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0035");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previousConfigCount;
      if (previousConfigKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = previousConfigKey;
      if (previousConfigValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = previousConfigValue;
      delete process.env.FILTER_REAL_GIT;
      delete process.env.FILTER_ENVIRONMENT_MARKER;
    }

    const environment = await readFile(environmentMarker, "utf8");
    const variables = Object.fromEntries(environment.split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const configKeys = Object.entries(variables)
      .filter(([name]) => /^GIT_CONFIG_KEY_\d+$/.test(name))
      .map(([, value]) => value);
    expect(Number(variables.GIT_CONFIG_COUNT)).toBe(configKeys.length);
    expect(configKeys).toContain(spaceKey);
    expect(configKeys).toContain(backslashKey);
    expect(configKeys).toContain("core.fsmonitor");
    expect(configKeys).toContain("core.hooksPath");
    expect(configKeys).not.toContain("filter.injected.smudge");
    for (const key of [spaceKey, backslashKey]) {
      const index = Object.entries(variables).find(([, value]) => value === key)?.[0].slice("GIT_CONFIG_KEY_".length);
      expect(variables[`GIT_CONFIG_VALUE_${index}`]).toBe("");
    }
  });

  it("does not execute fake git-lfs process or smudge drivers", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const processMarker = join(root, "git-lfs-process-marker");
    const smudgeMarker = join(root, "git-lfs-smudge-marker");
    const processScript = join(root, "git-lfs-process.sh");
    const smudgeScript = join(root, "git-lfs-smudge.sh");
    await executableMarkerScript(processScript, processMarker, "exit 1");
    await executableMarkerScript(smudgeScript, smudgeMarker, "cat");
    await writeFile(join(repoPath, ".gitattributes"), "payload.bin filter=lfs\n");
    await writeFile(join(repoPath, "payload.bin"), "payload\n");
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add fake lfs payload");
    await git(repoPath, "branch", "-f", "feature/2.2.1", "prod");
    await git(repoPath, "config", "filter.lfs.process", processScript);
    await git(repoPath, "config", "filter.lfs.smudge", smudgeScript);
    await git(repoPath, "config", "filter.lfs.required", "false");

    await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0036");

    expect(await pathExists(processMarker)).toBe(false);
    expect(await pathExists(smudgeMarker)).toBe(false);
  });

  it("does not execute diff.external while reading a coding worktree diff", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "external-diff-marker");
    const script = join(root, "external-diff.sh");
    await executableMarkerScript(script, marker);
    await git(repoPath, "config", "diff.external", script);
    await writeFile(join(repoPath, "README.md"), "changed\n");

    await getWorktreeDiff(repoPath);

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute a textconv driver while reading a coding worktree diff", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "textconv-marker");
    const script = join(root, "textconv.sh");
    await executableMarkerScript(script, marker, "cat \"$1\"");
    await writeFile(join(repoPath, ".gitattributes"), "*.txt diff=marker-textconv\n");
    await writeFile(join(repoPath, "tracked.txt"), "before\n");
    await git(repoPath, "config", "diff.marker-textconv.textconv", script);
    await git(repoPath, "add", "--all"); await git(repoPath, "commit", "-m", "add textconv payload");
    await writeFile(join(repoPath, "tracked.txt"), "after\n");

    await getWorktreeDiff(repoPath);

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute core.fsmonitor while reading a coding worktree snapshot", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const marker = join(root, "fsmonitor-marker");
    const script = join(root, "fsmonitor.sh");
    await executableMarkerScript(script, marker, "exit 1");
    await git(repoPath, "config", "core.fsmonitor", script);

    await getWorktreeSnapshot(repoPath);

    expect(await pathExists(marker)).toBe(false);
  });

  it("rejects a mounted snapshot worktree whose actual HEAD advanced past the frozen commit", async () => {
    const { repoPath } = await setupVersionRepository();
    const frozenHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0020", frozenHead);
    await writeFile(join(created.worktreePath, "progress.txt"), "progress\n");
    await git(created.worktreePath, "add", "--all");
    await git(created.worktreePath, "commit", "-m", "advance requirement");

    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0020", frozenHead))
      .rejects.toThrow("DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH");
  });

  it("rejects an unmounted snapshot branch whose ref advanced past the frozen commit", async () => {
    const { repoPath } = await setupVersionRepository();
    const frozenHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const tree = await git(repoPath, "rev-parse", `${frozenHead}^{tree}`);
    const advancedHead = await git(repoPath, "commit-tree", tree, "-p", frozenHead, "-m", "advance unmounted requirement");
    await git(repoPath, "update-ref", "refs/heads/ai/REQ-0021", advancedHead, "");

    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0021", frozenHead))
      .rejects.toThrow("DELIVERY_UNIT_SNAPSHOT_HEAD_MISMATCH");
  });

  it("creates from a frozen commit object after the live source branch is force-moved away", async () => {
    const { repoPath } = await setupVersionRepository();
    const frozenHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const tree = await git(repoPath, "rev-parse", `${frozenHead}^{tree}`);
    const replacementHead = await git(repoPath, "commit-tree", tree, "-m", "replacement source root");
    await git(repoPath, "update-ref", "refs/heads/feature/2.2.1", replacementHead, frozenHead);

    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0022", frozenHead);

    expect(created.baseCommit).toBe(frozenHead);
    expect(await git(created.worktreePath, "rev-parse", "HEAD")).toBe(frozenHead);
    expect(await git(repoPath, "rev-parse", "feature/2.2.1")).toBe(replacementHead);
  });

  it("serializes concurrent creation from the same frozen snapshot commit", async () => {
    const { repoPath } = await setupVersionRepository();
    const frozenHead = await git(repoPath, "rev-parse", "feature/2.2.1");

    const results = await Promise.all([
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0023", frozenHead),
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0023", frozenHead)
    ]);

    expect(results.map((item) => item.reused).sort()).toEqual([false, true]);
    expect(new Set(results.map((item) => item.worktreePath)).size).toBe(1);
    expect(await git(results[0]!.worktreePath, "rev-parse", "HEAD")).toBe(frozenHead);
  });

  it("creates a delivery worktree from the frozen head after its source branch advances", async () => {
    const { repoPath } = await setupVersionRepository();
    const frozenHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const tree = await git(repoPath, "rev-parse", "feature/2.2.1^{tree}");
    const advancedHead = await git(repoPath, "commit-tree", tree, "-p", frozenHead, "-m", "advance version");
    await git(repoPath, "update-ref", "refs/heads/feature/2.2.1", advancedHead, frozenHead);

    const created = await createOrReuseRequirementWorktree(
      repoPath,
      "feature/2.2.1",
      "REQ-0099",
      frozenHead
    );

    expect(created.baseCommit).toBe(frozenHead);
    expect(await git(created.worktreePath, "rev-parse", "HEAD")).toBe(frozenHead);
    expect(await git(repoPath, "rev-parse", "feature/2.2.1")).toBe(advancedHead);
  });

  it("creates independent deterministic worktrees from a version branch current HEAD", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const versionHead = await git(repoPath, "rev-parse", "feature/2.2.1");
    const first = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0001");
    expect(first).toEqual({
      branch: "ai/REQ-0001",
      worktreePath: resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-0001"),
      baseCommit: versionHead,
      reused: false
    });

    const versionTree = await git(repoPath, "rev-parse", "feature/2.2.1^{tree}");
    const advancedHead = await git(repoPath, "commit-tree", versionTree, "-p", versionHead, "-m", "advance version");
    await git(repoPath, "update-ref", "refs/heads/feature/2.2.1", advancedHead, versionHead);
    const second = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0002");
    expect(second.branch).toBe("ai/REQ-0002");
    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(second.baseCommit).toBe(await git(repoPath, "rev-parse", "feature/2.2.1"));
    expect(await git(first.worktreePath, "rev-parse", "HEAD")).toBe(versionHead);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("reuses the same managed worktree and preserves uncommitted changes", async () => {
    const { repoPath } = await setupVersionRepository();
    const first = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0001");
    await writeFile(join(first.worktreePath, "committed.txt"), "requirement commit\n");
    await git(first.worktreePath, "add", "--all");await git(first.worktreePath, "commit", "-m", "requirement progress");
    await git(repoPath, "branch", "feature/3.0.0", "prod");
    await writeFile(join(first.worktreePath, "unfinished.txt"), "keep me\n");
    const second = await createOrReuseRequirementWorktree(repoPath, "feature/3.0.0", "REQ-0001");
    expect(second).toEqual({ ...first, reused: true });
    expect(await git(first.worktreePath, "status", "--porcelain")).toContain("?? unfinished.txt");
    const metadataOutput=await git(first.worktreePath,"rev-parse","--git-path","ai-workflow-base-commit");const metadataPath=isAbsolute(metadataOutput)?metadataOutput:resolve(first.worktreePath,metadataOutput);
    expect((await readFile(metadataPath,"utf8")).trim()).toBe(first.baseCommit);
  });

  it("recovers immutable base metadata for a legacy requirement worktree from its earliest reflog entry",async()=>{
    const {repoPath}=await setupVersionRepository();const first=await createOrReuseRequirementWorktree(repoPath,"feature/2.2.1","REQ-0010");
    const metadataOutput=await git(first.worktreePath,"rev-parse","--git-path","ai-workflow-base-commit");const metadataPath=isAbsolute(metadataOutput)?metadataOutput:resolve(first.worktreePath,metadataOutput);await rm(metadataPath,{force:true});
    await writeFile(join(first.worktreePath,"progress.txt"),"progress\n");await git(first.worktreePath,"add","--all");await git(first.worktreePath,"commit","-m","progress");

    const reused=await createOrReuseRequirementWorktree(repoPath,"feature/2.2.1","REQ-0010");

    expect(reused).toEqual({...first,reused:true});expect((await readFile(metadataPath,"utf8")).trim()).toBe(first.baseCommit);
  });

  it("attaches an existing unmounted requirement branch at the deterministic path", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    await git(repoPath, "branch", "ai/REQ-0004", "feature/2.2.1");
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0004");
    expect(created).toMatchObject({ branch: "ai/REQ-0004", reused: false, baseCommit: await git(repoPath, "rev-parse", "feature/2.2.1") });
    expect(await git(created.worktreePath, "branch", "--show-current")).toBe("ai/REQ-0004");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects unsafe requirement codes and a matching branch mounted outside the managed root", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "../escape"))
      .rejects.toThrow("REQUIREMENT_CODE_INVALID");
    await git(repoPath, "branch", "ai/REQ-0003", "feature/2.2.1");
    await git(repoPath, "worktree", "add", join(root, "user-worktree"), "ai/REQ-0003");
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0003"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_OUTSIDE_MANAGED_ROOT");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects a symlinked managed requirements root that escapes its canonical location", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const managedRoot = resolve(repoPath, "..", ".ai-workflow-worktrees");
    const outside = join(root, "outside-requirements");
    await mkdir(outside);
    await symlink(outside, managedRoot);
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0005"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_PATH_ESCAPE");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a foreign repository replacing a stale registered requirement worktree", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0006");
    await replaceWithForeignRepository(created.worktreePath, "ai/REQ-0006");

    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0006"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_IDENTITY_MISMATCH");
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("anchors managed requirement paths beside the canonical repo when invoked through a symlink", async () => {
    const { root, repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const aliasParent = join(root, "aliases");
    const aliasPath = join(aliasParent, "alias");
    await mkdir(aliasParent);
    await symlink(repoPath, aliasPath);

    const created = await createOrReuseRequirementWorktree(aliasPath, "feature/2.2.1", "REQ-0007");
    expect(created.worktreePath).toBe(resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-0007"
    ));
    expect((await readdir(aliasParent)).sort()).toEqual(["alias"]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("serializes concurrent create-or-reuse calls for the same requirement", async () => {
    const { repoPath } = await setupVersionRepository();
    const before = await mainState(repoPath);
    const results = await Promise.all([
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0008"),
      createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-0008")
    ]);
    expect(results.map((item) => item.reused).sort()).toEqual([false, true]);
    expect(new Set(results.map((item) => item.worktreePath)).size).toBe(1);
    expect(await registeredPaths(repoPath, "ai/REQ-0008")).toHaveLength(1);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("rejects a requirement branch mounted at a non-deterministic managed path", async () => {
    const { repoPath } = await setupVersionRepository();
    const root = resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements");
    const wrongPath = resolve(root, "not-the-deterministic-code");
    await mkdir(root, { recursive: true });
    await git(repoPath, "branch", "ai/REQ-9000", "feature/2.2.1");
    await git(repoPath, "worktree", "add", wrongPath, "ai/REQ-9000");
    await expect(createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-9000"))
      .rejects.toThrow("REQUIREMENT_WORKTREE_PATH_MISMATCH");
  });

  it("neutralizes a required failing smudge filter during coding worktree checkout", async () => {
    const { repoPath } = await setupVersionRepository();
    await configureFailingSmudge(repoPath);
    const before = await mainState(repoPath);
    const target = resolve(await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9001");
    const created = await createOrReuseRequirementWorktree(repoPath, "feature/2.2.1", "REQ-9001");

    expect(created.worktreePath).toBe(target);
    expect(await localBranchExistsForTest(repoPath, "ai/REQ-9001")).toBe(true);
    expect(await pathExists(target)).toBe(true);
    expect(await registeredPaths(repoPath, "ai/REQ-9001")).toEqual([target]);
    expect(await mainState(repoPath)).toEqual(before);
  });

  it("classifies only exit code 1 without a signal as a missing Git ref", () => {
    expect(classifyGitFailure({ code: 1, signal: null })).toBe("not_found");
    expect(classifyGitFailure({ code: 128, signal: null })).toBe("command_failed");
    expect(classifyGitFailure({ code: "ENOENT", signal: null })).toBe("unavailable");
    expect(classifyGitFailure({ code: 1, signal: "SIGTERM" })).toBe("unavailable");
  });

  it("does not clean an external winner when worktree add was attempted without target ownership", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "ai/REQ-9011";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9011"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    await git(repoPath, "branch", branch, "feature/2.2.1");
    await git(repoPath, "worktree", "add", target, branch);
    const head = await git(repoPath, "rev-parse", branch);

    await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch,
      targetReserved: false, worktreeAddAttempted: true, worktreeAdded: false
    });

    expect(await git(repoPath, "rev-parse", branch)).toBe(head);
    expect(await git(target, "branch", "--show-current")).toBe(branch);
    expect(await registeredPaths(repoPath, branch)).toEqual([target]);
  });

  it("does not clean an unregistered foreign repository at a reserved target", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "ai/REQ-9012";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "requirements", "REQ-9012"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    await exec("git", ["init", "-b", branch, target]);
    await git(target, "config", "user.email", "foreign@example.com"); await git(target, "config", "user.name", "Foreign");
    await writeFile(join(target, "FOREIGN.md"), "foreign\n"); await git(target, "add", "--all"); await git(target, "commit", "-m", "foreign");

    await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: false
    });

    expect(await git(target, "branch", "--show-current")).toBe(branch);
    expect(await git(target, "show", "HEAD:FOREIGN.md")).toBe("foreign");
  });

  it("refuses to remove a dirty owned worktree when clean rollback is required", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "feature/dirty-cleanup";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "dirty-cleanup"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    const ownedHead = await git(repoPath, "rev-parse", "prod");
    await git(repoPath, "branch", branch, ownedHead);
    await git(repoPath, "worktree", "add", target, branch);
    await writeFile(join(target, "recovery.txt"), "keep this work\n");

    const removed = await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch, ownedHead,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: true, requireClean: true
    });

    expect(removed).toBe(false);
    expect(await pathExists(target)).toBe(true);
    expect(await git(target, "status", "--porcelain")).toContain("?? recovery.txt");
    expect(await localBranchExistsForTest(repoPath, branch)).toBe(true);
    expect(await registeredPaths(repoPath, branch)).toEqual([target]);
  });

  it("preserves both refs when a clean rollback target belongs to another branch", async () => {
    const { repoPath } = await setupVersionRepository();
    const branch = "feature/expected-owner";
    const winner = "feature/external-winner";
    const target = resolve(
      await realpath(repoPath), "..", ".ai-workflow-worktrees", basename(repoPath), "versions", "external-winner"
    );
    await mkdir(resolve(target, ".."), { recursive: true });
    const ownedHead = await git(repoPath, "rev-parse", "prod");
    await git(repoPath, "branch", branch, ownedHead);
    await git(repoPath, "branch", winner, ownedHead);
    await git(repoPath, "worktree", "add", target, winner);

    const removed = await cleanupFailedManagedWorktreeCreation({
      repoPath: await realpath(repoPath), worktreePath: target, branch, ownedHead,
      targetReserved: true, worktreeAddAttempted: true, worktreeAdded: true, requireClean: true
    });

    expect(removed).toBe(false);
    expect(await localBranchExistsForTest(repoPath, branch)).toBe(true);
    expect(await localBranchExistsForTest(repoPath, winner)).toBe(true);
    expect(await git(target, "branch", "--show-current")).toBe(winner);
  });
});
