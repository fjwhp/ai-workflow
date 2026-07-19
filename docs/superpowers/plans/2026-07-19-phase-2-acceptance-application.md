# Phase 2 Acceptance And Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete overall business acceptance, apply verified delivery units to local project-version worktrees in dependency order, preserve partial success, and finish a real two-project pilot without automatic commits or publication.

**Architecture:** A pure application planner derives stable topological order from frozen delivery dependencies. Acceptance enqueues only the first application job; a focused application coordinator validates and settles one unit at a time, then releases the next. Existing safe no-commit project-version application primitives are reused, while ownership and evidence move from requirement-level to delivery-unit-level records.

**Tech Stack:** TypeScript, Node.js child-process Git operations, SQLite, Fastify, React 19, Vitest, in-app browser acceptance.

---

## File Structure

- Create `shared/src/delivery-application.ts`: aggregate delivery states and ordered application-plan contracts.
- Create `server/src/delivery-application-planner.ts`: stable topological ordering and eligibility.
- Create `server/src/delivery-application-repository.ts`: per-unit application attempts and aggregate settlement.
- Create `server/src/delivery-application-service.ts`: preflight, safe no-commit apply, verification, and retry.
- Create `server/src/delivery-acceptance-routes.ts`: overall acceptance and per-unit application recovery endpoints.
- Modify `server/src/version-application.ts` and `server/src/project-version-routes.ts`: extract reusable Git-safe primitives without requirement-level ownership.
- Modify `server/src/delivery-coordinator.ts` and `server/src/automation-worker.ts`: application job sequencing.
- Create `web/src/acceptance-delivery-panel.tsx`: aggregate acceptance, ordered plan, partial state, and scoped retry UI.
- Modify `web/src/delivery-matrix.tsx`, `web/src/main.tsx`, and CSS: application evidence and responsive recovery actions.
- Modify runbooks and startup reset docs for the destructive live-data reset plus backup location.

### Task 1: Define Aggregate Delivery And Application Order

**Files:**
- Create: `shared/src/delivery-application.ts`
- Create: `shared/src/delivery-application.test.ts`
- Modify: `shared/src/index.ts`

- [ ] **Step 1: Write failing aggregate-state tests**

```ts
it.each([
  [["ready_for_acceptance", "ready_for_acceptance"], "awaiting_acceptance"],
  [["applied", "conflicted"], "partially_applied"],
  [["applied", "applied"], "completed"]
] as const)("aggregates %j as %s", (statuses, expected) => {
  expect(aggregateDeliveryStatus(statuses)).toBe(expected);
});
```

- [ ] **Step 2: Run the shared test**

Run: `npm test -- shared/src/delivery-application.test.ts`

Expected: FAIL because aggregate delivery contracts do not exist.

- [ ] **Step 3: Implement explicit aggregate states**

```ts
export const aggregateDeliveryStatuses = [
  "in_progress", "awaiting_acceptance", "applying",
  "partially_applied", "completed", "blocked"
] as const;
```

`completed` requires every required unit `applied`; `partially_applied` requires at least one applied and one non-applied required unit; optional skipped units never block completion.

- [ ] **Step 4: Run tests and shared typecheck**

Run: `npm test -- shared/src/delivery-application.test.ts`

Run: `npm run typecheck -w shared`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/delivery-application.ts shared/src/delivery-application.test.ts shared/src/index.ts
git commit -m "feat: define aggregate delivery state"
```

### Task 2: Build A Stable Dependency-Ordered Application Plan

**Files:**
- Create: `server/src/delivery-application-planner.ts`
- Create: `server/src/delivery-application-planner.test.ts`

- [ ] **Step 1: Write failing planner tests**

```ts
it("orders backend before frontend and preserves source order for peers", () => {
  expect(buildApplicationPlan({ units: [backend, worker, frontend], dependencies: [backendToFrontend] }))
    .toEqual([backend.id, worker.id, frontend.id]);
});

it("rejects a unit without valid quality evidence", () => {
  expect(() => buildApplicationPlan({ units: [unverified], dependencies: [] }))
    .toThrow("DELIVERY_UNIT_NOT_VERIFIED");
});
```

- [ ] **Step 2: Run planner tests**

Run: `npm test -- server/src/delivery-application-planner.test.ts`

Expected: FAIL because the planner does not exist.

- [ ] **Step 3: Implement the pure planner**

The planner accepts frozen units and edges, validates every required unit is `ready_for_acceptance`, reuses `validateDeliveryGraph`, and returns unit IDs in topological order with `position` as the tie-breaker. It performs no database or Git access.

- [ ] **Step 4: Run planner tests**

Run: `npm test -- server/src/delivery-application-planner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-application-planner.ts server/src/delivery-application-planner.test.ts
git commit -m "feat: plan dependency ordered application"
```

### Task 3: Persist Per-Unit Application Attempts

**Files:**
- Create: `server/src/delivery-application-repository.ts`
- Create: `server/src/delivery-application-repository.test.ts`
- Modify: `server/src/store.ts`

- [ ] **Step 1: Write failing settlement tests**

```ts
it("preserves an applied backend when frontend conflicts", () => {
  applications.complete(backendRun.id, completedResult());
  applications.complete(frontendRun.id, conflictResult(["src/api.ts"]));
  expect(unit(backend.id).status).toBe("applied");
  expect(unit(frontend.id).status).toBe("conflicted");
  expect(applications.aggregate(requirement.id)).toBe("partially_applied");
});
```

Assert one active application per unit and one owner per project-version worktree.

- [ ] **Step 2: Run repository tests**

Run: `npm test -- server/src/delivery-application-repository.test.ts`

Expected: FAIL because per-unit application attempts do not exist.

- [ ] **Step 3: Implement application persistence**

Use a new `delivery_application_runs` table keyed to `delivery_unit_id`, while retaining source/base/pre-apply commits, evidence hash, preflight JSON, command results, conflict files, error, and resolution status. `claim(unitId)` must atomically reserve the project version and set the unit `applying`. `complete` changes only that unit and recomputes the requirement aggregate.

- [ ] **Step 4: Run repository and store tests**

Run: `npm test -- server/src/delivery-application-repository.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-application-repository.ts server/src/delivery-application-repository.test.ts server/src/store.ts
git commit -m "feat: persist delivery applications"
```

### Task 4: Extract A Reusable Safe No-Commit Apply Primitive

**Files:**
- Modify: `server/src/version-application.ts`
- Modify: `server/src/version-application.test.ts`
- Modify: `server/src/project-version-routes.ts`
- Modify: `server/src/project-version-routes.test.ts`
- Create: `server/src/delivery-application-service.ts`
- Create: `server/src/delivery-application-service.test.ts`

- [ ] **Step 1: Write failing Git-safety tests**

Using temporary Git repositories, assert:

```ts
const result = await service.apply(frontendUnit.id);
expect(result.status).toBe("completed");
expect(await head(versionWorktree)).toBe(preApplyHead);
expect(await status(versionWorktree)).toContain("src/feature.ts");
expect(remoteRefs(repo)).toEqual([]);
```

Add dirty target, wrong repository identity, wrong branch, stale diff hash, occupied version, conflict, and verification-failure cases. Every case must assert the other project's worktree and HEAD remain unchanged.

- [ ] **Step 2: Run application service tests**

Run: `npm test -- server/src/delivery-application-service.test.ts server/src/version-application.test.ts`

Expected: FAIL because safe apply is coupled to requirement-level routes/runs.

- [ ] **Step 3: Extract and reuse the primitive**

Expose:

```ts
preflightVersionApplication(input: FrozenApplicationInput): Promise<ApplicationPreflight>
applyVersionWithoutCommit(input: FrozenApplicationInput): Promise<ApplicationResult>
verifyAppliedVersion(input: FrozenApplicationInput): Promise<CommandResult[]>
```

The primitive may invoke only local Git and frozen allowed commands. It must never run `git commit`, `git push`, create remote refs, or mutate the source worktree. Keep existing Phase 1 route tests passing until the clean reset removes the old live path.

- [ ] **Step 4: Run all Git-safety tests**

Run: `npm test -- server/src/delivery-application-service.test.ts server/src/version-application.test.ts server/src/project-version-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/version-application.ts server/src/version-application.test.ts server/src/project-version-routes.ts server/src/project-version-routes.test.ts server/src/delivery-application-service.ts server/src/delivery-application-service.test.ts
git commit -m "refactor: extract safe version application"
```

### Task 5: Sequence Applications Through Persistent Jobs

**Files:**
- Modify: `server/src/delivery-coordinator.ts`
- Modify: `server/src/delivery-coordinator.test.ts`
- Modify: `server/src/automation-worker.ts`
- Modify: `server/src/automation-worker.test.ts`

- [ ] **Step 1: Write failing sequencing tests**

```ts
it("enqueues only the first application after acceptance", async () => {
  await coordinator.acceptRequirement(requirement.id, "Business checks passed");
  expect(pendingActions()).toEqual([{ action: "apply", ownerId: backend.id }]);
});

it("releases frontend application only after backend settles applied", async () => {
  await worker.handle(backendApplyJob);
  expect(pendingActions()).toContainEqual({ action: "apply", ownerId: frontend.id });
});
```

- [ ] **Step 2: Run sequencing tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts server/src/automation-worker.test.ts`

Expected: FAIL because application actions are not registered.

- [ ] **Step 3: Add application job handling**

Acceptance stores the ordered plan and enqueues `apply:${unitId}:v${evidenceVersion}` for the first unit. Successful settlement enqueues the next unapplied eligible unit. Conflict or failed verification stops the sequence and sets `partially_applied` if an earlier unit succeeded.

Retry reuses the same frozen plan but uses a new attempt-specific dedupe key tied to the unchanged evidence version.

- [ ] **Step 4: Run sequencing and queue tests**

Run: `npm test -- server/src/delivery-coordinator.test.ts server/src/automation-worker.test.ts server/src/automation-job-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-coordinator.ts server/src/delivery-coordinator.test.ts server/src/automation-worker.ts server/src/automation-worker.test.ts
git commit -m "feat: sequence delivery applications"
```

### Task 6: Add Overall Acceptance And Scoped Recovery APIs

**Files:**
- Create: `server/src/delivery-acceptance-routes.ts`
- Create: `server/src/delivery-acceptance-routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

```text
POST /api/requirements/:id/accept-delivery
POST /api/delivery-units/:id/application/retry
GET  /api/delivery-units/:id/application-runs
```

Acceptance requires a non-empty human comment and all aggregate quality prerequisites. Retry is allowed only for the conflicted/failed unit and must not enqueue or reset an applied sibling.

- [ ] **Step 2: Run route tests**

Run: `npm test -- server/src/delivery-acceptance-routes.test.ts server/src/app.test.ts`

Expected: FAIL because the routes are absent.

- [ ] **Step 3: Implement server-owned eligibility**

Return `409` with specific codes for `QUALITY_NOT_COMPLETE`, `STALE_DELIVERY_EVIDENCE`, `APPLICATION_ALREADY_ACTIVE`, `APPLICATION_RETRY_NOT_ALLOWED`, and the existing `PROJECT_VERSION_APPLICATION_BUSY`. Include `allowedActions` in requirement/unit detail so the client never guesses.

- [ ] **Step 4: Run route and app tests**

Run: `npm test -- server/src/delivery-acceptance-routes.test.ts server/src/app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-acceptance-routes.ts server/src/delivery-acceptance-routes.test.ts server/src/app.ts server/src/app.test.ts
git commit -m "feat: accept and recover local delivery"
```

### Task 7: Build The Acceptance Delivery Interface

**Files:**
- Create: `web/src/acceptance-delivery-panel.tsx`
- Create: `web/src/acceptance-delivery-panel.test.ts`
- Modify: `web/src/delivery-matrix.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing view tests**

```ts
expect(acceptanceDeliveryView(partialFixture)).toMatchObject({
  statusLabel: "部分应用",
  appliedCount: 1,
  retryUnitId: frontend.id,
  canAccept: false
});
```

Assert applied rows have no rollback control, the conflicted row has one retry control, and the acceptance form requires a comment.

- [ ] **Step 2: Run web tests**

Run: `npm test -- web/src/acceptance-delivery-panel.test.ts web/src/delivery-matrix.test.ts`

Expected: FAIL because the acceptance panel does not exist.

- [ ] **Step 3: Implement the unframed acceptance section**

Render overall acceptance above the delivery matrix, then ordered per-project application status. Use existing Lucide icons and compact status labels. Do not nest cards. On 390px, stack project identity, evidence, and actions; keep the single valid action full-width.

- [ ] **Step 4: Run web tests, typecheck, and build**

Run: `npm test -- web/src/acceptance-delivery-panel.test.ts web/src/delivery-matrix.test.ts`

Run: `npm run typecheck -w web`

Run: `npm run build -w web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/acceptance-delivery-panel.tsx web/src/acceptance-delivery-panel.test.ts web/src/delivery-matrix.tsx web/src/main.tsx web/src/associations.css
git commit -m "feat: manage acceptance delivery"
```

### Task 8: Perform Reset, Browser QA, And Real Two-Project Pilot

**Files:**
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/pilot-runbook.md`

- [ ] **Step 1: Document destructive reset and recovery**

State that starting Phase 2 with a prior marker backs up the SQLite database and deletes old live data. Record backup naming, checksum/sidecar behavior, re-registration steps, and that source repositories/worktrees are never deleted or reset.

- [ ] **Step 2: Run complete automated verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, all workspaces typecheck, and production build succeeds.

- [ ] **Step 3: Verify desktop and mobile browser behavior**

Start: `npm run dev`

Verify in the in-app browser:

- five stages render without overlap at normal desktop width;
- the matrix stacks correctly at 390px;
- backend waiting/running/pass and frontend dependency release update without a full reload;
- separate review/test evidence opens correctly;
- stale and partial states show only valid actions;
- browser console contains no application errors.

- [ ] **Step 4: Run the real backend/frontend pilot**

Register two disposable local repositories and active versions. Create one requirement whose frontend depends on backend automated testing. Complete definition/design, allow continuous implementation and quality, accept delivery, and observe ordered application.

Before and after the pilot record for every main, version, and requirement worktree:

```bash
git rev-parse HEAD
git status --short
git branch --show-current
```

Expected: source requirement branches contain AI commits as designed; version worktree HEADs do not change during application; applied files remain uncommitted; no remote refs, pushes, PRs, or tags are created.

- [ ] **Step 5: Commit runbook updates after evidence is recorded**

```bash
git add README.md docs/getting-started.md docs/pilot-runbook.md
git commit -m "docs: verify phase 2 multi-project pilot"
```

## Final Acceptance

- Overall acceptance is the only normal mandatory human checkpoint after safe automation.
- Applications follow the frozen topological order and use persistent jobs.
- Applied repositories remain applied when a later repository conflicts.
- Retry is scoped to the failed unit and preserves sibling evidence/state.
- Target/version worktrees receive uncommitted changes only; no commit, push, PR, tag, or release occurs.
- The destructive old-data reset is backed up and clearly reported to the user.
- Desktop, 390px mobile, console, automated suite, and a real two-project pilot all pass.
