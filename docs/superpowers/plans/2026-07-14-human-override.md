# Human Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a human to explicitly advance Code Review and automated testing after inspecting the latest AI artifact, with mandatory comments and immutable audit evidence.

**Architecture:** Add a focused eligibility/snapshot helper, then expose one transactional store operation through a dedicated API endpoint. The requirement detail payload carries eligibility to a dedicated web view helper and confirmation modal, keeping normal approval and AI gate behavior unchanged.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Vitest

---

### Task 1: Eligibility and audit snapshot

**Files:**
- Create: `server/src/human-override.ts`
- Create: `server/src/human-override.test.ts`

- [ ] **Step 1: Write failing tests** for allowed stages, running/no-artifact rejection, trimmed comments, return counting, and risk/question snapshots.
- [ ] **Step 2: Run `npm test -- server/src/human-override.test.ts`** and verify failure because the helper is missing.
- [ ] **Step 3: Implement `buildHumanOverrideEligibility` and `buildHumanOverrideSnapshot`** as pure functions with explicit reason strings.
- [ ] **Step 4: Run `npm test -- server/src/human-override.test.ts`** and verify all helper tests pass.

### Task 2: Atomic persistence and API flow

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing store tests** proving approval insertion and stage advancement happen together and carry `human_override`, Artifact ID, return count, risks and questions.
- [ ] **Step 2: Run `npm test -- server/src/store.test.ts`** and verify failure on the missing store operation.
- [ ] **Step 3: Add migration columns and `applyHumanOverride`** using a SQLite transaction; update approval row mapping without changing existing records.
- [ ] **Step 4: Run the store tests** and verify they pass.
- [ ] **Step 5: Write failing API tests** for successful `code_review`/`testing` flow and rejection for empty comment, wrong stage, running state, missing Artifact and repeated request.
- [ ] **Step 6: Run `npm test -- server/src/app.test.ts`** and verify expected route failures.
- [ ] **Step 7: Add eligibility to requirement details and implement `POST /api/requirements/:id/human-override`** with schema validation and current-state revalidation.
- [ ] **Step 8: Run server tests** and verify all pass.

### Task 3: Visible, controlled interface

**Files:**
- Create: `web/src/human-override-view.ts`
- Create: `web/src/human-override-view.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing view-helper tests** proving the entry is always visible in `code_review` and `testing`, disabled with a reason when ineligible, and names the correct next stage.
- [ ] **Step 2: Run `npm test -- web/src/human-override-view.test.ts`** and verify failure because the helper is missing.
- [ ] **Step 3: Implement the view helper**, extend `Detail`, render the persistent action-panel entry, and add a confirmation modal with AI summary, risks, questions, return count, target stage and required comment.
- [ ] **Step 4: Add restrained warning and audit styles** to `web/src/associations.css`.
- [ ] **Step 5: Run web tests** and verify all pass.

### Task 4: Full verification

**Files:**
- Modify only files required by defects found during verification.

- [ ] **Step 1: Run `npm test`** and require zero failures.
- [ ] **Step 2: Run `npm run typecheck`** and require zero TypeScript errors.
- [ ] **Step 3: Run `npm run build`** and require a successful Vite production build.
- [ ] **Step 4: Reload `http://127.0.0.1:5173` in the in-app browser** and verify the button, disabled reasons, modal data, required comment behavior, successful transition and approval history label.
- [ ] **Step 5: Check `/Users/whp/Documents/workspace/haini-workspace/soto-dine`** and verify its main worktree remains unchanged; do not push.
