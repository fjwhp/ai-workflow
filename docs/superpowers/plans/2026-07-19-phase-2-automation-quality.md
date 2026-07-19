# Phase 2 Automation And Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuously execute ready delivery units, preserve separate implementation/review/test evidence, release dependencies exactly once, and pause safely when upstream evidence becomes stale.

**Architecture:** A persistent SQLite job queue owns retries and crash recovery. A small scheduler leases jobs and delegates to injected handlers; handlers use delivery-unit snapshots rather than live project associations. Implementation, code review, and automated testing each write immutable evidence versions, while a delivery coordinator performs deterministic gates, dependency release, aggregation, and invalidation.

**Tech Stack:** TypeScript, Node.js SQLite, Fastify, Codex/OpenAI runners already present in the server, React 19, SSE, Vitest.

---

## File Structure

- Create `server/src/automation-job-repository.ts`: enqueue, lease, renew, complete, fail, cancel, and expired-lease recovery.
- Create `server/src/automation-worker.ts`: polling lifecycle and injected action handlers.
- Create `server/src/delivery-coordinator.ts`: readiness, quality aggregation, dependency release, and stale propagation transactions.
- Create `server/src/delivery-execution-service.ts`: implementation, review, and testing handlers using frozen unit snapshots.
- Create `server/src/delivery-unit-routes.ts`: unit detail, manual retry, pause, stale reuse, and stale rerun endpoints.
- Modify `server/src/store.ts`: wire focused repositories; remove delivery orchestration logic from the Store facade.
- Modify `server/src/index.ts`: start recovery and worker after the database is ready.
- Modify `server/src/app.ts`: register delivery routes and remove requirement-level execution branching.
- Create `web/src/delivery-unit-view.ts`: status, blocker, and next-action projection.
- Modify `web/src/delivery-matrix.tsx`: live unit evidence and exception controls.
- Modify `web/src/main.tsx`: delegate unit actions and refresh/SSE integration.

### Task 1: Implement Persistent Job Queue Semantics

**Files:**
- Create: `server/src/automation-job-repository.ts`
- Create: `server/src/automation-job-repository.test.ts`
- Modify: `server/src/store.ts`

- [ ] **Step 1: Write failing queue tests**

```ts
it("deduplicates one action for one evidence version", () => {
  const first = jobs.enqueue(job("implement:unit-1:v1"));
  const second = jobs.enqueue(job("implement:unit-1:v1"));
  expect(second.id).toBe(first.id);
  expect(jobs.listPending()).toHaveLength(1);
});

it("reclaims only an expired lease", () => {
  const leased = jobs.leaseNext("worker-a", now, 30_000)!;
  expect(jobs.leaseNext("worker-b", now, 30_000)).toBeNull();
  expect(jobs.recoverExpired(addMs(now, 30_001))).toBe(1);
  expect(jobs.leaseNext("worker-b", addMs(now, 30_001), 30_000)?.id).toBe(leased.id);
});
```

- [ ] **Step 2: Run the queue tests**

Run: `npm test -- server/src/automation-job-repository.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement atomic queue operations**

Expose:

```ts
enqueue(input: AutomationJobInput): AutomationJob
leaseNext(workerId: string, now: Date, leaseMs: number): AutomationJob | null
renew(jobId: string, workerId: string, now: Date, leaseMs: number): boolean
complete(jobId: string, workerId: string): boolean
fail(jobId: string, workerId: string, error: string, retryable: boolean): boolean
cancelByOwnerVersion(ownerId: string, evidenceVersion: number): number
recoverExpired(now: Date): number
```

Use `BEGIN IMMEDIATE` around `leaseNext`; select one pending row by `created_at, id`, then update it only if still pending. Cap attempts at the configured handler limit and keep `last_error` bounded.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- server/src/automation-job-repository.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/automation-job-repository.ts server/src/automation-job-repository.test.ts server/src/store.ts
git commit -m "feat: persist automation jobs"
```

### Task 2: Run And Recover Automation Workers

**Files:**
- Create: `server/src/automation-worker.ts`
- Create: `server/src/automation-worker.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing worker lifecycle tests**

```ts
it("completes a leased job through the registered handler", async () => {
  const handled: string[] = [];
  const worker = createAutomationWorker({ jobs, handlers: { implement: async job => handled.push(job.id) } });
  await worker.drainOnce();
  expect(handled).toEqual([job.id]);
  expect(jobs.get(job.id)?.status).toBe("completed");
});

it("records retryable handler failure without advancing its owner", async () => {
  const worker = createAutomationWorker({ jobs, handlers: { implement: async () => { throw retryable("AI_UNAVAILABLE"); } } });
  await worker.drainOnce();
  expect(jobs.get(job.id)).toMatchObject({ status: "pending", attempt: 1, lastError: "AI_UNAVAILABLE" });
});
```

- [ ] **Step 2: Run worker tests**

Run: `npm test -- server/src/automation-worker.test.ts`

Expected: FAIL because no worker exists.

- [ ] **Step 3: Implement an injected, stoppable worker**

```ts
export type AutomationHandlers = Record<AutomationAction, (job: AutomationJob) => Promise<void>>;

export interface AutomationWorker {
  drainOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}
```

`createAutomationWorker(input)` returns this interface. `drainOnce` returns `false` when no job is leased and `true` after settling one job. `start` schedules bounded polling without overlapping drains. `stop` cancels polling and awaits the current handler. Start the worker only after expired leases and interrupted runs are recovered. Stop it during Fastify shutdown before closing SQLite.

- [ ] **Step 4: Run worker and startup tests**

Run: `npm test -- server/src/automation-worker.test.ts server/src/startup-acceptance.test.ts`

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add server/src/automation-worker.ts server/src/automation-worker.test.ts server/src/index.ts
git commit -m "feat: recover and run automation worker"
```

### Task 3: Execute One Delivery Unit From Its Frozen Snapshot

**Files:**
- Create: `server/src/delivery-execution-service.ts`
- Create: `server/src/delivery-execution-service.test.ts`
- Modify: `server/src/coding-agent.ts`
- Modify: `server/src/coding-agent.test.ts`
- Modify: `server/src/store.ts`

- [ ] **Step 1: Write a failing frozen-context test**

```ts
it("uses the unit snapshot even when the live project changes", async () => {
  const unit = fixtureUnit({ snapshotRepoPath: oldPath, snapshotVersionBranch: "feature/2.2.1" });
  store.updateProject(unit.projectId, { repoPath: newPath });
  await service.implement(unit.id);
  expect(codingAgent).toHaveBeenCalledWith(expect.objectContaining({
    project: expect.objectContaining({ repoPath: oldPath }),
    projectVersion: expect.objectContaining({ branch: "feature/2.2.1" })
  }));
});
```

Also assert a second concurrent implementation claim for the same unit returns `DELIVERY_UNIT_RUN_ACTIVE`.

- [ ] **Step 2: Run focused execution tests**

Run: `npm test -- server/src/delivery-execution-service.test.ts server/src/coding-agent.test.ts`

Expected: FAIL because execution is still requirement-owned.

- [ ] **Step 3: Implement unit-owned implementation**

Add `deliveryUnitId` and `evidenceVersion` to execution/run/evidence writes. `implement(unitId)` must atomically claim `ready -> running`, create the run, then invoke the existing Codex coding agent with the snapshot. On success it writes diff/file/command evidence and changes the unit to `awaiting_gate`; on failure it changes only that unit to `failed` or `returned`.

Do not read live `requirement_projects` after the unit claim.

- [ ] **Step 4: Run execution, coding, and evidence tests**

Run: `npm test -- server/src/delivery-execution-service.test.ts server/src/coding-agent.test.ts server/src/coding-evidence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-execution-service.ts server/src/delivery-execution-service.test.ts server/src/coding-agent.ts server/src/coding-agent.test.ts server/src/store.ts
git commit -m "feat: implement delivery units"
```

### Task 4: Keep Code Review And Automated Testing Independent

**Files:**
- Modify: `server/src/delivery-execution-service.ts`
- Modify: `server/src/delivery-execution-service.test.ts`
- Modify: `server/src/ai.ts`
- Modify: `server/src/ai.test.ts`

- [ ] **Step 1: Write failing independent-quality tests**

```ts
it("runs review and testing against the same immutable implementation evidence", async () => {
  await Promise.all([service.review(unit.id), service.test(unit.id)]);
  expect(store.deliveryUnits.latestEvidence(unit.id, "code_review")?.inputEvidenceVersion).toBe(1);
  expect(store.deliveryUnits.latestEvidence(unit.id, "automated_testing")?.inputEvidenceVersion).toBe(1);
});

it("does not pass quality when only testing passes", () => {
  expect(qualityGate({ review: "running", testing: "passed" })).toEqual({ status: "running" });
});
```

- [ ] **Step 2: Run quality tests**

Run: `npm test -- server/src/delivery-execution-service.test.ts server/src/ai.test.ts`

Expected: FAIL because delivery review/test handlers and evidence kinds do not exist.

- [ ] **Step 3: Implement separate handlers and prompts**

Review receives diff, complete changed files, frozen definition/design, and implementation command evidence. Testing receives the same frozen inputs plus project verification commands and acceptance-criterion trace. Persist separate `code_review` and `automated_testing` artifacts; never overwrite either with the other.

When implementation evidence becomes valid, enqueue both jobs with different dedupe keys:

```ts
review:${unit.id}:v${evidenceVersion}
test:${unit.id}:v${evidenceVersion}
```

- [ ] **Step 4: Run quality tests and server typecheck**

Run: `npm test -- server/src/delivery-execution-service.test.ts server/src/ai.test.ts`

Run: `npm run typecheck -w server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-execution-service.ts server/src/delivery-execution-service.test.ts server/src/ai.ts server/src/ai.test.ts
git commit -m "feat: verify delivery units independently"
```

### Task 5: Aggregate Quality And Release Dependencies Exactly Once

**Files:**
- Create: `server/src/delivery-coordinator.ts`
- Create: `server/src/delivery-coordinator.test.ts`
- Modify: `server/src/delivery-unit-repository.ts`
- Modify: `server/src/delivery-unit-repository.test.ts`

- [ ] **Step 1: Write failing release-race tests**

```ts
it("releases frontend only after backend review and testing pass", async () => {
  await coordinator.recordQuality(backend.id, "automated_testing", passingEvidence());
  expect(unit(frontend.id).status).toBe("waiting_dependency");
  await coordinator.recordQuality(backend.id, "code_review", passingEvidence());
  expect(unit(frontend.id).status).toBe("ready");
  expect(jobs.byDedupe(`implement:${frontend.id}:v1`)).toHaveLength(1);
});

it("serializes simultaneous final quality callbacks", async () => {
  await Promise.all([recordReviewPass(), recordTestingPass()]);
  expect(releasedEdges()).toHaveLength(1);
  expect(frontendImplementationJobs()).toHaveLength(1);
});
```

- [ ] **Step 2: Run coordinator tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts`

Expected: FAIL because aggregation and release are missing.

- [ ] **Step 3: Implement deterministic coordination**

Within `BEGIN IMMEDIATE`, reload current unit/evidence rows, reject superseded callbacks, compute the quality result, set backend `ready_for_acceptance` only when both evidence kinds pass, stamp `released_by_evidence_version`, move eligible downstream units to `ready`, and enqueue one implementation job.

An override must store actor, reason, evidence IDs, and risk acceptance; it cannot erase failing evidence.

- [ ] **Step 4: Run coordinator and repository tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts server/src/delivery-unit-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-coordinator.ts server/src/delivery-coordinator.test.ts server/src/delivery-unit-repository.ts server/src/delivery-unit-repository.test.ts
git commit -m "feat: release delivery dependencies"
```

### Task 6: Invalidate And Resolve Downstream Evidence

**Files:**
- Modify: `server/src/delivery-coordinator.ts`
- Modify: `server/src/delivery-coordinator.test.ts`
- Create: `server/src/delivery-unit-routes.ts`
- Create: `server/src/delivery-unit-routes.test.ts`

- [ ] **Step 1: Write failing invalidation tests**

```ts
it("marks every started descendant potentially stale", () => {
  coordinator.replaceImplementationEvidence(backend.id, newEvidence());
  expect(unit(frontend.id)).toMatchObject({ status: "potentially_stale" });
  expect(jobs.pendingFor(frontend.id)).toEqual([]);
});

it("requires a reason to reuse stale evidence", async () => {
  const response = await injectReuse(frontend.id, { reason: "" });
  expect(response.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run invalidation tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts server/src/delivery-unit-routes.test.ts`

Expected: FAIL because stale propagation and resolution routes are missing.

- [ ] **Step 3: Implement conservative descendant invalidation**

On new upstream implementation/contract evidence, traverse descendants inside one transaction, set started descendants `potentially_stale`, and cancel pending jobs tied to the old evidence version.

Add:

```text
POST /api/delivery-units/:id/stale-resolution
body { decision: "reuse" | "rerun", reason: string }
POST /api/delivery-units/:id/quality-override
body { reason: string, acceptedRisk: string }
POST /api/delivery-units/:id/skip
body { reason: string }
POST /api/requirements/:id/automation/pause
body { reason: string }
POST /api/requirements/:id/automation/resume
body { reason: string }
```

`reuse` records compared evidence versions and restores the prior resumable status. `rerun` increments evidence version, sets the earliest invalid phase, and enqueues the exact job for that phase. Quality override preserves both failing evidence records and records the actor plus accepted risk. Pause cancels pending requirement jobs and prevents new leases without interrupting an active Git mutation; resume recomputes readiness and enqueues only currently valid actions.

- [ ] **Step 4: Run coordinator and route tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts server/src/delivery-unit-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-coordinator.ts server/src/delivery-coordinator.test.ts server/src/delivery-unit-routes.ts server/src/delivery-unit-routes.test.ts
git commit -m "feat: resolve stale delivery evidence"
```

### Task 7: Expose Live Unit State And Valid Actions

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`
- Create: `web/src/delivery-unit-view.ts`
- Create: `web/src/delivery-unit-view.test.ts`
- Modify: `web/src/delivery-matrix.tsx`
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Write failing API and view tests**

Assert requirement detail returns each unit's implementation/review/test evidence, blocker, dependency releases, automation pause state, and `allowedActions`. Assert a stale frontend exposes only `reuse_evidence` and `rerun`, while a waiting frontend exposes no action. Assert an optional failed unit exposes `skip_optional` only after a non-empty reason is submitted.

- [ ] **Step 2: Run API and web tests**

Run: `npm test -- server/src/app.test.ts web/src/delivery-unit-view.test.ts`

Expected: FAIL because live unit detail and action projection are absent.

- [ ] **Step 3: Implement server-owned allowed actions**

The server computes `allowedActions`; the frontend does not infer safety from status strings. `deliveryUnitView()` only maps labels and tone. Add buttons for retry, stale reuse, and stale rerun using existing icon/button conventions and show review/test evidence separately.

- [ ] **Step 4: Run API/web tests, typecheck, and build**

Run: `npm test -- server/src/app.test.ts web/src/delivery-unit-view.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/app.test.ts web/src/delivery-unit-view.ts web/src/delivery-unit-view.test.ts web/src/delivery-matrix.tsx web/src/main.tsx
git commit -m "feat: operate delivery units from the matrix"
```

### Task 8: Verify Continuous Delivery Quality

**Files:**
- Modify: `docs/states-and-gates.md`
- Modify: `docs/workflow-sop.md`

- [ ] **Step 1: Document automation and recovery invariants**

Document leases, dedupe keys, separate review/test evidence, release prerequisites, stale decisions, global pause, and the fact that acceptance remains human.

- [ ] **Step 2: Run concurrency-focused tests repeatedly**

Run: `npm test -- server/src/automation-job-repository.test.ts server/src/automation-worker.test.ts server/src/delivery-coordinator.test.ts`

Expected: PASS. The release-race test itself must execute its simultaneous callback scenario 20 times and assert no duplicate release/job or open handle.

- [ ] **Step 3: Run complete verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass and production build succeeds.

- [ ] **Step 4: Inspect the final diff and working tree**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors and only the intended documentation update remains uncommitted.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/states-and-gates.md docs/workflow-sop.md
git commit -m "docs: explain automated delivery quality"
```

## Automation Acceptance

- Root units start automatically from persistent jobs.
- Backend review and testing are independent; both must pass before frontend release.
- Simultaneous callbacks release one edge and create one frontend job.
- Restart reclaims expired work without duplicate AI or Git execution.
- Upstream changes pause every affected descendant before another gate.
- Human reuse/rerun decisions are explicit and immutable.
- The UI exposes only server-authorized recovery actions.
