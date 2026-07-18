# AI Run Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every workflow AI run clickable and observable through a persisted, real-time execution details modal.

**Architecture:** Store one `stage_runs` record and ordered `stage_run_events` for each invocation. The server writes redacted lifecycle/output events and exposes snapshot plus SSE endpoints; the React client opens a four-tab modal and reconnects from the last event sequence.

**Tech Stack:** TypeScript, Fastify 5, Node SQLite, OpenAI-compatible API, React 19, Vitest, SSE.

---

### Task 1: Persist stage runs and ordered events

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`
- Create: `server/src/redaction.ts`
- Create: `server/src/redaction.test.ts`

- [ ] Write failing store tests that create a run, append two events, verify stable sequence order, complete/fail the run, reject a second active run, and recover interrupted runs.
- [ ] Write failing redaction tests for sensitive object keys, bearer tokens, private-key blocks and project patterns.
- [ ] Run `npm test -- server/src/store.test.ts server/src/redaction.test.ts` and confirm failures are caused by missing run/event APIs.
- [ ] Add the `stage_run_events` migration and store methods `createStageRun`, `appendStageRunEvent`, `getStageRun`, `listStageRuns`, `completeStageRun`, `failStageRun`, and `interruptActiveStageRuns`.
- [ ] Add a recursive `redactSensitive(value, patterns)` helper that returns a sanitized copy and never mutates its input.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Emit observable events from all AI runs

**Files:**
- Modify: `server/src/ai.ts`
- Modify: `server/src/codex-runner.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] Write failing API tests asserting `/run` creates a run immediately, duplicate active runs return `409`, run snapshots can be filtered by stage, and SSE replays events after `Last-Event-ID`.
- [ ] Run `npm test -- server/src/app.test.ts` and confirm the new API assertions fail.
- [ ] Extend `runAgent` and `runCodexCoding` with an event callback. Emit request, output, Codex command/file/message, parsed-result, completion and failure events without exposing secrets.
- [ ] Change `POST /api/requirements/:id/run` to create the persisted run before execution, write lifecycle events, and complete/fail the run alongside existing Artifact and requirement-state behavior.
- [ ] Add `GET /api/requirements/:id/runs`, `GET /api/runs/:runId`, and `GET /api/runs/:runId/events` SSE endpoints with ordered replay and keep-alive.
- [ ] Re-run the focused API tests and confirm they pass.

### Task 3: Add the execution details modal

**Files:**
- Create: `web/src/run-observability.ts`
- Create: `web/src/run-observability.test.ts`
- Create: `web/src/run-observability.css`
- Modify: `web/src/api.ts`
- Modify: `web/src/main.tsx`

- [ ] Write failing frontend helper tests for stage-specific latest-run selection, event de-duplication by sequence, terminal-state detection and readable event labels.
- [ ] Run `npm test -- web/src/run-observability.test.ts` and confirm the helper module is missing.
- [ ] Implement typed run/event helpers and add API methods for run snapshots.
- [ ] Make the current `AI 处理中` status and a `查看执行` command open the matching run. Allow historical nodes with runs to open their latest record.
- [ ] Implement a wide modal with `执行过程`, `输入上下文`, `原始输出`, and `最终结果` tabs; connect `EventSource`, replay persisted events, de-duplicate events and refresh requirement details on terminal events.
- [ ] Add responsive styling with stable modal dimensions, scroll regions and non-overlapping controls.
- [ ] Re-run frontend tests and confirm they pass.

### Task 4: Regression and browser verification

**Files:**
- Modify only if verification exposes a defect in the files above.

- [ ] Run `npm test -- --run` and confirm all tests pass.
- [ ] Run `npm run typecheck` and confirm all workspaces typecheck.
- [ ] Run `npm run build` and confirm the production bundle builds.
- [ ] Start the app with `.env`, open a requirement in `ai_running`, click the status, and verify the matching stage run appears.
- [ ] Verify all four tabs, no console errors, historical run access, terminal refresh behavior, and mobile/desktop layout.
- [ ] Confirm the target point-of-sale project working tree was not modified by this verification.
