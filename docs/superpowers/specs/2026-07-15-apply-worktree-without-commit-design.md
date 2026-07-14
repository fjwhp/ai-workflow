# Apply Worktree Changes Without Committing

## Goal

Change the integration action from creating a commit on the local target branch to applying the AI worktree changes into the target branch working tree without committing or pushing.

## User Experience

- Rename the primary action to `应用到本地工作区`.
- State beside the action and in the confirmation dialog that the operation does not commit and does not push.
- Continue showing the exact source worktree branch and requirement-specific target branch.
- After application, show changed files, staged state, test results, and the command the user can run when ready to commit.
- Use outcome labels that distinguish `已应用，测试通过` from `已应用，测试失败`.

## Git Behavior

1. Require the target repository to be on the selected target branch with a clean working tree.
2. Create one source commit inside the isolated AI worktree, as today, so Git has a stable change set.
3. Apply that source commit in the target repository with `git cherry-pick --no-commit <sourceCommit>`.
4. Leave the resulting changes staged in the target working tree. Do not create a target commit.
5. Never run `git push`, create a remote branch, or update a remote ref.

The integration record stores the source commit and records the target HEAD that existed before application. It must not describe the target HEAD as a newly created integration commit.

## Tests And State

- Run the configured project verification commands against the target working tree after changes are applied.
- When tests pass, mark the requirement completed while leaving the local changes staged and uncommitted.
- When tests fail, use the existing merge-test-failed state, keep the staged changes available for inspection, and allow test reruns without applying the change set again.
- The UI must make clear that test failure does not mean the local application failed.

## Conflict Recovery

If `cherry-pick --no-commit` conflicts:

1. Abort or reset only the integration operation's changes back to the captured pre-operation target HEAD.
2. Confirm the target working tree is clean again.
3. Record a conflict result and show the conflicting paths.
4. Do not retain a partial index or unresolved conflict markers.

Because preflight requires a clean target, this recovery cannot overwrite unrelated user changes that existed before the operation.

## Safety Invariants

- No target commit is created by the workflow.
- No remote operation is available in this flow.
- A dirty target repository blocks application.
- A requirement cannot apply the same change set twice.
- Protected branch confirmation remains required even though the result is uncommitted.
- Browser verification must not apply changes to the Soto Dine repository.

## Verification

- Unit tests cover `cherry-pick --no-commit`, staged uncommitted output, conflict cleanup, and test-failure retention.
- API tests confirm integration records do not claim a new target commit.
- View tests cover local-workspace wording and the absence of commit/push promises.
- Full tests, typecheck, and production build must pass.
- Browser verification stops before the apply action and confirms the revised wording.
