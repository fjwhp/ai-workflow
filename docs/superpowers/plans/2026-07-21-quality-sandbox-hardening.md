# Quality Sandbox Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delivery quality terminal settlement, persistence, toolchain execution, materialization, and cleanup fail closed under retries, hostile output, mutation, and deadlines.

**Architecture:** SQLite atomically settles automation jobs with their quality claims. Quality persistence deep-sanitizes bounded JSON. Automated testing snapshots a hashed minimal toolchain into the verification root and delegates bounded filesystem work to trusted direct child processes.

**Tech Stack:** TypeScript, Node.js child processes, SQLite, macOS Seatbelt/launchd, Vitest.

---

### Task 1: Bound And Redact Quality Persistence

**Files:**
- Modify: `server/src/redaction.ts`
- Modify: `server/src/redaction.test.ts`
- Modify: `server/src/delivery-quality-repository.ts`
- Modify: `server/src/delivery-quality-repository.test.ts`
- Modify: `server/src/delivery-execution-service.test.ts`

- [ ] Write failing repository and service tests whose review content, command output, trace, and error contain Basic/Bearer, AWS, OpenAI, GitHub, URL, DSN, and sensitive-key secrets.
- [ ] Run `npm test -- server/src/redaction.test.ts server/src/delivery-quality-repository.test.ts server/src/delivery-execution-service.test.ts` and confirm raw secrets are persisted by current code.
- [ ] Extend `redactSensitive` with explicit limits and return a detached JSON-safe value:

```ts
export interface RedactionLimits {
  maxDepth: number; maxNodes: number; maxStringCodePoints: number;
  maxCollectionItems: number; maxBytes: number;
}
export function redactSensitive(value: unknown, patterns?: string[], limits?: Partial<RedactionLimits>): unknown;
```

- [ ] Sanitize completion fields in `completeInTransaction` before the first INSERT and sanitize stable abort errors before UPDATE. Throw `DELIVERY_QUALITY_PERSISTENCE_LIMIT` before any write when safe bounded representation is impossible.
- [ ] Run the focused tests and confirm every probe is absent while existing diagnostics/events/summary tests remain green.

### Task 2: Atomically Settle Exhausted Quality Jobs

**Files:**
- Modify: `server/src/automation-job-repository.ts`
- Modify: `server/src/delivery-quality-repository.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/automation-job-repository.test.ts`
- Modify: `server/src/automation-worker.test.ts`
- Modify: `server/src/delivery-quality-repository.test.ts`
- Modify: `server/src/startup-acceptance.test.ts`

- [ ] Write failing tests for three retry failures, transaction rollback, final expired lease recovery, legacy orphan repair, different-token rejection, same-generation manual retry rejection, and new-generation independence.
- [ ] Run the focused queue/quality tests and confirm the job becomes failed while its quality run remains running.
- [ ] Make job settlement report the resulting state without opening its own transaction:

```ts
type AutomationFailureSettlement = "requeued" | "failed" | "rejected";
failInTransaction(jobId: string, workerId: string, error: unknown, retryable: boolean): AutomationFailureSettlement;
recoverExpiredInTransaction(now: Date): { recovered: number; terminalJobIds: string[] };
```

- [ ] In `WorkflowStore`, wrap fail/recover/reconcile in one `BEGIN IMMEDIATE`; abort only the exact running review/test claim whose token is the terminal job ID, with no evidence row.
- [ ] Run focused tests and prove injected second-write failures roll back the job transition.

### Task 3: Snapshot A Content-Addressed Toolchain

**Files:**
- Create: `server/src/verification-toolchain.ts`
- Create: `server/src/verification-toolchain.test.ts`
- Modify: `server/src/automated-testing.ts`
- Modify: `server/src/automated-testing.test.ts`
- Modify: `server/src/delivery-execution-service.ts`
- Modify: `server/src/delivery-quality-repository.ts`

- [ ] Write failing resolver tests for PATH executables, symlink cycles, bounded shebang parsing, `/usr/bin/env node`, nearest npm package root, mutation during copy, and closure limits.
- [ ] Write a failing macOS acceptance that runs a dependency-free temporary package through the user's real npm while project `node_modules` is absent.
- [ ] Implement a bounded canonical manifest:

```ts
interface ToolchainSnapshot {
  fingerprint: string;
  root: string;
  commands: Array<{ configured: string; executable: string; argsPrefix: string[] }>;
  manifest: Array<{ path: string; type: "file" | "symlink"; mode: number; size: number; sha256: string }>;
}
```

- [ ] Copy the closure to `.toolchain/<fingerprint>`, verify the copied manifest, remove write bits, verify again, and execute only snapshot absolute entrypoints with snapshot/system PATH.
- [ ] Run snapshot hashing and copying in a fixed trusted child with the remaining plan deadline, TERM/KILL enforcement, bounded input/output, and parent-side result validation.
- [ ] Add read-only Seatbelt rules for `.toolchain`, explicit write denial, and persist manifest metadata/fingerprint with testing evidence.
- [ ] Persist only the fingerprint, relative manifest, and relative command metadata; keep absolute verification root and bin paths runtime-only.
- [ ] Run resolver, automated testing, repository, and real macOS npm tests; retain the ignored-dependency failure.

### Task 4: Bound Materialization And Teardown

**Files:**
- Create: `server/src/trusted-subprocess.ts`
- Create: `server/src/trusted-subprocess.test.ts`
- Create: `server/src/verification-fs-helper.ts`
- Modify: `server/src/evidence-tree.ts`
- Modify: `server/src/evidence-tree.test.ts`
- Modify: `server/src/automated-testing.ts`
- Modify: `server/src/automated-testing.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/startup-acceptance.test.ts`

- [ ] Write failing tests for entry/inode/directory/path-depth/decoded-byte caps, materialization deadline expiry before command launch, TERM-to-KILL helper shutdown, cleanup timeout, quarantine preservation, bounded janitor scanning, and bounded worker stop.
- [ ] Implement a direct shell-free child primitive with fixed executable/argv, deadline timeout, TERM grace, KILL escalation, bounded output, and no descendant creation.
- [ ] Run the trusted materializer using `process.execPath` and a fixed helper mode/config path. Check the absolute deadline before and after every validation, hash, mkdir, write, chmod, and symlink operation.
- [ ] Restrict sandbox writes to worktree/HOME/TMP. Validate and rename generated parents into quarantine, then run direct `/bin/rm -rf -- <path>` with an independent 10-second budget.
- [ ] Run a startup janitor using the same primitive, strict canonical prefixes, and a fixed maximum number of quarantine entries.
- [ ] Bound both directory entries scanned and quarantines processed, and report failed, remaining, or truncated startup cleanup before worker creation.
- [ ] Run all focused tests and the real macOS acceptance suite.

### Task 5: Final Verification And Commit

- [ ] Run `npm test --` with all affected focused files.
- [ ] Run the real dependency-free npm acceptance and `RUN_MACOS_SANDBOX_ACCEPTANCE=1 npm test`.
- [ ] Run `npm run typecheck`, `npm run build`, `git diff --check`, and `git diff --cached --check`.
- [ ] Review staged names and diff, then create a local commit without pushing.
