# Isolated Delivery Application Design

## Goal

Remove the race-prone target-conflict rollback path from delivery application while preserving the Phase 3 contract: verified delivery-unit evidence is applied to the selected local project-version worktree without committing it, changing its branch HEAD, or publishing any Git ref.

Deterministic conflicts must be discovered in an isolated Git index before the target worktree is modified. Once real target mutation starts, any unexpected failure or concurrent external change is preserved as an uncertain state for explicit recovery; the application service never tries to infer that it still owns and may erase the resulting files.

## Confirmed Decisions

- Use an isolated three-way index to determine whether `sourceCommit` can be applied to `preApplyHead`.
- Return an ordinary `conflict` result only when the isolated index proves a deterministic conflict. The real target remains byte-for-byte unchanged.
- Remove automatic `restore`, `rm`, and `cherry-pick --quit` from delivery application.
- Run the real target mutation only after the isolated merge is clean and the target identity, branch, HEAD, cleanliness, application claim, and deadline are valid.
- If the real mutation fails or its postcondition cannot be proven, return `ambiguous` and preserve the target exactly as observed. Do not attempt cleanup.
- Keep successful target changes uncommitted. Never push, create a pull request, tag, release, or remote ref.
- Fence every visible source ref or real-index mutation immediately before and after its Git subprocess.
- Preserve callback errors as infrastructure/ownership errors. Do not convert them into ordinary application results.

## Why The Existing Design Must Change

The existing implementation runs `cherry-pick --no-commit` in the real target and attempts to roll it back after a conflict. It can prove that a conflict initially matches the expected source, target, and base objects, but it cannot prevent another local actor from editing or resolving that conflict between proof and cleanup. Rechecking more often narrows the interval without eliminating it.

The unsafe capability is automatic destructive cleanup in a shared worktree. The new design removes that capability. Read-only conflict simulation happens in disposable state, and the real target has no automatic rollback path.

## Component Responsibilities

### Delivery Application Service

The service continues to own:

- delivery-unit context validation;
- application-job lease and claim fencing;
- evidence-version association;
- source-commit binding and retry recovery;
- application settlement and sanitized persistence.

It supplies explicit callbacks for current source and target ownership. Callback errors propagate unchanged and leave the run unsettled so queue retry/reconciliation can use the existing claim lineage.

The service does not perform Git operations and does not interpret conflict internals.

### Local Integration Boundary

`integration.ts` continues to own local Git mechanics only:

- bounded, abortable, sanitized Git execution;
- source commit preparation;
- isolated conflict simulation;
- one no-commit target application attempt;
- contained post-application verification;
- read-only postcondition inspection.

It does not own queue sequencing, requirement state, database settlement, routes, or UI actions.

### Repository Evidence Helpers

Repository and evidence-tree helpers keep optional `AbortSignal` and absolute deadline inputs. Existing callers that omit them retain their current behavior. Delivery application passes both values through every identity, evidence, and Git subprocess call.

## Frozen Git Execution Session

Application creates a bounded execution session with:

- one absolute application deadline;
- the worker `AbortSignal`;
- a strict environment allowlist;
- hooks, fsmonitor, external diff, text conversion, and clean/smudge/process filters disabled;
- bounded stdout and stderr;
- no shell execution.

Filter overrides are discovered before a mutation fence. Mutation commands receive a prepared environment so no hidden filter-discovery subprocess runs between the final ownership callback and the actual Git subprocess.

Read-only Git operations may prepare their own environment, but every operation still receives the remaining deadline and abort signal.

## Source Commit Transaction

Source preparation has four explicit phases.

### 1. Freeze Evidence

Capture the source worktree identity and manifest. Validate the frozen evidence hash and exact changed path set. Invoke the current-source-claim callback before preparing repository objects.

### 2. Build Unreferenced Objects

Use a temporary index to build blobs, tree, and commit objects from the frozen manifest. Filters are disabled and blobs use raw frozen bytes. At this point no source branch ref or real source index is changed.

Unreferenced objects left by cancellation or a crash are harmless and may be pruned by normal Git maintenance. They are never treated as trusted evidence without the existing parent, path, and evidence-hash validation.

### 3. Publish The Source Ref

Update the managed source branch with compare-and-swap `update-ref`. The Git subprocess receives current-source-claim callbacks immediately before and after execution.

After the post-command fence succeeds, invoke `onSourcePrepared(sourceCommit)` immediately. This binds the commit to the application run before any further visible source mutation. If the process stops between ref publication and binding, existing unbound-commit recovery validates the exact parent, path set, and evidence hash on retry.

### 4. Synchronize The Real Source Index

Synchronize only the frozen evidence paths in the real source index. Preserve excluded or independently staged paths. Each real-index mutation is bounded and receives current-source-claim callbacks immediately before and after its subprocess.

Loss of ownership stops remaining index work. It never starts target simulation or target mutation.

## Isolated Conflict Simulation

Before touching the target, create a disposable index and perform the three-way merge equivalent of applying the source change:

```text
base   = sourceCommit^
ours   = preApplyHead
theirs = sourceCommit
```

The simulation uses Git's index merge machinery with `GIT_INDEX_FILE` pointing to the disposable index. It may write temporary index data and unreferenced merge objects, but it does not change a worktree, branch, or persistent application ref.

After simulation:

- any unmerged entries produce a `conflict` result with bounded conflict paths;
- the target identity, HEAD, index, worktree files, and refs must remain unchanged;
- a clean index produces a deterministic merged tree used only as verification evidence for the next step;
- the merged tree path set must match the frozen source change semantics;
- temporary files are removed with an independent bounded cleanup budget.

No `conflict` result is produced from a failed real-target mutation. Real-target failures are always uncertain because concurrent external activity cannot be distinguished safely.

## Real Target Application

Immediately before the target subprocess, after Git environment preparation, the boundary invokes a target-ownership callback. The target must previously have passed identity, registered-worktree, branch, clean-status, and exact-HEAD checks.

The boundary then runs the single local `cherry-pick --no-commit sourceCommit` subprocess with the remaining deadline and abort signal. An after callback immediately revalidates the live claim.

Outcomes:

- Success with valid postconditions: continue to verification.
- Git failure, timeout, abort, claim loss, or invalid postcondition: preserve the target and return or propagate an uncertain outcome. Never run restore, reset, rm, checkout, clean, or cherry-pick cleanup.
- External modification detected after the earlier clean check: preserve it. The application run owns the resulting dirty/uncertain state until explicit recovery resolves it.

This design does not claim that external filesystem writes can be prevented during a multi-file Git operation. It guarantees that delivery application will not erase them automatically.

## Verification And Settlement

Trusted index checks and isolated project commands retain their current containment:

- live target claim immediately before and after each command;
- one absolute deadline;
- abort-aware process-tree cleanup;
- sanitized environment and frozen toolchain;
- bounded and redacted output.

Settlement meanings remain:

- `applied`: real target application and all verification passed; target is intentionally dirty and HEAD unchanged;
- `conflicted`: isolated simulation found deterministic conflicts; target is untouched and clean;
- `failed` with clean state: preflight/source preparation failed before target mutation;
- `failed` with dirty or uncertain state: real mutation or verification did not complete safely; explicit recovery is required.

Callback, lease, and abort failures propagate rather than settling a normal result. Queue retry or reconciliation handles their application run lineage.

## Recovery And Retry

- A deterministic conflict reuses the same trusted source commit on retry.
- A crash after source ref publication but before binding uses existing exact unbound-commit recovery.
- A clean terminal failure may reuse the trusted source commit when evidence, parent, project version, and path proof still match.
- A dirty or uncertain target cannot be retried automatically. The run remains the durable owner until a later scoped recovery API records that the target was committed or reverted.
- Applied siblings are never reset when another unit conflicts or becomes uncertain.

## Security Invariants

- Target HEAD never changes during successful application.
- No automatic target commit, push, tag, release, pull request, or remote-ref creation exists.
- Source commits contain exactly frozen evidence paths and bytes.
- Inherited `GIT_*` variables, hooks, filters, text conversion, fsmonitor, and external diff cannot redirect or extend execution.
- Every subprocess is bounded and abortable.
- Every visible source ref/index mutation and target mutation has immediate before and after ownership callbacks.
- Delivery application contains no destructive target conflict cleanup.
- Persisted preflight, command, conflict, and error evidence is bounded, redacted, and sanitized.

## Test Strategy

### Isolated Conflict Tests

- A deterministic text conflict returns conflict paths while target HEAD, index bytes, worktree bytes, status, and refs remain unchanged.
- Add/delete, rename-like, binary, mode, and symlink conflicts are detected without target mutation.
- A clean simulation yields the expected merged tree and permits no-commit application.
- Temporary index cleanup is bounded and cancellation-aware.

### Source Mutation Fence Tests

- Lease loss during filter preparation prevents `update-ref` from starting.
- Lease loss as `update-ref` completes stops before commit binding or index synchronization and is recoverable.
- Binding callback failure propagates the same error object and leaves the run applying.
- Lease loss before or after a real source-index update prevents remaining index operations and all target work.

### Target Race Tests

- External conflict or edit introduced after simulation but before real mutation is preserved; no cleanup command starts.
- Real mutation failure never invokes restore, reset, rm, checkout, clean, or cherry-pick quit/abort.
- Claim loss or abort during the target subprocess propagates and leaves the run unsettled.
- Target HEAD and remote refs remain unchanged for success, deterministic conflict, failure, timeout, and abort.

### Regression Verification

- Delivery application, integration, repository, evidence-tree, automated-testing, process-execution, job-repository, and store suites pass outside the restricted sandbox where process enumeration is required.
- Server and shared typechecks pass.
- Full tests and production builds pass before Phase 3 completion.
- `git diff --check` passes for the task range and complete phase range.

## Non-Goals

- Preventing arbitrary external processes from writing directly to local worktree files.
- Automatically repairing a target after a concurrent external edit.
- Committing or publishing target changes.
- Queue sequencing, acceptance APIs, UI work, or pilot execution in this refactor.
- Changing successful source-commit reuse, evidence versions, or application persistence schemas.
