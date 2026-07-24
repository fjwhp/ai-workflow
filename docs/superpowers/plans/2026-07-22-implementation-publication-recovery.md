# Implementation Publication Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Atomically publish delivery implementation evidence with its automation job and recover every crash window without accepting ambiguous repository state.

**Architecture:** Persist an immutable publication journal before touching the authoritative worktree. Use one synchronous `BEGIN IMMEDIATE` section for lease fencing, Git publication, evidence/job settlement, and journal commit; reconcile prepared/committed journals before normal startup recovery.

**Tech Stack:** TypeScript, Node.js `DatabaseSync`, synchronous `child_process.spawnSync`, Git binary patches, Vitest child-process acceptance tests.

---

### Task 1: Journal Schema And Prepared Payload

**Files:**
- Modify: `server/src/database-schema.ts`
- Create: `server/src/implementation-publication.ts`
- Create: `server/src/implementation-publication.test.ts`
- Modify: `server/src/database-schema.test.ts`

- [x] **Step 1: Write failing schema tests**

Assert that the journal requires exact job/token/worker, unit/version, execution/run, attempt identity, repository identity, bounded patch metadata, publication status, and cleanup status; assert both uniqueness keys reject duplicates.

- [x] **Step 2: Run RED**

Run: `npx vitest run server/src/database-schema.test.ts server/src/implementation-publication.test.ts`

Expected: FAIL because the table and preparation API do not exist.

- [x] **Step 3: Implement minimal schema and preparation primitives**

Add the table, checks, foreign keys, and unique indexes. Add synchronous helpers that validate paths/hashes/identity, cap a binary patch at 8 MiB, compute SHA-256, and execute Git with fixed arguments, stdin, bounded output, disabled hooks/config, and `shell: false`.

- [x] **Step 4: Run GREEN**

Run the same focused command and require all tests to pass.

### Task 2: Atomic Publication And Same-Token Settlement

**Files:**
- Modify: `server/src/delivery-execution-repository.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/delivery-execution-service.ts`
- Modify: `server/src/automation-job-repository.ts`
- Modify: `server/src/automation-worker.ts`
- Modify: `server/src/delivery-execution-service.test.ts`
- Modify: `server/src/automation-worker.test.ts`

- [x] **Step 1: Write failing atomicity and idempotence tests**

Use a file-backed database and real repository. Assert one call publishes the expected diff and atomically leaves one coding-evidence row, one review job, one test job, completed implementation job, and committed journal. Inject a DB settlement failure and assert no evidence/job split. Reinvoke with the same claim token and assert no agent rerun or duplicate row.

- [x] **Step 2: Run RED**

Run: `npx vitest run server/src/delivery-execution-service.test.ts server/src/automation-worker.test.ts server/src/implementation-publication.test.ts`

Expected: FAIL because publication and job completion are separate.

- [x] **Step 3: Implement minimal synchronous transaction API**

Move authoritative publication behind `WorkflowStore`: prepare the journal in a short transaction; then acquire `BEGIN IMMEDIATE`, reload lease/journal, synchronously verify/apply/capture, call the existing in-transaction evidence/coordinator methods, complete the exact job lease, mark journal committed, and commit. Return `{ unit, alreadySettled }` so the worker skips duplicate completion.

- [x] **Step 4: Run GREEN and regression tests**

Run the RED command plus `server/src/automation-job-repository.test.ts`; require all pass.

### Task 3: Startup Reconciliation And Cleanup Isolation

**Files:**
- Create: `server/src/implementation-publication-recovery.ts`
- Create: `server/src/implementation-publication-recovery.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/index.test.ts`
- Modify: `server/src/repository.ts`

- [x] **Step 1: Write failing recovery tests**

Cover prepared+clean cancellation, prepared+exact patch reverse/retry, prepared+other dirty manual failure, committed cleanup retry, and cleanup rejection preserving singular completed job/evidence.

- [x] **Step 2: Add real SIGKILL RED**

Fork a child against a file-backed database and repository. Pause through a test-only child barrier immediately after real apply, send `SIGKILL`, restart through the production reconciliation entry, and assert a clean authoritative tree plus no owned attempt/marker/worktree registration.

- [x] **Step 3: Run RED**

Run: `npx vitest run server/src/implementation-publication-recovery.test.ts server/src/index.test.ts`

Expected: FAIL because startup does not reconcile journals before worker recovery.

- [x] **Step 4: Implement recovery state machine**

Add a bounded synchronous scanner and exact-state classification. Reverse only an exact journal patch, mark ambiguous state manual and throw a stable startup error, and invoke owned attempt cleanup outside the DB transaction. Reorder startup so this completes before all existing interruption/recovery calls.

- [x] **Step 5: Run GREEN**

Run the same focused command and require all tests to pass.

### Task 4: Cross-Process Lease Barrier

**Files:**
- Create: `server/src/implementation-publication-concurrency.test.ts`
- Modify: `server/src/implementation-publication.ts`
- Modify: `server/src/store.ts`

- [x] **Step 1: Write two-child RED**

Start two children sharing one SQLite file and authoritative repository. Hold both after attempt preparation, expire/reassign the first lease, release publication, and assert the stale token cannot apply while the current token creates the only final diff/evidence.

- [x] **Step 2: Run RED**

Run: `npx vitest run server/src/implementation-publication-concurrency.test.ts`

Expected: FAIL while publication depends on the process-local repository lock or checks outside the SQLite writer transaction.

- [x] **Step 3: Complete cross-process fencing**

Ensure every baseline/fence/apply/DB-commit operation is inside the same synchronous writer transaction and remove the process-local lock from publication correctness.

- [x] **Step 4: Run GREEN repeatedly**

Run the concurrency test three times and require the same singular result each time.

### Task 5: A-C Verification And Local Commit

**Files:** all A-C files above.

- [x] **Step 1: Run affected tests three times**

Run the focused schema/publication/recovery/concurrency/worker/service set three times.

- [x] **Step 2: Run project verification**

Run `RUN_MACOS_SANDBOX_ACCEPTANCE=1 npm test`, `npm run build`, `npm run typecheck`, and `git diff --check`.

- [x] **Step 3: Review invariants**

Confirm no asynchronous Git call is reachable inside the synchronous SQLite transaction, no evidence can commit while its implement job remains leased, and cleanup errors cannot reverse committed business state.

- [x] **Step 4: Commit locally**

Run `git add` only for A-C files and commit with `fix: make implementation publication recoverable`. Do not push.
