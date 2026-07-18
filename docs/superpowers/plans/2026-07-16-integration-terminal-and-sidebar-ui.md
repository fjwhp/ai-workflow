# Integration Terminal And Sidebar UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove contradictory completed-state actions and make every sidebar control responsive, filterable, collapsible, and accessible.

**Architecture:** Move integration action visibility into the pure integration view model. Add small pure navigation helpers for queue filtering and selected-detail clearing, then bind them in `App`. Use a persisted desktop-only collapsed flag to switch CSS grid/sidebar classes without changing mobile navigation.

**Tech Stack:** React, TypeScript, CSS, Lucide, Vitest, localStorage

---

### Task 1: Integration terminal-state actions

**Files:** `web/src/integration-view.ts`, `web/src/integration-view.test.ts`, `web/src/main.tsx`

- [x] Write failing tests for completed, awaiting, failed, conflict, and historical action visibility.
- [x] Verify RED with `npm test -- web/src/integration-view.test.ts`.
- [x] Add `showRecheck`, `showIntegrate`, and `showRerun` view flags; suppress completed disabled reasons.
- [x] Bind buttons and stale-error clearing to those flags.
- [x] Verify GREEN.

### Task 2: Navigation and queue filters

**Files:** `web/src/navigation-view.ts`, `web/src/navigation-view.test.ts`, `web/src/main.tsx`

- [x] Write failing pure tests for queue predicates and navigation state transitions.
- [x] Verify RED.
- [x] Implement queue filter definitions and navigation state helper.
- [x] Convert queue rows and dashboard stats to buttons; clear selected detail on primary navigation.
- [x] Display filtered requirements with an active-filter label and clear action.
- [x] Verify GREEN.

### Task 3: Collapsible sidebar

**Files:** `web/src/main.tsx`, `web/src/styles.css`

- [x] Add persisted `sidebarCollapsed` state and a Lucide panel toggle with tooltip and ARIA label.
- [x] Add collapsed desktop grid/sidebar styles with stable 72px width.
- [x] Keep tablet icon rail and mobile bottom navigation behavior unchanged.
- [x] Run typecheck and focused tests.

### Task 4: Verification

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Refresh the in-app browser and verify completed integration has no red warning or action buttons.
- [x] Verify sidebar collapse/expand and queue filter interactions on desktop.
