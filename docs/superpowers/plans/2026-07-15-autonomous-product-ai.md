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

### Task 2: Bounded Read-Only Project Evidence

**Files:**
- Create: `server/src/product-context.ts`
- Create: `server/src/product-context.test.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write a temporary-repository collector test**

Build a fixture with `README.md`, a relevant controller, an unrelated source file, `.env`, `private.pem`, `.git/config`, `node_modules`, and an oversized file. Assert:

```ts
const result = await collectProductContext({ repoPath, requirement, sensitivePatterns: ["private*"] });
expect(result.files.map(item => item.path)).toContain("README.md");
expect(result.files.map(item => item.path)).toContain("src/OrderController.java");
expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
expect(result.files.map(item => item.path)).not.toContain("private.pem");
expect(result.totalChars).toBeLessThanOrEqual(40_000);
```

- [ ] **Step 2: Run the collector test and verify RED**

Run: `npm test -- server/src/product-context.test.ts`

Expected: FAIL because `collectProductContext` does not exist.

- [ ] **Step 3: Implement safe traversal and relevance ranking**

Use `readdir({ withFileTypes: true })`, `readFile`, and `realpath`. Never follow symlinks. Exclude `.git`, dependency/build directories, hidden credential files, key/certificate extensions, project sensitive patterns, files over 128 KB, and binary content. Rank README/build/schema files first, then files whose path or content matches normalized requirement terms. Return at most 24 files and 40,000 characters:

```ts
type ProductContext = {
  policyVersion: "product-v1";
  files: { path: string; excerpt: string; truncated: boolean }[];
  totalChars: number;
  truncated: boolean;
};
```

- [ ] **Step 4: Add project evidence before PRD stage-run creation**

In `POST /api/requirements/:id/run`, only for `stage === "prd"` and a linked valid project, collect evidence and add it to the persisted run input:

```ts
const productContext = item.stage === "prd" && project
  ? await collectProductContext({ repoPath: project.repoPath, requirement: item, sensitivePatterns: project.sensitivePatterns })
  : undefined;
const context = { requirement: item, priorArtifacts, approvalHistory, productContext, reworkContext, userContext: req.body?.context };
```

Emit a sanitized `product.context_collected` event with paths, counts, and truncation, never raw excluded content.

- [ ] **Step 5: Run collector and API tests**

Run: `npm test -- server/src/product-context.test.ts server/src/app.test.ts && npm run typecheck -w server`

Expected: tests pass and the linked project remains unchanged.

### Task 3: Product-Specific Prompt And Parsing

**Files:**
- Modify: `server/src/ai.ts`
- Modify: `server/src/ai.test.ts`

- [ ] **Step 1: Write failing product prompt tests**

Export a pure `buildAgentPrompt(stage, context)` helper and assert the PRD prompt includes:

```ts
expect(prompt).toContain("默认自主推进");
expect(prompt).toContain("先检索 productContext");
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

### Task 4: PRD-Specific Gate Behavior

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

### Task 5: Product Artifact Review UI

**Files:**
- Create: `web/src/product-artifact-view.ts`
- Create: `web/src/product-artifact-view.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/execution.css`

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

- [ ] **Step 5: Run web tests and typecheck**

Run: `npm test -- web/src/product-artifact-view.test.ts web/src/gate-view.test.ts && npm run typecheck -w web`

Expected: tests pass and TypeScript reports no errors.

### Task 6: Full Verification And Read-Only Pilot

**Files:**
- Verify all changed files; do not modify Soto Dine.

- [ ] **Step 1: Run complete verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests, typechecks, and the production build pass.

- [ ] **Step 2: Capture Soto Dine baseline**

Record branch, HEAD, and porcelain status for `/Users/whp/Documents/workspace/haini-workspace/soto-dine`.

- [ ] **Step 3: Run a collector-only pilot against Soto Dine**

Call `collectProductContext` with a representative order/user requirement. Confirm returned evidence includes relevant paths, excludes all sensitive patterns, remains within limits, and performs no writes.

- [ ] **Step 4: Browser-verify an existing PRD artifact view**

Verify the new sections render for a structured fixture or newly created local test requirement. Do not call the external model unless the user separately authorizes a billable run.

- [ ] **Step 5: Confirm Soto Dine is unchanged**

Compare branch, HEAD, and porcelain status exactly with Step 2. Do not reset, clean, commit, or push the repository.
