import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile
} from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { executeLocalIntegration, preflightLocalIntegration } from "./integration.js";
import { getWorktreeSnapshot } from "./repository.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await readFile(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`TIMED_OUT_WAITING_FOR_FILE:${path}`);
}

function expectProcessExited(pid: number) {
  let error: unknown;
  try {
    process.kill(pid, 0);
  } catch (caught) {
    error = caught;
  }
  expect(error).toEqual(expect.objectContaining({ code: "ESRCH" }));
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowgate-integration-"))); roots.push(root);
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

async function fixtureWithDeterministicConflict() {
  const item = await fixture();
  await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
  const sourceSnapshot = await getWorktreeSnapshot(item.sourceWorktree);
  await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
  await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
  await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target conflict"]);
  return { ...item, evidenceHash: sourceSnapshot.evidenceHash };
}

async function captureIntegrationTargetState(
  item: Awaited<ReturnType<typeof fixture>>
) {
  const captureFiles = async (directory: string, prefix = ""): Promise<Array<{
    path: string;
    mode: number;
    type: "file" | "directory" | "symlink";
    bytes?: Buffer;
    link?: Buffer;
  }>> => {
    const captured: Awaited<ReturnType<typeof captureFiles>> = [];
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        captured.push({
          path: relativePath,
          mode: stat.mode,
          type: "symlink",
          link: await readlink(path, { encoding: "buffer" })
        });
      } else if (stat.isDirectory()) {
        captured.push({ path: relativePath, mode: stat.mode, type: "directory" });
        captured.push(...await captureFiles(path, relativePath));
      } else {
        captured.push({
          path: relativePath,
          mode: stat.mode,
          type: "file",
          bytes: await readFile(path)
        });
      }
    }
    return captured;
  };
  const indexPath = (await exec("git", [
    "-C", item.targetWorktree, "rev-parse", "--git-path", "index"
  ])).stdout.trim();
  return {
    head: (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout,
    branch: (await exec("git", ["-C", item.targetWorktree, "branch", "--show-current"])).stdout,
    status: (await exec("git", [
      "-C", item.targetWorktree, "status", "--porcelain=v2", "-z", "--untracked-files=all"
    ])).stdout,
    index: await readFile(indexPath),
    files: await captureFiles(item.targetWorktree),
    refs: (await exec("git", [
      "-C", item.repo, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)",
      "refs/heads/release/1.0", "refs/remotes"
    ])).stdout
  };
}

async function integrationRefs(item: Awaited<ReturnType<typeof fixture>>) {
  return (await exec("git", [
    "-C", item.repo, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)",
    "refs/remotes", "refs/tags"
  ])).stdout;
}

async function rejectIfTargetMutationStarts(
  item: Awaited<ReturnType<typeof fixture>>,
  options: { mutation?: "reject" | "pass" | "pause_after" } = {}
) {
  const wrapperDirectory = join(item.root, "git-reject-target-mutation-wrapper");
  const wrapper = join(wrapperDirectory, "git");
  const targetMutations = join(item.root, "target-mutations");
  const targetMutationFinished = join(item.root, "target-mutation-finished");
  const pausedMutationPid = join(item.root, "paused-target-mutation-pid");
  const destructiveCommands = join(item.root, "target-destructive-commands");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const lines = async (path: string) => (await readFile(path, "utf8").catch(() => ""))
    .split("\n").filter(Boolean);
  await mkdir(wrapperDirectory);
  await writeFile(wrapper, [
    "#!/bin/sh",
    "is_target=",
    "command=",
    "previous=",
    "is_no_commit=",
    "is_abort_or_quit=",
    "for argument in \"$@\"; do",
    `  if [ \"$previous\" = \"-C\" ] && [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
    "  if [ -z \"$command\" ] && [ \"$previous\" != \"-C\" ] && [ \"$argument\" != \"-C\" ]; then command=$argument; fi",
    "  if [ \"$argument\" = \"--no-commit\" ]; then is_no_commit=1; fi",
    "  if [ \"$argument\" = \"--abort\" ] || [ \"$argument\" = \"--quit\" ]; then is_abort_or_quit=1; fi",
    "  previous=$argument",
    "done",
    "if [ \"$is_target\" = \"1\" ]; then",
    "  if [ \"$command\" = \"cherry-pick\" ] && [ \"$is_no_commit\" = \"1\" ]; then",
    `    printf '%s\\n' \"$*\" >> ${JSON.stringify(targetMutations)}`,
    ...(options.mutation === "pass" || options.mutation === "pause_after" ? [
      `    ${JSON.stringify(realGit)} \"$@\"`,
      "    status=$?",
      `    : > ${JSON.stringify(targetMutationFinished)}`,
      ...(options.mutation === "pause_after" ? [
        `    if [ \"$status\" = \"0\" ]; then printf '%s\\n' \"$$\" > ${JSON.stringify(pausedMutationPid)}; exec /bin/sleep 10; fi`
      ] : []),
      "    exit $status"
    ] : [
      "    printf 'injected ordinary target Git failure\\n' >&2",
      "    exit 97"
    ]),
    "  fi",
    "  if [ \"$command\" = \"restore\" ] || [ \"$command\" = \"reset\" ] || [ \"$command\" = \"rm\" ] || [ \"$command\" = \"checkout\" ] || [ \"$command\" = \"clean\" ] || { [ \"$command\" = \"cherry-pick\" ] && [ \"$is_abort_or_quit\" = \"1\" ]; }; then",
    `    printf '%s\\n' \"$*\" >> ${JSON.stringify(destructiveCommands)}`,
    "    exit 98",
    "  fi",
    "fi",
    `exec ${JSON.stringify(realGit)} \"$@\"`
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
  return {
    targetMutations: () => lines(targetMutations),
    targetMutationFinished: () => readFile(targetMutationFinished).then(() => true, () => false),
    waitForTargetMutation: () => waitForFile(targetMutationFinished),
    pausedMutationPid: async () => Number((await readFile(pausedMutationPid, "utf8")).trim()),
    destructiveCommands: () => lines(destructiveCommands),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}

async function fixtureWithTwoChangedFiles() {
  const item = await fixture();
  await writeFile(join(item.sourceWorktree, "second.txt"), "second\n");
  const snapshot = await getWorktreeSnapshot(item.sourceWorktree);
  return { ...item, evidenceHash: snapshot.evidenceHash };
}

async function fixtureWithLongChangedPaths() {
  const item = await fixture();
  const directory = [
    `batch-${"a".repeat(180)}`,
    `nested-${"b".repeat(180)}`,
    `literal-[*]-${"c".repeat(180)}`
  ].join("/");
  const files = Array.from({ length: 22 }, (_, index) =>
    `${directory}/entry-${String(index).padStart(2, "0")}-${"d".repeat(180)}.txt`
  );
  await mkdir(join(item.sourceWorktree, directory), { recursive: true });
  await Promise.all(files.map((file) => writeFile(join(item.sourceWorktree, file), `${file}\n`)));
  const snapshot = await getWorktreeSnapshot(item.sourceWorktree);
  return { ...item, evidenceHash: snapshot.evidenceHash, files };
}

async function fixtureWithDirectoryBoundary(withPadding: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowgate-integration-"))); roots.push(root);
  const repo = join(root, "repo"), targetWorktree = join(root, "version");
  const sourceWorktree = join(root, ".ai-workflow-worktrees", "repo", "requirements", "REQ-0001");
  const parent = "a";
  const child = `a/child-${"e".repeat(180)}/nested-${"f".repeat(180)}/value-${"g".repeat(180)}.txt`;
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Flowgate Test"]);
  await writeFile(join(repo, "value.txt"), "base\n");
  await writeFile(join(repo, parent), "old file\n");
  await exec("git", ["-C", repo, "add", "--all"]);
  await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "release/1.0", targetWorktree, "main"]);
  await mkdir(dirname(sourceWorktree), { recursive: true });
  await exec("git", ["-C", repo, "worktree", "add", "-b", "ai/REQ-0001", sourceWorktree, "main"]);
  await rm(join(sourceWorktree, parent));
  await mkdir(dirname(join(sourceWorktree, child)), { recursive: true });
  await writeFile(join(sourceWorktree, child), "new child\n");
  if (withPadding) {
    const paddingDirectory = [
      `0-batch-${"h".repeat(190)}`,
      `nested-${"i".repeat(190)}`,
      `literal-[*]-${"j".repeat(190)}`
    ].join("/");
    const paddingFiles = Array.from({ length: 20 }, (_, index) =>
      `${paddingDirectory}/entry-${String(index).padStart(2, "0")}-${"k".repeat(180)}.txt`
    );
    await mkdir(join(sourceWorktree, paddingDirectory), { recursive: true });
    await Promise.all(paddingFiles.map((file) => writeFile(join(sourceWorktree, file), `${file}\n`)));
  }
  const snapshot = await getWorktreeSnapshot(sourceWorktree);
  return { root, repo, targetWorktree, sourceWorktree, evidenceHash: snapshot.evidenceHash, parent, child };
}

async function installSourceTreeArgvBudgetWrapper(
  item: Awaited<ReturnType<typeof fixture>>,
  budgetBytes: number,
  boundaryPaths?: readonly [string, string]
) {
  const wrapperDirectory = join(item.root, "git-source-tree-argv-wrapper");
  const wrapper = join(wrapperDirectory, "git");
  const queries = join(item.root, "source-tree-query-bytes");
  const rejected = join(item.root, "source-tree-query-rejected");
  const boundaryParent = join(item.root, "source-tree-boundary-parent");
  const boundaryChild = join(item.root, "source-tree-boundary-child");
  const boundarySameQuery = join(item.root, "source-tree-boundary-same-query");
  const targetMutation = join(item.root, "source-tree-target-mutation");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const exists = (path: string) => readFile(path).then(() => true, () => false);

  await mkdir(wrapperDirectory);
  await writeFile(wrapper, [
    "#!/bin/sh",
    "is_source=",
    "is_target=",
    "is_ls_tree=",
    "is_cherry_pick=",
    "has_separator=",
    "has_literal_pathspecs=",
    "has_boundary_parent=",
    "has_boundary_child=",
    "for argument in \"$@\"; do",
    `  if [ "$argument" = ${JSON.stringify(item.sourceWorktree)} ]; then is_source=1; fi`,
    `  if [ "$argument" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
    "  if [ \"$argument\" = \"ls-tree\" ]; then is_ls_tree=1; fi",
    "  if [ \"$argument\" = \"cherry-pick\" ]; then is_cherry_pick=1; fi",
    "  if [ \"$argument\" = \"--\" ]; then has_separator=1; fi",
    "  if [ \"$argument\" = \"--literal-pathspecs\" ]; then has_literal_pathspecs=1; fi",
    ...(boundaryPaths ? [
      `  if [ "$argument" = ${JSON.stringify(boundaryPaths[0])} ]; then has_boundary_parent=1; fi`,
      `  if [ "$argument" = ${JSON.stringify(boundaryPaths[1])} ]; then has_boundary_child=1; fi`
    ] : []),
    "done",
    "if [ \"$is_target\" = \"1\" ] && [ \"$is_cherry_pick\" = \"1\" ]; then",
    `  : > ${JSON.stringify(targetMutation)}`,
    "fi",
    "if [ \"$is_source\" = \"1\" ] && [ \"$is_ls_tree\" = \"1\" ] && [ \"$has_separator\" = \"1\" ]; then",
    "  bytes=4",
    "  for argument in \"$@\"; do bytes=$((bytes + ${#argument} + 1)); done",
    `  if [ "$bytes" -gt ${budgetBytes} ]; then`,
    `    printf '%s\n' "$bytes" > ${JSON.stringify(rejected)}`,
    "    printf 'SOURCE_RECOVERED_PATH_QUERY_ARGV_TOO_LARGE:%s\n' \"$bytes\" >&2",
    "    exit 91",
    "  fi",
    "  if [ \"$has_literal_pathspecs\" != \"1\" ]; then",
    `    : > ${JSON.stringify(rejected)}`,
    "    printf 'SOURCE_RECOVERED_PATH_QUERY_NOT_LITERAL\n' >&2",
    "    exit 92",
    "  fi",
    `  if [ "$has_boundary_parent" = "1" ]; then : > ${JSON.stringify(boundaryParent)}; fi`,
    `  if [ "$has_boundary_child" = "1" ]; then : > ${JSON.stringify(boundaryChild)}; fi`,
    "  if [ \"$has_boundary_parent\" = \"1\" ] && [ \"$has_boundary_child\" = \"1\" ]; then",
    `    : > ${JSON.stringify(boundarySameQuery)}`,
    "  fi",
    `  printf '%s\n' "$bytes" >> ${JSON.stringify(queries)}`,
    "fi",
    `exec ${JSON.stringify(realGit)} "$@"`
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;

  return {
    queryBytes: async () => (await readFile(queries, "utf8")).trim().split("\n").map(Number),
    rejected: () => exists(rejected),
    boundaryPathsQueried: async () => await exists(boundaryParent) && await exists(boundaryChild),
    boundaryQueriesSplit: async () => await exists(boundaryParent) && await exists(boundaryChild)
      && !await exists(boundarySameQuery),
    targetMutationStarted: () => exists(targetMutation),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}

type SourceBoundaryCommand = "update-ref" | "update-index";

async function installSourceGitBoundaryWrapper(
  item: Awaited<ReturnType<typeof fixture>>,
  options: {
    command: SourceBoundaryCommand;
    loseOwnershipAfterFilterLookup?: boolean;
    loseOwnershipAfterCommand?: boolean;
    selectedCommandFailure?: string;
  }
) {
  const wrapperDirectory = join(item.root, `git-source-${options.command}-wrapper`);
  const wrapper = join(wrapperDirectory, "git");
  const snapshotCompletions = join(item.root, `source-${options.command}-snapshot-completions`);
  const sourcePreparationStarted = join(item.root, `source-${options.command}-preparation-started`);
  const forcedLoss = join(item.root, `source-${options.command}-forced-loss`);
  const filterLookupFinished = join(item.root, `source-${options.command}-filter-finished`);
  const commandStarted = join(item.root, `source-${options.command}-started`);
  const commandCompleted = join(item.root, `source-${options.command}-completed`);
  const realIndexMutations = join(item.root, `source-${options.command}-real-index`);
  const targetWork = join(item.root, `source-${options.command}-target-work`);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const exists = (path: string) => readFile(path).then(() => true, () => false);
  const lineCount = async (path: string) => {
    const contents = await readFile(path, "utf8").catch(() => "");
    return contents.split("\n").filter(Boolean).length;
  };

  await mkdir(wrapperDirectory);
  await writeFile(wrapper, [
    "#!/bin/sh",
    "is_source=",
    "is_target=",
    "is_config=",
    "is_selected=",
    "is_update_index=",
    "is_diff=",
    "is_cached=",
    "is_no_ext_diff=",
    "is_no_textconv=",
    "for argument in \"$@\"; do",
    `  if [ \"$argument\" = ${JSON.stringify(item.sourceWorktree)} ]; then is_source=1; fi`,
    `  if [ \"$argument\" = ${JSON.stringify(item.targetWorktree)} ]; then is_target=1; fi`,
    "  if [ \"$argument\" = \"config\" ]; then is_config=1; fi",
    `  if [ \"$argument\" = ${JSON.stringify(options.command)} ]; then is_selected=1; fi`,
    "  if [ \"$argument\" = \"update-index\" ]; then is_update_index=1; fi",
    "  if [ \"$argument\" = \"diff\" ]; then is_diff=1; fi",
    "  if [ \"$argument\" = \"--cached\" ]; then is_cached=1; fi",
    "  if [ \"$argument\" = \"--no-ext-diff\" ]; then is_no_ext_diff=1; fi",
    "  if [ \"$argument\" = \"--no-textconv\" ]; then is_no_textconv=1; fi",
    "done",
    "if [ \"$is_diff\" = \"1\" ] && [ \"$is_cached\" = \"1\" ] && [ \"$is_no_ext_diff\" = \"1\" ] && [ \"$is_no_textconv\" = \"1\" ]; then",
    `  ${JSON.stringify(realGit)} \"$@\"`,
    "  status=$?",
    `  printf 'done\\n' >> ${JSON.stringify(snapshotCompletions)}`,
    `  if [ \"$(wc -l < ${JSON.stringify(snapshotCompletions)})\" -ge 2 ]; then : > ${JSON.stringify(sourcePreparationStarted)}; fi`,
    "  exit $status",
    "fi",
    `if [ \"$is_target\" = \"1\" ] && [ -f ${JSON.stringify(sourcePreparationStarted)} ]; then`,
    `  printf '%s\\n' \"$*\" >> ${JSON.stringify(targetWork)}`,
    "fi",
    `if [ \"$is_source\" = \"1\" ] && [ \"$is_config\" = \"1\" ] && [ -f ${JSON.stringify(sourcePreparationStarted)} ]; then`,
    `  ${JSON.stringify(realGit)} \"$@\"`,
    "  status=$?",
    `  : > ${JSON.stringify(filterLookupFinished)}`,
    "  exit $status",
    "fi",
    "is_real_index=",
    "if [ \"$is_source\" = \"1\" ] && [ \"$is_update_index\" = \"1\" ] && [ -z \"${GIT_INDEX_FILE+x}\" ]; then",
    "  is_real_index=1",
    `  printf '%s\\n' \"$*\" >> ${JSON.stringify(realIndexMutations)}`,
    "fi",
    "if [ \"$is_selected\" = \"1\" ] && { [ \"$is_update_index\" != \"1\" ] || [ \"$is_real_index\" = \"1\" ]; }; then",
    `  printf '%s\\n' \"$*\" >> ${JSON.stringify(commandStarted)}`,
    ...(options.selectedCommandFailure ? [
      `  printf '%s\\n' ${JSON.stringify(options.selectedCommandFailure)} >&2`,
      "  status=23"
    ] : [
      `  ${JSON.stringify(realGit)} \"$@\"`,
      "  status=$?"
    ]),
    `  printf '%s\\n' \"$*\" >> ${JSON.stringify(commandCompleted)}`,
    "  exit $status",
    "fi",
    `exec ${JSON.stringify(realGit)} \"$@\"`
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath ?? ""}`;
  const error = new Error(`DELIVERY_APPLICATION_SOURCE_${options.command.toUpperCase()}_CLAIM_LOST`);

  return {
    error,
    loseOwnership: () => writeFile(forcedLoss, ""),
    sourceFilterPrepared: () => exists(filterLookupFinished),
    assertCurrent: async () => {
      if (await exists(forcedLoss)
        || (options.loseOwnershipAfterFilterLookup && await exists(filterLookupFinished))
        || (options.loseOwnershipAfterCommand && await exists(commandCompleted))) {
        throw error;
      }
    },
    commandStarted: () => exists(commandStarted),
    commandCompleted: () => exists(commandCompleted),
    realIndexMutationCount: () => lineCount(realIndexMutations),
    targetWorkStarted: () => exists(targetWork),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
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
  it("does not publish the source ref after ownership loss during source filter lookup", async () => {
    const item = await fixture();
    const sourceHead = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const marker = await installSourceGitBoundaryWrapper(item, {
      command: "update-ref", loseOwnershipAfterFilterLookup: true
    });

    try {
      await expect(executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 fenced source ref", commands: [],
        onSourceFrozen: async () => {
          expect(await marker.sourceFilterPrepared()).toBe(true);
          await marker.assertCurrent();
        },
        assertSourceOwnership: marker.assertCurrent
      })).rejects.toBe(marker.error);

      expect((await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(sourceHead);
      expect(await marker.commandStarted()).toBe(false);
      expect(await marker.targetWorkStarted()).toBe(false);
    } finally {
      marker.restore();
    }
  });

  it("stops source index synchronization when ownership is lost as update-ref completes", async () => {
    const item = await fixtureWithTwoChangedFiles();
    const marker = await installSourceGitBoundaryWrapper(item, {
      command: "update-ref", loseOwnershipAfterCommand: true
    });

    try {
      await expect(executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 fenced source index", commands: [],
        assertSourceOwnership: marker.assertCurrent
      })).rejects.toBe(marker.error);

      expect(await marker.commandCompleted()).toBe(true);
      expect(await marker.realIndexMutationCount()).toBe(0);
      expect(await marker.targetWorkStarted()).toBe(false);
    } finally {
      marker.restore();
    }
  });

  it.each(["before", "after"] as const)(
    "stops remaining source index mutations and target work after ownership loss %s a real source index update",
    async (boundary) => {
      const item = await fixtureWithTwoChangedFiles();
      const marker = await installSourceGitBoundaryWrapper(item, {
        command: "update-index", loseOwnershipAfterCommand: boundary === "after"
      });

      try {
        await expect(executeLocalIntegration({
          ...integrationInput(item), commitMessage: `REQ-0001 source index ${boundary} fence`, commands: [],
          onSourcePrepared: boundary === "before" ? marker.loseOwnership : undefined,
          assertSourceOwnership: marker.assertCurrent
        })).rejects.toBe(marker.error);

        expect(await marker.realIndexMutationCount()).toBe(boundary === "before" ? 0 : 1);
        expect(await marker.targetWorkStarted()).toBe(false);
      } finally {
        marker.restore();
      }
    }
  );

  it.each(["lost", "current"] as const)(
    "preserves %s source ownership precedence when the fenced Git command fails",
    async (ownership) => {
      const item = await fixture();
      const gitError = "SOURCE_UPDATE_REF_COMMAND_FAILED";
      const marker = await installSourceGitBoundaryWrapper(item, {
        command: "update-ref",
        selectedCommandFailure: gitError,
        loseOwnershipAfterCommand: ownership === "lost"
      });

      try {
        const pending = executeLocalIntegration({
          ...integrationInput(item), commitMessage: "REQ-0001 source error precedence", commands: [],
          assertSourceOwnership: marker.assertCurrent
        });
        if (ownership === "lost") {
          await expect(pending).rejects.toBe(marker.error);
        } else {
          const result = await pending;
          expect(result.status).toBe("failed");
          expect(result.error).toContain(gitError);
        }
        expect(await marker.commandCompleted()).toBe(true);
      } finally {
        marker.restore();
      }
    }
  );

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

  it("proves deterministic conflict never starts destructive target cleanup", async () => {
    const item = await fixtureWithDeterministicConflict();
    const targetBefore = await captureIntegrationTargetState(item);
    const preApplyHead = targetBefore.head.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item);
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), evidenceHash: item.evidenceHash,
        commitMessage: "REQ-0001 deterministic conflict", commands: []
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "conflict",
      preApplyHead,
      targetState: "untouched_clean",
      conflictFiles: ["value.txt"],
      commandResults: []
    });
    expect(await guard.targetMutations()).toEqual([]);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect(await captureIntegrationTargetState(item)).toEqual(targetBefore);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect(await integrationRefs(item)).toBe(refsBefore);
  });

  it("proves a concurrent target edit remains uncertain without destructive cleanup", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item);
    const externalBytes = Buffer.from("external target edit\n\0raw");
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 concurrent target", commands: [],
        onBeforeTargetMutation: async () => {
          await writeFile(join(item.targetWorktree, "external.txt"), externalBytes);
        }
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "ambiguous",
      preApplyHead,
      targetState: "uncertain",
      commandResults: []
    });
    expect(await readFile(join(item.targetWorktree, "external.txt"))).toEqual(externalBytes);
    expect(await guard.targetMutations()).toEqual([]);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect(await integrationRefs(item)).toBe(refsBefore);
  });

  it("preserves an ordinary target Git failure and returns uncertain without cleanup", async () => {
    const item = await fixture();
    const targetBefore = await captureIntegrationTargetState(item);
    const guard = await rejectIfTargetMutationStarts(item);
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 ordinary target Git failure", commands: []
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "ambiguous",
      targetState: "uncertain",
      commandResults: [],
      error: "injected ordinary target Git failure\n"
    });
    expect(await guard.targetMutations()).toHaveLength(1);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect(await captureIntegrationTargetState(item)).toEqual(targetBefore);
  });

  it("preserves a foreign conflict created immediately before target mutation", async () => {
    const item = await fixture();
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

  it("reports a wildcard conflict without touching a matching sibling path", async () => {
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

  it("proves a target Git timeout preserves uncertain staged state without destructive cleanup", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pause_after" });
    const realNow = Date.now.bind(Date);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let thrown: unknown;
    try {
      await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 target Git timeout", commands: [],
        onBeforeTargetMutation: () => {
          clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 294_000);
        }
      });
    } catch (error) {
      thrown = error;
    } finally {
      clock?.mockRestore();
      guard.restore();
    }

    expect(thrown).toEqual(expect.objectContaining({ message: "DELIVERY_APPLICATION_DEADLINE_EXCEEDED" }));
    expect(await guard.targetMutationFinished()).toBe(true);
    expectProcessExited(await guard.pausedMutationPid());
    expect(await guard.targetMutations()).toHaveLength(1);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout)
      .toContain("A  feature.txt");
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe("implemented\n");
    expect(await integrationRefs(item)).toBe(refsBefore);
  }, 15_000);

  it("proves worker abort preserves uncertain staged state without destructive cleanup", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pause_after" });
    const controller = new AbortController();
    let abortedAt = 0;
    let thrown: unknown;
    try {
      const pending = executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 worker abort", commands: [], signal: controller.signal
      });
      await guard.waitForTargetMutation();
      abortedAt = Date.now();
      controller.abort();
      try {
        await pending;
      } catch (error) {
        thrown = error;
      }
    } finally {
      guard.restore();
    }

    expect(thrown).toEqual(expect.objectContaining({ message: "DELIVERY_APPLICATION_ABORTED" }));
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(await guard.targetMutationFinished()).toBe(true);
    expectProcessExited(await guard.pausedMutationPid());
    expect(await guard.targetMutations()).toHaveLength(1);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout)
      .toContain("A  feature.txt");
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe("implemented\n");
    expect(await integrationRefs(item)).toBe(refsBefore);
  }, 15_000);

  it("proves lease loss after target mutation never settles or starts destructive cleanup", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pass" });
    const ownershipError = new Error("DELIVERY_APPLICATION_LEASE_STALE_AFTER_TARGET_MUTATION");
    let thrown: unknown;
    try {
      await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 post-mutation lease loss", commands: [],
        assertTargetOwnership: async () => {
          if (await guard.targetMutationFinished()) throw ownershipError;
        }
      });
    } catch (error) {
      thrown = error;
    } finally {
      guard.restore();
    }

    expect(thrown).toBe(ownershipError);
    expect(await guard.targetMutationFinished()).toBe(true);
    expect(await guard.targetMutations()).toHaveLength(1);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout)
      .toContain("A  feature.txt");
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe("implemented\n");
    expect(await integrationRefs(item)).toBe(refsBefore);
  });

  it("returns uncertain without cleanup when an external actor commits the applied target", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pass" });
    let externalCommit = "";
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 external target commit", commands: [],
        onTargetMutated: async () => {
          await exec(realGit, ["-C", item.targetWorktree, "commit", "-m", "external actor commit"]);
          externalCommit = (await exec(realGit, ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
        }
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "ambiguous",
      preApplyHead,
      targetState: "uncertain",
      error: "TARGET_CHANGED_AFTER_APPLICATION",
      commandResults: []
    });
    expect(externalCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(externalCommit).not.toBe(preApplyHead);
    expect((await exec(realGit, ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(externalCommit);
    expect((await exec(realGit, ["-C", item.targetWorktree, "show", "HEAD:feature.txt"])).stdout)
      .toBe("implemented\n");
    expect((await exec(realGit, ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
    expect(await guard.destructiveCommands()).toEqual([]);
    expect(await integrationRefs(item)).toBe(refsBefore);
  });

  it("returns uncertain without cleanup when verification fails after an external staged index replacement", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const externalBytes = "external staged bytes with trailing whitespace \n";
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pass" });
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 external staged index", commands: [
          { command: "git", argsPrefix: ["diff", "--cached", "--check"] }
        ],
        onTargetMutated: async () => {
          await writeFile(join(item.targetWorktree, "feature.txt"), externalBytes);
          await exec(realGit, ["-C", item.targetWorktree, "add", "--", "feature.txt"]);
        }
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "ambiguous",
      preApplyHead,
      targetState: "uncertain",
      error: "TARGET_CHANGED_AFTER_APPLICATION"
    });
    expect(result!.commandResults).toHaveLength(1);
    expect(result!.commandResults[0]?.code).not.toBe(0);
    expect((await exec(realGit, ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe(externalBytes);
    expect((await exec(realGit, ["-C", item.targetWorktree, "show", ":feature.txt"])).stdout)
      .toBe(externalBytes);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect(await integrationRefs(item)).toBe(refsBefore);
  });

  it("returns uncertain when external unstaged and untracked files appear after target mutation", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pass" });
    const unstagedBytes = "external unstaged bytes\n";
    const untrackedBytes = "external untracked bytes\n";
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 external worktree edits", commands: [],
        onTargetMutated: async () => {
          await writeFile(join(item.targetWorktree, "feature.txt"), unstagedBytes);
          await writeFile(join(item.targetWorktree, "external.txt"), untrackedBytes);
        }
      });
    } finally {
      guard.restore();
    }

    expect(result!, JSON.stringify(result)).toMatchObject({
      status: "ambiguous",
      preApplyHead,
      targetState: "uncertain",
      error: "TARGET_CHANGED_AFTER_APPLICATION"
    });
    expect((await exec(realGit, ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe(unstagedBytes);
    expect(await readFile(join(item.targetWorktree, "external.txt"), "utf8")).toBe(untrackedBytes);
    expect(await guard.destructiveCommands()).toEqual([]);
  });

  it("does not start target mutation after ownership loss during the final target read", async () => {
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
      const callbackError = new Error("DELIVERY_APPLICATION_CLAIM_LOST_DURING_FINAL_TARGET_READ");
      const pending = executeLocalIntegration({
        ...integrationInput(item), commitMessage: "REQ-0001 primary fence", commands: [],
        onBeforeTargetMutation: async () => { await writeFile(mutationArmed, ""); },
        assertTargetOwnership: async () => {
          if (await readFile(filterLookupFinished).then(() => true, () => false)) {
            throw callbackError;
          }
        }
      });

      await expect(pending).rejects.toBe(callbackError);
      await expect(readFile(filterLookupFinished, "utf8")).resolves.toBe("");
      await expect(readFile(cherryPickStarted, "utf8")).rejects.toThrow();
      expect((await exec("git", ["-C", item.targetWorktree, "status", "--porcelain"])).stdout).toBe("");
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

  it("bounds recovered source tree queries by fixed argv bytes", async () => {
    const budgetBytes = 16 * 1024;
    const item = await fixtureWithLongChangedPaths();
    await exec("git", ["-C", item.sourceWorktree, "add", "--all"]);
    await exec("git", ["-C", item.sourceWorktree, "commit", "-m", "large source evidence"]);
    const sourceCommit = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", item.sourceWorktree, "update-index", "--force-remove", "--", item.files[0]!]);
    const marker = await installSourceTreeArgvBudgetWrapper(item, budgetBytes);

    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), sourceCommit, commitMessage: "must not be created", commands: []
      });

      expect(result.error).toBeNull();
      expect(result.status).toBe("completed");
      const queryBytes = await marker.queryBytes();
      expect(queryBytes.length).toBeGreaterThan(1);
      expect(queryBytes.every((bytes) => bytes <= budgetBytes)).toBe(true);
      expect(await marker.rejected()).toBe(false);
      expect((await exec("git", ["-C", item.sourceWorktree, "status", "--porcelain=v1"])).stdout).toBe("");
    } finally {
      marker.restore();
    }
  }, 15_000);

  it.each([
    { batchBoundary: "same query batch", withPadding: false, expectedSplit: false },
    { batchBoundary: "different query batches", withPadding: true, expectedSplit: true }
  ])("conservatively reports a recovered file-to-directory boundary conflict across $batchBoundary", async ({
    withPadding, expectedSplit
  }) => {
    const budgetBytes = 16 * 1024;
    const item = await fixtureWithDirectoryBoundary(withPadding);
    await exec("git", ["-C", item.sourceWorktree, "add", "--all"]);
    await exec("git", ["-C", item.sourceWorktree, "commit", "-m", "replace file with directory"]);
    const sourceCommit = (await exec("git", ["-C", item.sourceWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const targetBefore = await captureIntegrationTargetState(item);
    const marker = await installSourceTreeArgvBudgetWrapper(item, budgetBytes, [item.parent, item.child]);

    try {
      const result = await executeLocalIntegration({
        ...integrationInput(item), sourceCommit, commitMessage: "must not be created", commands: []
      });

      expect({
        boundaryPathsQueried: await marker.boundaryPathsQueried(),
        boundaryQueriesSplit: await marker.boundaryQueriesSplit(),
        targetMutationStarted: await marker.targetMutationStarted(),
        status: result.status,
        error: result.error
      }).toEqual({
        boundaryPathsQueried: true,
        boundaryQueriesSplit: expectedSplit,
        targetMutationStarted: false,
        status: "conflict",
        error: "APPLICATION_CONFLICT"
      });
      expect(result.conflictFiles?.length).toBeGreaterThan(0);
      expect(result.conflictFiles?.some((path) =>
        path === item.parent || path.startsWith(`${item.parent}/`)
      )).toBe(true);
      expect(await captureIntegrationTargetState(item)).toEqual(targetBefore);
      expect((await exec("git", ["-C", item.sourceWorktree, "status", "--porcelain=v1"])).stdout).toBe("");
    } finally {
      marker.restore();
    }
  }, 15_000);

  it("proves verification failure preserves intended staged changes without destructive cleanup", async () => {
    const item = await fixture();
    const preApplyHead = (await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim();
    const refsBefore = await integrationRefs(item);
    const guard = await rejectIfTargetMutationStarts(item, { mutation: "pass" });
    let result: Awaited<ReturnType<typeof executeLocalIntegration>>;
    try {
      result = await executeLocalIntegration({
        ...integrationInput(item), expectedTargetHead: preApplyHead,
        commitMessage: "REQ-0001 verification failure",
        commands: [{ command: process.execPath, argsPrefix: ["-e", "process.exit(7)"] }]
      });
    } finally {
      guard.restore();
    }

    expect(result!.status).toBe("test_failed");
    expect(result!.preApplyHead).toBe(preApplyHead);
    expect(result!.statusPorcelain).toContain("A  feature.txt");
    expect(await guard.targetMutations()).toHaveLength(1);
    expect(await guard.destructiveCommands()).toEqual([]);
    expect((await exec("git", ["-C", item.targetWorktree, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(preApplyHead);
    expect((await exec("git", ["-C", item.targetWorktree, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
    expect(await readFile(join(item.targetWorktree, "feature.txt"), "utf8")).toBe("implemented\n");
    expect(await integrationRefs(item)).toBe(refsBefore);
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
