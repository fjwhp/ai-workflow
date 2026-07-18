# Mobile Action Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current-stage approval controls above long artifact content on mobile and visible beside it on desktop.

**Architecture:** Preserve the existing component order and grid. Replace the mobile block layout with a vertical flex layout so `order: -1` works, and make the desktop action panel sticky without using a fixed overlay.

**Tech Stack:** CSS, React, in-app browser responsive verification

---

### Task 1: Responsive action-panel layout

**Files:**
- Modify: `web/src/styles.css`

- [x] Capture the current 390px DOM geometry and verify the action panel follows the artifact section.
- [x] Change the mobile `.detail-grid` to `display:flex; flex-direction:column` and retain `.action-panel{order:-1}`.
- [x] Add desktop-only sticky positioning to `.action-panel` with `top:16px`.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [x] Verify at 390px, 760px, and desktop width that the action panel precedes or remains beside the artifact, with no overlap or horizontal overflow.
