# Integration Conflict Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a failed local application to reuse its source commit, show conflict files, and retry without committing or pushing the target branch.

**Architecture:** Extend integration preflight with an optional reusable source commit. Validate its branch ancestry and canonical patch hash, use it instead of requiring an uncommitted worktree diff, and return structured conflict paths. The API derives the reusable commit only from the latest matching conflict run; the UI renders those details and changes the action label for retries.

**Tech Stack:** TypeScript, Fastify, React, Git CLI, Vitest

---

### Task 1: Commit-backed integration evidence

**Files:**
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/integration.ts`

- [ ] **Step 1: Write failing tests**

Add tests that create a source commit, confirm the clean worktree fails without `sourceCommit`, then confirm preflight accepts the matching commit and rejects a commit whose patch hash differs.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/integration.test.ts`
Expected: FAIL because `sourceCommit` is not part of the integration input and clean worktrees remain invalid.

- [ ] **Step 3: Implement canonical commit evidence**

Extend `Input` with `sourceCommit?: string`. Read the commit patch using `git diff <commit>^ <commit> -- .`, verify the commit is an ancestor of the expected source branch, and compare `hashDiff(commitPatch)` with `evidenceDiffHash`. Return `evidenceMode: "worktree" | "commit"` and the resolved source commit from preflight.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/integration.test.ts`
Expected: PASS.

### Task 2: Conflict capture and source commit reuse

**Files:**
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/integration.ts`

- [ ] **Step 1: Write failing tests**

Extend the conflict test to require `conflictFiles: ["value.txt"]`. Add a retry test proving `executeLocalIntegration` accepts the prior `sourceCommit` and does not create a second source commit.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/integration.test.ts`
Expected: FAIL because conflict paths are absent and execution always commits the worktree.

- [ ] **Step 3: Implement conflict capture and reuse**

Before abort/reset, obtain unresolved files with `git diff --name-only --diff-filter=U`. If preflight resolves commit evidence, skip `git add` and `git commit` and apply the validated source commit directly. Return `conflictFiles` on conflict.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/integration.test.ts`
Expected: PASS.

### Task 3: API retry context

**Files:**
- Modify: `server/src/app.test.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write failing API test**

Create a latest conflict integration run matching requirement, evidence, source branch, worktree, and target branch. Assert `integration-check` passes the recorded `sourceCommit` into preflight and a different target branch does not reuse it.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/app.test.ts`
Expected: FAIL because `integrationContext` never returns a reusable source commit.

- [ ] **Step 3: Implement matching rules**

Add a helper that returns the latest conflict run's source commit only when requirement, evidence, execution, source branch, worktree, and target branch match. Include it in preflight and execution input.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/app.test.ts`
Expected: PASS.

### Task 4: Retry user interface

**Files:**
- Modify: `web/src/integration-view.test.ts`
- Modify: `web/src/integration-view.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing view tests**

Assert a conflict run plus allowed preflight yields label `应用冲突`, action label `重新应用到本地`, and `canIntegrate: true`. Assert invalid commit evidence remains disabled with the failed check detail.

- [ ] **Step 2: Verify RED**

Run: `npm test -- web/src/integration-view.test.ts`
Expected: FAIL because the action label is always `应用到本地工作区`.

- [ ] **Step 3: Implement retry presentation**

Derive the retry action label from the latest run status. Render source commit and `conflictFiles` in a compact conflict block above the integration actions. Preserve protected-target confirmation and no-push messaging.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- web/src/integration-view.test.ts`
Expected: PASS.

### Task 5: Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused tests**

Run: `npm test -- server/src/integration.test.ts server/src/app.test.ts web/src/integration-view.test.ts`
Expected: all focused tests pass.

- [ ] **Step 2: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass, typecheck exits 0, production build exits 0.

- [ ] **Step 3: Verify repositories**

Confirm the Soto Dine target repository remains on `feature/0710-serious-msg`, is clean, and has not been pushed. Confirm only intended workflow files changed.
