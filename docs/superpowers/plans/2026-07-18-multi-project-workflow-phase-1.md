# Multi-Project Workflow Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-project requirement model with maintainable project management and multi-project requirement associations while preserving new single-delivery-project execution and explicitly blocking real multi-project coding until phase 2.

**Architecture:** Recreate the local SQLite database under a new schema, make `requirement_projects` the only relationship source, and isolate project validation, association rules, snapshots, and AI context assembly into focused modules. The UI keeps requirement creation simple and moves collaborator/module configuration to requirement detail; existing coding and integration code receives one resolved delivery project through an adapter.

**Tech Stack:** TypeScript, Fastify, SQLite via the existing store driver, Zod, React 19, Vite, Vitest, local Git CLI.

---

## File Structure

- Create `shared/src/project-association.ts`: shared association enums, types, and primary/delivery selectors.
- Modify `shared/src/schemas.ts`: project create/update and requirement association request schemas.
- Modify `shared/src/index.ts`: export the new shared contracts.
- Create `server/src/database-reset.ts`: one-time backup and clean-database initialization decision.
- Create `server/src/database-reset.test.ts`: backup/reset behavior tests.
- Modify `server/src/store.ts`: new schema and project/association/snapshot persistence.
- Modify `server/src/store.test.ts`: constraints, archive behavior, snapshot, and reset-backed store tests.
- Create `server/src/project-service.ts`: repository validation, technology detection, project lifecycle rules.
- Create `server/src/project-service.test.ts`: temporary-repository validation tests.
- Create `server/src/requirement-projects.ts`: association validation, material-change detection, and sole-delivery resolution.
- Create `server/src/requirement-projects.test.ts`: relationship invariant and coding-guard tests.
- Create `server/src/project-context.ts`: bounded multi-project knowledge retrieval for technical design.
- Create `server/src/project-context.test.ts`: context separation and aggregation tests.
- Modify `server/src/app.ts`: new project/association APIs, reset startup, AI context, and sole-delivery adapter.
- Modify `server/src/app.test.ts`: API and phase-1 execution behavior.
- Create `web/src/project-management.tsx`: project list, create/edit drawer, archive controls.
- Create `web/src/requirement-projects.tsx`: association summary/editor and module scope controls.
- Create `web/src/project-management.test.ts`: pure UI view-model tests.
- Create `web/src/requirement-projects.test.ts`: association editor/view-model tests.
- Modify `web/src/main.tsx`: route the new components and replace the single project selector.
- Modify `web/src/associations.css`: project management and association editor styling.
- Modify `README.md`: clean-reset warning and phase-1 usage.

### Task 1: Define Shared Multi-Project Contracts

**Files:**
- Create: `shared/src/project-association.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/src/schemas.test.ts`

- [ ] **Step 1: Write failing schema and selector tests**

Add tests that prove one primary association can be selected, context-only primary is valid, duplicate projects are rejected by the collection schema, and selected module mode requires module IDs:

```ts
it("accepts a context primary and a delivery collaborator", () => {
  const result = requirementProjectsInputSchema.parse({ associations: [
    { projectId: "backend", role: "primary", usage: "context", deliveryRequired: false, moduleMode: "auto", moduleIds: [] },
    { projectId: "web", role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds: ["user-management"] }
  ]});
  expect(selectPrimaryProject(result.associations)?.projectId).toBe("backend");
  expect(selectDeliveryProjects(result.associations).map(item => item.projectId)).toEqual(["web"]);
});

it("rejects duplicate projects and selected mode without modules", () => {
  expect(() => requirementProjectsInputSchema.parse({ associations: [
    { projectId: "web", role: "primary", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds: [] },
    { projectId: "web", role: "collaborator", usage: "context", deliveryRequired: false, moduleMode: "auto", moduleIds: [] }
  ]})).toThrow();
});
```

- [ ] **Step 2: Run the shared tests and verify RED**

Run: `npm test -- shared/src/schemas.test.ts`

Expected: FAIL because `requirementProjectsInputSchema` and selector functions do not exist.

- [ ] **Step 3: Add the contracts and schemas**

Define the exact shared contract:

```ts
export type ProjectRole = "primary" | "collaborator";
export type ProjectUsage = "context" | "delivery";
export type ModuleMode = "auto" | "all" | "selected";

export type RequirementProject = {
  id: string;
  requirementId: string;
  projectId: string;
  projectName?: string;
  role: ProjectRole;
  usage: ProjectUsage;
  deliveryRequired: boolean;
  moduleMode: ModuleMode;
  moduleIds: string[];
  position: number;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export function selectPrimaryProject(items: RequirementProject[]) {
  return items.find(item => item.status === "active" && item.role === "primary");
}

export function selectDeliveryProjects(items: RequirementProject[]) {
  return items.filter(item => item.status === "active" && item.usage === "delivery").sort((a, b) => a.position - b.position);
}
```

Add `projectInputSchema`, `projectUpdateSchema`, `requirementProjectInputSchema`, and `requirementProjectsInputSchema`. The collection schema must enforce exactly one primary, unique `projectId`, `deliveryRequired === false` for context associations, and non-empty unique `moduleIds` for selected mode. Replace `RequirementInput.projectId` with required `primaryProjectId`.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `npm test -- shared/src/schemas.test.ts && npm run typecheck -w shared`

Expected: PASS.

- [ ] **Step 5: Commit the shared contracts**

```bash
git add shared/src/project-association.ts shared/src/schemas.ts shared/src/schemas.test.ts shared/src/index.ts
git commit -m "feat: define multi-project requirement contracts"
```

### Task 2: Add Clean Database Reset And New Schema

**Files:**
- Create: `server/src/database-reset.ts`
- Create: `server/src/database-reset.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing clean-reset tests**

Use a temporary directory and assert that an old database is backed up once and replaced with a fresh database marker:

```ts
it("backs up an incompatible database and requests a fresh schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowgate-reset-"));
  const dbPath = join(root, "workflow.db");
  await writeFile(dbPath, "old-database");
  const result = await prepareCleanDatabase(dbPath, "multi-project-v1");
  expect(result.reset).toBe(true);
  expect(result.backupPath).toMatch(/workflow\.db\.backup-/);
  expect(await readFile(result.backupPath!, "utf8")).toBe("old-database");
  expect(existsSync(dbPath)).toBe(false);
});
```

Add a second test proving a database with the current schema marker is not reset.

- [ ] **Step 2: Run reset tests and verify RED**

Run: `npm test -- server/src/database-reset.test.ts`

Expected: FAIL because `prepareCleanDatabase` does not exist.

- [ ] **Step 3: Implement explicit schema-version reset**

Implement `prepareCleanDatabase(dbPath, expectedVersion)` so it:

1. returns without mutation when no database exists;
2. reads a sibling `${dbPath}.schema-version` marker;
3. copies an incompatible database to `${dbPath}.backup-${timestamp}`;
4. removes the incompatible database, WAL, and SHM files;
5. removes the stale marker;
6. returns the backup path for startup logging.

After `WorkflowStore` creates the new schema successfully, write the `multi-project-v1` marker atomically. Do not add a reset HTTP endpoint.

- [ ] **Step 4: Replace the requirement-project schema**

Create these tables directly in the fresh schema:

```sql
CREATE TABLE requirement_projects (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary','collaborator')),
  usage TEXT NOT NULL CHECK(usage IN ('context','delivery')),
  delivery_required INTEGER NOT NULL,
  module_mode TEXT NOT NULL CHECK(module_mode IN ('auto','all','selected')),
  module_ids_json TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(requirement_id, project_id),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX requirement_primary_active
  ON requirement_projects(requirement_id)
  WHERE role = 'primary' AND status = 'active';

CREATE TABLE requirement_project_snapshots (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  associations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(requirement_id) REFERENCES requirements(id)
);
```

Remove `requirements.project_id` and `requirements.integration_target_branch` from the fresh requirement schema. Keep execution tables unchanged in phase 1 because their adapter receives one resolved delivery project.

- [ ] **Step 5: Add store tests for fresh schema constraints**

Test that a new store starts empty, can create one primary association, rejects a second active primary, and contains no legacy `project_id` column in `requirements` using `PRAGMA table_info(requirements)`.

- [ ] **Step 6: Run store and reset tests**

Run: `npm test -- server/src/database-reset.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the clean schema reset**

```bash
git add server/src/database-reset.ts server/src/database-reset.test.ts server/src/store.ts server/src/store.test.ts server/src/index.ts
git commit -m "feat: reset local data for multi-project schema"
```

### Task 3: Implement Project Validation, Editing, And Archiving

**Files:**
- Create: `server/src/project-service.ts`
- Create: `server/src/project-service.test.ts`
- Modify: `server/src/repository.ts`
- Modify: `server/src/store.ts`

- [ ] **Step 1: Write failing project lifecycle tests**

Create a temporary Git repository with `package.json` and assert validation detects Git, Node, npm, and the local branch. Add tests for a missing path, duplicate repository path, branch absence, editing, and archiving:

```ts
const result = await inspectProjectRepository(repo, "main");
expect(result).toMatchObject({ valid: true, category: "frontend" });
expect(result.technology).toContain("node");
expect(result.modules).toContain("root");

const archived = store.archiveProject(project.id);
expect(archived.status).toBe("archived");
expect(store.listProjects({ activeOnly: true })).toEqual([]);
```

- [ ] **Step 2: Run project service tests and verify RED**

Run: `npm test -- server/src/project-service.test.ts`

Expected: FAIL because inspection and lifecycle methods do not exist.

- [ ] **Step 3: Implement bounded repository inspection**

`inspectProjectRepository(repoPath, defaultBranch)` must use argument-array Git calls and bounded file reads. It verifies repository root and local branch, then detects:

- Maven from `pom.xml`;
- Gradle from `build.gradle` or `build.gradle.kts`;
- Node/package manager from `package.json` and lock files;
- modules from the latest project knowledge entries, falling back to `root`.

Return `{ valid, repoPath, defaultBranch, category, technology, packageManager, modules, warnings }`. Do not run build or test commands during inspection.

- [ ] **Step 4: Add project persistence methods**

Extend projects with `category`, `technology_json`, `status`, and `updated_at`. Add:

```ts
updateProject(id: string, input: ProjectUpdateInput)
archiveProject(id: string)
listProjects(options?: { activeOnly?: boolean })
findProjectByRepoPath(repoPath: string)
```

Reject duplicate normalized repository paths. An archived project remains readable by ID but is excluded from active selectors.

- [ ] **Step 5: Run project lifecycle tests**

Run: `npm test -- server/src/project-service.test.ts server/src/repository.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit project lifecycle support**

```bash
git add server/src/project-service.ts server/src/project-service.test.ts server/src/repository.ts server/src/store.ts server/src/store.test.ts
git commit -m "feat: manage validated local projects"
```

### Task 4: Implement Requirement Associations And Snapshots

**Files:**
- Create: `server/src/requirement-projects.ts`
- Create: `server/src/requirement-projects.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`

- [ ] **Step 1: Write failing invariant and adapter tests**

Cover exactly one primary, archived project rejection, selected-module validation against indexed modules, context-only primary, and sole-delivery resolution:

```ts
expect(resolveSoleDeliveryProject([
  association({ projectId: "domain", role: "primary", usage: "context" }),
  association({ projectId: "web", role: "collaborator", usage: "delivery" })
])?.projectId).toBe("web");

expect(() => resolveSoleDeliveryProject([
  association({ projectId: "api", usage: "delivery" }),
  association({ projectId: "web", usage: "delivery" })
])).toThrowError("MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED");
```

- [ ] **Step 2: Run requirement-project tests and verify RED**

Run: `npm test -- server/src/requirement-projects.test.ts`

Expected: FAIL because association validation and resolution do not exist.

- [ ] **Step 3: Implement transactional association replacement**

Add store methods:

```ts
listRequirementProjects(requirementId: string): RequirementProject[]
replaceRequirementProjects(requirementId: string, inputs: RequirementProjectInput[]): RequirementProject[]
createRequirementProjectSnapshot(requirementId: string): RequirementProjectSnapshot
getRequirementProjectSnapshot(requirementId: string): RequirementProjectSnapshot | null
```

`replaceRequirementProjects` validates all projects before a transaction, replaces active rows atomically, and updates requirement time. It must not partially save a malformed collection.

- [ ] **Step 4: Implement material-change invalidation**

Create `hasMaterialAssociationChange(before, after)` comparing project ID, role, usage, required flag, module mode, and sorted module IDs. When technical design or a later stage has an approved snapshot and the change is material, return `{ invalidateTechnicalDesign: true }`; display-order-only changes return false.

- [ ] **Step 5: Add requirement creation through associations**

Change `createRequirement` to accept `primaryProjectId`, create the requirement and its primary required-delivery association in one transaction, and return `projects`. A missing or archived primary project fails without creating the requirement.

- [ ] **Step 6: Run focused store and association tests**

Run: `npm test -- server/src/requirement-projects.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit association persistence**

```bash
git add server/src/requirement-projects.ts server/src/requirement-projects.test.ts server/src/store.ts server/src/store.test.ts
git commit -m "feat: persist requirement project associations"
```

### Task 5: Add Project And Association APIs

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing API tests**

Add API tests for:

- `POST /api/projects/validate` returning detected stack without persistence;
- `POST /api/projects` creating a validated project;
- `PATCH /api/projects/:id` revalidating path/branch changes;
- `POST /api/projects/:id/archive` retaining readable history;
- `GET /api/projects?status=active` excluding archived projects;
- `GET /api/requirements/:id/projects` returning all associations;
- `PUT /api/requirements/:id/projects` atomically replacing associations;
- a material association change returning the requirement to `technical_design` with `ai_ready` status.

Use real temporary Git repositories in validation tests; never point tests at Soto Dine.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npm test -- server/src/app.test.ts`

Expected: FAIL with 404 or missing response fields for the new routes.

- [ ] **Step 3: Implement project routes with Zod validation**

Every mutation parses shared schemas and maps errors consistently:

```json
{ "error": "PROJECT_REPOSITORY_INVALID", "message": "默认分支不存在", "details": [] }
```

Repository path/branch edits must validate before store mutation. Archive returns `409 PROJECT_IN_ACTIVE_DELIVERY` only when a phase-2-active delivery exists; during phase 1 no old history exists after reset.

- [ ] **Step 4: Implement association routes and design invalidation**

The PUT route validates module selections, replaces rows transactionally, and if material change occurs at or after approved technical design:

1. updates requirement stage to `technical_design` and status to `ai_ready`;
2. records a system approval/revision reason `项目关联或模块范围发生变化`;
3. marks the prior snapshot superseded;
4. returns the refreshed requirement detail.

- [ ] **Step 5: Run API tests**

Run: `npm test -- server/src/app.test.ts server/src/project-service.test.ts server/src/requirement-projects.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the APIs**

```bash
git add server/src/app.ts server/src/app.test.ts
git commit -m "feat: expose project and association APIs"
```

### Task 6: Assemble Multi-Project Technical-Design Context

**Files:**
- Create: `server/src/project-context.ts`
- Create: `server/src/project-context.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/ai.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing context tests**

Create two ready knowledge snapshots and assert technical design receives both while coding resolves only the sole delivery project:

```ts
const context = await buildRequirementProjectContext(store, requirement.id, "technical_design");
expect(context.projects.map(item => item.projectId)).toEqual(["backend", "web"]);
expect(context.projects[0]).toMatchObject({ role: "primary", usage: "context" });
expect(context.totalChars).toBeLessThanOrEqual(60000);
```

Add a test that two delivery projects produce `MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED` at coding and that PRD/review can still run.

- [ ] **Step 2: Run context tests and verify RED**

Run: `npm test -- server/src/project-context.test.ts`

Expected: FAIL because context assembly does not exist.

- [ ] **Step 3: Implement role-aware bounded retrieval**

`buildRequirementProjectContext(store, requirementId, stage)` loads all active associations in position order. For `technical_design`, retrieve at most 24 entries and 20,000 characters per project, then enforce a 60,000-character aggregate cap. Each project block contains identity, role, usage, module scope, knowledge version, source head, summary, and bounded entries.

For coding and later project-execution stages in phase 1, call `resolveSoleDeliveryProject`; inject only that project's knowledge and module scope. Do not let the coding runner write outside that repository worktree.

- [ ] **Step 4: Update run evidence**

Record one `knowledge.retrieved` event per project with project ID, knowledge version, source head, paths, and truncation. Store the frozen association snapshot when technical design is approved.

- [ ] **Step 5: Run AI and API tests**

Run: `npm test -- server/src/project-context.test.ts server/src/ai.test.ts server/src/app.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit multi-project context**

```bash
git add server/src/project-context.ts server/src/project-context.test.ts server/src/app.ts server/src/app.test.ts server/src/ai.ts
git commit -m "feat: assemble multi-project design context"
```

### Task 7: Build Project Management UI

**Files:**
- Create: `web/src/project-management.tsx`
- Create: `web/src/project-management.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing project view-model tests**

Extract and test pure helpers:

```ts
expect(projectActions({ status: "active" })).toEqual(["edit", "rebuild", "archive"]);
expect(projectActions({ status: "archived" })).toEqual(["view"]);
expect(projectValidationLabel({ valid: true, technology: ["node"], packageManager: "pnpm" }))
  .toBe("Git 可用 · Node · pnpm");
```

- [ ] **Step 2: Run UI helper tests and verify RED**

Run: `npm test -- web/src/project-management.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement the project list and drawer**

Replace the inline `Projects`/`ProjectRow` implementation with a focused component that provides:

- always-visible `New Project` button;
- active/archived segmented filter;
- category, path, branch, health, technology, module count, and knowledge state;
- edit, rebuild knowledge, and archive commands;
- create/edit drawer with name, path, branch, category, allowed commands, and sensitive patterns;
- explicit `Validate Repository` action and visible validation result before save.

Use Lucide icons, accessible labels, 8px-or-less radii, and no nested cards. Archive requires a confirmation modal naming the project and explaining that history remains unavailable only because this clean install has none.

- [ ] **Step 4: Add request-state handling**

Disable duplicate submissions, retain entered values after API failure, display server error messages next to the relevant field, refresh the list after create/edit/archive, and keep knowledge rebuild polling scoped to projects in `building` status.

- [ ] **Step 5: Run UI tests and typecheck**

Run: `npm test -- web/src/project-management.test.ts web/src/project-knowledge-view.test.ts && npm run typecheck -w web`

Expected: PASS.

- [ ] **Step 6: Commit project management UI**

```bash
git add web/src/project-management.tsx web/src/project-management.test.ts web/src/main.tsx web/src/associations.css
git commit -m "feat: add maintainable project management UI"
```

### Task 8: Build Requirement Association UI

**Files:**
- Create: `web/src/requirement-projects.tsx`
- Create: `web/src/requirement-projects.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing association view-model tests**

Test summary text, archived exclusion, module selection, exactly one primary, and the phase-1 execution guard:

```ts
expect(associationSummary([
  item({ projectName: "Soto Dine", role: "primary", usage: "context" }),
  item({ projectName: "Admin Web", role: "collaborator", usage: "delivery" })
])).toBe("主项目 Soto Dine · 1 个交付项目");

expect(phaseOneDeliveryGate([delivery("api"), delivery("web")])).toEqual({
  allowed: false,
  message: "多项目编码将在第二期启用；当前可继续完善总体技术设计"
});
```

- [ ] **Step 2: Run association UI tests and verify RED**

Run: `npm test -- web/src/requirement-projects.test.ts`

Expected: FAIL because the helpers and component do not exist.

- [ ] **Step 3: Update new-requirement creation**

Replace the legacy optional project select with a required active primary-project select posting `primaryProjectId`. If no active project exists, show a direct `前往项目配置` command rather than a disabled empty selector.

- [ ] **Step 4: Implement association summary and editor**

The requirement sidebar shows primary project and delivery count. `Manage Associated Projects` opens a modal/table where users can:

- add active projects not already associated;
- choose one primary using a radio control;
- choose context/delivery with a segmented control;
- toggle required delivery only when usage is delivery;
- select auto/all/selected module mode;
- choose indexed modules when selected mode is active;
- reorder projects;
- save the entire collection atomically.

Show a design-invalidation warning before saving a material change at or after technical design.

- [ ] **Step 5: Add the planned-delivery section and guard**

At technical design and coding, show one row per delivery project with project name, module scope, and `第二期启用分项目执行`. Disable `启动 AI` at coding when more than one delivery project exists and display the exact guard message. One delivery project continues to use the current coding modal.

- [ ] **Step 6: Run UI tests and typecheck**

Run: `npm test -- web/src/requirement-projects.test.ts web/src/navigation-view.test.ts && npm run typecheck -w web`

Expected: PASS.

- [ ] **Step 7: Commit requirement association UI**

```bash
git add web/src/requirement-projects.tsx web/src/requirement-projects.test.ts web/src/main.tsx web/src/associations.css
git commit -m "feat: manage requirement project associations"
```

### Task 9: Document Reset And Verify Phase 1 End To End

**Files:**
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Test: `server/src/app.test.ts`

- [ ] **Step 1: Add the reset and usage documentation**

Document that the first startup of this version:

- stops if an AI/integration process is active;
- backs up the old SQLite database locally;
- starts with no projects or requirements;
- requires projects to be re-registered;
- does not modify or push linked repositories;
- supports real coding only when exactly one delivery project is configured until phase 2.

Include the backup filename pattern and manual recovery command that stops the service, moves the fresh database aside, and restores the backup.

- [ ] **Step 2: Run all automated verification**

Run:

```bash
npm run typecheck
npm run build
npm test
```

Expected: all commands exit 0 and Vitest reports no failed files or tests.

- [ ] **Step 3: Verify clean reset with a copied database**

Copy the current local database to a temporary directory, start the server against that temporary data directory, and verify:

- a timestamped backup exists;
- `GET /api/projects` returns `[]`;
- `GET /api/requirements` returns `[]`;
- the schema marker equals `multi-project-v1`.

Do not run the destructive reset against the user's live database until the user explicitly starts phase-1 acceptance.

- [ ] **Step 4: Verify the browser workflow**

Start the development server and test at desktop and mobile widths:

1. Register a temporary backend repository.
2. Register a temporary frontend repository.
3. Edit the frontend default branch and revalidate.
4. Create a requirement with backend as primary.
5. Change backend to context and add frontend as required delivery.
6. Select a frontend module and save.
7. Confirm technical-design context contains both projects.
8. Confirm a single delivery project can enter coding.
9. Add backend as a second delivery project and confirm coding is blocked with the phase-2 message.
10. Archive a temporary project and confirm it disappears from new association choices.

Capture browser console errors and require zero application errors.

- [ ] **Step 5: Confirm repository safety**

Run `git status --short` in every linked acceptance repository and confirm the project-registration and knowledge operations created no source changes, commits, branches, pushes, or pull requests.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/getting-started.md server/src/app.test.ts
git commit -m "docs: explain multi-project phase one reset"
```

## Phase 1 Completion Gate

Phase 1 is complete only when:

- the clean reset is backed up and verified against a copied database;
- project create/edit/validate/archive works from the UI;
- requirements use `requirement_projects` exclusively;
- technical design consumes all associated project knowledge;
- exactly one delivery project continues through current coding/integration;
- multiple delivery projects stop safely before coding with a visible phase-2 explanation;
- all automated and browser checks pass;
- no linked repository is committed or pushed.
