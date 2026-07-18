# Local Code Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual local-code-integration stage that creates one AI-branch commit, cherry-picks it to the configured local default branch, runs allowlisted tests, and never pushes.

**Architecture:** Extend the domain with a non-AI `integration` stage and dedicated statuses. Keep Git preflight and mutation in a focused integration service, persist immutable integration runs in SQLite, expose narrow APIs, and render a dedicated merge workspace in the existing requirement detail page.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Vitest, Git CLI

---

### Task 1: Workflow domain

**Files:** `shared/src/domain.ts`, `shared/src/domain.test.ts`

- [x] Add failing tests proving acceptance advances to integration and integration is labeled “代码合并”.
- [x] Run `npm test -- shared/src/domain.test.ts` and verify the new assertions fail.
- [x] Add `integration`, `awaiting_merge`, and `merge_test_failed`; update labels and return routing.
- [x] Run the domain tests and verify they pass.

### Task 2: Git preflight and integration executor

**Files:** `server/src/integration.ts`, `server/src/integration.test.ts`

- [x] Add failing temporary-repository tests for clean preflight, dirty target rejection, successful commit/cherry-pick, and conflict abort.
- [x] Run `npm test -- server/src/integration.test.ts` and verify failure because the module is missing.
- [x] Implement parameter-array Git calls, preflight checks, source commit creation, cherry-pick with abort, and allowlisted command execution.
- [x] Run the integration tests and verify all temporary repositories pass.

### Task 3: Persistence and API

**Files:** `server/src/store.ts`, `server/src/store.test.ts`, `server/src/app.ts`, `server/src/app.test.ts`

- [x] Add failing Store tests for immutable integration runs, one running record, successful completion, and test-failed state.
- [x] Implement the `integration_runs` migration and Store methods.
- [x] Add failing API tests for acceptance-to-integration flow, read-only preflight, duplicate rejection, and rerun-test permissions.
- [x] Implement integration detail payload and the three dedicated endpoints, using project paths and commands only from persisted configuration.
- [x] Run all server tests and verify they pass.

### Task 4: Integration workspace UI

**Files:** `web/src/integration-view.ts`, `web/src/integration-view.test.ts`, `web/src/main.tsx`, `web/src/associations.css`

- [x] Add failing view tests for check-list state, button eligibility, target branch, conflict, test failure, and completion labels.
- [x] Implement the pure view helper and dedicated code-integration panel.
- [x] Add “重新检查”, “合并到本地分支”, confirmation modal, polling state, and “重新运行合并后测试”.
- [x] Show source/target commits, test commands, errors, and the explicit “不会 push” notice.
- [x] Run all web tests and verify they pass.

### Task 5: Verification

**Files:** only files required by defects found during verification.

- [x] Run `npm test`, `npm run typecheck`, and `npm run build` with zero failures.
- [x] Browser-check the new timeline node and integration panel without submitting a real point-of-sale merge.
- [x] Confirm point-of-sale main worktree remains unchanged and no push occurred.
