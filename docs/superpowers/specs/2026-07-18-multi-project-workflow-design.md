# Multi-Project Workflow Design

## Goal

Extend Flowgate from a single-project requirement workflow into a maintainable multi-project workflow. A requirement keeps one business-level flow while each repository that must change receives an independent delivery unit for coding, review, testing, rework, and local application.

The design must keep ordinary single-project requirements simple, preserve local-only execution, and support frontend, backend, test, shared-library, and future repository types without another data-model rewrite.

## Confirmed Product Decisions

- A requirement has exactly one primary project and may have multiple collaborating projects.
- The primary project owns business context and workflow identity; it does not have to contain code changes.
- Project associations explicitly distinguish `context` from `delivery` usage.
- The requirement retains one PRD, engineering review, overall technical design, and acceptance flow.
- Coding and later engineering work expand into one delivery unit per delivery project.
- Delivery units support dependency ordering. Independent units may run in parallel.
- A project-level failure returns only that delivery unit unless the evidence invalidates the overall design.
- A Git repository is the project boundary. Modules are discovered and selected within the project rather than registered as separate projects.
- Projects may be edited and archived. Projects with history are never destructively deleted.
- Delivery is split into two independently usable implementation phases.

## Architecture

### Requirement Main Flow

The main requirement owns business intent and cross-project decisions:

`PRD -> engineering review -> overall technical design -> project delivery -> overall acceptance -> local application`

The `project delivery` node is a summary gate. It does not hide project status: the requirement detail expands it into a delivery matrix showing every project and its coding, review, testing, and application state.

### Project Association

`requirement_projects` is the stable relationship between a requirement and a project. It contains:

- requirement and project identifiers;
- relationship role: `primary` or `collaborator`;
- usage: `context` or `delivery`;
- module selection mode: `auto`, `all`, or `selected`;
- selected module identifiers when the mode is `selected`;
- required or optional delivery classification;
- display order, lifecycle status, and timestamps.

Each requirement has exactly one active `primary` association. A project can appear only once in a requirement. The primary association may use `context`; therefore primary status never implies source modification.

### Delivery Unit

Each active association with `usage = delivery` owns one delivery unit. A delivery unit contains:

- its own state and current delivery stage;
- frozen project, module, command-policy, and target-branch snapshot;
- coding execution and Codex session;
- isolated worktree and branch;
- coding evidence, reviews, tests, returns, and human overrides;
- local integration target and application runs;
- version and stale-evidence state.

Existing execution, coding-evidence, and integration concepts move under a delivery-unit identifier in phase 2. The requirement remains their aggregate owner for navigation and audit.

### Dependencies

`delivery_dependencies` stores directed edges from an upstream delivery unit to a downstream unit. An edge has one release condition:

- overall technical design approved;
- upstream coding and self-test passed;
- upstream automated testing passed.

Dependency updates are accepted only when the graph is acyclic. The scheduler starts all ready units and leaves dependent units in `waiting_dependency`. Removing a unit with downstream dependencies requires the dependency graph to be repaired in the same update.

## Project Management

The project page always shows a `New Project` command, including when projects already exist.

### Create And Validate

Project creation collects name, repository path, default branch, and optional project category. Before persistence, the server verifies:

- the path is an accessible Git repository root;
- the default branch exists locally;
- the repository is not already registered under another active project;
- the current worktree state can be read;
- sensitive patterns and allowed command policies are valid.

The knowledge index detects the technology stack, module structure, package manager or build tool, and likely verification commands. Detection is presented for confirmation; it does not silently execute project commands.

### Edit And Archive

Users can edit name, repository path, default branch, category, command policy, and sensitive patterns. A path or branch change triggers repository validation and a knowledge rebuild. Historical executions retain their frozen repository snapshot and original evidence paths.

Archiving removes a project from new requirement selectors and prevents new executions. Existing in-progress delivery units may complete. Historical requirements, knowledge, approvals, worktree evidence, and application runs remain readable.

## Requirement Association Experience

### Requirement Creation

The new-requirement form selects only the primary project. This keeps the common single-project path compact. The primary project defaults to `delivery` usage but can later be changed to `context` before technical design approval.

### Requirement Detail

A `Manage Associated Projects` action opens the complete association editor. It supports:

- adding active collaborator projects;
- choosing primary or collaborator role;
- choosing context or delivery usage;
- marking delivery as required or optional;
- choosing automatic, whole-repository, or selected-module scope;
- ordering projects and configuring dependencies.

Module choices come from the current project knowledge index. If the index is missing or stale, automatic scope remains available and selected-module editing explains why modules cannot be listed.

### Configuration Freeze

Technical design approval freezes an association snapshot for delivery. Changing the project set, delivery usage, module scope, or dependency graph afterward invalidates technical-design approval and returns the requirement to technical design. Existing worktrees are preserved but marked stale and cannot be applied until regenerated or explicitly resolved.

## AI Context And Knowledge

Product and review AI receive the primary project's business memory plus relevant active knowledge from all collaborators. The overall technical-design AI receives:

- the approved PRD and review;
- repository and module summaries for every associated project;
- cross-project contracts and dependency edges;
- relevant project rules, decisions, risks, and prior requirement experience.

Coding and project-level review/test AI receive only the overall approved context plus their delivery project's repository knowledge, module scope, upstream contracts, and dependency evidence. Project knowledge uses a configurable aggregate serialized-JSON character budget (`AI_PROJECT_CONTEXT_MAX_CHARS`, default 200,000, hard ceiling 1,000,000), allocated fairly across active projects. This character count is an audit and memory bound, not a model-token estimate. If irreducible identity metadata for excessive associated projects cannot fit, the run is rejected; operators must raise the budget or reduce associations. Coding receives only its sole delivery project's block, allowing that block to use most of the aggregate budget while preventing one coding agent from modifying a different repository.

Knowledge candidates remain project-scoped. Cross-project decisions are referenced from each affected project with shared requirement evidence; they are not stored as an unowned global fact.

## Phase 1: Project And Association Foundation

Phase 1 delivers usable project management and multi-project planning without changing the real coding executor.

### Scope

- persistent project create, validate, edit, list, and archive operations;
- always-visible project creation UI and project editor;
- project category and detected technology metadata;
- `requirement_projects` relationships and module scopes;
- primary and collaborator project management in requirement creation/detail;
- all associated project knowledge in overall technical-design input;
- frozen association snapshots and design invalidation after material changes;
- a clean local-data reset that recreates the SQLite database under the new model;
- the new project-association model as the only source of truth.

Phase 1 displays planned delivery units but does not launch separate project executions. A requirement with more than one delivery project cannot enter coding until phase 2 is enabled; the interface states this explicitly. New single-delivery-project requirements continue through the existing executor through an adapter that reads the sole delivery association, not a legacy requirement field.

### Phase 1 Acceptance

- A user can register Soto Dine, a frontend repository, and another repository from the project page.
- Projects can be edited and archived without losing historical data.
- One requirement can use Soto Dine as context-only primary and a frontend repository as required delivery.
- Another requirement can use backend and frontend as required delivery projects with selected or automatic modules.
- Overall technical design shows evidence from every association and describes cross-project contracts.
- After the explicit reset, new single-project requirements remain executable through the new association model.

## Phase 2: Multi-Project Delivery Execution

### Scope

- delivery-unit state machine and dependency graph;
- per-project Codex execution, worktree, evidence, review, testing, and rework;
- dependency-aware readiness and optional parallel execution;
- delivery matrix and aggregate requirement gate;
- project-level human overrides with reasons;
- per-project target branch, integration preflight, local application, and rerun;
- dependency-ordered local application across repositories;
- project-scoped knowledge publication when delivery evidence is complete.

### Aggregate Gate

The requirement can enter overall acceptance only when:

- every required delivery unit has passed review and automated testing, or has an explicit valid human override;
- every dependency edge is satisfied;
- no required unit is running, returned, conflicted, stale, or awaiting clarification;
- every optional unit is either complete or explicitly skipped with a recorded reason.

The requirement is complete only after all required delivery units have applied successfully to their local target workspaces. Application never creates a target commit, pushes, or creates a pull request.

### Phase 2 Acceptance

- A backend testing gate can release a dependent frontend coding unit.
- A frontend failure returns only the frontend unit and preserves valid backend evidence.
- A changed upstream contract marks affected downstream evidence stale and requires an AI or human rerun decision.
- Each repository independently selects its local target branch and performs preflight checks.
- Two repositories can be applied locally in dependency order without commit or push.
- The overall requirement status accurately summarizes every delivery unit.

## Returns And Invalidation

Project-level findings target a delivery unit and its previous delivery stage. Findings that contradict the approved cross-project contract target overall technical design.

When upstream code or contract evidence changes:

1. Direct downstream units become `potentially_stale`.
2. AI compares the changed contract and consumed evidence.
3. Unaffected units record the assessment and resume.
4. Affected units return to the earliest invalid stage.

Completed units are never silently reset. Every invalidation records cause, evidence, actor, affected units, and prior state.

## Error Handling And Safety

- Invalid repository path or missing branch marks the project `needs_attention`; new runs are blocked while history stays readable.
- Archiving during delivery allows existing work to finish but prevents new associations and executions.
- Cyclic dependencies, missing dependency endpoints, and premature starts return explicit errors.
- A material association change after design approval invalidates the design and marks existing delivery evidence stale.
- Concurrent local applications targeting the same repository and branch are blocked with the owning requirement identified.
- A dirty target workspace, invalid evidence hash, missing worktree, or application conflict remains a project-level failure and does not mutate other repositories.
- Sensitive file rules and command allowlists remain project-specific and are frozen into execution evidence.

## Clean Data Reset

The current installation is local and the user has explicitly chosen not to preserve existing projects or workflow history. The upgrade uses a full local reset instead of a compatibility migration:

1. Stop active AI and integration processes before the schema change.
2. Copy the existing SQLite file to a timestamped local backup.
3. Create a fresh SQLite database directly from the new schema, without running row-level migration.
4. Re-register local projects through the new project UI and rebuild their source knowledge from their repositories.
5. Start requirement numbering again from `REQ-0001` and create all new requirements through the multi-project association model.

The reset is not exposed as a routine UI action. It is a one-time schema upgrade operation with a preflight summary and local SQLite backup. After verification, the backup can be removed manually. Application code contains no row migration, dual reads, dual writes, legacy fallbacks, or old-data branching.

## User Interface

### Project Page

- project count, active/archive filter, and always-visible new-project button;
- project rows with category, repository path, health, detected stack, module count, and knowledge status;
- commands for edit, validate, rebuild knowledge, and archive;
- a focused drawer or modal for create/edit, with repository validation results.

### Requirement Detail

- compact association summary next to requirement metadata;
- association editor for role, usage, required status, module scope, and dependencies;
- frozen-snapshot indicator after technical design approval;
- phase-2 delivery matrix with one row per project and columns for coding, review, testing, and local application;
- direct access to project run details, failure reasons, evidence, and return actions.

The main workflow stays horizontal and compact. Detailed project state belongs in the delivery matrix, not in duplicated full workflow timelines.

## Testing Strategy

- schema reset tests proving a backup is created and a fresh database starts with the new schema and no old rows;
- store tests for primary uniqueness, duplicate associations, archive behavior, and immutable snapshots;
- pure dependency-graph tests for readiness, fan-out, fan-in, cycles, and invalid endpoints;
- aggregate-gate tests for required, optional, skipped, overridden, stale, and failed units;
- API tests for project validation/edit/archive and association replacement;
- prompt-context tests proving overall design receives every project while coding receives only its project;
- integration tests using two temporary Git repositories for isolated worktrees, dependency ordering, conflict isolation, and no push;
- browser tests for project CRUD, association editing, module selection, delivery matrix, long failure reasons, and responsive action controls;
- regression tests proving new single-project requirements execute through the new association model after phase 1.

## Long-Term Extension Points

- New project categories are metadata and capability profiles, not new workflow tables.
- New dependency release conditions extend a validated condition enum.
- Alternative coding agents implement the delivery executor interface and retain the same evidence contract.
- Remote CI and pull-request integrations may consume delivery units later, but remain disabled unless explicitly configured.
- Cross-repository release orchestration can build on the dependency graph without changing the requirement main flow.

This design deliberately avoids parent/child requirements and direct `projectIds[]` fields. Those approaches either duplicate business gates or entangle project-specific state inside the requirement record, making local rework and long-term evolution harder.
