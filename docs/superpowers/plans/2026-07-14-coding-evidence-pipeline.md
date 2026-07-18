# Coding Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist immutable Git evidence for every coding execution and pass verified evidence into code review, testing, and acceptance AI contexts.

**Architecture:** A pure evidence builder hashes and truncates Git diff while preserving metadata. SQLite links one evidence snapshot to each coding execution; downstream runs resolve and validate the latest snapshot before invoking AI.

**Tech Stack:** TypeScript, Node crypto/fs, Git CLI, SQLite, Fastify, React, Vitest.

---

### Task 1: Evidence builder

**Files:** Create `server/src/coding-evidence.ts`, `server/src/coding-evidence.test.ts`.

- [ ] Write failing tests for stable SHA-256, diff truncation and metadata.
- [ ] Implement the pure snapshot builder and verify focused tests.

### Task 2: Evidence persistence

**Files:** Modify `server/src/store.ts`, `server/src/store.test.ts`.

- [ ] Write failing tests for immutable one-to-one evidence and latest selection.
- [ ] Add `coding_evidence` migration and store APIs.
- [ ] Verify focused store tests.

### Task 3: Capture and transmit evidence

**Files:** Modify `server/src/app.ts`, `server/src/repository.ts`, `server/src/app.test.ts`.

- [ ] Capture evidence after Codex diff and before creating the coding Artifact.
- [ ] Resolve and validate evidence for code review, testing and acceptance.
- [ ] Include evidence ID, hash, diff, file metadata and diagnostics in AI context and Artifact.
- [ ] Create a deterministic human-review Artifact when evidence is missing or stale.

### Task 4: Evidence UI

**Files:** Modify `web/src/main.tsx`, `web/src/execution.css`; create helper tests if needed.

- [ ] Display evidence state, execution ID, hash, file count, line stats and truncation.
- [ ] Provide an expandable evidence diff in coding and downstream stages.

### Task 5: Verification

- [ ] Run all tests, typecheck and production build.
- [ ] Re-run `REQ-0005` coding to generate evidence, approve coding, run code review, and confirm the Review input references the real diff.
- [ ] Confirm no push and no point-of-sale main-worktree modification.
