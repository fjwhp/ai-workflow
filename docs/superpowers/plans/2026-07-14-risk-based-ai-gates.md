# Risk-Based AI Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically approve clear low-risk AI artifacts, automatically return clearly blocked artifacts, and request humans only for ambiguous or mandatory stages.

**Architecture:** A pure gate evaluator converts an artifact plus persisted configuration into one explainable decision. The store applies that decision idempotently in a transaction, while the API exposes configuration and includes gate records in requirement details.

**Tech Stack:** TypeScript, Fastify, Node SQLite, React, Vitest.

---

### Task 1: Deterministic gate evaluator

**Files:**
- Create: `shared/src/gate.ts`
- Create: `shared/src/gate.test.ts`
- Modify: `shared/src/index.ts`

- [ ] Write failing tests for auto-approve, conclusion return, S0 return, low confidence, conditional, S1, risks, questions, disabled automation, coding and acceptance.
- [ ] Run `npm test -- shared/src/gate.test.ts` and confirm the evaluator is missing.
- [ ] Implement `evaluateGate(stage, artifact, config)` returning `auto_approve`, `auto_return`, or `human_review` with readable reasons.
- [ ] Re-run the focused test and confirm all cases pass.

### Task 2: Persist configuration and idempotent decisions

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`

- [ ] Write failing tests for default/update configuration and one gate decision per artifact.
- [ ] Add settings storage plus approval columns `actor_type`, `artifact_id`, and `reasons_json` through backward-compatible migrations.
- [ ] Implement config read/update and transactional `applyGateDecision` that advances one stage, returns one stage, or waits for a human.
- [ ] Re-run store tests and confirm duplicate processing does not create duplicate approvals or move twice.

### Task 3: Apply gates after AI completion

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] Write failing API tests for gate configuration GET/PATCH and resulting requirement state.
- [ ] After Artifact creation, evaluate and apply the gate for coding and ordinary AI runs instead of always setting `awaiting_approval`.
- [ ] Add gate lifecycle events and return gate records from requirement details.
- [ ] Re-run API tests and confirm configuration validation and state transitions pass.

### Task 4: Explain gates and configure policy in the UI

**Files:**
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles.css`
- Create: `web/src/gate-view.ts`
- Create: `web/src/gate-view.test.ts`

- [ ] Write failing helper tests for latest stage gate and human-review reason formatting.
- [ ] Display AI automatic decisions and human-review trigger reasons in requirement details.
- [ ] Add settings controls for automation, confidence threshold, and mandatory human stages.
- [ ] Verify controls save to SQLite and refresh without losing values.

### Task 5: Full verification

**Files:**
- Modify only files above if verification reveals a defect.

- [ ] Run `npm test -- --run`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Verify auto-approve, human review, and auto-return through API fixtures or browser-visible requirements.
- [ ] Inspect the desktop and mobile UI, browser console, and point-of-sale project Git status.
