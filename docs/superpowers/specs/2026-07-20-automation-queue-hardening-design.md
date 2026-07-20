# Automation Queue Hardening Design

## Scope

Harden the existing SQLite automation queue against corrupt stored rows, failed lease transactions,
unreachable persisted states, embedded NUL characters, and simultaneous workers. This change does not
add queue execution behavior or migrate old rows. The final worker-ID constraint changes the schema
marker from `phase-2-automation-v3` to `phase-2-automation-v4`, so an existing v3 live database is
backed up and replaced with a fresh v4 database.

## Repository Boundary

All stored rows pass through one fail-closed decoder. The decoder accepts `unknown`, validates every
persisted field and cross-field invariant, and either returns a complete `AutomationJob` or throws
`AUTOMATION_JOB_ROW_INVALID`. Stored payload parse and finite-number failures are wrapped by this row
error. Public input validation remains separate, so invalid enqueue, worker, date, and identifier
inputs retain their existing stable error codes.

The decoder validates runtime strings, enums, safe integer ranges, ASCII owner IDs, the canonical
dedupe key, finite JSON payloads, attempt limits, status/lease pairing, canonical millisecond ISO
timestamps, timestamp ordering, and nullable error text. `enqueue`, `get`, `byDedupe`, `listPending`,
and `leaseNext` reuse it.

## Lease Transaction

`leaseNext` keeps `BEGIN IMMEDIATE` and the pending partial-index selector. After the guarded update,
it fetches and decodes the complete row before `COMMIT`. Any fetch or decode error therefore rolls the
lease back, preserving `pending` and the original attempt count.

The catch path retains the original error. It attempts rollback only while `db.isTransaction` is true
and ignores a rollback error. This covers SQLite triggers using `RAISE(ROLLBACK)`, where SQLite has
already ended the transaction and a second rollback would otherwise mask the trigger error.

## Database Invariants

Pending jobs require `attempt < max_attempts`. Leased jobs require
`attempt BETWEEN 1 AND max_attempts`; all other states retain `attempt <= max_attempts`. The
`listPending` predicate is exactly the same eligibility predicate used by `leaseNext` and the partial
pending index.

Every constrained automation-job text value rejects embedded NUL explicitly before its length or
format checks. Nullable text applies the check inside its non-null branch. Normal Unicode payload and
error strings remain supported; worker identifiers use the ASCII-safe identifier policy below.

## Concurrency And Verification

Two real worker threads open independent SQLite connections, wait on a shared ready/go barrier, and
call `leaseNext` for one pending job. Exactly one result is the job and the other is null. Workers have
a finite timeout, close their database connections, and are terminated in `finally` to prevent CI
hangs or leaked handles.

Tests first reproduce transaction rollback, corrupt row groups, unreachable DDL states, NUL bypasses,
v3-to-v4 reset, and real concurrent leasing. Focused tests precede the full suite, typecheck, production
build, documentation scan, and diff check.

## Public Text Follow-Up

Public worker IDs use `[A-Za-z0-9_-]+` and a maximum length of 128. Emoji, whitespace, colon, NUL, and
other punctuation fail with `AUTOMATION_JOB_WORKER_ID_INVALID` before a lease transaction starts. The
stored-row decoder and v4 DDL enforce the same policy, so no public input can leak a SQLite CHECK error.

Failure details have a different trust boundary: handlers may receive arbitrary exception text, so
failure settlement replaces each NUL with the visible two-character sequence `\0` before truncating
to 4096 Unicode code points. `Error` objects use their message and other non-string thrown values use
a safe string conversion; an empty string retains the existing input error. Retryable and terminal
failure updates clear the lease without exposing a SQLite CHECK error, while normal Unicode and emoji
remain intact.
