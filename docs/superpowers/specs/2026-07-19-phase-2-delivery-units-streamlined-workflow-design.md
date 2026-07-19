# Phase 2 Delivery Units And Streamlined Workflow Design

## Goal

Deliver the first usable Phase 2 multi-project workflow slice while reducing the visible workflow from nine stages to five clear, non-overlapping stages.

The first end-to-end scenario is a requirement with a backend delivery unit and a dependent frontend delivery unit. Backend automated testing releases frontend implementation. Both units retain independent implementation, review, testing, version, evidence, and local-application state.

Quality remains the primary constraint. Efficiency comes from removing duplicate responsibilities, grouping related checks, and automatically running safe work. It does not come from removing independent review, automated testing, evidence validation, or final business acceptance.

## Confirmed Decisions

- Use a real `delivery_units` domain model instead of adding project fields to requirement-level execution records.
- Create every delivery unit when solution design is approved. Blocked units remain visible as `waiting_dependency`.
- Start with the release condition `upstream automated testing passed` for the backend-to-frontend pilot.
- Mark affected downstream evidence `potentially_stale` when upstream code or contract evidence changes. A human must record whether to reuse or rerun it.
- Apply repositories in dependency order, but settle each repository independently. A successful backend application is not automatically rolled back when frontend application fails.
- Replace the nine visible stages with five: requirement definition, solution design, implementation, quality verification, and acceptance delivery.
- Give each stage one responsibility and one owned output contract. Later stages consume frozen earlier outputs instead of regenerating them.
- Use policy-driven continuous automation for safe work. Require humans for overall business acceptance and exceptional or unsafe conditions.
- Never automatically commit a target/version worktree, push a branch, or create a pull request.

## First Slice

The first slice must prove this complete flow:

```text
requirement definition
  -> solution design
  -> backend implementation
  -> backend code review + automated testing
  -> release frontend dependency
  -> frontend implementation
  -> frontend code review + automated testing
  -> overall acceptance
  -> backend local application
  -> frontend local application
```

The backend and frontend are separately registered projects. Each delivery association selects its own active project version. The dependency graph is frozen with the approved solution design.

Single-project requirements use the same model with one delivery unit and no dependency edge. They must remain as simple to operate as the current single-project path.

## Non-Goals

This slice does not implement:

- arbitrary user-defined dependency release expressions;
- automatic target commits, pushes, remote branches, pull requests, tags, or releases;
- cross-repository atomic rollback;
- AI-driven automatic resolution of stale downstream evidence;
- production deployment or environment orchestration;
- conversion of historical Phase 1 requirements into live Phase 2 delivery units;
- a generic workflow-builder UI.

## Five-Stage Workflow

The user-visible requirement workflow is:

```text
definition -> solution_design -> implementation -> quality_verification -> acceptance_delivery
```

Delivery units expand inside implementation, quality verification, and acceptance delivery. They do not add more top-level requirement stages.

### 1. Requirement Definition

Purpose: decide why the requirement exists, what business behavior is in scope, and how success is observed.

Inputs:

- the submitted business problem and expected outcome;
- primary and context-project knowledge;
- relevant requirement history and project rules.

Owned outputs:

- underlying business goal and target users;
- scope and explicit non-goals;
- business rules and exception flows;
- measurable acceptance criteria;
- reversible assumptions and genuinely blocking questions.

This stage must not choose architecture, project decomposition, module scope, interfaces, or implementation tasks.

### 2. Solution Design

Purpose: translate the frozen requirement definition into an executable cross-project delivery design.

Inputs:

- approved requirement-definition artifact;
- associated-project knowledge and selected versions;
- module choices and project command policies.

Owned outputs:

- delivery-project and module scope;
- cross-project contracts and data/interface design;
- acyclic dependency graph and release conditions;
- compatibility, rollback, observability, and test strategy;
- per-unit implementation intent and acceptance-criterion coverage plan.

This stage must not silently change the business goal or acceptance criteria and must not modify source code.

Approval freezes the project associations, versions, module scopes, contracts, dependency graph, and policy snapshots. The same transaction creates all delivery units and scheduler work.

### 3. Implementation

Purpose: implement the frozen design inside each delivery unit and produce reproducible coding evidence.

Inputs:

- frozen requirement and solution-design artifacts;
- the unit's project, version, modules, command policy, and upstream evidence;
- prior return context for that unit.

Owned outputs:

- source branch and requirement worktree;
- Git diff, file list, and diff hash;
- self-test, typecheck, build, and allowed-command results;
- trace from changed code/tests to acceptance criteria;
- implementation diagnostics and known limitations.

This stage must not reinterpret business scope, redesign cross-project contracts, approve its own quality, or apply changes to the target version worktree.

### 4. Quality Verification

Purpose: independently determine whether a delivery unit is safe and correct against the frozen requirement and design.

It contains two distinct checks:

- Code review checks correctness, security, performance, maintainability, scope compliance, and test adequacy.
- Automated testing checks functional behavior, regression behavior, build validity, and acceptance-criterion coverage.

Both checks own separate runs, artifacts, statuses, and retry history. Neither can substitute for the other. They may execute concurrently after valid implementation evidence exists. The unit passes only when both pass or a valid, reasoned human override exists.

Quality verification reports and routes findings. It must not edit code, rewrite the solution design, or alter acceptance criteria.

### 5. Acceptance Delivery

Purpose: confirm the aggregate business result and safely apply verified changes to the selected local project versions.

Inputs:

- the approved requirement definition and solution design;
- every required unit's implementation, review, and test evidence;
- optional-unit completion or explicit skip records;
- current project-version and target-worktree state.

Owned outputs:

- overall business acceptance decision;
- dependency-ordered application plan;
- per-unit preflight, application, and verification results;
- final aggregate delivery status.

This stage must not reinterpret requirements or repair implementation. Failures route to the stage that owns the defective output.

## Responsibility And Return Contract

Every return contains:

- one responsible stage;
- the affected requirement or delivery unit;
- reproducible evidence;
- user or business impact;
- the condition that must be satisfied before resuming.

Generic returns such as "the previous stage has a problem" are invalid. A finding that contradicts business scope returns to requirement definition. A cross-project contract or architecture finding returns to solution design. An implementation or local-test finding returns only the affected unit to implementation. Review or test harness defects remain inside quality verification.

## Domain Model

### Delivery Unit

`delivery_units` is created from one frozen `requirement_projects` delivery association.

```text
id
requirement_id
association_snapshot_id
project_id
project_version_id
required
position
phase: implementation | quality_verification | acceptance_delivery
status: waiting_dependency | ready | running | awaiting_gate | returned |
        potentially_stale | ready_for_acceptance | applying | applied |
        conflicted | failed | skipped
evidence_version
created_at
updated_at
completed_at
```

Project, version, repository path, branch, module scope, sensitive patterns, allowed commands, and source knowledge version are copied into an immutable unit snapshot. Later project configuration edits do not mutate in-flight units.

### Dependencies

`delivery_dependencies` stores directed edges:

```text
id
requirement_id
upstream_unit_id
downstream_unit_id
release_condition: automated_testing_passed
released_by_evidence_version
released_at
created_at
```

The server rejects self-edges, duplicate edges, missing endpoints, cross-requirement endpoints, and cycles. The first slice exposes only `automated_testing_passed`; the schema keeps the condition explicit so later slices can add approved conditions without changing edge ownership.

### Unit Runs And Evidence

Implementation, code review, automated testing, stale-evidence resolution, and local application each have independent runs tied to `delivery_unit_id`. Existing stage-run observability is reused, but the owner is explicit rather than inferred from the requirement's current stage.

Every critical evidence record includes:

- requirement and delivery-unit identifiers;
- input artifact versions;
- project-knowledge and policy versions;
- repository HEAD, base commit, source commit, and diff hash where applicable;
- executed commands and bounded outputs;
- actor, decision, reasons, and timestamps.

### Automation Jobs

`automation_jobs` is a persistent queue for safe continuous execution:

```text
id
dedupe_key
owner_type: requirement | delivery_unit
owner_id
action
status: pending | leased | completed | failed | canceled
attempt
lease_owner
lease_expires_at
payload_json
last_error
created_at
updated_at
```

`dedupe_key` is unique for one owner, evidence version, and action. Workers atomically lease jobs and renew bounded leases. Service restart returns expired leases to `pending`; it never converts interrupted work to success.

## Creation And Scheduling

Solution-design approval performs one transaction:

1. Validate the frozen associations, active versions, module scopes, and acyclic graph.
2. Store the approved solution-design snapshot.
3. Create one delivery unit per active delivery association.
4. Create dependency edges.
5. Mark units with unsatisfied incoming edges `waiting_dependency`.
6. Mark root units `ready` and enqueue idempotent implementation jobs.

The transaction commits before a worker starts external AI or Git work.

Automated testing is the named dependency release signal, but it cannot bypass code review. When backend automated testing passes, the scheduler checks the current review evidence. If review has also passed, it records a new backend evidence version and atomically releases eligible frontend edges. If review is still running, the edge remains blocked and is reevaluated when review finishes. The frontend changes from `waiting_dependency` to `ready` exactly once and receives one implementation job.

Independent root units may execute in parallel. Application remains topologically ordered and serialized per repository/version target.

## Policy-Driven Automation

Continuous automation is enabled by policy, not by hard-coded stage assumptions. A safe node may pass and enqueue its successor when all of these are true:

- output schema and required evidence are complete;
- conclusion is passing and confidence meets the configured threshold;
- no blocking question, unresolved risk, S0 finding, or S1 finding exists;
- implementation changes remain within the frozen module and sensitive-path policy;
- required project verification commands pass;
- evidence hashes still match the current worktree and source commit;
- all dependency conditions are satisfied.

Automation pauses for:

- high-risk or ambiguous business decisions;
- sensitive-path or command-policy violations;
- dependency, evidence, or worktree inconsistencies;
- application conflicts or dirty target worktrees;
- partial application;
- invalid configuration or scheduler errors.

Overall business acceptance remains a human checkpoint. After acceptance, dependency-ordered local application may run automatically. The system still never commits target changes, pushes, or creates a pull request.

Every automatic gate records its policy version, evidence version, decision, and reasons. Operators can disable continuous automation globally and can pause a requirement without corrupting queued or running state.

## Upstream Change And Evidence Invalidation

When upstream code or contract evidence changes after a downstream unit has started:

1. Increment the upstream evidence version.
2. Mark every affected descendant unit `potentially_stale` before it can pass another gate.
3. Cancel pending automatic jobs that require the superseded evidence version.
4. Preserve completed artifacts and runs as history.
5. Require a recorded human decision to reuse current downstream evidence or rerun from the earliest invalid phase.

Reuse records the compared evidence versions and rationale. Rerun creates a new unit evidence version and leaves prior evidence immutable.

The first slice uses conservative descendant invalidation. AI-assisted contract-diff classification is deferred until a later slice.

## Aggregate Requirement Gate

The requirement enters overall acceptance only when:

- every required unit has passed code review and automated testing or has a valid override;
- every dependency edge is released by the expected evidence version;
- no required unit is running, returned, conflicted, failed, or potentially stale;
- every optional unit is complete or explicitly skipped with a reason.

The requirement becomes complete only when all required units are `applied`. A mixture of applied and unapplied required units is `partially_applied`, not completed.

## Local Application

After overall acceptance, the scheduler computes a stable topological order. For each unit it:

1. Verify the project, version, source worktree, source commit, and diff hash.
2. Verify that the version worktree is active, belongs to the project, and is not occupied by another requirement.
3. Verify that the target worktree has the expected clean or owned pending state.
4. Apply the source commit without creating a target commit.
5. Run the frozen project verification commands.
6. Persist the application evidence and release the next unit.

Each repository settles independently. If backend application succeeds and frontend conflicts, backend remains `applied`, frontend becomes `conflicted`, and the requirement becomes `partially_applied`. Only frontend repair and retry are allowed. Automatic rollback of backend is forbidden.

## User Interface

The requirement detail header shows only the five main stages. Requirement-level artifacts appear under requirement definition and solution design. Implementation, quality verification, and delivery use a delivery matrix.

Each project occupies one matrix row with:

- project and version identity;
- dependency and release state;
- implementation state;
- code-review conclusion;
- automated-test conclusion;
- local-application state;
- current blocker and one next action.

Code review and automated testing are grouped under quality verification but remain separate controls and evidence views. Automatic successes are compact and expandable. Exceptions expand the evidence, reason, owner, and allowed recovery action.

On narrow screens, the matrix becomes one vertically grouped project section at a time. Labels and actions must not overflow at 390px. The interface does not duplicate full workflow timelines inside each project.

## Error Handling And Recovery

- Invalid or cyclic dependency updates fail before freezing design.
- Project or version closure blocks new units but keeps historical units readable.
- Missing worktrees, repository identity mismatch, dirty targets, and hash mismatch fail only the affected unit.
- Concurrent application to the same repository/version is rejected with the owning requirement identified.
- Worker crashes leave an expired lease that can be retried; they do not advance workflow state.
- Repeated callbacks, reconnects, and retries are idempotent by evidence version and action.
- Partial application preserves every successful repository and exposes only valid next actions.
- Invalid automation configuration falls back to human review.

## Local Data Upgrade

The stage model changes from nine stages to five and the execution owner changes from requirement to delivery unit. The current installation is local and has already used explicit backup-and-reset upgrades. This slice uses the same one-time approach instead of maintaining two live state machines:

1. Stop active AI, scheduler, coding, and application work.
2. Back up the SQLite database with a timestamped manifest and checksum.
3. Create a fresh database with the five-stage and delivery-unit schema.
4. Re-register local projects and versions, then rebuild local source knowledge.
5. Start new requirements through the Phase 2 model.

Historical Phase 1 requirements remain available in the backup, not in the live application. The reset does not modify registered source repositories, source branches, project main worktrees, version worktrees, or requirement worktrees. Any pre-existing uncommitted version-worktree changes must be inventoried before reset and remain untouched.

No row migration, dual read, dual write, legacy stage fallback, or mixed workflow version is implemented.

## Testing

### Unit Tests

- Five-stage transition and return ownership rules.
- Delivery-unit creation from frozen associations.
- Dependency validation, cycle rejection, and readiness calculation.
- Aggregate acceptance and completion gates.
- Automatic gate policy and mandatory pause conditions.
- Stale-evidence propagation and reuse/rerun decisions.
- Topological application ordering and partial-application aggregation.
- Automation-job deduplication, leasing, expiry, and retry.

### Store And API Integration Tests

- Solution-design approval atomically creates snapshots, units, edges, and jobs.
- Backend automated testing releases frontend implementation exactly once.
- Independent root units can hold simultaneous active runs.
- Review and automated testing create separate evidence and must both pass.
- Upstream evidence replacement blocks downstream progression before another gate.
- Service restart recovers expired jobs without duplicate AI or Git work.
- Backend application success plus frontend conflict produces `partially_applied` and a frontend-only retry.
- Single-project requirements use one delivery unit without extra operator work.

### Git Safety Tests

- Each unit uses the selected project version and isolated requirement worktree.
- Repository identity, branch, base commit, diff hash, and target ownership are revalidated.
- Application does not create a target commit, push, remote branch, tag, or pull request.
- Dirty, occupied, missing, and mismatched targets fail before mutation.
- Successful application preserves uncommitted target changes for human inspection.

### Browser And Pilot Acceptance

- Five-stage navigation and delivery matrix on desktop and 390px mobile.
- Automatic backend-to-frontend release is visible without manual refresh races.
- Review and test evidence are separately inspectable.
- Potentially stale and partially applied states expose only valid recovery actions.
- A real backend/frontend two-project pilot completes without automatic commit, push, or PR.
- Existing project and version worktrees remain on their original commits except for explicitly applied, uncommitted pilot changes.

## Success Criteria

The slice is complete when a real two-project requirement can move from requirement definition through local application with only meaningful human intervention, backend testing releases frontend implementation automatically, all quality checks remain independent and auditable, failures remain scoped and recoverable, and no target repository is committed or published automatically.
