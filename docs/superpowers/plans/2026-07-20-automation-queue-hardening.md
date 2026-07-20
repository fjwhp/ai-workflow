# Automation Queue Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automation leasing atomic and make every stored automation-job read fail closed while tightening the reachable SQLite schema and v3 reset contract.

**Architecture:** A single runtime row decoder owns persisted-row validation and is called by every repository read path. SQLite constraints mirror reachable application states, while `leaseNext` decodes inside its write transaction and preserves the original error during best-effort rollback.

**Tech Stack:** TypeScript, Node.js `DatabaseSync`, SQLite, Vitest, Node.js worker threads

---

### Task 1: Atomic Lease Failure Handling

**Files:**
- Modify: `server/src/automation-job-repository.test.ts`
- Modify: `server/src/automation-job-repository.ts`

- [ ] **Step 1: Write failing transaction tests**

Add tests that persist SQLite-valid `1e999`, call `leaseNext`, expect the stored-row error, and query the
database directly for `{ status: "pending", attempt: 0 }`. Add a `BEFORE UPDATE` trigger using
`RAISE(ROLLBACK, 'forced lease rollback')` and assert that exact original error plus unchanged state.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: payload corruption commits a partial lease, and the rollback trigger error is masked by a
second rollback attempt.

- [ ] **Step 3: Decode before commit with guarded rollback**

Implement this control flow:

```ts
const job = decodeAutomationJobRow(row);
this.db.exec("COMMIT");
return job;
```

In the catch path, test `this.db.isTransaction`, attempt rollback inside its own `try/catch`, and always
rethrow the original error.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: both transaction tests pass with no partial lease.

### Task 2: Complete Stored-Row Decoder

**Files:**
- Modify: `server/src/automation-job-repository.test.ts`
- Modify: `server/src/automation-job-repository.ts`

- [ ] **Step 1: Write failing table-driven corruption tests**

Use `PRAGMA ignore_check_constraints = ON` to corrupt independent row groups and assert that `get`,
`byDedupe`, `listPending`, and `leaseNext` throw `AUTOMATION_JOB_ROW_INVALID`. Cover runtime text types,
unknown enums, unsafe owner IDs, noncanonical keys, counters, status-attempt combinations, lease pairs,
payloads, timestamps, and nullable errors.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: existing mapper returns invented enums, string counters, and invalid dates, or leaks the
payload-specific stored error.

- [ ] **Step 3: Implement one fail-closed decoder**

Decode `unknown` through a record guard, validate every field and invariant, parse the payload, and wrap
all stored-row failures:

```ts
function decodeAutomationJobRow(value: unknown): AutomationJob {
  try {
    // Validate all fields and cross-field invariants, then return the job.
  } catch {
    throw new Error("AUTOMATION_JOB_ROW_INVALID");
  }
}
```

Call it from enqueue-after-select, get, byDedupe, listPending, and leaseNext. Keep public input validators
outside the wrapper.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: all row corruption groups fail with the stable row error.

### Task 3: Reachable DDL And NUL Safety

**Files:**
- Modify: `server/src/database-schema.test.ts`
- Modify: `server/src/database-schema.ts`
- Modify: `server/src/automation-job-repository.test.ts`
- Modify: `server/src/automation-job-repository.ts`

- [ ] **Step 1: Write failing schema and selector tests**

Assert direct exhausted pending and attempt-zero leased inserts fail. Add direct embedded-NUL cases for
every constrained text group, plus a repository Unicode round trip. Assert `listPending` excludes an
exhausted row injected with ignored checks and use `EXPLAIN QUERY PLAN` to require
`idx_automation_jobs_pending_lease`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/database-schema.test.ts server/src/automation-job-repository.test.ts`

Expected: unreachable states and selected NUL strings are accepted, and listPending includes an
ineligible row.

- [ ] **Step 3: Tighten DDL and list selector**

Add the status-dependent attempt check, explicit `instr(value, char(0)) = 0` checks before length or
format checks, and change listPending to:

```sql
SELECT * FROM automation_jobs
WHERE status = 'pending' AND attempt < max_attempts
ORDER BY created_at, id
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/database-schema.test.ts server/src/automation-job-repository.test.ts`

Expected: DDL, NUL, eligibility, Unicode, and query-plan assertions pass.

### Task 4: Real Concurrent Leasing

**Files:**
- Modify: `server/src/automation-job-repository.test.ts`

- [ ] **Step 1: Write the failing worker-thread barrier test**

Open one connection per worker, wait for both ready messages, send go to both, and collect a job or null
with a finite timeout. Assert one job, one null, no worker error, and exit code zero; terminate both in
`finally`.

- [ ] **Step 2: Verify RED or race sensitivity**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected before the transaction fix: the test exposes any busy error, duplicate lease, or hanging
worker; after Task 1 it becomes regression evidence for the intended atomic behavior.

- [ ] **Step 3: Keep the production transaction minimal**

Use the existing `BEGIN IMMEDIATE` plus guarded candidate update. Do not add process-local locks or
retry loops; SQLite serialization and `busy_timeout` coordinate the independent connections.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: exactly one worker leases the job and both workers shut down.

### Task 5: Schema Marker V3 And Full Verification

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/database-reset.test.ts`
- Modify: `server/src/startup-acceptance.test.ts`
- Modify: `server/src/foundation-documentation.test.ts`
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/states-and-gates.md`
- Modify: `docs/workflow-sop.md`

- [ ] **Step 1: Write failing v2-to-v3 reset tests**

Set the old live marker to `phase-2-automation-v2`, require a backup, fresh schema, and final
`phase-2-automation-v3` marker in reset and real startup acceptance tests. Require all four current
documents to identify v3 as the live marker.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/src/database-reset.test.ts server/src/startup-acceptance.test.ts server/src/foundation-documentation.test.ts`

Expected: production still writes v2 and documentation still names v2 as current.

- [ ] **Step 3: Bump the marker and documentation**

Change the server marker to `phase-2-automation-v3`; describe v2 and older databases as backup-only
inputs to the existing fresh-reset policy in all four current documents.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit zero. Scan current docs for conflicting current-v2 wording and self-review
the complete diff for Critical and Important issues before creating one independent fix commit.
