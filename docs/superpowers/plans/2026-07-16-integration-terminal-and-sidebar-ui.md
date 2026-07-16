# Integration Terminal And Sidebar UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove contradictory completed-state actions and make every sidebar control responsive, filterable, collapsible, and accessible.

**Architecture:** Move integration action visibility into the pure integration view model. Add small pure navigation helpers for queue filtering and selected-detail clearing, then bind them in `App`. Use a persisted desktop-only collapsed flag to switch CSS grid/sidebar classes without changing mobile navigation.

**Tech Stack:** React, TypeScript, CSS, Lucide, Vitest, localStorage

---

### Task 1: Integration terminal-state actions

**Files:** `web/src/integration-view.ts`, `web/src/integration-view.test.ts`, `web/src/main.tsx`

- [ ] Write failing tests for completed, awaiting, failed, conflict, and historical action visibility.
- [ ] Verify RED with `npm test -- web/src/integration-view.test.ts`.
- [ ] Add `showRecheck`, `showIntegrate`, and `showRerun` view flags; suppress completed disabled reasons.
- [ ] Bind buttons and stale-error clearing to those flags.
- [ ] Verify GREEN.

### Task 2: Navigation and queue filters

**Files:** `web/src/navigation-view.ts`, `web/src/navigation-view.test.ts`, `web/src/main.tsx`

- [ ] Write failing pure tests for queue predicates and navigation state transitions.
- [ ] Verify RED.
- [ ] Implement queue filter definitions and navigation state helper.
- [ ] Convert queue rows and dashboard stats to buttons; clear selected detail on primary navigation.
- [ ] Display filtered requirements with an active-filter label and clear action.
- [ ] Verify GREEN.

### Task 3: Collapsible sidebar

**Files:** `web/src/main.tsx`, `web/src/styles.css`

- [ ] Add persisted `sidebarCollapsed` state and a Lucide panel toggle with tooltip and ARIA label.
- [ ] Add collapsed desktop grid/sidebar styles with stable 72px width.
- [ ] Keep tablet icon rail and mobile bottom navigation behavior unchanged.
- [ ] Run typecheck and focused tests.

### Task 4: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Refresh the in-app browser and verify completed integration has no red warning or action buttons.
- [ ] Verify sidebar collapse/expand and queue filter interactions on desktop.
