import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { simulateDeliveryMerge, type DeliveryMergeSimulationInput } from "./delivery-application-merge.js";

const exec = promisify(execFile);
const roots: string[] = [];
const INVALID_UTF8_LINK_TARGET = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type MergeKind = "clean" | "text" | "add-delete" | "binary" | "mode" | "symlink";

interface WorktreeEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  bytes?: Buffer;
  target?: Buffer;
}

interface TargetSnapshot {
  head: string;
  branch: string;
  status: Buffer;
  index: Buffer;
  entries: WorktreeEntry[];
  localRefs: Buffer;
  remoteRefs: Buffer;
}

interface MergeFixture {
  root: string;
  repoPath: string;
  targetWorktreePath: string;
  remotePath: string;
  baseCommit: string;
  targetCommit: string;
  sourceCommit: string;
  targetTagObject: string;
  sourceTagObject: string;
  targetReplacementObject: string;
  sourceReplacementObject: string;
  simulationInput: DeliveryMergeSimulationInput;
  before: TargetSnapshot;
}

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
}

async function commit(cwd: string, message: string) {
  await git(cwd, "add", "--all");
  await git(cwd, "commit", "-m", message);
  return (await git(cwd, "rev-parse", "HEAD")).stdout.toString("utf8").trim();
}

async function createBase(repoPath: string, kind: MergeKind) {
  await writeFile(join(repoPath, "value.txt"), Buffer.from("base value\n"));
  await symlink(INVALID_UTF8_LINK_TARGET, join(repoPath, "raw-link"));
  if (kind === "binary") await writeFile(join(repoPath, "asset.bin"), Buffer.from([0, 1, 2, 0, 255]));
  if (kind === "mode") await writeFile(join(repoPath, "script.sh"), Buffer.from("#!/bin/sh\nprintf 'base\\n'\n"), { mode: 0o644 });
  if (kind === "symlink") await symlink("base-destination", join(repoPath, "link"));
}

async function changeSource(repoPath: string, kind: MergeKind) {
  if (kind === "clean") await writeFile(join(repoPath, "source.txt"), Buffer.from("source bytes\n"));
  if (kind === "text") await writeFile(join(repoPath, "value.txt"), Buffer.from("source value\n"));
  if (kind === "add-delete") await writeFile(join(repoPath, "value.txt"), Buffer.from("source edit\n"));
  if (kind === "binary") await writeFile(join(repoPath, "asset.bin"), Buffer.from([0, 9, 8, 0, 7]));
  if (kind === "mode") await writeFile(join(repoPath, "script.sh"), Buffer.from("#!/bin/sh\nprintf 'source\\n'\n"), { mode: 0o644 });
  if (kind === "symlink") {
    await rm(join(repoPath, "link"));
    await symlink("source-destination", join(repoPath, "link"));
  }
}

async function changeTarget(targetWorktreePath: string, kind: MergeKind) {
  if (kind === "clean") await writeFile(join(targetWorktreePath, "target.txt"), Buffer.from("target bytes\n"));
  if (kind === "text") await writeFile(join(targetWorktreePath, "value.txt"), Buffer.from("target value\n"));
  if (kind === "add-delete") await rm(join(targetWorktreePath, "value.txt"));
  if (kind === "binary") await writeFile(join(targetWorktreePath, "asset.bin"), Buffer.from([0, 6, 5, 0, 4]));
  if (kind === "mode") await chmod(join(targetWorktreePath, "script.sh"), 0o755);
  if (kind === "symlink") {
    await rm(join(targetWorktreePath, "link"));
    await symlink("target-destination", join(targetWorktreePath, "link"));
  }
}

async function captureEntries(root: string): Promise<WorktreeEntry[]> {
  const entries: WorktreeEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === ".git") continue;
      const path = join(directory, name);
      const stat = await lstat(path);
      const entryPath = relative(root, path).split(sep).join("/");
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        entries.push({
          path: entryPath,
          type: "symlink",
          mode,
          target: await readlink(path, { encoding: "buffer" })
        });
      } else if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: "directory", mode });
        await visit(path);
      } else {
        entries.push({ path: entryPath, type: "file", mode, bytes: await readFile(path) });
      }
    }
  };
  await visit(root);
  return entries;
}

async function targetSnapshot(fixture: Pick<MergeFixture, "targetWorktreePath" | "remotePath">): Promise<TargetSnapshot> {
  const indexPathOutput = (await git(fixture.targetWorktreePath, "rev-parse", "--git-path", "index"))
    .stdout.toString("utf8").trim();
  const indexPath = resolve(fixture.targetWorktreePath, indexPathOutput);
  return {
    head: (await git(fixture.targetWorktreePath, "rev-parse", "HEAD")).stdout.toString("utf8").trim(),
    branch: (await git(fixture.targetWorktreePath, "symbolic-ref", "HEAD")).stdout.toString("utf8").trim(),
    status: (await git(fixture.targetWorktreePath, "status", "--porcelain=v2", "-z", "--untracked-files=all")).stdout,
    index: await readFile(indexPath),
    entries: await captureEntries(fixture.targetWorktreePath),
    localRefs: (await git(fixture.targetWorktreePath, "for-each-ref", "--format=%(refname)%00%(objectname)%00")).stdout,
    remoteRefs: (await exec("git", ["--git-dir", fixture.remotePath, "for-each-ref", "--format=%(refname)%00%(objectname)%00"], {
      encoding: "buffer", maxBuffer: 4 * 1024 * 1024
    })).stdout
  };
}

async function expectTargetState(fixture: MergeFixture, before = fixture.before) {
  expect(await targetSnapshot(fixture)).toEqual(before);
}

async function createMergeFixture(kind: MergeKind): Promise<MergeFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `delivery-merge-${kind}-`)));
  roots.push(root);
  const repoPath = join(root, "repo");
  const targetWorktreePath = join(root, "target-worktree");
  const remotePath = join(root, "remote.git");
  await exec("git", ["init", "-b", "main", repoPath]);
  await git(repoPath, "config", "user.email", "delivery-merge@example.com");
  await git(repoPath, "config", "user.name", "Delivery Merge Test");
  await createBase(repoPath, kind);
  const baseCommit = await commit(repoPath, "base");
  await git(repoPath, "branch", "target", baseCommit);
  await git(repoPath, "branch", "source", baseCommit);
  await git(repoPath, "worktree", "add", targetWorktreePath, "target");

  await changeTarget(targetWorktreePath, kind);
  const targetCommit = await commit(targetWorktreePath, "target");
  await git(repoPath, "switch", "source");
  await changeSource(repoPath, kind);
  const sourceCommit = await commit(repoPath, "source");
  await git(repoPath, "tag", "-a", "target-object", "-m", "target object", targetCommit);
  await git(repoPath, "tag", "-a", "source-object", "-m", "source object", sourceCommit);
  const targetTagObject = (await git(repoPath, "rev-parse", "target-object^{tag}"))
    .stdout.toString("utf8").trim();
  const sourceTagObject = (await git(repoPath, "rev-parse", "source-object^{tag}"))
    .stdout.toString("utf8").trim();
  const targetReplacementFile = join(root, "target-replacement-object");
  const sourceReplacementFile = join(root, "source-replacement-object");
  await writeFile(targetReplacementFile, "target replacement object\n");
  await writeFile(sourceReplacementFile, "source replacement object\n");
  const targetReplacementObject = (await git(repoPath, "hash-object", "-w", targetReplacementFile))
    .stdout.toString("utf8").trim();
  const sourceReplacementObject = (await git(repoPath, "hash-object", "-w", sourceReplacementFile))
    .stdout.toString("utf8").trim();
  await git(repoPath, "update-ref", `refs/replace/${targetReplacementObject}`, targetCommit);
  await git(repoPath, "update-ref", `refs/replace/${sourceReplacementObject}`, sourceCommit);

  await exec("git", ["init", "--bare", remotePath]);
  await git(repoPath, "remote", "add", "origin", remotePath);
  await git(repoPath, "tag", "snapshot-tag", baseCommit);
  await git(repoPath, "push", "origin", "--all");
  await git(repoPath, "push", "origin", "--tags");

  const fixture = {
    root,
    repoPath,
    targetWorktreePath,
    remotePath,
    baseCommit,
    targetCommit,
    sourceCommit,
    targetTagObject,
    sourceTagObject,
    targetReplacementObject,
    sourceReplacementObject,
    simulationInput: {
      repoPath,
      sourceCommit,
      preApplyHead: targetCommit,
      deadlineAt: Date.now() + 5_000
    }
  } as MergeFixture;
  fixture.before = await targetSnapshot(fixture);
  return fixture;
}

async function exists(path: string) {
  return readFile(path).then(() => true, () => false);
}

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await exists(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`marker not created: ${path}`);
}

async function installBlockingReadTreeWrapper(fixture: MergeFixture) {
  const wrapperDirectory = join(fixture.root, "blocking-git");
  const wrapperPath = join(wrapperDirectory, "git");
  const started = join(fixture.root, "read-tree-started");
  const terminated = join(fixture.root, "read-tree-terminated");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await mkdir(wrapperDirectory);
  await writeFile(wrapperPath, [
    "#!/bin/sh",
    "is_read_tree=",
    "for argument in \"$@\"; do",
    "  if [ \"$argument\" = \"read-tree\" ]; then is_read_tree=1; fi",
    "done",
    "if [ \"$is_read_tree\" = \"1\" ]; then",
    `  : > ${JSON.stringify(started)}`,
    `  trap ': > ${JSON.stringify(terminated)}; exit 143' TERM INT`,
    "  while :; do /bin/sleep 0.05; done",
    "fi",
    `exec ${JSON.stringify(realGit)} \"$@\"`
  ].join("\n"));
  await chmod(wrapperPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
  return {
    started,
    terminated: () => exists(terminated),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}

function oversizedValidConflictRecords() {
  const paths = [
    ...Array.from({ length: 1_024 }, (_, index) => `file-${String(index).padStart(6, "0")}`),
    ...Array.from({ length: 6_000 }, (_, index) =>
      `zz-padding-${String(index).padStart(6, "0")}-${"x".repeat(900)}`
    )
  ];
  return paths.map((path) => {
    return [1, 2].map((stage) =>
      `100644 ${String(stage).repeat(40)} ${stage}\t${path}\0`
    ).join("");
  }).join("");
}

function excessiveCountConflictRecords() {
  return Array.from({ length: 131_073 }, (_, index) => {
    const path = `file-${String(index).padStart(6, "0")}`;
    return [1, 2].map((stage) =>
      `100644 ${String(stage).repeat(40)} ${stage}\t${path}\0`
    ).join("");
  }).join("");
}

async function installConflictScanOutputWrapper(
  fixture: MergeFixture,
  name: string,
  output: { stdoutPath?: string; stderrPath?: string }
) {
  const wrapperDirectory = join(fixture.root, `${name}-git`);
  const wrapperPath = join(wrapperDirectory, "git");
  const writeTreeStarted = join(fixture.root, `${name}-write-tree-started`);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await mkdir(wrapperDirectory);
  await writeFile(wrapperPath, [
    "#!/bin/sh",
    "is_unmerged=",
    "is_write_tree=",
    "for argument in \"$@\"; do",
    "  if [ \"$argument\" = \"-u\" ]; then is_unmerged=1; fi",
    "  if [ \"$argument\" = \"write-tree\" ]; then is_write_tree=1; fi",
    "done",
    "if [ \"$is_unmerged\" = \"1\" ]; then",
    ...(output.stderrPath ? [`  /bin/cat ${JSON.stringify(output.stderrPath)} >&2`] : []),
    ...(output.stdoutPath ? [`  exec /bin/cat ${JSON.stringify(output.stdoutPath)}`] : ["  exit 0"]),
    "fi",
    "if [ \"$is_write_tree\" = \"1\" ]; then",
    `  : > ${JSON.stringify(writeTreeStarted)}`,
    "fi",
    `exec ${JSON.stringify(realGit)} \"$@\"`
  ].join("\n"));
  await chmod(wrapperPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
  return {
    writeTreeStarted: () => exists(writeTreeStarted),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}

describe("simulateDeliveryMerge", () => {
  it("returns a merged tree for a clean three-way application", async () => {
    const fixture = await createMergeFixture("clean");

    const result = await simulateDeliveryMerge(fixture.simulationInput);

    expect(result).toEqual({
      status: "clean",
      mergedTree: expect.stringMatching(/^[0-9a-f]{40}$/),
      conflictFiles: []
    });
    if (result.status !== "clean") throw new Error("expected a clean simulation");
    const names = (await git(fixture.repoPath, "ls-tree", "-r", "--name-only", "-z", result.mergedTree))
      .stdout.toString("utf8").split("\0").filter(Boolean).sort();
    expect(names).toEqual(["raw-link", "source.txt", "target.txt", "value.txt"]);
    await expectTargetState(fixture);
  });

  it("captures invalid UTF-8 symlink targets as raw bytes before and after simulation", async () => {
    const fixture = await createMergeFixture("clean");
    const beforeLink = fixture.before.entries.find((entry) => entry.path === "raw-link");
    expect(Buffer.isBuffer(beforeLink?.target)).toBe(true);
    expect(beforeLink?.target).toEqual(INVALID_UTF8_LINK_TARGET);

    await simulateDeliveryMerge(fixture.simulationInput);

    await expectTargetState(fixture);
    const after = await targetSnapshot(fixture);
    expect(after.entries.find((entry) => entry.path === "raw-link")?.target)
      .toEqual(INVALID_UTF8_LINK_TARGET);
  });

  it.each([
    ["text", "value.txt"],
    ["add-delete", "value.txt"],
    ["binary", "asset.bin"],
    ["mode", "script.sh"],
    ["symlink", "link"]
  ] as const)("detects a %s conflict without touching the target", async (kind, conflictFile) => {
    const fixture = await createMergeFixture(kind);

    const result = await simulateDeliveryMerge(fixture.simulationInput);

    expect(result).toEqual({ status: "conflict", mergedTree: null, conflictFiles: [conflictFile] });
    await expectTargetState(fixture);
  });

  it("terminates a running read-tree when the application is aborted", async () => {
    const fixture = await createMergeFixture("clean");
    const wrapper = await installBlockingReadTreeWrapper(fixture);
    const controller = new AbortController();
    try {
      const pending = simulateDeliveryMerge({
        ...fixture.simulationInput,
        signal: controller.signal,
        deadlineAt: Date.now() + 5_000
      });
      await waitFor(wrapper.started);
      controller.abort(new Error("LEASE_LOST"));

      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");
      expect(await wrapper.terminated()).toBe(true);
    } finally {
      wrapper.restore();
    }
    await expectTargetState(fixture);
  });

  it("terminates a running read-tree when its deadline expires", async () => {
    const fixture = await createMergeFixture("clean");
    const wrapper = await installBlockingReadTreeWrapper(fixture);
    try {
      const pending = simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() + 1_000
      });
      await waitFor(wrapper.started);

      await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_DEADLINE_EXCEEDED");
      expect(await wrapper.terminated()).toBe(true);
    } finally {
      wrapper.restore();
    }
    await expectTargetState(fixture);
  });

  it("rejects an expired deadline before starting Git", async () => {
    const fixture = await createMergeFixture("clean");
    const wrapperDirectory = join(fixture.root, "reject-all-git");
    const marker = join(fixture.root, "git-started");
    const wrapperPath = join(wrapperDirectory, "git");
    await mkdir(wrapperDirectory);
    await writeFile(wrapperPath, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 97\n`);
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() - 1
      })).rejects.toThrow("DELIVERY_APPLICATION_DEADLINE_EXCEEDED");
      expect(await exists(marker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expectTargetState(fixture);
  });

  it.each([
    (fixture: MergeFixture) => ({ ...fixture.simulationInput, repoPath: "relative/repo" }),
    (fixture: MergeFixture) => ({ ...fixture.simulationInput, repoPath: `${fixture.repoPath}/../repo` }),
    (fixture: MergeFixture) => ({ ...fixture.simulationInput, sourceCommit: fixture.sourceCommit.toUpperCase() }),
    (fixture: MergeFixture) => ({ ...fixture.simulationInput, sourceCommit: "a".repeat(39) }),
    (fixture: MergeFixture) => ({ ...fixture.simulationInput, preApplyHead: "b".repeat(41) })
  ])("rejects invalid path and commit inputs", async (invalidInput) => {
    const fixture = await createMergeFixture("clean");

    await expect(simulateDeliveryMerge(invalidInput(fixture)))
      .rejects.toThrow("DELIVERY_APPLICATION_MERGE_INPUT_INVALID");
    await expectTargetState(fixture);
  });

  it("rejects a source commit without a parent", async () => {
    const fixture = await createMergeFixture("clean");

    await expect(simulateDeliveryMerge({
      ...fixture.simulationInput,
      sourceCommit: fixture.baseCommit
    })).rejects.toThrow("DELIVERY_APPLICATION_SOURCE_PARENT_INVALID");
    await expectTargetState(fixture);
  });

  it.each([
    ["sourceCommit", "sourceTagObject"],
    ["preApplyHead", "targetTagObject"]
  ] as const)("rejects an annotated tag object passed as %s", async (inputField, fixtureField) => {
    const fixture = await createMergeFixture("clean");

    await expect(simulateDeliveryMerge({
      ...fixture.simulationInput,
      [inputField]: fixture[fixtureField]
    })).rejects.toThrow("DELIVERY_APPLICATION_MERGE_COMMIT_INVALID");
    await expectTargetState(fixture);
  });

  it.each([
    ["sourceCommit", "sourceReplacementObject"],
    ["preApplyHead", "targetReplacementObject"]
  ] as const)("ignores replace refs for a non-commit %s", async (inputField, fixtureField) => {
    const fixture = await createMergeFixture("clean");

    await expect(simulateDeliveryMerge({
      ...fixture.simulationInput,
      [inputField]: fixture[fixtureField]
    })).rejects.toThrow("DELIVERY_APPLICATION_MERGE_COMMIT_INVALID");
    await expectTargetState(fixture);
  });

  it("rejects duplicate conflict stages as malformed evidence", async () => {
    const fixture = await createMergeFixture("text");
    const wrapperDirectory = join(fixture.root, "malformed-conflict-git");
    const wrapperPath = join(wrapperDirectory, "git");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      "is_unmerged=",
      "for argument in \"$@\"; do if [ \"$argument\" = \"-u\" ]; then is_unmerged=1; fi; done",
      "if [ \"$is_unmerged\" = \"1\" ]; then",
      "  printf '100644 1111111111111111111111111111111111111111 1\\tvalue.txt\\0'",
      "  printf '100644 2222222222222222222222222222222222222222 1\\tvalue.txt\\0'",
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(simulateDeliveryMerge(fixture.simulationInput))
        .rejects.toThrow("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expectTargetState(fixture);
  });

  it("returns conflict without write-tree when bounded evidence omits an oversized path", async () => {
    const fixture = await createMergeFixture("text");
    const wrapperDirectory = join(fixture.root, "oversized-conflict-git");
    const wrapperPath = join(wrapperDirectory, "git");
    const writeTreeStarted = join(fixture.root, "write-tree-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      "is_unmerged=",
      "is_write_tree=",
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = \"-u\" ]; then is_unmerged=1; fi",
      "  if [ \"$argument\" = \"write-tree\" ]; then is_write_tree=1; fi",
      "done",
      "if [ \"$is_unmerged\" = \"1\" ]; then",
      "  printf '100644 1111111111111111111111111111111111111111 1\\tlong-'",
      "  /usr/bin/head -c 262140 /dev/zero | /usr/bin/tr '\\000' a",
      "  printf '\\0'",
      "  printf '100644 2222222222222222222222222222222222222222 2\\tlong-'",
      "  /usr/bin/head -c 262140 /dev/zero | /usr/bin/tr '\\000' a",
      "  printf '\\0'",
      "  exit 0",
      "fi",
      "if [ \"$is_write_tree\" = \"1\" ]; then",
      `  : > ${JSON.stringify(writeTreeStarted)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(simulateDeliveryMerge(fixture.simulationInput)).resolves.toEqual({
        status: "conflict",
        mergedTree: null,
        conflictFiles: []
      });
      expect(await exists(writeTreeStarted)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expectTargetState(fixture);
  });

  it("bounds conflict evidence larger than the Git capture limit without write-tree", async () => {
    const fixture = await createMergeFixture("text");
    const wrapperDirectory = join(fixture.root, "capture-limit-conflict-git");
    const wrapperPath = join(wrapperDirectory, "git");
    const evidencePath = join(fixture.root, "oversized-conflicts");
    const writeTreeStarted = join(fixture.root, "capture-limit-write-tree-started");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const records = oversizedValidConflictRecords();
    expect(Buffer.byteLength(records)).toBeGreaterThan(10 * 1024 * 1024);
    await writeFile(evidencePath, records);
    await mkdir(wrapperDirectory);
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      "is_unmerged=",
      "is_write_tree=",
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = \"-u\" ]; then is_unmerged=1; fi",
      "  if [ \"$argument\" = \"write-tree\" ]; then is_write_tree=1; fi",
      "done",
      "if [ \"$is_unmerged\" = \"1\" ]; then",
      `  exec /bin/cat ${JSON.stringify(evidencePath)}`,
      "fi",
      "if [ \"$is_write_tree\" = \"1\" ]; then",
      `  : > ${JSON.stringify(writeTreeStarted)}`,
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      const result = await simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() + 10_000
      });
      expect(result.status).toBe("conflict");
      expect(result.conflictFiles).toHaveLength(1_024);
      expect(Buffer.byteLength(JSON.stringify(result.conflictFiles))).toBeLessThanOrEqual(262_144);
      expect(await exists(writeTreeStarted)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expectTargetState(fixture);
  });

  it("preserves a bounded conflict result when valid records exceed the former record limit", async () => {
    const fixture = await createMergeFixture("text");
    const evidencePath = join(fixture.root, "excessive-count-conflicts");
    await writeFile(evidencePath, excessiveCountConflictRecords());
    const wrapper = await installConflictScanOutputWrapper(fixture, "excessive-count-conflicts", {
      stdoutPath: evidencePath
    });
    try {
      const result = await simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() + 10_000
      });
      expect(result).toEqual({
        status: "conflict",
        mergedTree: null,
        conflictFiles: Array.from({ length: 1_024 }, (_, index) =>
          `file-${String(index).padStart(6, "0")}`
        )
      });
      expect(Buffer.byteLength(JSON.stringify(result.conflictFiles))).toBeLessThanOrEqual(262_144);
      expect(await wrapper.writeTreeStarted()).toBe(false);
    } finally {
      wrapper.restore();
    }
    await expectTargetState(fixture);
  });

  it.each([
    ["traversal path", `100644 ${"3".repeat(40)} 1\t../escape\0`],
    ["duplicate stage", `100644 ${"9".repeat(40)} 1\tfile-000000\0`]
  ])("rejects a %s after the conflict capture cutoff", async (name, invalidRecord) => {
    const fixture = await createMergeFixture("text");
    const evidencePath = join(fixture.root, `post-cutoff-${name.replace(" ", "-")}`);
    await writeFile(evidencePath, `${oversizedValidConflictRecords()}${invalidRecord}`);
    const wrapper = await installConflictScanOutputWrapper(fixture, `post-cutoff-${name.replace(" ", "-")}`, {
      stdoutPath: evidencePath
    });
    try {
      await expect(simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() + 10_000
      })).rejects.toThrow("DELIVERY_APPLICATION_CONFLICT_EVIDENCE_INVALID");
      expect(await wrapper.writeTreeStarted()).toBe(false);
    } finally {
      wrapper.restore();
    }
    await expectTargetState(fixture);
  });

  it("fails closed when a clean conflict scan exceeds the stderr bound", async () => {
    const fixture = await createMergeFixture("clean");
    const stderrPath = join(fixture.root, "oversized-conflict-stderr");
    await writeFile(stderrPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x65));
    const wrapper = await installConflictScanOutputWrapper(fixture, "oversized-conflict-stderr", {
      stderrPath
    });
    try {
      await expect(simulateDeliveryMerge({
        ...fixture.simulationInput,
        deadlineAt: Date.now() + 10_000
      })).rejects.toThrow("DELIVERY_APPLICATION_MERGE_GIT_FAILED");
      expect(await wrapper.writeTreeStarted()).toBe(false);
    } finally {
      wrapper.restore();
    }
    await expectTargetState(fixture);
  });

  it("fails closed when a clean merged tree changes a path outside the source change", async () => {
    const fixture = await createMergeFixture("clean");
    const wrapperDirectory = join(fixture.root, "path-set-git");
    const wrapperPath = join(wrapperDirectory, "git");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(wrapperDirectory);
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      "is_diff_tree=",
      "is_target_diff=",
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = \"diff-tree\" ]; then is_diff_tree=1; fi",
      `  if [ \"$argument\" = ${JSON.stringify(fixture.targetCommit)} ]; then is_target_diff=1; fi`,
      "done",
      "if [ \"$is_diff_tree\" = \"1\" ] && [ \"$is_target_diff\" = \"1\" ]; then",
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?",
      "  printf 'outside.txt\\0'",
      "  exit $status",
      "fi",
      `exec ${JSON.stringify(realGit)} \"$@\"`
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(simulateDeliveryMerge(fixture.simulationInput))
        .rejects.toThrow("DELIVERY_APPLICATION_MERGED_PATH_SET_INVALID");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expectTargetState(fixture);
  });
});
