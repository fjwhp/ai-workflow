# Phase 2 Workflow Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the nine-stage requirement flow with five single-responsibility stages and atomically create visible delivery units plus dependency edges when solution design is approved.

**Architecture:** Keep requirement-level definition/design artifacts separate from project-level delivery state. Add shared delivery-unit contracts and graph validation, persist units through a focused repository owned by `WorkflowStore`, and let solution-design approval freeze associations and create the delivery plan in one SQLite transaction. This plan stops before AI/Git delivery-unit execution; Plan 2 consumes the ready units and persistent jobs.

**Tech Stack:** TypeScript, Zod, Node.js SQLite (`DatabaseSync`), Fastify, React 19, Vitest.

---

## File Structure

- Create `shared/src/delivery-unit.ts`: delivery phases, statuses, dependency types, graph validation, and aggregate helpers.
- Modify `shared/src/domain.ts`: five requirement stages and their return ownership.
- Modify `shared/src/schemas.ts`: structured solution-design delivery plan and dependency validation.
- Modify `shared/src/index.ts`: export delivery-unit contracts.
- Create `server/src/database-schema.ts`: own the complete fresh Phase 2 DDL instead of growing `WorkflowStore.migrate()`.
- Create `server/src/delivery-unit-repository.ts`: SQLite persistence and atomic delivery-plan creation using a caller-owned transaction.
- Create `server/src/requirement-workflow-service.ts`: requirement-level transition and approval transactions.
- Create `server/src/requirement-routes.ts`: requirement HTTP validation and response mapping.
- Modify `server/src/store.ts`: repository wiring and narrow persistence facade; remove schema and workflow orchestration responsibilities.
- Modify `server/src/ai.ts`: dedicated prompts/schemas for requirement definition and solution design.
- Modify `server/src/app.ts`: five-stage routing and delivery-unit detail payload.
- Create `web/src/workflow-view.ts`: five-stage presentation helpers.
- Create `web/src/delivery-matrix.tsx`: read-only delivery plan and dependency state.
- Create `web/src/requirement-detail.tsx`: own requirement detail composition outside the application shell.
- Modify `web/src/main.tsx` and `web/src/styles.css`: keep `main.tsx` focused on navigation/state and render the five-stage detail without duplicated timelines.
- Modify `server/src/index.ts` and reset tests: advance schema marker to `phase-2-delivery-v1`.

### Task 1: Define The Five-Stage Domain

**Files:**
- Modify: `shared/src/domain.ts`
- Modify: `shared/src/domain.test.ts`

- [ ] **Step 1: Write failing stage and return-route tests**

```ts
it("uses five non-overlapping workflow stages", () => {
  expect(workflowStages).toEqual([
    "definition", "solution_design", "implementation",
    "quality_verification", "acceptance_delivery"
  ]);
});

it.each([
  ["solution_design", "definition"],
  ["implementation", "solution_design"],
  ["quality_verification", "implementation"],
  ["acceptance_delivery", "quality_verification"]
] as const)("routes %s findings to %s", (stage, target) => {
  expect(returnStage(stage)).toBe(target);
});
```

- [ ] **Step 2: Run the shared domain test and confirm the old enum fails**

Run: `npm test -- shared/src/domain.test.ts`

Expected: FAIL because `workflowStages` still contains nine legacy stages.

- [ ] **Step 3: Replace the stage enum, labels, and return map**

```ts
export const workflowStages = [
  "definition", "solution_design", "implementation",
  "quality_verification", "acceptance_delivery"
] as const;

export const stageLabels: Record<WorkflowStage, string> = {
  definition: "需求定义",
  solution_design: "方案设计",
  implementation: "实现",
  quality_verification: "质量验证",
  acceptance_delivery: "验收交付"
};
```

Keep generic requirement statuses limited to `ai_ready`, `ai_running`, `awaiting_approval`, `returned`, `blocked`, `completed`, `closed`, and `cancelled`. Project-level ready/running/application states belong to delivery units, not `requirements.status`.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- shared/src/domain.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/domain.ts shared/src/domain.test.ts
git commit -m "refactor: define five-stage workflow"
```

### Task 2: Define Delivery Units And Solution-Design Output

**Files:**
- Create: `shared/src/delivery-unit.ts`
- Create: `shared/src/delivery-unit.test.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/schemas.test.ts`
- Modify: `shared/src/index.ts`

- [ ] **Step 1: Write failing graph and schema tests**

```ts
it("orders an acyclic backend-to-frontend graph", () => {
  expect(validateDeliveryGraph(["backend", "frontend"], [{
    upstreamProjectId: "backend",
    downstreamProjectId: "frontend",
    releaseCondition: "automated_testing_passed"
  }]).order).toEqual(["backend", "frontend"]);
});

it("rejects a dependency cycle", () => {
  expect(() => validateDeliveryGraph(["a", "b"], [
    { upstreamProjectId: "a", downstreamProjectId: "b", releaseCondition: "automated_testing_passed" },
    { upstreamProjectId: "b", downstreamProjectId: "a", releaseCondition: "automated_testing_passed" }
  ])).toThrow("DELIVERY_DEPENDENCY_CYCLE");
});
```

Add a schema test that parses a solution-design artifact containing `deliveryPlan.units`, `deliveryPlan.dependencies`, and `contracts` and rejects a dependency endpoint absent from `units`.

- [ ] **Step 2: Run the focused tests and confirm missing exports**

Run: `npm test -- shared/src/delivery-unit.test.ts shared/src/schemas.test.ts`

Expected: FAIL because the delivery-unit module and solution-design schema do not exist.

- [ ] **Step 3: Implement exact shared contracts**

```ts
export const deliveryUnitPhases = ["implementation", "quality_verification", "acceptance_delivery"] as const;
export const deliveryUnitStatuses = [
  "waiting_dependency", "ready", "running", "awaiting_gate", "returned",
  "potentially_stale", "ready_for_acceptance", "applying", "applied",
  "conflicted", "failed", "skipped"
] as const;
export const deliveryReleaseConditions = ["automated_testing_passed"] as const;

export type DeliveryDependencyInput = {
  upstreamProjectId: string;
  downstreamProjectId: string;
  releaseCondition: "automated_testing_passed";
};
```

`validateDeliveryGraph(projectIds, dependencies)` must reject self-edges, duplicate edges, missing endpoints, and cycles, and return a stable topological order using the original project order as the tie-breaker.

Add `solutionDesignArtifactSchema` extending `aiArtifactSchema` with:

```ts
deliveryPlan: z.object({
  units: z.array(z.object({
    projectId: nonEmptyIdSchema,
    moduleIds: z.array(nonEmptyIdSchema),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1)
  })).min(1),
  dependencies: z.array(deliveryDependencyInputSchema)
}),
contracts: z.array(z.object({ name: z.string(), producerProjectId: nonEmptyIdSchema, consumerProjectIds: z.array(nonEmptyIdSchema), description: z.string() }))
```

- [ ] **Step 4: Run shared tests and typecheck**

Run: `npm test -- shared/src/delivery-unit.test.ts shared/src/schemas.test.ts`

Run: `npm run typecheck -w shared`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/delivery-unit.ts shared/src/delivery-unit.test.ts shared/src/schemas.ts shared/src/schemas.test.ts shared/src/index.ts
git commit -m "feat: define delivery unit contracts"
```

### Task 3: Create The Phase 2 Database Schema And Reset Boundary

**Files:**
- Create: `server/src/database-schema.ts`
- Create: `server/src/database-schema.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/database-reset.test.ts`
- Modify: `server/src/startup-acceptance.test.ts`

- [ ] **Step 1: Write a failing fresh-schema test**

```ts
it("creates only the Phase 2 delivery schema on a fresh database", () => {
  const db = openFreshStoreDatabase();
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    "delivery_units", "delivery_dependencies", "delivery_unit_snapshots",
    "automation_jobs"
  ]));
  expect(columns(db, "stage_runs")).toEqual(expect.arrayContaining(["owner_type", "owner_id"]));
  expect(columns(db, "artifacts")).toEqual(expect.arrayContaining(["owner_type", "owner_id"]));
});
```

Update reset acceptance expectations from `project-versions-v1` to `phase-2-delivery-v1`.

- [ ] **Step 2: Run reset and schema tests**

Run: `npm test -- server/src/database-schema.test.ts server/src/store.test.ts server/src/database-reset.test.ts server/src/startup-acceptance.test.ts`

Expected: FAIL because the marker and Phase 2 tables are absent.

- [ ] **Step 3: Extract and add the fresh schema and marker**

Move the complete fresh DDL out of `WorkflowStore.migrate()` into `createPhase2Schema(db)`. Do not keep an `ensureColumn` or legacy migration path. Add the tables exactly as specified in the design, including foreign keys and these safety indexes:

```sql
CREATE UNIQUE INDEX idx_delivery_unit_project
  ON delivery_units(requirement_id, project_id);
CREATE UNIQUE INDEX idx_delivery_dependency_edge
  ON delivery_dependencies(requirement_id, upstream_unit_id, downstream_unit_id);
CREATE UNIQUE INDEX idx_delivery_unit_active_run
  ON stage_runs(owner_type, owner_id, stage)
  WHERE status = 'running';
CREATE UNIQUE INDEX idx_automation_job_dedupe
  ON automation_jobs(dedupe_key);
```

Set `schemaVersion` in `server/src/index.ts` to `phase-2-delivery-v1`. Remove migration tests that add columns to legacy Phase 1 tables; this upgrade is backup-and-reset, not row migration. `WorkflowStore` calls `createPhase2Schema(this.db)` and owns no DDL text.

- [ ] **Step 4: Run the reset and schema tests**

Run: `npm test -- server/src/database-schema.test.ts server/src/store.test.ts server/src/database-reset.test.ts server/src/startup-acceptance.test.ts`

Expected: PASS, including restoration of the backed-up WAL set and an empty Phase 2 database.

- [ ] **Step 5: Commit**

```bash
git add server/src/database-schema.ts server/src/database-schema.test.ts server/src/store.ts server/src/store.test.ts server/src/index.ts server/src/database-reset.test.ts server/src/startup-acceptance.test.ts
git commit -m "feat: create phase 2 delivery schema"
```

### Task 4: Persist Delivery Units And Dependencies

**Files:**
- Create: `server/src/delivery-unit-repository.ts`
- Create: `server/src/delivery-unit-repository.test.ts`
- Modify: `server/src/store.ts`

- [ ] **Step 1: Write failing repository tests**

Create two projects, active versions, one requirement, and a frozen association snapshot. Assert:

```ts
const input = {
  requirementId: requirement.id,
  snapshot,
  plan: {
    units: [unit("backend"), unit("frontend")],
    dependencies: [dependency("backend", "frontend")]
  }
};
const result = store.deliveryUnits.createPlan(input);
expect(result.units.map(item => [item.projectId, item.status])).toEqual([
  [backend.id, "ready"],
  [frontend.id, "waiting_dependency"]
]);
expect(() => store.deliveryUnits.createPlan(input)).toThrow("DELIVERY_PLAN_EXISTS");
```

Also prove a missing/closed version, context-only project, graph cycle, or unit omitted from the snapshot leaves zero persisted units.

- [ ] **Step 2: Run the repository test**

Run: `npm test -- server/src/delivery-unit-repository.test.ts`

Expected: FAIL because `store.deliveryUnits` is undefined.

- [ ] **Step 3: Implement the focused repository**

```ts
export interface DeliveryUnitPersistence {
  createPlan(input: CreateDeliveryPlanInput): DeliveryPlanResult;
  listForRequirement(requirementId: string): DeliveryUnit[];
  listDependencies(requirementId: string): DeliveryDependency[];
}
```

Implement this interface in `DeliveryUnitRepository`, instantiated once in `WorkflowStore` after schema creation. Validate the complete plan before the first insert; map every snake-case row field to the camel-case shared contract. Keep transaction ownership in `WorkflowStore`; do not open nested transactions from the repository.

- [ ] **Step 4: Run repository and store tests**

Run: `npm test -- server/src/delivery-unit-repository.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/delivery-unit-repository.ts server/src/delivery-unit-repository.test.ts server/src/store.ts
git commit -m "feat: persist delivery plans"
```

### Task 5: Freeze And Create The Plan On Solution-Design Approval

**Files:**
- Create: `server/src/requirement-workflow-service.ts`
- Create: `server/src/requirement-workflow-service.test.ts`
- Create: `server/src/requirement-routes.ts`
- Create: `server/src/requirement-routes.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write failing transactional approval tests**

```ts
it("atomically freezes design and creates delivery units", async () => {
  const response = await approveSolutionDesign(fixture.requirement.id);
  expect(response.statusCode).toBe(200);
  const detail = await getRequirement(fixture.requirement.id);
  expect(detail.deliveryUnits).toHaveLength(2);
  expect(detail.deliveryDependencies).toHaveLength(1);
  expect(detail.stage).toBe("implementation");
});
```

Add a failure case with a cyclic artifact. Assert response `409 DELIVERY_DEPENDENCY_CYCLE`, requirement remains `solution_design/awaiting_approval`, and no snapshot/unit/dependency/job rows exist.

- [ ] **Step 2: Run approval tests**

Run: `npm test -- server/src/requirement-workflow-service.test.ts server/src/requirement-routes.test.ts`

Expected: FAIL because approval does not parse or persist a delivery plan.

- [ ] **Step 3: Implement one transaction**

Add `approveSolutionDesign(input)` to `RequirementWorkflowService`. It coordinates repositories over one database transaction; `WorkflowStore` no longer owns transition policy:

```ts
return this.store.withImmediateTransaction(() => {
  const snapshot = this.store.createRequirementProjectSnapshotInTransaction(input.requirementId, now);
  const plan = solutionDesignArtifactSchema.parse(input.artifact.content).deliveryPlan;
  const created = this.store.deliveryUnits.createPlan({ requirementId: input.requirementId, snapshot, plan });
  this.store.insertApprovalInTransaction(input.requirementId, "solution_design", input.approval, now);
  this.store.updateRequirementInTransaction(input.requirementId, "implementation", "ai_ready", now);
  return created;
});
```

`withImmediateTransaction` commits on return and rolls back on throw. Repository methods with an `InTransaction` suffix never open their own transaction. The approval route must take its graph only from the latest validated solution-design artifact, not from client-supplied hidden fields.

- [ ] **Step 4: Run transactional tests**

Run: `npm test -- server/src/requirement-workflow-service.test.ts server/src/requirement-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/requirement-workflow-service.ts server/src/requirement-workflow-service.test.ts server/src/requirement-routes.ts server/src/requirement-routes.test.ts server/src/store.ts server/src/app.ts
git commit -m "feat: create delivery units from approved design"
```

### Task 6: Give Definition And Design Dedicated AI Contracts

**Files:**
- Modify: `server/src/ai.ts`
- Modify: `server/src/ai.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing prompt and parsing tests**

```ts
it("keeps definition out of technical design", () => {
  const prompt = systemPrompt("definition");
  expect(prompt).toContain("不得选择架构、项目拆分或实现方式");
});

it("requires an executable multi-project delivery plan", () => {
  const prompt = systemPrompt("solution_design");
  expect(prompt).toContain("deliveryPlan");
  expect(prompt).toContain("upstreamProjectId");
  expect(prompt).toContain("automated_testing_passed");
});
```

Assert the solution-design parser requires project IDs, versions, dependencies, contracts, module scope, and acceptance coverage and parses with `solutionDesignArtifactSchema`.

- [ ] **Step 2: Run AI tests**

Run: `npm test -- server/src/ai.test.ts server/src/app.test.ts`

Expected: FAIL because legacy `prd` and generic non-PRD prompts remain.

- [ ] **Step 3: Implement stage-specific prompts and parsers**

```ts
const schemaFor = (stage: WorkflowStage) =>
  stage === "definition" ? productArtifactSchema :
  stage === "solution_design" ? solutionDesignArtifactSchema :
  aiArtifactSchema;
```

Remove `MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED` from the implementation entry path. In this plan, implementation details return delivery units but do not start them; Plan 2 supplies the worker.

- [ ] **Step 4: Run AI/app tests and typecheck**

Run: `npm test -- server/src/ai.test.ts server/src/app.test.ts`

Run: `npm run typecheck -w server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/ai.ts server/src/ai.test.ts server/src/app.ts server/src/app.test.ts
git commit -m "refactor: separate definition and solution design roles"
```

### Task 7: Render Five Stages And A Read-Only Delivery Matrix

**Files:**
- Create: `web/src/workflow-view.ts`
- Create: `web/src/workflow-view.test.ts`
- Create: `web/src/delivery-matrix.tsx`
- Create: `web/src/delivery-matrix.test.ts`
- Create: `web/src/requirement-detail.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing presentation tests**

```ts
expect(workflowSteps()).toEqual([
  "需求定义", "方案设计", "实现", "质量验证", "验收交付"
]);
expect(deliveryRowView(frontend, dependencies)).toMatchObject({
  dependencyLabel: "等待 Backend 自动化测试",
  nextAction: null
});
```

Add a 390px-safe class contract test asserting the matrix uses `.delivery-row-grid` on desktop and `.delivery-row-stack` below 620px.

- [ ] **Step 2: Run web tests**

Run: `npm test -- web/src/workflow-view.test.ts web/src/delivery-matrix.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement focused view helpers and components**

`DeliveryMatrix` accepts only `{ units, dependencies, projects }`. It renders one project row with project/version, dependency, implementation, review, testing, application, blocker, and one next action. It does not fetch data or mutate state.

Move the current requirement-detail composition out of `main.tsx` into `requirement-detail.tsx`. Replace the legacy nine-node timeline there with `workflowSteps()` and render `DeliveryMatrix` only for stages `implementation`, `quality_verification`, and `acceptance_delivery`. `main.tsx` keeps page navigation, top-level loading, and modal routing only.

- [ ] **Step 4: Run web tests, typecheck, and build**

Run: `npm test -- web/src/workflow-view.test.ts web/src/delivery-matrix.test.ts`

Run: `npm run typecheck -w web`

Run: `npm run build -w web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/workflow-view.ts web/src/workflow-view.test.ts web/src/delivery-matrix.tsx web/src/delivery-matrix.test.ts web/src/requirement-detail.tsx web/src/main.tsx web/src/styles.css
git commit -m "feat: show five-stage delivery matrix"
```

### Task 8: Document And Verify The Foundation

**Files:**
- Modify: `README.md`
- Modify: `docs/states-and-gates.md`
- Modify: `docs/workflow-sop.md`
- Modify: `docs/getting-started.md`

- [ ] **Step 1: Replace legacy workflow documentation**

Document the five stage contracts, the backup/reset marker `phase-2-delivery-v1`, the fact that Phase 1 history remains in the backup, and that this foundation shows ready units but Plan 2 activates continuous execution.

- [ ] **Step 2: Scan for stale stage names outside historical design/plan files**

Run: `rg -n 'requirement_review|technical_design|awaiting_merge|MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED' README.md docs shared/src server/src web/src -g '!docs/superpowers/**'`

Expected: no live-code or current-document matches.

- [ ] **Step 3: Run the complete verification suite**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, all three workspaces typecheck, and production build succeeds.

- [ ] **Step 4: Inspect reset safety and branch diff**

Run: `git diff --check`

Run: `git status --short`

Run: `git log --oneline --decorate -8`

Expected: no whitespace errors; only intentional documentation edits remain before the final commit.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/states-and-gates.md docs/workflow-sop.md docs/getting-started.md
git commit -m "docs: explain phase 2 workflow foundation"
```

## Foundation Acceptance

- A fresh `phase-2-delivery-v1` database uses only the five-stage live workflow.
- Definition and design have distinct structured outputs and no overlapping ownership.
- Approving a valid two-project solution design atomically creates backend `ready` and frontend `waiting_dependency` units.
- Invalid graphs leave no partial snapshot or delivery rows.
- Single-project design creates one ready unit without extra UI steps.
- The browser displays five top-level stages and a responsive read-only delivery matrix.
- No AI/Git delivery-unit job runs yet; that boundary is explicit and tested.
