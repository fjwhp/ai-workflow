# Apply Worktree Without Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply each AI worktree change set to the selected local target branch as staged, uncommitted files and never update a remote ref.

**Architecture:** Keep the isolated worktree source commit as the stable change set, but replace target-side `git cherry-pick` with `git cherry-pick --no-commit`. Capture the target HEAD before applying, preserve staged changes through verification, and update UI language so local application, committing, testing, and pushing are distinct operations.

**Tech Stack:** TypeScript, Node.js child processes, Git CLI, Fastify, SQLite, React, Vitest

---

### Task 1: Apply Changes Without A Target Commit

**Files:**
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/integration.ts`

- [ ] **Step 1: Replace the successful integration expectation with an uncommitted-application test**

Update the first test to capture the target HEAD before execution and assert that HEAD is unchanged while the new file is staged:

```ts
const beforeHead = (await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim();
const result = await executeLocalIntegration({ ...input, commands: [] });
expect(result.status).toBe("completed");
expect(result.targetCommit).toBe(beforeHead);
expect((await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(beforeHead);
expect((await exec("git", ["-C", item.repo, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
expect((await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout).toContain("A  feature.txt");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- server/src/integration.test.ts`

Expected: FAIL because target `HEAD` advances after the current cherry-pick.

- [ ] **Step 3: Implement no-commit application and capture the original target HEAD**

In `executeLocalIntegration`, capture the target HEAD before the source worktree is committed, then use:

```ts
const targetCommit = (await git(input.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
await git(input.worktreePath, ["add", "--all"]);
await git(input.worktreePath, ["commit", "-m", input.commitMessage]);
sourceCommit = (await git(input.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
await git(input.repoPath, ["cherry-pick", "--no-commit", sourceCommit]);
```

Return `targetCommit` as the pre-application target HEAD for completed and test-failed results. Change errors to `应用预检未通过` and `本地应用后测试失败`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- server/src/integration.test.ts`

Expected: all integration tests pass.

- [ ] **Step 5: Commit the integration behavior**

```bash
git add server/src/integration.ts server/src/integration.test.ts
git commit -m "feat: apply worktree changes without committing"
```

### Task 2: Guarantee Conflict Cleanup And Test-Failure Retention

**Files:**
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/integration.ts`

- [ ] **Step 1: Add failing assertions for conflict cleanup**

Extend the conflict test to assert the original target HEAD and file content are restored, the index is clean, and no cherry-pick state remains:

```ts
import { readFile, stat } from "node:fs/promises";

expect((await exec("git", ["-C", item.repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
expect(await readFile(join(item.repo, "value.txt"), "utf8")).toBe("target\n");
expect((await exec("git", ["-C", item.repo, "status", "--porcelain"])).stdout).toBe("");
await expect(stat(join(item.repo, ".git", "CHERRY_PICK_HEAD"))).rejects.toThrow();
```

Add a test command fixture that exits non-zero and assert staged changes remain after `test_failed`:

```ts
const result = await executeLocalIntegration({ ...input, commands: [{ command: process.execPath, argsPrefix: ["-e", "process.exit(7)"] }] });
expect(result.status).toBe("test_failed");
expect((await exec("git", ["-C", item.repo, "diff", "--cached", "--name-only"])).stdout).toContain("feature.txt");
```

- [ ] **Step 2: Run the focused tests and verify RED where cleanup is incomplete**

Run: `npm test -- server/src/integration.test.ts`

Expected: the new assertions expose any incomplete no-commit conflict cleanup.

- [ ] **Step 3: Restore only the clean pre-operation target on conflict**

In the catch block, abort the sequencer when present and restore the captured target HEAD:

```ts
try { await git(input.repoPath, ["cherry-pick", "--abort"]); } catch { /* no active sequencer */ }
await git(input.repoPath, ["reset", "--hard", targetCommit]);
```

This reset is permitted only after preflight proved the target clean and only inside the integration failure path.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- server/src/integration.test.ts`

Expected: success, conflict cleanup, and failed-test retention tests all pass.

- [ ] **Step 5: Commit safety behavior**

```bash
git add server/src/integration.ts server/src/integration.test.ts
git commit -m "test: cover uncommitted integration recovery"
```

### Task 3: Record And Describe Local Application Correctly

**Files:**
- Modify: `server/src/app.test.ts`
- Modify: `server/src/app.ts`
- Modify: `web/src/integration-view.test.ts`
- Modify: `web/src/integration-view.ts`
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Add failing view and API expectations**

Add view fields that centralize the action copy:

```ts
expect(integrationView("awaiting_merge", { allowed: true, checks: [] }, null)).toMatchObject({
  actionLabel: "应用到本地工作区",
  safetyLabel: "保留为本地未提交改动，不会 commit，不会 push"
});
```

In the integration API test fixture, assert the completed record's `targetCommit` equals the pre-application target HEAD rather than a generated integration commit.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- web/src/integration-view.test.ts server/src/app.test.ts`

Expected: FAIL because the view does not expose the new copy and current API semantics still describe merging.

- [ ] **Step 3: Update server result wording and view model**

Use `本地应用后测试失败` in the test-rerun completion path. Return these view fields from `integrationView`:

```ts
actionLabel: "应用到本地工作区",
safetyLabel: "保留为本地未提交改动，不会 commit，不会 push"
```

- [ ] **Step 4: Update the panel, confirmation dialog, and result labels**

Make the component text explicit:

```tsx
<span>{view.safetyLabel}</span>
<button>{view.actionLabel}</button>
```

The confirmation modal title is `应用到本地工作区`; its subtitle says the change set will remain staged and uncommitted. Label `targetCommit` as `应用前目标提交`, and show:

```tsx
<p>下一步：检查暂存改动后，由你手动执行 git commit。</p>
```

Remove all claims that the workflow creates a local target commit or performs a normal cherry-pick merge.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- web/src/integration-view.test.ts server/src/app.test.ts && npm run typecheck`

Expected: all focused tests and workspace typecheck pass.

- [ ] **Step 6: Commit API and UI semantics**

```bash
git add server/src/app.ts server/src/app.test.ts web/src/integration-view.ts web/src/integration-view.test.ts web/src/main.tsx
git commit -m "feat: clarify local uncommitted application"
```

### Task 4: Full Safety Verification

**Files:**
- Verify only; do not modify the Soto Dine repository.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass, TypeScript reports no errors, and Vite production build succeeds.

- [ ] **Step 2: Capture Soto Dine safety baseline**

Run:

```bash
git -C /Users/whp/Documents/workspace/haini-workspace/soto-dine status --porcelain
git -C /Users/whp/Documents/workspace/haini-workspace/soto-dine rev-parse HEAD
git -C /Users/whp/Documents/workspace/haini-workspace/soto-dine branch --show-current
```

Record the output. Do not clean or reset the existing repository state.

- [ ] **Step 3: Browser-verify wording without applying changes**

Open an integration-stage requirement and confirm the panel shows `应用到本地工作区` and `不会 commit，不会 push`. Open and cancel the confirmation dialog. Do not confirm the application.

- [ ] **Step 4: Confirm Soto Dine is unchanged**

Repeat the Step 2 commands and compare exact status, HEAD, and branch output to the baseline.

- [ ] **Step 5: Commit any test-only documentation adjustment, if one was required**

No commit is needed when verification makes no file changes. Never stage or push files in the Soto Dine repository.
