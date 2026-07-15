# Autonomous Product AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Product PRD AI investigate linked projects, make safe reversible decisions, and escalate only structured high-risk blocking questions.

**Architecture:** Add a bounded read-only repository evidence collector and a versioned product-role prompt policy, then parse PRD runs with a dedicated schema. Keep the common artifact contract for all other stages, specialize PRD gate behavior around `blockingQuestions`, and expose autonomous decisions, assumptions, evidence, and blockers in the existing artifact view.

**Tech Stack:** TypeScript, Node.js filesystem APIs, OpenAI SDK, Zod, Fastify, React, Vitest

---

### Task 1: Product Artifact Contract And Decision Policy

**Files:**
- Modify: `shared/src/schemas.ts`
- Create: `shared/src/schemas.test.ts`
- Create: `server/src/product-policy.ts`
- Create: `server/src/product-policy.test.ts`

- [ ] **Step 1: Write failing policy and schema tests**

Create tests that express the three decision classes and the structured PRD output:

```ts
expect(classifyProductUnknown({ topic: "默认分页数量", impact: "可随时调整" })).toBe("reversible_assumption");
expect(classifyProductUnknown({ topic: "用户数据永久删除", impact: "不可恢复" })).toBe("blocking_decision");
expect(classifyProductUnknown({ topic: "现有接口是否支持备注", impact: "可从项目确认" })).toBe("evidence_gap");
```

Add a `productArtifactSchema.safeParse` case containing `underlyingGoal`, `targetUsers`, `productDecisions`, structured `assumptions`, `scope`, `flows`, `acceptanceCriteria`, `evidence`, and `blockingQuestions`.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- server/src/product-policy.test.ts shared/src/schemas.test.ts`

Expected: FAIL because the classifier and product schema do not exist.

- [ ] **Step 3: Add the product artifact schema**

Define reusable records and extend the common schema:

```ts
const productDecisionSchema = z.object({ decision: z.string(), rationale: z.string(), evidence: z.array(z.string()) });
const productAssumptionSchema = z.object({ assumption: z.string(), rationale: z.string(), validation: z.string(), impactIfWrong: z.string() });
const blockingQuestionSchema = z.object({ question: z.string(), impact: z.string(), options: z.array(z.string()).min(2) });

export const productArtifactSchema = aiArtifactSchema.extend({
  underlyingGoal: z.string().min(1),
  targetUsers: z.array(z.string()).min(1),
  productDecisions: z.array(productDecisionSchema),
  assumptions: z.array(productAssumptionSchema),
  scope: z.object({ mvp: z.array(z.string()), nonGoals: z.array(z.string()) }),
  flows: z.object({ primary: z.array(z.string()), exceptions: z.array(z.string()) }),
  acceptanceCriteria: z.array(z.string()).min(1),
  evidence: z.array(z.object({ source: z.string(), fact: z.string() })),
  blockingQuestions: z.array(blockingQuestionSchema)
});
```

Change the base schema's `assumptions` to `z.array(z.union([z.string(), productAssumptionSchema]))` so historical artifacts remain readable.

- [ ] **Step 4: Implement deterministic high-risk classification**

Export `classifyProductUnknown(input): "evidence_gap" | "reversible_assumption" | "blocking_decision"`. Use explicit risk terms for permission, money, compliance, privacy, permanent deletion, irreversible migration, and mutually exclusive core rules; classify repository-answerable statements as evidence gaps and everything else as reversible assumptions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- server/src/product-policy.test.ts shared/src/schemas.test.ts && npm run typecheck -w shared && npm run typecheck -w server`

Expected: all focused tests and both typechecks pass.

### Task 2: Persistent Project Knowledge Store

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`
- Create: `server/src/project-knowledge.ts`
- Create: `server/src/project-knowledge.test.ts`

- [ ] **Step 1: Write failing persistence and version tests**

Add Store tests for immutable knowledge versions and durable project status:

```ts
const building = store.beginProjectKnowledge(project.id, "abc123", "manual");
expect(store.getProjectKnowledgeStatus(project.id)).toMatchObject({ status: "building", sourceHead: "abc123" });
const ready = store.completeProjectKnowledge(building.id, { summary: "点餐平台", entries: [{ path: "README.md", kind: "overview", title: "项目介绍", content: "...", tags: ["overview"] }] });
expect(store.getLatestProjectKnowledge(project.id)).toMatchObject({ id: ready.id, version: 1, status: "ready", sourceHead: "abc123" });
expect(store.listProjectKnowledgeVersions(project.id)).toHaveLength(1);
```

- [ ] **Step 2: Run Store tests and verify RED**

Run: `npm test -- server/src/store.test.ts`

Expected: FAIL because the knowledge tables and Store methods do not exist.

- [ ] **Step 3: Add SQLite knowledge tables and Store methods**

Create `project_knowledge_versions` with project ID, monotonic version, status, source HEAD, refresh reason, summary, entries JSON, counts, error, and timestamps. Add `beginProjectKnowledge`, `completeProjectKnowledge`, `failProjectKnowledge`, `getLatestProjectKnowledge`, `getProjectKnowledgeStatus`, and `listProjectKnowledgeVersions`. Interrupted `building` versions become `failed` during startup recovery.

- [ ] **Step 4: Write the read-only indexer RED test**

Build a temporary Git fixture containing `README.md`, build manifests, a relevant controller, schema, tests, `.env`, `private.pem`, `.git`, dependencies, and an oversized file. Assert `buildProjectKnowledge` returns the Git HEAD, broad structured entries, no secret content, no excluded paths, at most 80 entries, and at most 120,000 characters.

- [ ] **Step 5: Implement safe bounded indexing**

In `project-knowledge.ts`, use parameter-array Git calls plus `readdir`, `lstat`, `realpath`, and `readFile`. Never follow symlinks. Exclude Git internals, dependencies, build outputs, credential filenames, key/certificate extensions, project sensitive patterns, binary files, and files over 128 KB. Classify entries as `overview`, `module`, `api`, `domain`, `schema`, `rule`, `test`, or `constraint`, retaining relative evidence paths.

- [ ] **Step 6: Run persistence and indexer tests**

Run: `npm test -- server/src/store.test.ts server/src/project-knowledge.test.ts && npm run typecheck -w server`

Expected: knowledge versions persist and the indexer remains read-only and bounded.

### Task 3: Knowledge Lifecycle, Retrieval, And APIs

**Files:**
- Create: `server/src/knowledge-service.ts`
- Create: `server/src/knowledge-service.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing lifecycle and retrieval tests**

Assert `ensureProjectKnowledge` builds when absent, reuses the same version when HEAD is unchanged, creates a new version after a commit, and `retrieveProjectKnowledge` ranks requirement terms while always including overview/module entries:

```ts
const first = await service.ensureProjectKnowledge(project, "first_use");
const reused = await service.ensureProjectKnowledge(project, "ai_run");
expect(reused.id).toBe(first.id);
await commitFixtureChange(repoPath);
const refreshed = await service.ensureProjectKnowledge(project, "head_changed");
expect(refreshed.version).toBe(2);
expect(service.retrieveProjectKnowledge(refreshed, requirement).entries.some(entry => entry.path.includes("Order"))).toBe(true);
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npm test -- server/src/knowledge-service.test.ts`

Expected: FAIL because the lifecycle service does not exist.

- [ ] **Step 3: Implement HEAD-aware ensure and retrieval**

Read HEAD with `git rev-parse HEAD`. Reuse a ready version with the same HEAD; otherwise call the indexer and persist a new immutable version. Retrieve at most 24 entries and 40,000 characters using normalized title, expected outcome, business problem, path, title, tags, and content terms. Return version, source HEAD, summary, entries, total available count, and truncation.

- [ ] **Step 4: Add project knowledge endpoints**

Implement:

```text
GET  /api/projects/:id/knowledge
POST /api/projects/:id/knowledge/rebuild
```

The GET endpoint reports status and current version. Rebuild starts a durable run and returns `202`; duplicate active builds return `409`. Project creation schedules initial generation without making registration fail if indexing fails.

- [ ] **Step 5: Inject retrieved knowledge into every analytical AI run**

For `prd`, `requirement_review`, `technical_design`, `code_review`, `testing`, and `acceptance`, call `ensureProjectKnowledge`, retrieve against the requirement, and persist `projectKnowledge` in the stage-run input. Emit `knowledge.reused`, `knowledge.refreshed`, and `knowledge.retrieved` events containing version, HEAD, paths, counts, and truncation but no excluded content. Coding continues using its worktree-specific context.

- [ ] **Step 6: Add API tests and verify**

Test initial status, manual rebuild, duplicate rebuild rejection, HEAD refresh, run-input retrieval, service-restart visibility, and unchanged repository status. Run:

`npm test -- server/src/knowledge-service.test.ts server/src/app.test.ts && npm run typecheck -w server`

Expected: all lifecycle and API tests pass.

### Task 4: Product-Specific Prompt And Parsing

**Files:**
- Modify: `server/src/ai.ts`
- Modify: `server/src/ai.test.ts`

- [ ] **Step 1: Write failing product prompt tests**

Export a pure `buildAgentPrompt(stage, context)` helper and assert the PRD prompt includes:

```ts
expect(prompt).toContain("默认自主推进");
expect(prompt).toContain("先检索 projectKnowledge");
expect(prompt).toContain("可逆假设");
expect(prompt).toContain("blockingQuestions");
expect(prompt).toContain("不得因普通实现细节要求人工决定");
```

Assert a non-PRD prompt retains the existing common artifact fields and does not require product-only fields.

- [ ] **Step 2: Run AI tests and verify RED**

Run: `npm test -- server/src/ai.test.ts`

Expected: FAIL because `buildAgentPrompt` is not exported and no product policy exists.

- [ ] **Step 3: Implement versioned product-role prompt construction**

Split prompt construction from transport. The PRD branch must instruct the model to:

- Decode literal ask versus underlying outcome.
- Use repository evidence before declaring a gap.
- Decide reversible details and record rationale.
- Reserve blockers for the exact high-risk categories in the design.
- Define target users, MVP, non-goals, flows, acceptance criteria, evidence, assumptions, and blocking questions.
- Self-review from product, user, engineering, and test perspectives.
- Set `conclusion: "pass"` when only reversible assumptions remain.

- [ ] **Step 4: Parse PRD output with the dedicated schema**

Use:

```ts
const result = stage === "prd" ? productArtifactSchema.parse(parsed) : aiArtifactSchema.parse(parsed);
```

Keep both Responses and Chat Completions transports unchanged.

- [ ] **Step 5: Run AI tests and typecheck**

Run: `npm test -- server/src/ai.test.ts && npm run typecheck -w server`

Expected: prompt tests pass for PRD and non-PRD stages.

### Task 5: PRD-Specific Gate Behavior

**Files:**
- Modify: `shared/src/gate.test.ts`
- Modify: `shared/src/gate.ts`

- [ ] **Step 1: Add failing PRD gate cases**

Assert ordinary questions and reversible assumptions do not block PRD, while blockers do:

```ts
expect(evaluateGate("prd", { ...pass, openQuestions: ["按钮文案待验证"], blockingQuestions: [] }, defaultGateConfig).decision).toBe("auto_approve");
expect(evaluateGate("prd", { ...pass, blockingQuestions: [{ question: "删除是否可恢复" }] }, defaultGateConfig)).toMatchObject({ decision: "human_review" });
expect(evaluateGate("requirement_review", { ...pass, openQuestions: ["范围是什么"] }, defaultGateConfig).decision).toBe("human_review");
```

- [ ] **Step 2: Run gate tests and verify RED**

Run: `npm test -- shared/src/gate.test.ts`

Expected: PRD with ordinary `openQuestions` currently requires human review.

- [ ] **Step 3: Specialize question gating for PRD**

Before generic `openQuestions` handling, count `blockingQuestions` for PRD. Add a human-review reason when blockers exist; ignore PRD `openQuestions` for gating. Preserve conclusion, confidence, S0/S1 finding, risk, mandatory-human-stage, and all non-PRD behavior.

- [ ] **Step 4: Run all shared tests and typecheck**

Run: `npm test -- shared/src && npm run typecheck -w shared`

Expected: all shared tests pass.

### Task 6: Product Artifact And Knowledge UI

**Files:**
- Create: `web/src/product-artifact-view.ts`
- Create: `web/src/product-artifact-view.test.ts`
- Create: `web/src/project-knowledge-view.ts`
- Create: `web/src/project-knowledge-view.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/execution.css`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing view-model tests**

Create `productArtifactView(content)` and assert it returns normalized groups:

```ts
expect(productArtifactView(content)).toMatchObject({
  decisions: [{ title: "默认分页 20 条", evidence: ["src/ListApi.java"] }],
  assumptions: [{ title: "沿用现有错误码", validation: "接口评审确认" }],
  blockers: [{ title: "永久删除还是软删除", options: ["软删除", "永久删除"] }]
});
```

Also test historical string assumptions and missing product-only fields produce empty groups.

- [ ] **Step 2: Run view tests and verify RED**

Run: `npm test -- web/src/product-artifact-view.test.ts`

Expected: FAIL because the view model does not exist.

- [ ] **Step 3: Implement the normalization helper**

Return `goal`, `users`, `decisions`, `assumptions`, `evidence`, `scope`, `flows`, `criteria`, and `blockers`, normalizing historical strings without mutating artifact content.

- [ ] **Step 4: Render compact product review sections**

When `artifact.stage === "prd"`, render sections titled `AI 自主补全`, `依据`, `采用的假设`, and `需要人工决定`. Show the blocker section only when blockers exist; otherwise show `没有需要人工补充的阻塞问题`. Keep the existing summary and metrics above these sections.

- [ ] **Step 5: Add the project knowledge status view**

Add project knowledge view tests and render status, source HEAD, version, update time, indexed module/file counts, last error, and a `重建知识库` button in `Projects`. Poll while status is `building`; retain failure details and allow retry.

- [ ] **Step 6: Run web tests and typecheck**

Run: `npm test -- web/src/product-artifact-view.test.ts web/src/project-knowledge-view.test.ts web/src/gate-view.test.ts && npm run typecheck -w web`

Expected: tests pass and TypeScript reports no errors.

### Task 7: Full Verification, Restart, And Read-Only Pilot

**Files:**
- Verify all changed files; do not modify Soto Dine.

- [ ] **Step 1: Run complete verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests, typechecks, and the production build pass.

- [ ] **Step 2: Capture Soto Dine baseline**

Record branch, HEAD, and porcelain status for `/Users/whp/Documents/workspace/haini-workspace/soto-dine`.

- [ ] **Step 3: Build and inspect Soto Dine knowledge without model billing**

Build the persisted knowledge version and retrieve it for a representative order/user requirement. Confirm it includes relevant paths, excludes all sensitive patterns, remains within limits, and performs no writes.

- [ ] **Step 4: Browser-verify an existing PRD artifact view**

Verify the new sections render for a structured fixture or newly created local test requirement. Do not call the external model unless the user separately authorizes a billable run.

- [ ] **Step 5: Restart both services and verify recovery**

Stop the existing local dev processes, start `npm run dev`, confirm health, project knowledge status, and the browser at `http://127.0.0.1:5173/`. Verify the knowledge version survives restart.

- [ ] **Step 6: Confirm Soto Dine is unchanged**

Compare branch, HEAD, and porcelain status exactly with Step 2. Do not reset, clean, commit, or push the repository.
