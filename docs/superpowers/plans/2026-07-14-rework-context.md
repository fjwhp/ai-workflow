# Rework Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show structured return reasons prominently and pass the same immutable rework checklist into the responsible AI stage.

**Architecture:** Build a normalized rework context from an approval plus its source Artifact. Persist one context per return approval, expose a compatibility context for existing returned requirements, and lock it into each rework Stage Run input.

**Tech Stack:** TypeScript, SQLite, Fastify, React, Vitest.

---

### Task 1: Rework context builder

**Files:** Create `server/src/rework-context.ts`, `server/src/rework-context.test.ts`.

- [ ] Write failing tests for structured findings, severity ordering and approval-only fallback.
- [ ] Implement stable item IDs and normalized context.

### Task 2: Persistence and return integration

**Files:** Modify `server/src/store.ts`, `server/src/store.test.ts`, `server/src/app.ts`.

- [ ] Add immutable `rework_contexts` table and one-per-approval constraint.
- [ ] Persist contexts for AI and human returns.
- [ ] Derive a compatibility context for historical returned requirements.

### Task 3: Rework AI input

**Files:** Modify `server/src/app.ts`, `server/src/codex-runner.ts`.

- [ ] Lock the latest context into the Stage Run input.
- [ ] Add an explicit rework checklist section to the Codex prompt.
- [ ] Preserve the context ID in coding output.

### Task 4: Return reason panel

**Files:** Modify `web/src/main.tsx`, `web/src/associations.css`; create `web/src/rework-view.ts` and tests.

- [ ] Show source/target/time/actor and grouped severity counts.
- [ ] Expand S0/S1 and collapse S2/S3 by default.
- [ ] Display evidence, impact and recommendation for every item.

### Task 5: Verification

- [ ] Run full tests, typecheck and build.
- [ ] Verify `REQ-0005` displays Code Review v3 reasons while its current AI run remains uninterrupted.
- [ ] Confirm point-of-sale main worktree is unchanged and no push occurs.
