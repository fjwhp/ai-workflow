# Isolated Delivery Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect delivery conflicts in a disposable Git index and remove destructive conflict cleanup from the real target while fencing every visible source and target mutation.

**Architecture:** Source evidence is converted into a commit through an isolated index, then the managed source ref and real source index are updated through explicit before/after ownership fences. A focused merge simulator performs the source-parent/target/source three-way merge in a temporary index. Only a clean simulation permits one real `cherry-pick --no-commit`; any real-target failure is preserved as uncertain and never automatically rolled back.

**Tech Stack:** TypeScript, Node.js child-process APIs, Git temporary indexes, SQLite-backed delivery claims, Vitest real-repository tests.

---

## Risk-Based Verification And Review Policy

This policy records the review optimization approved on 2026-07-22. It applies to the
remaining work in this plan and the following Phase 3 tasks. Quality gates remain
mandatory; repeated execution of identical evidence does not.

### Risk Classification

| Risk | Examples | Review gate |
| --- | --- | --- |
| High | Git or filesystem mutation, process control, concurrency, claim/lease fencing, persistence, recovery, migrations, security boundaries | Independent specification review followed by independent quality/security review |
| Medium | Ordinary service/API behavior and UI workflows without a new mutation, persistence, concurrency, or security boundary | One reviewer covers separate specification and quality sections |
| Low | Documentation, copy, and isolated presentation-only changes | One focused review |

For the remaining delivery work, T4 Tasks 3-4 and Phase 3 T5-T6 are high risk. T7 is
medium risk unless implementation introduces a high-risk boundary. T8 is a milestone
acceptance gate and does not add a separate code review unless acceptance changes code.

### Test Evidence Ownership

1. The implementer proves RED, then runs the smallest affected GREEN tests while editing.
2. After the task commit, the coordinator runs one canonical affected suite, affected
   workspace typechecks, and diff/status checks. This is the task's reusable evidence.
3. Reviewers inspect their assigned concerns and reuse canonical evidence. They run only
   a minimal targeted reproduction when they identify a concrete doubt; they do not rerun
   the same complete suite by default.
4. A review fix reruns its direct regression and affected suite. The complete affected
   suite is repeated only when the fix changes shared infrastructure or a behavioral
   contract. Only the review role that found the issue repeats its review unless the fix
   also changes the specification contract.
5. Cross-module full tests, full typecheck/build, browser acceptance, and real-project
   pilots run once at their milestone gate rather than after every task.

### Non-Negotiable Quality Rules

- RED/GREEN evidence is never replaced by code inspection.
- Critical and Important findings block progression.
- Specification and quality responsibilities remain separate on high-risk work.
- A reviewer cannot approve their own implementation.
- Evidence is reusable only for the exact commit SHA it verified; any subsequent code
  change invalidates the affected evidence.

---

## File Structure

- Create `server/src/delivery-application-merge.ts`: isolated-index three-way merge simulation and bounded conflict evidence.
- Create `server/src/delivery-application-merge.test.ts`: real Git tests for clean, conflict, binary, mode, symlink, timeout, and cancellation behavior.
- Modify `server/src/integration.ts`: prepared Git environments, source mutation fences, simulator integration, one real no-commit apply, and read-only failure handling.
- Modify `server/src/integration.test.ts`: source ref/index fence tests, no-cleanup target race tests, and no-publication invariants.
- Modify `server/src/delivery-application-service.ts`: provide one current-source/current-target claim callback without owning Git mechanics.
- Modify `server/src/delivery-application-service.test.ts`: callback propagation, retry recovery, deterministic conflict, and uncertain target ownership tests.
- Reuse `server/src/repository.ts` and `server/src/evidence-tree.ts` unchanged unless a failing test proves an existing optional signal/deadline call omits a subprocess in the new path.

## Test Helper Contracts

The plan uses these test-only helpers. Implement them in the named test file before the tests that call them; none belongs in production code.

In `server/src/integration.test.ts`:

```ts
type BoundaryCommand = "update-ref" | "update-index" | "cherry-pick";
type BoundaryOptions = {
  command: BoundaryCommand;
  loseOwnershipAfterFilterLookup?: boolean;
  loseOwnershipAfterCommand?: boolean;
};

async function fixtureWithTwoChangedFiles() {
  const item = await fixture();
  await writeFile(join(item.sourceWorktree, "second.txt"), "second\n");
  const snapshot = await getWorktreeSnapshot(item.sourceWorktree);
  return { ...item, evidenceHash: snapshot.evidenceHash };
}

async function fixtureWithDeterministicConflict() {
  const item = await fixture();
  await writeFile(join(item.sourceWorktree, "value.txt"), "source\n");
  const snapshot = await getWorktreeSnapshot(item.sourceWorktree);
  await writeFile(join(item.targetWorktree, "value.txt"), "target\n");
  await exec("git", ["-C", item.targetWorktree, "add", "--all"]);
  await exec("git", ["-C", item.targetWorktree, "commit", "-m", "target conflict"]);
  return { ...item, evidenceHash: snapshot.evidenceHash };
}

async function integrationHead(worktree: string) {
  return (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
}

async function integrationRefs(item: Awaited<ReturnType<typeof fixture>>) {
  return (await exec("git", [
    "-C", item.repo, "for-each-ref", "--format=%(refname):%(objectname)",
    "refs/remotes", "refs/tags"
  ])).stdout;
}

async function captureIntegrationTargetState(item: Awaited<ReturnType<typeof fixture>>) {
  const indexPath = (await exec("git", [
    "-C", item.targetWorktree, "rev-parse", "--git-path", "index"
  ])).stdout.trim();
  return {
    head: await integrationHead(item.targetWorktree),
    status: (await exec("git", [
      "-C", item.targetWorktree, "status", "--porcelain=v1", "--untracked-files=all"
    ])).stdout,
    index: await readFile(indexPath),
    value: await readFile(join(item.targetWorktree, "value.txt")),
    refs: await integrationRefs(item)
  };
}
```

`installGitBoundaryWrapper(item, options)` creates an executable `git` wrapper directory under `item.root`, prepends it to `PATH`, and returns:

```ts
{
  error: Error;
  assertCurrent(): Promise<void>;
  commandStarted(): Promise<boolean>;
  realIndexMutationStarted(): Promise<boolean>;
  restore(): void;
}
```

The wrapper must:

- delegate to the absolute real Git binary with `exec` and unchanged argv;
- create separate regular-file markers for filter lookup, selected-command start, selected-command completion, and real-index mutation;
- make `assertCurrent` throw the same `error` object at the configured marker;
- identify real-index mutation only when `GIT_INDEX_FILE` is absent and argv contains `update-index`;
- restore the original `PATH` in the test's `finally` block.

`rejectIfTargetMutationStarts(item)` uses the same absolute-binary wrapper pattern and records target-worktree invocations of `cherry-pick --no-commit`. It also records any target invocation of `restore`, `reset`, `rm`, `checkout`, `clean`, `cherry-pick --abort`, or `cherry-pick --quit`. It returns asynchronous `targetMutationStarted()` and `destructiveCommands()` readers plus `restore()`.

In `server/src/delivery-application-merge.test.ts`, define one `createMergeFixture(kind)` helper. It creates a temporary repository with `base`, `target`, and `source` commits, plus a registered target worktree checked out at `target`. The supported `kind` values and exact divergent changes are:

- `clean`: source adds `source.txt`; target adds `target.txt`;
- `text`: source and target write different bytes to `value.txt`;
- `add-delete`: source edits `value.txt`; target deletes it;
- `binary`: source and target write different fixed `Buffer` values to `asset.bin`;
- `mode`: source changes `script.sh` content while target changes its executable mode;
- `symlink`: source and target replace `link` with different symlink targets.

The helper returns commit IDs, repository/worktree paths, `simulationInput`, and a `before` snapshot containing target HEAD, branch, porcelain status, raw index bytes, recursively captured worktree entry type/mode/bytes/link target, local tags/remotes, and bare-remote refs. `expectTargetState(fixture, before)` captures the same fields again and asserts deep equality.

## Task 1: Fence Source Ref And Real-Index Mutation

**Files:**
- Modify: `server/src/integration.ts`
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/delivery-application-service.ts`
- Modify: `server/src/delivery-application-service.test.ts`

- [ ] **Step 1: Write failing source-ref fence tests**

Add real Git wrapper tests to `server/src/integration.test.ts` that mark filter preparation, `update-ref` start/completion, and real-index `update-index` start. The lease callback must fail at the named boundary.

```ts
it("does not publish the source ref after lease loss during filter preparation", async () => {
  const item = await fixture();
  const sourceHead = await integrationHead(item.sourceWorktree);
  const marker = await installGitBoundaryWrapper(item, {
    command: "update-ref",
    loseOwnershipAfterFilterLookup: true
  });

  try {
    await expect(executeLocalIntegration({
      ...integrationInput(item),
      commitMessage: "REQ-0001 fenced source ref",
      commands: [],
      assertSourceOwnership: marker.assertCurrent
    })).rejects.toBe(marker.error);

    expect(await integrationHead(item.sourceWorktree)).toBe(sourceHead);
    expect(await marker.commandStarted()).toBe(false);
  } finally {
    marker.restore();
  }
});

it("stops source index synchronization when lease loss follows update-ref", async () => {
  const item = await fixtureWithTwoChangedFiles();
  const marker = await installGitBoundaryWrapper(item, {
    command: "update-ref",
    loseOwnershipAfterCommand: true
  });

  try {
    await expect(executeLocalIntegration({
      ...integrationInput(item),
      commitMessage: "REQ-0001 fenced source index",
      commands: [],
      assertSourceOwnership: marker.assertCurrent
    })).rejects.toBe(marker.error);

    expect(await marker.realIndexMutationStarted()).toBe(false);
  } finally {
    marker.restore();
  }
});
```

The wrapper helper belongs in the test file and invokes the real Git binary with fixed argv. It must not assert only callback counts.

- [ ] **Step 2: Run the source fence tests and verify RED**

Run:

```bash
npm test -- server/src/integration.test.ts -t "source ref|source index"
```

Expected: FAIL because `update-ref` and real-index updates currently run without immediate in-command ownership fences.

- [ ] **Step 3: Add an explicit source ownership callback**

Extend the execution input in `server/src/integration.ts`:

```ts
export type LocalIntegrationExecutionInput = FrozenApplicationInput & {
  commitMessage: string;
  commands: VerificationCommand[];
  signal?: AbortSignal;
  onSourceFrozen?: () => void | Promise<void>;
  onSourcePrepared?: (sourceCommit: string) => void | Promise<void>;
  assertSourceOwnership?: () => void | Promise<void>;
  assertTargetOwnership?: () => void | Promise<void>;
};
```

Add one helper whose errors are never caught as Git/domain failures:

```ts
async function assertSourceOwnership(input: LocalIntegrationExecutionInput) {
  throwIfApplicationAborted(input.signal);
  await input.assertSourceOwnership?.();
  throwIfApplicationAborted(input.signal);
}
```

In `server/src/delivery-application-service.ts`, pass the same live application claim check for source and target:

```ts
const assertCurrentClaim = async () => {
  throwIfAborted(signal);
  claim = this.dependencies.applications.assertClaim(claim);
};

assertSourceOwnership: assertCurrentClaim,
assertTargetOwnership: assertCurrentClaim,
```

- [ ] **Step 4: Prepare mutation Git environments before fencing**

Split Git environment preparation from subprocess execution so filter lookup cannot occur between the ownership callback and a mutation.

```ts
interface PreparedGitEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

async function prepareGitEnvironment(cwd: string, execution: GitExecutionContext) {
  const overrides = await codingFilterOverrides(cwd, remainingGitOptions(execution));
  return {
    cwd,
    env: codingGitEnvironmentWithFsmonitor([
      ["core.hooksPath", "/dev/null"],
      ["commit.gpgSign", "false"],
      ...overrides
    ])
  } satisfies PreparedGitEnvironment;
}
```

The prepared runner must call `fence.before`, launch the actual Git subprocess immediately, then call `fence.after`. It must preserve the exact callback error object.

- [ ] **Step 5: Split source object creation from visible mutations**

Refactor source preparation into these ordered operations:

```ts
const preparedSourceGit = await prepareGitEnvironment(input.sourceWorktreePath, execution);
await input.onSourceFrozen?.();
await assertSourceOwnership(input);
const prepared = await buildFrozenSourceObjects(input, snapshot, execution, preparedSourceGit);

await runPreparedGit(preparedSourceGit, [
  "update-ref", `refs/heads/${input.sourceBranch}`,
  prepared.sourceCommit, prepared.baseCommit
], execution, { before: sourceFence, after: sourceFence });

await input.onSourcePrepared?.(prepared.sourceCommit);
await assertSourceOwnership(input);
await synchronizeFrozenSourceIndex(
  input, snapshot, preparedSourceGit, execution,
  { before: sourceFence, after: sourceFence }
);
```

`buildFrozenSourceObjects` may write unreferenced blobs/tree/commit objects through the temporary index, but it must not update a ref or the real source index. `synchronizeFrozenSourceIndex` updates only frozen evidence paths and preserves excluded/pre-staged paths. Every real-index Git subprocess receives both fences.

- [ ] **Step 6: Update service callback propagation tests**

In `server/src/delivery-application-service.test.ts`, assert the same callback error object rejects and the run stays applying:

```ts
await expect(service.apply(unit.id, applicationInput(firstLease))).rejects.toBe(callbackError);
expect(applications.listForUnit(unit.id)[0]).toMatchObject({
  status: "applying",
  sourceCommit: null
});
```

Then fail the first job retryably, lease attempt 2, and assert exact unbound-commit recovery binds the same commit and same run ID.

- [ ] **Step 7: Run source/service tests and verify GREEN**

Run:

```bash
npm test -- server/src/integration.test.ts server/src/delivery-application-service.test.ts
npm run typecheck -w server
```

Expected: all source fence, callback propagation, recovery, and existing application tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add server/src/integration.ts server/src/integration.test.ts \
  server/src/delivery-application-service.ts server/src/delivery-application-service.test.ts
git diff --cached --check
git commit -m "fix: fence delivery source mutations"
```

## Task 2: Simulate Delivery Merge In A Disposable Index

**Files:**
- Create: `server/src/delivery-application-merge.ts`
- Create: `server/src/delivery-application-merge.test.ts`

- [ ] **Step 1: Write failing real-Git simulator tests**

Define the desired public contract in `server/src/delivery-application-merge.test.ts`:

```ts
it("returns a merged tree for a clean three-way application", async () => {
  const repo = await createMergeFixture("clean");
  const result = await simulateDeliveryMerge({
    repoPath: repo.repoPath,
    sourceCommit: repo.sourceCommit,
    preApplyHead: repo.targetCommit,
    signal: AbortSignal.timeout(5_000),
    deadlineAt: Date.now() + 5_000
  });

  expect(result).toMatchObject({ status: "clean", conflictFiles: [] });
  expect(result.mergedTree).toMatch(/^[0-9a-f]{40}$/);
  await expectTargetState(repo, repo.before);
});

it.each(["text", "add-delete", "binary", "mode", "symlink"])(
  "detects a %s conflict without touching the target",
  async (kind) => {
    const repo = await createMergeFixture(kind);
    const result = await simulateDeliveryMerge(repo.simulationInput);

    expect(result.status).toBe("conflict");
    expect(result.conflictFiles.length).toBeGreaterThan(0);
    await expectTargetState(repo, repo.before);
  }
);
```

Capture target HEAD, branch, status, index bytes, worktree file/symlink bytes, local refs, and remote refs before simulation. Compare all fields afterward.

- [ ] **Step 2: Run simulator tests and verify RED**

Run:

```bash
npm test -- server/src/delivery-application-merge.test.ts
```

Expected: FAIL because the simulator module does not exist.

- [ ] **Step 3: Define bounded simulator contracts**

Create `server/src/delivery-application-merge.ts`:

```ts
export interface DeliveryMergeSimulationInput {
  repoPath: string;
  sourceCommit: string;
  preApplyHead: string;
  signal?: AbortSignal;
  deadlineAt: number;
}

export type DeliveryMergeSimulation =
  | { status: "clean"; mergedTree: string; conflictFiles: [] }
  | { status: "conflict"; mergedTree: null; conflictFiles: string[] };

export async function simulateDeliveryMerge(
  input: DeliveryMergeSimulationInput
): Promise<DeliveryMergeSimulation>;
```

Validate canonical absolute repository path, 40-character lower-case commit IDs, live deadline, and non-aborted signal before creating temporary state.

- [ ] **Step 4: Implement the three-way temporary index**

Use a `mkdtemp` directory and an index path that does not exist before Git creates it:

```ts
const sourceParent = await revParse(`${input.sourceCommit}^`);
await git(["read-tree", "-m", sourceParent, input.preApplyHead, input.sourceCommit], {
  GIT_INDEX_FILE: indexPath
});
const unmerged = await git(["ls-files", "-u", "-z"], { GIT_INDEX_FILE: indexPath });
```

Parse conflict paths from structured `ls-files -u -z` records, deduplicate them, sort them, and apply the existing maximum-count/byte bounds. If conflicts exist, return them without running `write-tree`. Otherwise run `write-tree` and verify that `git diff-tree targetHead mergedTree` contains no path outside `git diff-tree sourceParent sourceCommit`.

Every Git command uses the strict Git environment, remaining deadline, abort signal, fixed argv, and no shell. Temporary directory removal runs in `finally` with an independent bounded cleanup helper.

- [ ] **Step 5: Add cancellation and deadline tests**

Use a Git wrapper that blocks `read-tree` and records termination:

```ts
const controller = new AbortController();
const pending = simulateDeliveryMerge({ ...input, signal: controller.signal });
await wrapper.waitUntilStarted();
controller.abort(new Error("LEASE_LOST"));
await expect(pending).rejects.toThrow("DELIVERY_APPLICATION_ABORTED");
expect(await wrapper.wasTerminated()).toBe(true);
```

Add a separate expired-deadline test that proves no Git command starts.

- [ ] **Step 6: Run simulator tests and verify GREEN**

Run:

```bash
npm test -- server/src/delivery-application-merge.test.ts
npm run typecheck -w server
```

Expected: all clean/conflict/type/cancellation/deadline tests PASS and target snapshots remain identical.

- [ ] **Step 7: Commit Task 2**

```bash
git add server/src/delivery-application-merge.ts server/src/delivery-application-merge.test.ts
git diff --cached --check
git commit -m "feat: simulate delivery merge in isolation"
```

## Task 3: Remove Real-Target Conflict Cleanup

**Files:**
- Modify: `server/src/integration.ts`
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/delivery-application-service.test.ts`

- [ ] **Step 1: Write failing deterministic-conflict integration test**

Replace the test that expects a real conflict followed by rollback with a target non-mutation assertion:

```ts
it("settles a deterministic conflict without starting target mutation", async () => {
  const item = await fixtureWithDeterministicConflict();
  const before = await captureIntegrationTargetState(item);
  const wrapper = await rejectIfTargetMutationStarts(item);
  try {
    const result = await executeLocalIntegration({
      ...integrationInput(item),
      evidenceHash: item.evidenceHash,
      commitMessage: "REQ-0001 isolated conflict",
      commands: []
    });

    expect(result).toMatchObject({
      status: "conflict",
      targetState: "untouched_clean",
      conflictFiles: ["value.txt"]
    });
    expect(await wrapper.targetMutationStarted()).toBe(false);
    expect(await captureIntegrationTargetState(item)).toEqual(before);
  } finally {
    wrapper.restore();
  }
});
```

- [ ] **Step 2: Write failing concurrent-target preservation test**

Inject an external edit through the existing `onBeforeTargetMutation` boundary, which runs after clean simulation and immediately before real mutation. Assert the result is ambiguous, the external bytes remain, and no destructive command is invoked.

```ts
it("preserves a concurrent target edit without cleanup", async () => {
  const item = await fixture();
  const wrapper = await rejectIfTargetMutationStarts(item);
  const externalPath = join(item.targetWorktree, "external.txt");
  try {
    const result = await executeLocalIntegration({
      ...integrationInput(item),
      commitMessage: "REQ-0001 concurrent target edit",
      commands: [],
      onBeforeTargetMutation: async () => {
        await writeFile(externalPath, "external edit\n");
      }
    });

    expect(result).toMatchObject({ status: "ambiguous", targetState: "uncertain" });
    expect(await readFile(externalPath, "utf8")).toBe("external edit\n");
    expect(await wrapper.destructiveCommands()).toEqual([]);
  } finally {
    wrapper.restore();
  }
});
```

The destructive command list must include `restore`, `reset`, `rm`, `checkout`, `clean`, `cherry-pick --abort`, and `cherry-pick --quit`.

- [ ] **Step 3: Run the new integration tests and verify RED**

Run:

```bash
npm test -- server/src/integration.test.ts -t "deterministic conflict|concurrent target"
```

Expected: FAIL because the current path still mutates the real target before reporting conflict and contains cleanup commands.

- [ ] **Step 4: Invoke isolated simulation before target mutation**

After source commit binding/index synchronization and a fresh read-only target check, call:

```ts
const simulation = await simulateDeliveryMerge({
  repoPath: input.projectRepoPath,
  sourceCommit,
  preApplyHead,
  signal: input.signal,
  deadlineAt: execution.deadlineAt
});

if (simulation.status === "conflict") {
  const untouched = await inspectTargetState(input, execution);
  return {
    status: "conflict",
    preflight,
    sourceCommit,
    preApplyHead,
    targetState: untouched.identityValid && untouched.clean && untouched.head === preApplyHead
      ? "untouched_clean"
      : "uncertain",
    statusPorcelain: untouched.statusPorcelain,
    conflictFiles: simulation.conflictFiles,
    commandResults: [],
    error: "APPLICATION_CONFLICT"
  };
}
```

If the target changed during simulation, return `ambiguous`, not `conflict`.

- [ ] **Step 5: Delete destructive conflict cleanup**

Remove these implementation paths from `server/src/integration.ts`:

- `ownsFailedCherryPickState`;
- unmerged stage/tree ownership parsing used only by cleanup;
- conflict restore/rm/quit operations;
- `rollbackError` and `rollbackPostcondition` production writes if no remaining caller consumes them;
- tests that validate automatic real-target rollback.

Do not replace them with reset, checkout, clean, or another cleanup strategy.

- [ ] **Step 6: Make real-target failures read-only and uncertain**

Prepare the target Git environment before the final target check. Run only the real mutation with immediate fences:

```ts
const targetGit = await prepareGitEnvironment(input.targetWorktreePath, execution);
const targetBeforeMutation = await inspectTargetState(input, execution);
if (!targetBeforeMutation.identityValid || !targetBeforeMutation.clean
  || targetBeforeMutation.head !== preApplyHead) {
  return {
    status: "ambiguous",
    preflight,
    sourceCommit,
    preApplyHead,
    targetState: "uncertain",
    statusPorcelain: targetBeforeMutation.statusPorcelain,
    commandResults: [],
    error: "TARGET_CHANGED_BEFORE_APPLICATION"
  };
}

try {
  await runPreparedGit(targetGit, ["cherry-pick", "--no-commit", sourceCommit], execution, {
    before: targetFence,
    after: targetFence
  });
} catch (error) {
  if (targetOwnershipError) throw targetOwnershipError;
  throwIfApplicationAborted(input.signal);
  const observed = await inspectTargetState(input, execution);
  return {
    status: "ambiguous",
    preflight,
    sourceCommit,
    preApplyHead,
    targetState: "uncertain",
    statusPorcelain: observed.statusPorcelain,
    commandResults: [],
    error: String((error as { stderr?: unknown; message?: unknown }).stderr
      ?? (error as { message?: unknown }).message ?? error)
  };
}
```

The catch may inspect identity, HEAD, and status only. It must not mutate Git state or files.

- [ ] **Step 7: Update delivery service conflict/uncertain assertions**

In `server/src/delivery-application-service.test.ts`:

- deterministic conflict settles the unit `conflicted`, stores bounded paths, and leaves the target byte-for-byte unchanged;
- real-target uncertainty settles `failed` with `worktreeState: "dirty_or_uncertain"` only for a domain Git failure;
- ownership callback/abort errors propagate and leave the run `applying`;
- no applied sibling is reset.

- [ ] **Step 8: Run Task 3 tests and verify GREEN**

Run outside the restricted sandbox when process enumeration is required:

```bash
npm test -- server/src/delivery-application-merge.test.ts \
  server/src/integration.test.ts \
  server/src/delivery-application-service.test.ts
npm run typecheck -w server
```

Expected: simulator, deterministic conflict, no-cleanup race, service settlement, callback, and no-commit tests PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add server/src/integration.ts server/src/integration.test.ts \
  server/src/delivery-application-service.test.ts
git diff --cached --check
git commit -m "refactor: isolate delivery application conflicts"
```

## Task 4: Verify Complete T4 Safety And Recovery

**Files:**
- Modify only if a failing regression proves a gap in:
  - `server/src/integration.test.ts`
  - `server/src/delivery-application-service.test.ts`
  - `server/src/delivery-application-merge.test.ts`

- [ ] **Step 1: Add a no-destructive-command regression matrix**

Use `rejectIfTargetMutationStarts` to assert zero target cleanup commands in six individually named tests:

```ts
expect(await wrapper.destructiveCommands()).toEqual([]);
expect(await integrationHead(item.targetWorktree)).toBe(preApplyHead);
expect(await integrationRefs(item)).toEqual(remoteRefsBefore);
```

The six tests are named `deterministic conflict`, `concurrent target edit`, `target Git timeout`, `worker abort`, `lease loss after target mutation`, and `verification failure`. Each uses its existing fixture/setup from `integration.test.ts`, surrounds wrapper installation with `try/finally`, and applies the three assertions above. Verification failure retains intended uncommitted changes. Deterministic conflict retains a clean untouched target. Other post-mutation failures retain observed uncertain state.

- [ ] **Step 2: Run the focused T4/T3 regression suite**

Run outside the sandbox because process containment tests require `/bin/ps`, launchd, and local process control:

```bash
npm test -- \
  server/src/delivery-application-merge.test.ts \
  server/src/delivery-application-service.test.ts \
  server/src/integration.test.ts \
  server/src/delivery-application-repository.test.ts \
  server/src/automation-job-repository.test.ts \
  server/src/store.test.ts \
  server/src/automated-testing.test.ts \
  server/src/process-execution.test.ts \
  server/src/repository.test.ts
```

Expected: every test file passes; only documented platform-conditional tests may skip.

- [ ] **Step 3: Run type and diff verification**

```bash
npm run typecheck -w shared
npm run typecheck -w server
git diff --check 10caecf..HEAD
git diff --check c2c8294..HEAD
git status --short
```

Expected: typechecks and diff checks exit 0. Status contains only the intended Task 4 test edits plus the pre-existing untracked `.local/` before the final commit.

- [ ] **Step 4: Commit final regression evidence if Step 1 changed tests**

```bash
git add server/src/integration.test.ts \
  server/src/delivery-application-service.test.ts \
  server/src/delivery-application-merge.test.ts
git diff --cached --check
git commit -m "test: prove isolated delivery application safety"
```

If Step 1 required no edits because earlier tasks already contain the complete matrix, do not create an empty commit.

- [ ] **Step 5: Run T4 review gates**

Dispatch a fresh spec reviewer for `10caecf..HEAD`. Only after approval, dispatch a fresh quality/security reviewer for the full T4 range `c2c8294..HEAD`. Fix every Critical and Important finding through the task implementer, rerun both review gates, and do not begin T5 until both approve.

## Completion Criteria

- Deterministic conflicts are produced only from isolated simulation and never modify the real target.
- Delivery application contains no destructive target conflict cleanup command path.
- Visible source ref/index and real target mutations have immediate before/after live-claim fences.
- Callback, abort, and lease errors propagate without ordinary settlement.
- Successful application leaves target HEAD unchanged and intended changes uncommitted.
- Conflict/retry/unbound-commit recovery retains the trusted source commit and exact evidence lineage.
- No push, remote ref, pull request, tag, release, or automatic target commit occurs.
- Focused regression, typecheck, diff checks, spec review, and quality review pass before T5 starts.
