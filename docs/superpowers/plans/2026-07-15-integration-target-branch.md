# Integration Target Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each requirement safely select its local integration target branch, defaulting to the repository's current branch instead of the project's production default.

**Architecture:** Add a nullable requirement field and focused repository branch helpers. Dedicated APIs expose validated local branches and persist one requirement target; preflight and integration consume only that saved target. The UI always renders the merge button and makes eligibility visible.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Vitest, Git CLI

---

### Task 1: Local branch discovery

**Files:** `server/src/repository.ts`, `server/src/repository.test.ts`

- [ ] Add failing temporary-repository tests for current branch, local branch listing and protected branch classification.
- [ ] Implement parameter-array Git helpers and protected-name detection.
- [ ] Run focused repository tests.

### Task 2: Requirement target persistence and APIs

**Files:** `server/src/store.ts`, `server/src/store.test.ts`, `server/src/app.ts`, `server/src/app.test.ts`

- [ ] Add failing Store tests for migration-compatible target save/read.
- [ ] Implement `integration_target_branch` and guarded setter.
- [ ] Add failing API tests for branch listing, invalid branch, wrong stage and protected confirmation.
- [ ] Implement branch list/target APIs and use saved target in preflight, integration records and execution.
- [ ] Run server tests and typecheck.

### Task 3: Target selector and persistent merge action

**Files:** `web/src/integration-view.ts`, `web/src/integration-view.test.ts`, `web/src/main.tsx`, `web/src/associations.css`

- [ ] Add failing view tests proving the button is always visible, disabled with reasons, and protected targets require confirmation.
- [ ] Add the local branch selector, current/protected labels and automatic current-branch selection when unset.
- [ ] Keep the merge button rendered in every integration state and show all failed preflight reasons.
- [ ] Update confirmation modal to show the exact target and require protected branch text confirmation.
- [ ] Run web tests and typecheck.

### Task 4: Verification

- [ ] Run all tests, typecheck and production build.
- [ ] Browser-verify REQ-0005 selects `feature/0710-serious-msg`, preflight passes and merge button becomes enabled.
- [ ] Do not click merge; confirm Soto Dine status and history remain unchanged and no push occurs.
