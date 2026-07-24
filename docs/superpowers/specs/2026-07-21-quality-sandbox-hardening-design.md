# Quality Persistence And Sandbox Hardening Design

## Goal

Close fail-open boundaries in delivery quality execution: exhausted automation retries leaving active quality claims, host toolchains that cannot safely execute inside the sandbox, unbounded verification materialization and teardown, unredacted quality evidence persistence, unsafe janitor ownership inference, and unbounded shutdown waits.

## Terminal Automation Settlement

Quality automation jobs and their quality claims share one SQLite database and must settle together. `WorkflowStore` owns one `BEGIN IMMEDIATE` transaction that changes a leased job to its retry or terminal state. When a `review` or `test` job becomes terminally failed, that same transaction aborts the matching running quality claim identified by job ID claim token, owner, evidence version, and action-to-kind mapping. The abort uses a stable error code and writes no quality evidence.

Failures in either update roll back both updates. A retryable failure below the attempt cap keeps the job pending and the same-token quality claim running. A different token cannot enter that claim. A new evidence version has an independent job dedupe key and independent quality run.

Startup expired-lease recovery uses the same transaction and then reconciles legacy terminal-job/running-claim pairs. This closes a crash after a handler failure but before worker settlement without inventing successful or failed quality evidence.

## Frozen Toolchain Layer

Project ignored artifacts, including `node_modules`, never enter verification evidence or the runtime sandbox. Dependencies required by verification must be supplied as tracked, hash-verifiable project evidence or as part of the frozen command toolchain closure. A live ignored `node_modules` directory is never trusted or copied; when verifiable dependencies are absent, the fixed command records an explicit failure.

Before materialization, each frozen command is resolved through the sanitized PATH to a canonical executable. The resolver parses a bounded shebang, including `/usr/bin/env` interpreter lookup, and locates the nearest package root required by script entrypoints such as npm. It rejects unsupported, ambiguous, cyclic, oversized, or mutable layouts.

The minimal closure is copied into a content-addressed `.toolchain/<fingerprint>` directory under the verification root. The closure contains the canonical entrypoint, its interpreter, the nearest package-root contents, and the minimal bin links needed for fixed-argv execution. Copying is bounded by file count, directory count, path depth, per-file bytes, and total bytes. Snapshotting runs in a trusted direct child with only the remaining plan deadline; the parent applies TERM followed by KILL, so hashing and copying cannot extend the plan indefinitely. A canonical manifest records relative paths, type, mode, size, link target, and SHA-256. The copied layer is rehashed, made read-only, and rehashed again before command launch.

Commands execute only snapshot entrypoints. For npm this means the snapshot Node binary and snapshot npm CLI, with PATH limited to snapshot bins plus system directories. The Seatbelt profile permits read-only access to the frozen layer and explicitly denies writes to it. The layer fingerprint, relative manifest, and relative command metadata are included in automated-testing results and persisted quality evidence; ephemeral absolute verification paths remain runtime-only. Verification aborts as infrastructure failure if snapshot identity changes.

## Bounded Materialization And Cleanup

Evidence validation adds explicit entry, inode, directory, path-depth, decoded-file, and total-byte limits. Materialization runs in a trusted direct child process launched with the current Node executable and fixed helper/config arguments. It cannot spawn descendants. The parent gives it only the remaining plan deadline, then applies TERM followed by KILL. Expiry records deadline results for every unstarted command and never starts a verification command.

The sandbox may write only the verification worktree, HOME, and TMP directories, not their parent. Active roots use the exact `ai-workflow-verification-<six-character-mkdtemp-suffix>` grammar, mode `0700`, and a `0600` regular-file marker containing version, uid, random UUID nonce, device, and inode. Final cleanup validates that identity, revalidates it immediately before rename, and renames to the exact `<suffix>-<nonce>` quarantine grammar. The startup janitor considers only exact quarantine names whose marker schema, uid, modes, nonce, device, and inode all match. It revalidates the same observed identity after scanning, before cleanup, and before each trusted `chmod` and `rm` subprocess. A mismatch is reported and never deleted.

A trusted direct `/bin/rm` child, invoked with fixed argv and no shell, receives an independent 10-second TERM/KILL budget. Failure returns `AUTOMATED_TEST_CLEANUP_FAILED`, never quality evidence, and leaves the quarantine path for a startup janitor. Before worker creation, the janitor scans only a fixed number of directory entries and limits the number of quarantines processed per startup. Failed, remaining, or scan-truncated work is explicitly reported.

Node does not expose the `openat`/directory-fd-relative rename, chmod, and remove primitives needed to eliminate path replacement races. Marker and inode revalidation narrows the window but does not remove the residual TOCTOU interval between the final check and trusted subprocess path resolution. The implementation therefore does not claim absolute race elimination.

## Persistence Redaction

`DeliveryQualityRepository` is the mandatory sanitization boundary for completion content, command results, acceptance traces, and abort errors. It recursively copies and sanitizes structured values before serialization. Sensitive key names take precedence over value heuristics. Text recognition covers Basic and Bearer authorization, AWS access/secret/session credentials, OpenAI and GitHub tokens, URL userinfo, connection strings, private keys, and key/password/secret/token assignments.

The sanitizer has explicit maximum depth, node count, string length, collection length, and total serialized bytes. During traversal it incrementally charges exact UTF-8 JSON bytes for escaped strings and keys, numbers, booleans, null, commas, colons, brackets, and braces. It stops before visiting or constructing later values as soon as the next serialized token exceeds the budget. A final `JSON.stringify` byte check remains as defense in depth. If the whole record cannot be safely represented, persistence throws a stable infrastructure error without writing raw data. The worker retry path then converges through the atomic terminal settlement above. Existing coding diagnostics, events, and summaries continue using the same sanitizer and must not regress.

## Cancellation And Shutdown

Every leased automation handler receives a per-job `AbortSignal`. Worker stop permanently disables polling, cancels the heartbeat, aborts the active controller, and waits at most 15 seconds for the same in-flight drain. An abort-aware handler settles normally through the repository. An abort-ignoring handler makes stop reject with `AUTOMATION_WORKER_STOP_TIMEOUT`; it is not leased or settled again. After that same handler eventually settles, a later stop may wait for it and succeed.

Review combines the worker signal with a disposable 300-second provider deadline and supplies the resulting signal to both OpenAI Responses and Chat Completions request options. Materialization, toolchain snapshotting, launchd-managed commands, and fallback command execution receive the worker signal. Trusted children escalate TERM to KILL; launchd execution immediately enters coalition termination and bootout. Those cleanup paths use independent uncanceled budgets. Automated testing waits for child/coalition cleanup and verification-root cleanup before throwing `AUTOMATED_TEST_ABORTED`, which the quality service maps to retryable infrastructure failure without evidence.

Server resource closure marks resources closed only after worker stop and SQLite close both succeed. If stop times out, the first close rejects and SQLite remains open. A later close bypasses any app-level cached rejection, waits for the same in-flight worker drain, then closes SQLite exactly once. Normal close remains idempotent.

## Verification

Tests prove three-attempt exhaustion and rollback, restart and legacy orphan recovery, token and generation boundaries, provider and command-output redaction, incremental byte-budget termination, toolchain mutation rejection, real dependency-free npm execution from the snapshot layer, ignored dependency failure, materialization limits and deadline expiry, ownership-marker forgery and inode replacement rejection, valid stale cleanup and concurrent disappearance, provider/helper/command cancellation, containment cleanup ordering, bounded worker stop, and retryable server close. Final verification runs focused tests, the real npm and macOS acceptance cases, the full suite, typecheck, build, and both diff checks.
