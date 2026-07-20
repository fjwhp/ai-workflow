# Quality Persistence And Sandbox Hardening Design

## Goal

Close four fail-open boundaries in delivery quality execution: exhausted automation retries leaving active quality claims, host toolchains that cannot safely execute inside the sandbox, unbounded verification materialization and teardown, and unredacted quality evidence persistence.

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

The sandbox may write only the verification worktree, HOME, and TMP directories, not their parent. Final cleanup first validates the canonical generated-prefix path and atomically renames the parent into a quarantine namespace. A trusted direct `/bin/rm` child, invoked with fixed argv and no shell, receives an independent 10-second TERM/KILL budget. Failure returns `AUTOMATED_TEST_CLEANUP_FAILED`, never quality evidence, and leaves the quarantine path for a startup janitor. Before worker creation, the janitor uses the same bounded primitive, scans only a fixed number of directory entries for strict generated prefixes, and limits the number of quarantines processed per startup. Failed, remaining, or scan-truncated work is explicitly reported. Worker shutdown never waits beyond these fixed budgets.

## Persistence Redaction

`DeliveryQualityRepository` is the mandatory sanitization boundary for completion content, command results, acceptance traces, and abort errors. It recursively copies and sanitizes structured values before serialization. Sensitive key names take precedence over value heuristics. Text recognition covers Basic and Bearer authorization, AWS access/secret/session credentials, OpenAI and GitHub tokens, URL userinfo, connection strings, private keys, and key/password/secret/token assignments.

The sanitizer has explicit maximum depth, node count, string length, collection length, and total serialized bytes. It replaces bounded overflow with stable redaction/truncation markers; if the whole record cannot be safely represented, persistence throws a stable infrastructure error without writing raw data. The worker retry path then converges through the atomic terminal settlement above. Existing coding diagnostics, events, and summaries continue using the same sanitizer and must not regress.

## Verification

Tests prove three-attempt exhaustion and rollback, restart and legacy orphan recovery, token and generation boundaries, provider and command-output redaction, toolchain mutation rejection, real dependency-free npm execution from the snapshot layer, ignored dependency failure, materialization limits and deadline expiry, quarantine cleanup timeout, bounded startup janitor behavior, and bounded worker stop. Final verification runs focused tests, the real npm and macOS acceptance cases, the full suite, typecheck, build, and both diff checks.
