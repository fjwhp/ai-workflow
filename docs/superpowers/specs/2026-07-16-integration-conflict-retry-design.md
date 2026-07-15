# Integration Conflict Retry Design

## Goal

Allow a requirement whose first local application produced a Git conflict to be retried without losing coding evidence or leaving the target repository in a conflicted state.

## Current Failure

The first integration attempt commits the AI worktree changes before applying that commit to the target repository. If the apply conflicts, the target repository is reset, but subsequent preflight checks still require an uncommitted worktree diff. The source worktree is now clean, so preflight reports zero changed files and stale evidence even though the committed source change still exists.

## Design

Integration evidence has two valid forms:

1. Uncommitted worktree diff matching the stored coding evidence hash.
2. A source commit created by a previous integration attempt, whose patch matches the stored coding evidence hash.

For a fresh attempt, the service validates the worktree diff, creates the source commit, and records it on the integration run. For a retry after conflict, it reuses the recorded source commit and does not create another commit.

Preflight returns the evidence mode, resolved source commit, and checks that explain whether the worktree diff or committed patch is valid. A previous conflict does not by itself block another attempt.

## Conflict Handling

The target repository is captured before applying the source commit. On conflict, the service collects the conflicted file paths, aborts the cherry-pick where possible, resets the target repository to the captured commit, and verifies that no partial changes remain. The integration run stores the source commit, conflict paths, and error.

The workflow remains at `integration / awaiting_merge`, so the user can inspect the conflict and retry. No commit, push, or pull request is created in the target repository.

## User Interface

When the latest integration run has status `conflict`, the integration panel shows:

- the source commit;
- a concise conflict explanation;
- the conflicting file list;
- a `重新应用到本地` action when commit-based preflight succeeds.

The existing target branch selector and protected-branch confirmation remain unchanged.

## API And Storage

The latest conflict run supplies the reusable source commit. No schema migration is required because integration runs already persist `source_commit`, preflight JSON, and error text. Conflict paths are stored inside preflight/result JSON.

Integration context passes the reusable commit to preflight and execution only when it belongs to the same requirement, evidence record, source branch, worktree, and target branch.

## Safety

- Validate that the reusable commit is reachable from the expected source branch.
- Hash the commit patch using the same canonical diff representation as coding evidence.
- Never reuse a commit from another requirement, evidence record, source branch, or target branch.
- Always restore the target repository after a failed apply.
- Never commit or push the target branch.

## Tests

Add regression coverage for:

- preflight accepting a clean source worktree when a matching source commit is supplied;
- preflight rejecting an unrelated or changed source commit;
- conflict results containing conflict paths while restoring a clean target worktree;
- retry reusing the existing source commit instead of creating a second commit;
- integration view enabling `重新应用到本地` after successful commit-based preflight;
- integration view showing clear disabled reasons when committed evidence is invalid.
