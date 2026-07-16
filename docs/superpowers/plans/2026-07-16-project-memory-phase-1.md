# Project Memory Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist evidence-backed candidate knowledge from approved workflow artifacts and publish safe candidates when local application and verification complete.

**Architecture:** Add normalized knowledge records, candidates, and change sets to the existing SQLite store. A deterministic extractor maps approved artifact fields into typed candidates. Completion creates a change set, auto-publishes low-risk non-conflicting candidates, and leaves risky or conflicting candidates for review. APIs expose project records and requirement changes; the UI adds read-only views.

**Tech Stack:** TypeScript, Node SQLite, Fastify, React, Vitest

---

### Task 1: Knowledge domain and extraction

**Files:**
- Create: `server/src/project-memory.ts`
- Create: `server/src/project-memory.test.ts`

- [ ] Write failing tests for approved artifact extraction, unapproved exclusion, evidence links, risk gating, and duplicate subjects.
- [ ] Verify RED.
- [ ] Implement deterministic extraction from product decisions, facts, findings, risks, scope, acceptance criteria, and integration results.
- [ ] Verify GREEN.

### Task 2: Persistent lifecycle

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`

- [ ] Write failing tests for candidate persistence, immutable active versions, publication, conflict, and supersession.
- [ ] Verify RED.
- [ ] Add `knowledge_records`, `knowledge_record_versions`, `knowledge_candidates`, and `knowledge_change_sets` tables and store methods.
- [ ] Verify GREEN.

### Task 3: Workflow publication service

**Files:**
- Create: `server/src/project-memory-service.ts`
- Create: `server/src/project-memory-service.test.ts`
- Modify: `server/src/app.ts`

- [ ] Write failing service tests for candidate refresh after approval and publication after completed integration.
- [ ] Verify RED.
- [ ] Build candidates from approved artifacts, create a completion change set, publish safe candidates, retain review candidates, and make completion idempotent.
- [ ] Call publication after successful integration and test rerun completion.
- [ ] Verify GREEN.

### Task 4: APIs and UI

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] Add API tests for project memory and requirement knowledge changes.
- [ ] Add `GET /api/projects/:id/memory` and `GET /api/requirements/:id/knowledge-changes`.
- [ ] Add project knowledge layer summaries and a requirement knowledge-change section.
- [ ] Show candidate, active, conflict, and superseded status with evidence and source stage.

### Task 5: Verification

- [ ] Run focused tests.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Refresh the browser and verify Soto Dine project memory and REQ-0001 change set.
- [ ] Confirm no model request, repository commit, or push occurred.
