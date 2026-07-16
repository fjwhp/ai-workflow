# Integration Terminal UI Design

## Goal

Make the integration panel show only actions valid for the requirement's current state, with a clean terminal state after local application and verification complete.

## State Matrix

| Requirement state | Display | Available actions |
| --- | --- | --- |
| `awaiting_merge` | Preflight checks, planned modules and commands | Recheck, apply locally |
| `awaiting_merge` with latest conflict | Conflict details and commit-backed preflight | Recheck, reapply locally |
| `merge_test_failed` | Applied changes, failed command and output | Rerun tests |
| `completed` | Target branch, applied source commit, successful commands | None |
| Historical integration stage | Stored result only | None |

## Behavior

The integration view model exposes explicit action visibility instead of always returning `showIntegrate: true`. A completed state has no disabled reason because application is finished, not unavailable. Disabled reasons are reserved for an action the user can reasonably attempt in the current state.

The component clears stale local errors when the requirement status changes. It only renders the recheck button in `awaiting_merge`, only renders the apply button when the view model allows it, and only renders the rerun button in `merge_test_failed`.

The backend preflight endpoint remains restricted to `awaiting_merge`. The UI no longer calls it or offers a control that calls it after completion.

## Completed Presentation

The completed panel displays:

- `已完成` status;
- source worktree commit;
- target branch and target commit captured before local application;
- automatically selected verification modules and commands;
- successful command exit codes;
- a clear statement that changes remain local and uncommitted.

No error-colored notice or disabled action reason appears.

## Tests

Add view-model coverage proving:

- completed state hides recheck, apply and rerun actions;
- completed state has no disabled reasons;
- awaiting merge exposes recheck and apply;
- test failure exposes rerun only;
- conflict exposes recheck and reapply;
- historical stages expose no actions.
