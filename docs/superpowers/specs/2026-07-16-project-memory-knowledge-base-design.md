# Project Memory Knowledge Base Design

## Goal

Evolve the local source index into a durable, versioned project memory that captures verified business knowledge, engineering decisions, implementation facts, and testing experience across the full workflow.

The knowledge base remains local, auditable, evidence-backed, and safe for long-term maintenance. AI drafts never silently become project truth.

## Knowledge Layers

### Source Facts

Facts derived from the linked repository:

- modules and dependency boundaries;
- APIs, controllers, services, entities, schemas, and configuration;
- tests and verified build commands;
- file ownership and code paths.

Source facts are refreshed from file hashes and repository snapshots. They are evidence, not product decisions.

### Project Rules

Durable rules that apply across requirements:

- business terminology and definitions;
- business invariants and permission rules;
- privacy, security, and compliance constraints;
- module boundaries and repository conventions;
- coding and testing standards.

### Decisions

Approved choices and their rationale:

- product decisions from approved PRDs;
- interface and data contracts;
- technical and architecture decisions;
- rejected alternatives and trade-offs.

### Requirement Experience

Reusable learning from completed work:

- implementation summaries and affected modules;
- confirmed code review findings;
- defects, fixes, and regression risks;
- successful test commands and acceptance evidence;
- operational limitations and follow-up work.

## Knowledge Record

Each record contains:

- stable identifier;
- project identifier;
- layer and knowledge type;
- title and structured content;
- applicable modules and tags;
- source requirement and workflow stage;
- evidence references to artifact versions, code paths, commits, test runs, or approvals;
- status: `candidate`, `active`, `conflict`, `superseded`, or `invalid`;
- effective version and optional superseding record;
- confidence and risk level;
- creator type and timestamps;
- source hash and last verification time.

Records are immutable after publication. Corrections create a new version and supersede the old record.

## Candidate Lifecycle

AI-generated knowledge remains candidate knowledge during an active requirement.

Candidates are produced at these gates:

| Workflow gate | Candidate knowledge |
| --- | --- |
| PRD approved | business terms, user goals, product rules, decisions |
| Technical design approved | contracts, module choices, data rules, architecture decisions |
| Code review approved | implementation facts, confirmed constraints, resolved findings |
| Testing passed | test strategy, commands, cases, environment requirements, regression scope |
| Acceptance passed | verified business outcomes and operational behavior |

A return invalidates or revises candidates created from the returned stage and downstream stages. Draft artifacts and unapproved assumptions never enter durable knowledge.

## Publication Gate

When local application and verification complete, the workflow builds a knowledge change set:

- `add`: new durable knowledge;
- `update`: a new version superseding an existing record;
- `invalidate`: existing knowledge contradicted by removed behavior;
- `conflict`: competing truths that require a decision.

The change set publishes automatically when:

- all source artifacts are approved;
- code evidence is valid;
- application and automatic verification passed;
- each record has evidence;
- no active record conflicts with the candidate;
- confidence meets the configured threshold;
- no mandatory human-risk category is present.

Human confirmation is required for permission, security, money, privacy, compliance, destructive behavior, public contracts, architecture boundaries, or conflicting terminology.

## Source Refresh

### Initial Build

Project association creates the first source snapshot and module map.

### Incremental Refresh

After a branch commit or completed local application, compare:

- Git HEAD;
- index and worktree snapshot hash;
- tracked file content hashes;
- prior source snapshot hashes.

Only changed modules and dependent summaries are rebuilt. This removes the current limitation where HEAD alone cannot detect staged or uncommitted changes.

### Full Reconciliation

Manual rebuild and optional scheduled maintenance perform a complete source scan, verify active knowledge evidence, detect deleted or renamed code, and mark unsupported records for review. Full rebuild does not overwrite business rules or decisions.

## Conflict Handling

New candidates are compared with active records by normalized subject, scope, modules, and evidence.

Conflicts never overwrite active knowledge automatically. The conflict view supports:

- keep existing knowledge;
- publish the candidate and supersede the existing record;
- merge into an edited new version;
- mark the candidate not applicable.

The decision and actor are stored as evidence.

## Role-Based Retrieval

Retrieval combines exact tags, module paths, business terms, knowledge layer, recency, evidence strength, and workflow role.

- Product AI receives terms, product rules, historical decisions, and related outcomes.
- Review and design AI receive rules, architecture decisions, similar requirements, and risks.
- Coding Codex receives relevant source paths, approved contracts, repository rules, and verified commands.
- Code review AI receives design decisions, the current diff, historical defects, and security rules.
- Test AI receives acceptance criteria, contracts, regression cases, environment constraints, and commands.

Only active knowledge and explicit candidates from the current requirement are injected. Conflicted, superseded, and invalid records are excluded unless the task is conflict review.

Every run records the knowledge identifiers and versions it consumed.

## User Interface

### Project Knowledge

Tabs for source facts, project rules, decisions, and requirement experience. Records show status, scope, evidence, version, and last verification time.

### Knowledge Changes

Each requirement shows candidate records and the planned add, update, invalidate, and conflict operations. Users can inspect evidence before final publication.

### Knowledge Conflicts

A work queue lists unresolved conflicts with side-by-side old and new content, evidence, impact, and resolution controls.

### Rebuild Status

The project page distinguishes incremental refresh, full reconciliation, and workflow publication. It reports changed modules, records checked, candidates published, conflicts found, and unsupported knowledge.

## Storage

Add normalized SQLite tables for knowledge records, immutable versions, evidence links, candidate sets, change sets, conflict resolutions, source snapshots, and file hashes. Keep the current `project_knowledge_versions` source index during migration, then adapt it as the source snapshot layer.

No external vector database is required initially. Structured filters and the existing local ranking remain the baseline. Embeddings can be introduced later behind a local retrieval interface without changing the record lifecycle.

## Safety And Privacy

- Keep all knowledge and evidence local.
- Continue excluding secrets, credentials, certificates, generated output, and configured sensitive patterns.
- Store references and bounded excerpts rather than unnecessary complete files.
- Redact sensitive values before persistence and AI injection.
- Never publish AI assumptions as active knowledge without approved evidence.
- Never modify or push the linked repository during knowledge operations.

## Delivery Phases

### Phase 1: Durable Records And Candidates

Add the knowledge schema, candidate extraction from approved artifacts, requirement knowledge-change view, and completion-time publication gate.

### Phase 2: Incremental Source Snapshots

Add file hashes, worktree/index snapshot awareness, changed-module refresh, rename/deletion handling, and reconciliation reporting.

### Phase 3: Conflict Resolution

Add semantic subject matching, conflict records, the conflict queue, resolution UI, and automatic supersession.

### Phase 4: Role-Based Retrieval

Replace the current flat retrieval with layer-aware role profiles, trace consumed knowledge per AI run, and add retrieval quality tests.

### Phase 5: Maintenance And Quality

Add stale-evidence checks, optional scheduled reconciliation, duplicate detection, coverage metrics, and knowledge health reporting.

Each phase must be independently usable and preserve existing source-index behavior until its replacement is verified.

## Testing

- lifecycle tests for candidate, active, superseded, conflict, and invalid states;
- publication gate tests for automatic and mandatory-human cases;
- return-flow tests that invalidate downstream candidates;
- snapshot tests for HEAD, staged, untracked, renamed, and deleted files;
- retrieval tests for each workflow role;
- conflict resolution audit tests;
- redaction and sensitive-file exclusion tests;
- migration tests preserving current project knowledge;
- end-to-end tests from requirement completion to a new active knowledge version.
