# Inline AI Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the active Stage Run as a Codex-like, user-visible event stream inside the current workflow stage.

**Architecture:** A pure `stream-view` module converts persisted events into safe display entries and merges model deltas. A focused React component owns snapshot recovery, SSE updates, connection state and scroll following, while the existing modal remains the full-detail surface.

**Tech Stack:** TypeScript, React, EventSource/SSE, Vitest, CSS

---

### Task 1: Safe stream event model

**Files:** `web/src/stream-view.ts`, `web/src/stream-view.test.ts`

- [x] Add failing tests for reasoning filtering, output-delta merging, sequence deduplication, Codex command/file normalization and terminal entries.
- [x] Run the focused test and verify it fails because the module is missing.
- [x] Implement the pure normalization and merge functions.
- [x] Run the focused test and verify all cases pass.

### Task 2: Inline SSE component

**Files:** `web/src/inline-run-stream.tsx`, `web/src/main.tsx`, `web/src/run-observability.css`

- [x] Add the component with snapshot recovery, last-sequence SSE connection, reconnect indicator and terminal refresh callback.
- [x] Add safe visible-event cards, merged model output, collapsible command/diagnostic output and full-detail action.
- [x] Add bounded internal scrolling, auto-follow pause and “回到最新”.
- [x] Replace the current empty/artifact body with the inline stream only while the current stage is `ai_running`.
- [x] Keep stop disabled with a clear unsupported explanation.

### Task 3: Verification

**Files:** only files required by defects found during verification.

- [x] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [x] Browser-verify running and recovered streams at desktop and mobile widths without modifying the point-of-sale main worktree.
- [x] Confirm no internal reasoning appears and the full execution modal remains accessible.
