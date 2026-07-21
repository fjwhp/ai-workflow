# Implementation Publication Recovery Design

## Goal

Make delivery-unit implementation publication crash recoverable, cross-process serialized, and atomically settled with its automation job. Preserve completed evidence when cleanup fails, reject ambiguous repository state, and keep source and packed installations safe.

## Publication Journal

`implementation_publication_journals` is the durable boundary between an isolated coding attempt and the authoritative project-version worktree. A prepared row binds one implementation lease to one immutable attempt and payload:

- automation job id, claim token, and worker id;
- delivery unit id and evidence version;
- execution id and stage-run id;
- attempt path, device, inode, and ownership nonce;
- repository and authoritative worktree paths;
- base commit and authoritative baseline diff hash;
- bounded binary patch bytes, byte count, and SHA-256 hash;
- expected published diff hash;
- `prepared`, `committed`, `canceled`, or `manual` status;
- independent cleanup status and bounded error text.

The journal is unique by exact job claim. A partial unique active slot permits only one `prepared`, `committed`, or `manual` row per delivery-unit evidence version; canceled attempts remain immutable history while a retry inserts a new row. Patch preparation rejects oversized payloads before persistence. The row is fsync-equivalent durable through SQLite's synchronous transaction; no temporary patch pathname is authoritative.

## Atomic Publication

Preparation runs in a short `BEGIN IMMEDIATE` transaction after coding finishes and before the authoritative worktree changes. Final publication runs inside one synchronous `BEGIN IMMEDIATE` transaction on the same `WorkflowStore` connection:

Before preparation, the service ignores custom-agent evidence as an authority and recaptures the attempt with the frozen sensitive patterns. A bounded raw Git status includes tracked, untracked, and ignored paths. Any ignored path, sensitive match, evidence exclusion, size truncation, file-count overflow, or mismatch between raw path/status and manifest content hash fails as `IMPLEMENTATION_UNPUBLISHABLE_CHANGES` before a journal row is inserted. Patch capture uses a temporary index and a fixed number of hook/filter-neutralized Git calls, with a monotonic runtime budget, so it neither scales subprocesses per file nor mutates the real index.

1. Reload and validate the live automation lease and prepared journal.
2. Capture the authoritative baseline synchronously and match the frozen base commit and baseline hash.
3. Run fixed-argv, no-hook, bounded `git apply --check`, then `git apply` using the journal BLOB through standard input.
4. Capture the exact authoritative snapshot synchronously and match the expected patch/diff hash.
5. Complete execution, stage run, coding evidence, delivery-unit state, review/test deduplicated jobs, implementation automation job, and journal status.
6. Commit SQLite.

Preparation reserves the exact token/worker lease through a bounded publication deadline. Final settlement fences expiry again after synchronous apply. If that fence or later settlement fails after apply, the service immediately runs the same prepared/exact-patch reconciliation path, reverses the patch, and makes the job retryable without waiting for restart.

No asynchronous Git process is awaited while the SQLite transaction is open. SQLite rollback cannot undo the filesystem, so a row remains `prepared` when the process dies after apply and before commit. Startup reconciliation consumes that durable intent.

Calling settlement again with the same job and claim token returns the already completed evidence without rerunning the coding agent or duplicating evidence/jobs. A different or stale token fails closed.

## Startup Reconciliation

Reconciliation runs before stage-run interruption, automation lease recovery, delivery-execution recovery, or worker startup.

- `prepared` plus authoritative clean baseline: mark canceled, then clean the attempt.
- `prepared` plus exact expected published diff: reverse the stored patch synchronously, verify the baseline is restored, mark canceled, then make the job retryable.
- any other dirty or identity-mismatched state: mark manual and fail startup closed.
- `committed`: never reverse publication; retry only owned attempt cleanup.

Cleanup failure never changes committed business state. It leaves cleanup pending with a bounded diagnostic and is retried on startup. Cleanup validates the journaled attempt identity before removal.

Startup scans cleanup-pending `canceled` as well as `committed` journals. Journal cleanup is idempotent across crashes after status commit and after filesystem removal: path, ownership marker, quarantine, and Git worktree registration are all checked against the stored device, inode, uid, and nonce. Verified total absence is success; a stale registration is safely removed/pruned before completion.

SQLite triggers make publication identity and payload immutable, reject deletion, permit status only from `prepared` to one terminal state, and prevent completed cleanup from being downgraded.

## Cross-Process Concurrency

The SQLite writer lock from `BEGIN IMMEDIATE` is the publication lock shared by every server process using the same database. Baseline inspection, lease fencing, patch application, exact-diff validation, and DB settlement all occur while that lock is held. The process-local repository `Map` is not part of the correctness model.

Two-process acceptance holds workers at a barrier before publication, expires and reassigns the first lease, then releases both. The stale process cannot apply; the current lease is the only published diff and coding evidence.

## Pilot And Installation Follow-Up

Pilot publication records and validates the direct parent's device/inode and requires a current-uid, non-symlink, non-writable parent (or an explicitly strict sticky-directory rule). Native publication opens that parent with `O_DIRECTORY | O_NOFOLLOW`, verifies identity with `fstat`, and uses dirfd-relative exclusive rename. Cleanup first quarantines staging inside the trusted parent, verifies identity, then removes it.

The native installer uses a fixed entry that exists both in source checkouts and packed output. A clean source `npm install` either compiles safely or reports a supported safe skip; packed installs continue to compile the packaged source.

## Verification

Tests include schema constraints, same-token idempotence, cleanup rejection, real child `SIGKILL` after apply and before DB commit, restart recovery, and a two-child lease barrier. Each behavior is introduced RED-first. Final verification repeats affected tests, the full macOS sandbox suite, build, typecheck, source install, packed install, and diff checks.
