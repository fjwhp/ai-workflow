# Change-Aware Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically select safe module-scoped verification commands from each requirement's coding evidence when applying changes locally.

**Architecture:** Add a deterministic verification planner that maps changed Maven files to their nearest module `pom.xml`, emits shell-free command descriptors, and falls back to project commands only when inference cannot produce a plan. Integration preflight and execution share the same server-calculated plan, and the UI presents it before application.

**Tech Stack:** TypeScript, Fastify, React, Git CLI, Node filesystem APIs, Vitest

---

### Task 1: Maven verification planner

**Files:**
- Create: `server/src/verification-plan.ts`
- Create: `server/src/verification-plan.test.ts`

- [ ] Write failing tests for one module, duplicate files, multiple modules, root build changes, and fallback.
- [ ] Run `npm test -- server/src/verification-plan.test.ts` and verify RED.
- [ ] Implement `buildVerificationPlan({ repoPath, changedFiles, fallbackCommands })` using nearest `pom.xml` discovery and safe `{command,argsPrefix}` descriptors.
- [ ] Run the test and verify GREEN.

### Task 2: Integration preflight and execution

**Files:**
- Modify: `server/src/integration.ts`
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/app.ts`

- [ ] Write failing tests requiring preflight to expose `changedModules`, `plannedCommands`, and `commandSource`.
- [ ] Run focused tests and verify RED.
- [ ] Pass evidence files and fallback commands through integration context, calculate the plan in preflight, block when no safe command exists, and execute only `preflight.plannedCommands`.
- [ ] Run focused tests and verify GREEN.

### Task 3: Integration UI

**Files:**
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles.css`

- [ ] Render detected modules and planned commands in the integration panel before confirmation.
- [ ] Preserve existing conflict, retry, protected-branch, and no-push behavior.
- [ ] Run web typecheck and integration view tests.

### Task 4: Verification

**Files:**
- Verify only

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Restart one dev-service instance.
- [ ] Verify current REQ-0001 planning selects `dine-service/dine-admin-service` rather than `dine-product-service`.
- [ ] Confirm Soto Dine remains uncommitted and unpushed.
