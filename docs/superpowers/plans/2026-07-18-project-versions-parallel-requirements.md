# Project Versions And Parallel Requirements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped version branches with long-lived version worktrees so one project can run multiple globally numbered requirements in parallel and safely apply them one at a time as uncommitted local changes.

**Architecture:** Introduce `project_versions` as the owner of the target branch, long-lived worktree, and single-writer application lease. Store the selected version on each delivery `requirement_projects` association, create `ai/REQ-0001` worktrees only when coding begins, and reuse the existing evidence-checked `cherry-pick --no-commit` integration flow against the version worktree. Keep Git lifecycle, application state, HTTP routes, and React view models in focused modules instead of expanding `server/src/app.ts` and `web/src/main.tsx` further.

**Tech Stack:** TypeScript, Fastify, SQLite via `node:sqlite`, Zod, React 19, Vite, Vitest, local Git CLI.

---

## File Structure

- Create `shared/src/project-version.ts`: version status, persisted contract, validation result, and local-resolution types.
- Modify `shared/src/project-association.ts`: attach a version to delivery associations.
- Modify `shared/src/domain.ts`: add waiting-for-local-resolution workflow states.
- Modify `shared/src/schemas.ts`: version inputs and version-aware requirement/association schemas.
- Modify `shared/src/index.ts`: export version contracts.
- Modify `shared/src/schemas.test.ts`: version and delivery-association schema coverage.
- Modify `shared/src/domain.test.ts`: new state-transition coverage.
- Modify `server/src/database-reset.ts`: use the new schema marker through the existing backup/reset flow.
- Modify `server/src/database-reset.test.ts`: new marker reset coverage.
- Modify `server/src/index.ts`: start with `project-versions-v1`.
- Modify `server/src/startup-acceptance.test.ts`: assert the new clean schema.
- Modify `server/src/store.ts`: version schema, requirement counter, version associations, execution metadata, leases, and resolution persistence.
- Create `server/src/project-version-store.test.ts`: focused store invariants and transaction tests.
- Create `server/src/project-version-service.ts`: Git validation and long-lived version worktree lifecycle.
- Create `server/src/project-version-service.test.ts`: temporary-repository Git tests.
- Create `server/src/project-version-routes.ts`: version list/validate/create/recheck/close routes.
- Create `server/src/project-version-routes.test.ts`: route behavior and stable error tests.
- Modify `server/src/requirement-projects.ts`: project-version validation and sole-delivery version resolution.
- Modify `server/src/requirement-projects.test.ts`: context/delivery version invariants.
- Modify `server/src/repository.ts`: separate version and requirement worktree paths, version-based coding branches, and same-requirement reuse.
- Modify `server/src/repository.test.ts`: main-worktree preservation and branch isolation tests.
- Modify `server/src/coding-agent.ts`: start coding from the resolved project version.
- Modify `server/src/coding-agent.test.ts`: version branch/base commit assertions.
- Create `server/src/version-application.ts`: application lease, queue, and local-resolution classification.
- Create `server/src/version-application.test.ts`: single-writer and commit/revert/ambiguous resolution tests.
- Modify `server/src/integration.ts`: target the version worktree and preserve current no-commit semantics.
- Modify `server/src/integration.test.ts`: version worktree application and isolation tests.
- Modify `server/src/app.ts`: register focused routes and pass resolved versions into coding/application flows.
- Modify `server/src/app.test.ts`: version-aware requirement, coding, and application API regression tests.
- Create `web/src/project-versions.tsx`: version list, create dialog, close dialog, status, and queue summary.
- Create `web/src/project-versions.test.ts`: version form and view-model tests.
- Modify `web/src/project-management.tsx`: mount the version section per project.
- Create `web/src/new-requirement.tsx`: project-then-version requirement form.
- Create `web/src/new-requirement.test.ts`: dependent selection and empty-state tests.
- Modify `web/src/requirement-projects.tsx`: version selection for delivery associations.
- Modify `web/src/requirement-projects.test.ts`: delivery/context version behavior.
- Create `web/src/version-application-view.ts`: queue and local-resolution presentation helpers.
- Create `web/src/version-application-view.test.ts`: blocking and resolution labels.
- Modify `web/src/main.tsx`: use focused form/components and remove free target-branch selection for versioned requirements.
- Modify `web/src/associations.css`: version, queue, and responsive layout styles.
- Modify `README.md`: new reset warning and version workflow summary.
- Modify `docs/getting-started.md`: version worktree operations, recovery, and trial runbook.

### Task 1: Define Shared Version Contracts And Workflow States

**Files:**
- Create: `shared/src/project-version.ts`
- Modify: `shared/src/project-association.ts`
- Modify: `shared/src/domain.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/src/schemas.test.ts`
- Test: `shared/src/domain.test.ts`

- [ ] **Step 1: Write failing shared-contract tests**

Add tests proving version inputs are normalized, delivery associations require a version, context associations reject one, new requirements require a primary version, and local-application success can wait for human resolution:

```ts
it("requires versions only for delivery associations", () => {
  expect(requirementProjectInputSchema.parse({
    projectId: "api", projectVersionId: "v-221", role: "primary", usage: "delivery",
    deliveryRequired: true, moduleMode: "auto", moduleIds: [], position: 0
  }).projectVersionId).toBe("v-221");
  expect(() => requirementProjectInputSchema.parse({
    projectId: "docs", projectVersionId: "v-docs", role: "collaborator", usage: "context",
    deliveryRequired: false, moduleMode: "auto", moduleIds: [], position: 1
  })).toThrow("Context projects cannot select a version");
});

it("requires a primary version when creating a requirement", () => {
  expect(requirementInputSchema.parse({
    title: "登录提示", businessProblem: "登录失败原因无法区分", expectedOutcome: "显示明确原因",
    priority: "medium", primaryProjectId: "api", primaryProjectVersionId: "v-221"
  }).primaryProjectVersionId).toBe("v-221");
});

it("waits for local resolution after a successful no-commit application", () => {
  expect(canTransition("awaiting_merge", "awaiting_local_resolution")).toBe(true);
  expect(canTransition("awaiting_local_resolution", "completed")).toBe(true);
  expect(canTransition("awaiting_local_resolution", "awaiting_merge")).toBe(true);
});
```

- [ ] **Step 2: Run shared tests and verify RED**

Run: `npm test -- shared/src/schemas.test.ts shared/src/domain.test.ts`

Expected: FAIL because project-version contracts and the new workflow status do not exist.

- [ ] **Step 3: Add exact shared contracts**

Create `shared/src/project-version.ts` with these public contracts:

```ts
export const projectVersionStatuses = ["active", "closed"] as const;
export type ProjectVersionStatus = typeof projectVersionStatuses[number];

export interface ProjectVersion {
  id: string;
  projectId: string;
  projectName?: string;
  name: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  status: ProjectVersionStatus;
  headCommit: string;
  pendingRequirementId?: string;
  pendingIntegrationRunId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type ProjectVersionValidation = {
  valid: boolean;
  mode?: "create_branch" | "attach_branch" | "reuse_worktree";
  branch: string;
  baseBranch: string;
  headCommit?: string;
  existingWorktreePath?: string;
  error?: string;
};

export type LocalResolution =
  | { status: "pending" }
  | { status: "committed"; commit: string }
  | { status: "reverted" }
  | { status: "ambiguous"; currentHead: string };
```

Extend `RequirementProject` and `RequirementProjectInput` with `projectVersionId?: string` and optional display fields `projectVersionName`, `projectVersionBranch`, and `projectVersionStatus`. Add `primaryProjectVersionId` to `requirementInputSchema`. Add `projectVersionInputSchema` with `{ name, branch, baseBranch, reuseExistingWorktree?: boolean }`, all trimmed and non-empty.

Add `awaiting_local_resolution` and `manual_resolution_required` to `workflowStatuses`. Permit only these transitions:

```ts
awaiting_merge: ["merge_test_failed", "awaiting_local_resolution", "cancelled"],
merge_test_failed: ["awaiting_local_resolution", "cancelled"],
awaiting_local_resolution: ["completed", "awaiting_merge", "manual_resolution_required", "cancelled"],
manual_resolution_required: ["completed", "awaiting_merge", "cancelled"],
```

- [ ] **Step 4: Update existing schema fixtures and run shared verification**

Every existing delivery association fixture must include a matching `projectVersionId`; context fixtures must omit it. Every `RequirementInput` fixture must add `primaryProjectVersionId`.

Run: `npm test -- shared/src/schemas.test.ts shared/src/domain.test.ts && npm run typecheck -w shared`

Expected: PASS.

- [ ] **Step 5: Commit shared contracts**

```bash
git add shared/src/project-version.ts shared/src/project-association.ts shared/src/domain.ts shared/src/schemas.ts shared/src/index.ts shared/src/schemas.test.ts shared/src/domain.test.ts
git commit -m "feat: define project version contracts"
```

### Task 2: Rebuild The Local Database For Version Ownership

**Files:**
- Modify: `server/src/database-reset.ts`
- Modify: `server/src/database-reset.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/store.ts`
- Create: `server/src/project-version-store.test.ts`
- Modify: `server/src/startup-acceptance.test.ts`

- [ ] **Step 1: Write failing clean-schema tests**

Test that `project-versions-v1` resets `multi-project-v1`, creates the new tables and columns, starts the counter at one, and exposes no legacy free integration target:

```ts
it("creates the project-version schema and an atomic requirement counter", () => {
  const store = new WorkflowStore(dbPath);
  const db = (store as any).db as DatabaseSync;
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
  expect(columns("project_versions")).toContain("worktree_path");
  expect(columns("requirement_projects")).toContain("project_version_id");
  expect(columns("executions")).toEqual(expect.arrayContaining(["project_version_id", "base_commit"]));
  expect(columns("integration_runs")).toEqual(expect.arrayContaining([
    "project_version_id", "pre_apply_head", "resolution_status", "resolution_commit"
  ]));
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
  expect(tables).not.toContain("requirement_integration_targets");
});
```

Add a startup acceptance expectation that the schema marker equals `project-versions-v1`.

- [ ] **Step 2: Run reset/store tests and verify RED**

Run: `npm test -- server/src/database-reset.test.ts server/src/project-version-store.test.ts server/src/startup-acceptance.test.ts`

Expected: FAIL because the new schema is absent and startup still writes `multi-project-v1`.

- [ ] **Step 3: Define the fresh schema**

Set the startup marker to `project-versions-v1`. Create these new schema elements directly in `WorkflowStore.migrate()`:

```sql
CREATE TABLE project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','closed')),
  head_commit TEXT NOT NULL,
  pending_requirement_id TEXT,
  pending_integration_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(project_id,name),
  UNIQUE(project_id,branch),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (key,value) VALUES ('requirement',0);
```

Add `project_version_id` to `requirement_projects`; add `project_version_id` and `base_commit` to `executions`; add `project_version_id`, `pre_apply_head`, `resolution_status`, and `resolution_commit` to `integration_runs`. Remove `requirement_integration_targets` from the fresh schema and its read/write methods.

- [ ] **Step 4: Allocate requirement codes inside the creation transaction**

Replace `COUNT(*) + 1` with this transaction-local allocator:

```ts
private nextRequirementCode() {
  const row = this.db.prepare(
    "UPDATE counters SET value = value + 1 WHERE key = 'requirement' RETURNING value"
  ).get() as { value: number };
  return `REQ-${String(row.value).padStart(4, "0")}`;
}
```

Call it only after `BEGIN` and before inserting the requirement. Add a test with two store connections creating requirements in interleaved promises; assert committed codes are unique and ordered.

- [ ] **Step 5: Run database verification**

Run: `npm test -- server/src/database-reset.test.ts server/src/project-version-store.test.ts server/src/startup-acceptance.test.ts`

Expected: PASS, including a real child-server reset and backup.

- [ ] **Step 6: Commit the new clean schema**

```bash
git add server/src/database-reset.ts server/src/database-reset.test.ts server/src/index.ts server/src/store.ts server/src/project-version-store.test.ts server/src/startup-acceptance.test.ts
git commit -m "feat: rebuild local data for project versions"
```

### Task 3: Implement Safe Version Branch And Worktree Lifecycle

**Files:**
- Create: `server/src/project-version-service.ts`
- Create: `server/src/project-version-service.test.ts`
- Modify: `server/src/repository.ts`
- Modify: `server/src/repository.test.ts`

- [ ] **Step 1: Write failing temporary-repository tests**

Create a repository with `prod`, an unattached `feature/2.2.1`, and a second occupied worktree. Test all three modes and main-worktree preservation:

```ts
it("creates a long-lived version worktree without changing the main worktree", async () => {
  const before = await readRepositoryState(repo);
  const validation = await inspectProjectVersion({ repoPath: repo, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod" });
  expect(validation.mode).toBe("create_branch");
  const created = await createProjectVersionWorktree({ ...validation, repoPath: repo, versionId: "v-221" });
  expect(await currentBranch(created.worktreePath)).toBe("feature/2.2.1");
  expect(await readRepositoryState(repo)).toEqual(before);
});

it("refuses to reuse the registered project root as a version worktree", async () => {
  await checkout(repo, "feature/2.2.1");
  await expect(inspectProjectVersion({ repoPath: repo, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod" }))
    .rejects.toThrow("PROJECT_VERSION_BRANCH_IN_USE");
});
```

- [ ] **Step 2: Run the Git service tests and verify RED**

Run: `npm test -- server/src/project-version-service.test.ts server/src/repository.test.ts`

Expected: FAIL because version inspection and long-lived worktree creation do not exist.

- [ ] **Step 3: Implement branch inspection and deterministic paths**

Export these functions from `project-version-service.ts`:

```ts
export async function inspectProjectVersion(input: {
  repoPath: string; name: string; branch: string; baseBranch: string;
}): Promise<ProjectVersionValidation>;

export async function createProjectVersionWorktree(input: {
  repoPath: string; versionId: string; branch: string; baseBranch: string;
  mode: "create_branch" | "attach_branch" | "reuse_worktree";
  existingWorktreePath?: string; reuseExistingWorktree?: boolean;
}): Promise<{ worktreePath: string; headCommit: string; createdBranch: boolean; createdWorktree: boolean }>;

export async function inspectVersionWorktree(input: {
  repoPath: string; worktreePath: string; branch: string;
}): Promise<{ valid: boolean; clean: boolean; headCommit: string; status: string }>;
```

Use `git check-ref-format --branch`, `git show-ref --verify`, `git worktree list --porcelain`, and `realpath`. Resolve version paths to `../.ai-workflow-worktrees/<repo>/versions/<version-id>`. Reject traversal, symlink escape, the registered project root, a worktree owned by another branch, and an occupied branch without explicit reusable external worktree confirmation.

- [ ] **Step 4: Separate requirement worktree paths**

Replace `createIsolatedWorktree` with a create-or-reuse operation. Requirement paths use `requirements/<REQ>` and accept the selected version branch as the first-run base:

```ts
export async function createOrReuseRequirementWorktree(repoPath: string, baseBranch: string, requirementCode: string) {
  const branch = `ai/${requirementCode}`;
  const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath), "requirements");
  const worktreePath = resolve(root, requirementCode);
  const existing = await findRegisteredWorktree(repoPath, branch);
  if (existing) return { branch, worktreePath: existing.path, baseCommit: existing.baseCommit, reused: true };
  if (await localBranchExists(repoPath, branch)) {
    await execFileAsync("git", ["-C", repoPath, "worktree", "add", worktreePath, branch]);
  } else {
    await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath, baseBranch]);
  }
  const baseCommit = (await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  return { branch, worktreePath, baseCommit, reused: false };
}
```

`findRegisteredWorktree` must parse `git worktree list --porcelain`, verify the path remains under the managed requirements root, and reject a branch registered outside that root. Add a test proving a second coding/rework run reuses the same path and preserves existing changes; a concurrent active stage run remains rejected by the existing run lock.

- [ ] **Step 5: Run Git lifecycle tests**

Run: `npm test -- server/src/project-version-service.test.ts server/src/repository.test.ts`

Expected: PASS with the main worktree branch and status unchanged.

- [ ] **Step 6: Commit the Git lifecycle**

```bash
git add server/src/project-version-service.ts server/src/project-version-service.test.ts server/src/repository.ts server/src/repository.test.ts
git commit -m "feat: manage project version worktrees"
```

### Task 4: Persist Project Versions And Version-Aware Associations

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/project-version-store.test.ts`
- Modify: `server/src/requirement-projects.ts`
- Modify: `server/src/requirement-projects.test.ts`
- Modify: `server/src/store.test.ts`

- [ ] **Step 1: Write failing version store and association tests**

Cover create/list/get, duplicate name/branch, close blocking, cross-project version rejection, context version rejection, and snapshot contents:

```ts
it("stores a delivery version and freezes it in the association snapshot", () => {
  const project = createProject(store, "api");
  const version = store.createProjectVersion({
    projectId: project.id, name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod",
    worktreePath: "/tmp/api-v221", headCommit: "abc123"
  });
  const req = store.createRequirement(requirementInput(project.id, version.id));
  expect(store.listRequirementProjects(req.id)[0]).toMatchObject({
    projectVersionId: version.id, projectVersionName: "2.2.1", projectVersionBranch: "feature/2.2.1"
  });
  expect(store.createRequirementProjectSnapshot(req.id).associations[0]).toMatchObject({
    projectVersionId: version.id, projectVersionHead: "abc123"
  });
});
```

- [ ] **Step 2: Run focused store tests and verify RED**

Run: `npm test -- server/src/project-version-store.test.ts server/src/requirement-projects.test.ts server/src/store.test.ts`

Expected: FAIL because version persistence and association validation are absent.

- [ ] **Step 3: Add exact store APIs**

Implement these methods in `WorkflowStore`:

```ts
createProjectVersion(input: { projectId: string; name: string; branch: string; baseBranch: string; worktreePath: string; headCommit: string }): ProjectVersion
listProjectVersions(projectId: string, status: "active" | "closed" | "all"): ProjectVersion[]
getProjectVersion(id: string): ProjectVersion | null
updateProjectVersionHead(id: string, headCommit: string): ProjectVersion | null
closeProjectVersion(id: string): ProjectVersion
listVersionRequirements(id: string): any[]
```

Join `project_versions` in `listRequirementProjects` and `mapRequirementProject`. Insert `project_version_id` in `insertRequirementAssociation`. Add version rows to `projectValidationRows` or pass a separate `versions` map into `validateRequirementProjects`.

- [ ] **Step 4: Enforce association invariants**

Extend `validateRequirementProjects` with these exact checks:

```ts
if (item.usage === "delivery" && !item.projectVersionId) throw new Error("REQUIREMENT_VERSION_REQUIRED");
if (item.usage === "context" && item.projectVersionId) throw new Error("CONTEXT_PROJECT_VERSION_NOT_ALLOWED");
const version = item.projectVersionId ? options.versions.get(item.projectVersionId) : undefined;
if (item.projectVersionId && (!version || version.projectId !== item.projectId)) throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
if (version?.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
```

The create-requirement transaction must validate `primaryProjectVersionId`, insert it into the primary association, and allocate the requirement code in the same transaction.

- [ ] **Step 5: Run store and association verification**

Run: `npm test -- server/src/project-version-store.test.ts server/src/requirement-projects.test.ts server/src/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add server/src/store.ts server/src/project-version-store.test.ts server/src/requirement-projects.ts server/src/requirement-projects.test.ts server/src/store.test.ts
git commit -m "feat: persist project versions and requirement links"
```

### Task 5: Expose Version Lifecycle APIs

**Files:**
- Create: `server/src/project-version-routes.ts`
- Create: `server/src/project-version-routes.test.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write failing route tests**

Test list filters, validation without mutation, create-new branch, attach-existing branch, duplicate errors, recheck, close success, and close blockers:

```ts
it("validates then creates a version without changing the project main worktree", async () => {
  const validation = await app.inject({ method: "POST", url: `/api/projects/${project.id}/versions/validate`, payload: {
    name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod"
  }});
  expect(validation.json()).toMatchObject({ valid: true, mode: "create_branch" });
  const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/versions`, payload: {
    name: "2.2.1", branch: "feature/2.2.1", baseBranch: "prod"
  }});
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ name: "2.2.1", status: "active" });
  expect(await readRepositoryState(repo)).toEqual(before);
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test -- server/src/project-version-routes.test.ts`

Expected: FAIL because the route plugin is missing.

- [ ] **Step 3: Implement a focused Fastify plugin**

Export `registerProjectVersionRoutes(app, { store })`. Parse request bodies with `projectVersionInputSchema`. Implement:

```text
GET  /api/projects/:projectId/versions?status=active|closed|all
POST /api/projects/:projectId/versions/validate
POST /api/projects/:projectId/versions
GET  /api/project-versions/:id
POST /api/project-versions/:id/recheck
POST /api/project-versions/:id/close
GET  /api/project-versions/:id/requirements
```

Creation must re-run inspection, create/attach the worktree, persist the row, and clean up only a branch/worktree created by this request if persistence fails. Map the design error codes to stable `400`, `404`, or `409` responses.

- [ ] **Step 4: Register routes and run API verification**

Call `registerProjectVersionRoutes(app, { store })` from `buildApp`. Do not inline the handlers into `app.ts`.

Run: `npm test -- server/src/project-version-routes.test.ts server/src/app.test.ts && npm run typecheck -w server`

Expected: PASS.

- [ ] **Step 5: Commit version APIs**

```bash
git add server/src/project-version-routes.ts server/src/project-version-routes.test.ts server/src/app.ts
git commit -m "feat: expose project version lifecycle APIs"
```

### Task 6: Create Requirement Worktrees From The Selected Version

**Files:**
- Modify: `server/src/coding-agent.ts`
- Modify: `server/src/coding-agent.test.ts`
- Modify: `server/src/repository.ts`
- Modify: `server/src/repository.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`

- [ ] **Step 1: Write failing version-based coding tests**

Prove no branch is created at requirement creation, coding starts from the latest version HEAD, execution metadata records the immutable base, and closed/mismatched versions block before a run is created:

```ts
it("creates ai/REQ worktree from the selected version only when coding starts", async () => {
  const req = store.createRequirement(requirementInput(project.id, version.id));
  expect(await localBranchExists(repo, `ai/${req.code}`)).toBe(false);
  await commitFile(version.worktreePath, "baseline.txt", "v2");
  const result = await runCodingAgent({ requirement: req, artifacts: [], project, version: store.getProjectVersion(version.id)! });
  expect(result.branch).toBe(`ai/${req.code}`);
  expect(result.baseCommit).toBe(await head(version.worktreePath));
  expect(await localBranchExists(repo, result.branch)).toBe(true);
});
```

- [ ] **Step 2: Run coding tests and verify RED**

Run: `npm test -- server/src/coding-agent.test.ts server/src/repository.test.ts server/src/app.test.ts`

Expected: FAIL because coding still starts from `project.defaultBranch` and execution rows lack version metadata.

- [ ] **Step 3: Pass the resolved version into coding**

Change the coding input type to:

```ts
type CodingVersion = { id: string; branch: string; worktreePath: string; status: "active" | "closed" };

type CodingAgentInput = {
  requirement: any;
  artifacts: any[];
  project: CodingProject;
  version: CodingVersion;
};
```

At the beginning of `runCodingAgent(input: CodingAgentInput)`, replace the existing worktree creation line with:

```ts
if (input.version.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
const worktree = await createOrReuseRequirementWorktree(
  input.project.repoPath, input.version.branch, input.requirement.code
);
```

Keep the current OpenAI tool loop below this setup except for returning `baseCommit` and `reused` with the existing result.

Resolve exactly one delivery association and its joined version before creating a stage run. Add `projectVersionId` and `baseCommit` to `addExecution` and execution mapping.

- [ ] **Step 4: Preserve snapshot and stale-version behavior**

When technical design is approved, freeze version ID/name/branch/worktree/head in `requirement_project_snapshots`. If the association version changes afterward, supersede the snapshot and return the requirement to technical design using the existing material-change path. A version HEAD advancing without association changes does not invalidate design; it is captured when coding begins.

- [ ] **Step 5: Run coding and API verification**

Run: `npm test -- server/src/coding-agent.test.ts server/src/repository.test.ts server/src/app.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit version-based coding**

```bash
git add server/src/coding-agent.ts server/src/coding-agent.test.ts server/src/repository.ts server/src/repository.test.ts server/src/store.ts server/src/app.ts server/src/app.test.ts
git commit -m "feat: start requirement coding from project versions"
```

### Task 7: Add Atomic Version Application Leases And Queues

**Files:**
- Create: `server/src/version-application.ts`
- Create: `server/src/version-application.test.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/project-version-store.test.ts`
- Modify: `server/src/project-version-routes.ts`
- Modify: `server/src/project-version-routes.test.ts`

- [ ] **Step 1: Write failing lease and queue tests**

Test one active writer per version, independent writers across versions, ordered waiting requirements, atomic rollback, and restart recovery inputs:

```ts
it("allows one pending application per version", () => {
  const first = store.beginVersionApplication({ versionId: version.id, requirementId: req1.id, run: run1 });
  expect(first.version.pendingRequirementId).toBe(req1.id);
  expect(() => store.beginVersionApplication({ versionId: version.id, requirementId: req2.id, run: run2 }))
    .toThrow("PROJECT_VERSION_APPLICATION_BUSY");
  expect(store.listVersionApplicationQueue(version.id).map(item => item.requirementId)).toEqual([req1.id, req2.id]);
});
```

- [ ] **Step 2: Run lease tests and verify RED**

Run: `npm test -- server/src/version-application.test.ts server/src/project-version-store.test.ts`

Expected: FAIL because lease and queue APIs do not exist.

- [ ] **Step 3: Implement pure resolution classification**

Create `version-application.ts`:

```ts
export function classifyLocalResolution(input: {
  statusPorcelain: string; preApplyHead: string; currentHead: string;
}): LocalResolution {
  if (input.statusPorcelain.length > 0) return { status: "pending" };
  if (input.currentHead === input.preApplyHead) return { status: "reverted" };
  if (input.currentHead) return { status: "committed", commit: input.currentHead };
  return { status: "ambiguous", currentHead: input.currentHead };
}
```

The caller must perform ancestry and repository identity checks first; a non-descendant HEAD becomes `ambiguous`, not `committed`.

- [ ] **Step 4: Implement transactional store operations**

Add exact methods:

```ts
beginVersionApplication(input: { versionId: string; requirementId: string; run: any }): { version: ProjectVersion; run: any }
completeVersionApplicationApply(input: { runId: string; sourceCommit: string; preApplyHead: string; status: "awaiting_local_resolution" | "merge_test_failed" }): any
releaseVersionApplication(input: { versionId: string; runId: string; resolution: "committed" | "reverted"; resolutionCommit?: string }): any
markVersionResolutionAmbiguous(input: { versionId: string; runId: string; currentHead: string }): any
listVersionApplicationQueue(versionId: string): any[]
listPendingVersionApplications(): any[]
```

`beginVersionApplication` must conditionally update `project_versions` only when both pending columns are null, insert the run, and update the requirement state in one SQLite transaction.

Add `GET /api/project-versions/:id/application-queue` to the version route plugin. It returns the current owner first, followed by eligible `awaiting_merge` requirements ordered by `updated_at` and code. Route tests must prove another project/version cannot read or mutate this queue through mismatched IDs.

- [ ] **Step 5: Run lease and store tests**

Run: `npm test -- server/src/version-application.test.ts server/src/project-version-store.test.ts server/src/project-version-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit application ownership**

```bash
git add server/src/version-application.ts server/src/version-application.test.ts server/src/store.ts server/src/project-version-store.test.ts server/src/project-version-routes.ts server/src/project-version-routes.test.ts
git commit -m "feat: serialize project version applications"
```

### Task 8: Apply Evidence To Version Worktrees And Detect Human Resolution

**Files:**
- Modify: `server/src/integration.ts`
- Modify: `server/src/integration.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`
- Modify: `server/src/project-version-routes.ts`
- Modify: `server/src/project-version-routes.test.ts`

- [ ] **Step 1: Write failing application and resolution tests**

Cover successful no-commit application, queue blocking, conflict rollback and lease release, test-failure lease retention, manual commit completion, manual revert return, non-descendant ambiguity, and retry without duplicate application:

```ts
it("keeps the version leased until a human commits or reverts", async () => {
  const applied = await executeLocalIntegration(versionInput);
  expect(applied.status).toBe("completed");
  expect(await status(version.worktreePath)).not.toBe("");
  expect(store.getRequirement(req.id)?.status).toBe("awaiting_local_resolution");
  await git(version.worktreePath, ["commit", "-am", "REQ-0001 local review"]);
  const resolved = await recheckVersionApplication(store, version.id);
  expect(resolved).toMatchObject({ status: "committed" });
  expect(store.getRequirement(req.id)?.status).toBe("completed");
});
```

- [ ] **Step 2: Run integration/API tests and verify RED**

Run: `npm test -- server/src/integration.test.ts server/src/app.test.ts server/src/project-version-routes.test.ts`

Expected: FAIL because integration still targets `project.repoPath` and completes the requirement immediately.

- [ ] **Step 3: Target the version worktree**

Rename the integration input target explicitly:

```ts
type Input = {
  targetWorktreePath: string;
  targetBranch: string;
  sourceWorktreePath: string;
  sourceBranch: string;
  evidenceDiffHash: string;
  sourceCommit?: string;
  changedFiles?: string[];
  fallbackCommands?: VerificationCommand[];
};
```

Run all target branch/status/cherry-pick/tests against `targetWorktreePath`. Keep source evidence checks against `sourceWorktreePath`. On successful tests, do not commit the target and return its porcelain status plus `preApplyHead`.

- [ ] **Step 4: Wire lease outcomes to workflow states**

Use these exact rules:

```ts
if (result.status === "completed") {
  store.completeVersionApplicationApply({ runId: run.id, sourceCommit: result.sourceCommit!, preApplyHead: result.preApplyHead, status: "awaiting_local_resolution" });
}
if (result.status === "test_failed") {
  store.completeVersionApplicationApply({ runId: run.id, sourceCommit: result.sourceCommit!, preApplyHead: result.preApplyHead, status: "merge_test_failed" });
}
if (result.status === "conflict") {
  store.releaseFailedVersionApplication(version.id, run.id, result.error);
}
```

Remove free target-branch mutation for versioned requirements. The target always comes from the frozen version association.

- [ ] **Step 5: Implement recheck and startup recovery**

`POST /api/project-versions/:id/recheck` must inspect the pending version worktree, verify current HEAD is a descendant of `preApplyHead`, classify it, and atomically update requirement/run/version. On server startup, call the same routine for every `listPendingVersionApplications()` row; do not silently release inaccessible or ambiguous worktrees.

- [ ] **Step 6: Run integration and API verification**

Run: `npm test -- server/src/integration.test.ts server/src/app.test.ts server/src/project-version-routes.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the version application flow**

```bash
git add server/src/integration.ts server/src/integration.test.ts server/src/app.ts server/src/app.test.ts server/src/project-version-routes.ts server/src/project-version-routes.test.ts
git commit -m "feat: apply requirements to version worktrees"
```

### Task 9: Build Project Version Management UI

**Files:**
- Create: `web/src/project-versions.tsx`
- Create: `web/src/project-versions.test.ts`
- Modify: `web/src/project-management.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing version UI view-model tests**

Test active/closed grouping, create-mode labels, validation invalidation after editing branch/base, close blockers, application owner, and queue counts:

```ts
it("invalidates validation when branch identity changes", () => {
  const validated = recordVersionValidation(form, { valid: true, mode: "create_branch" });
  expect(canSaveVersion(validated)).toBe(true);
  expect(canSaveVersion(updateVersionField(validated, "branch", "feature/2.2.2"))).toBe(false);
});

it("shows the pending requirement and blocks closing", () => {
  expect(projectVersionView({ ...version, pendingRequirementId: "REQ-0001" }, queue)).toMatchObject({
    canClose: false, closeReason: "REQ-0001 正在等待本地提交或撤销"
  });
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test -- web/src/project-versions.test.ts`

Expected: FAIL because the component and helpers are missing.

- [ ] **Step 3: Implement focused version management components**

Export `ProjectVersions`, `VersionDialog`, and `CloseVersionDialog` from `project-versions.tsx`. The dialog state must be:

```ts
type VersionFormState = {
  values: { name: string; branch: string; baseBranch: string; reuseExistingWorktree: boolean };
  validation?: ProjectVersionValidation;
  validatedIdentity?: string;
  busy: "validate" | "save" | null;
  error?: string;
};
```

Fetch versions per expanded project, poll only versions with pending applications, and preserve the last successful snapshot on transient refresh errors. Display name, branch, base, HEAD, worktree path, requirement-stage counts, pending owner, queue length, recheck, and close.

- [ ] **Step 4: Mount versions in project management**

Render `<ProjectVersions project={project} />` beneath project knowledge/memory. Keep project create/edit/archive operation keys separate from version operations so concurrent actions on different projects do not overwrite each other.

- [ ] **Step 5: Add responsive styles and run frontend verification**

At widths below 720px, stack version metadata and actions, keep branch/worktree code breakable, and render dialogs within viewport height without horizontal scrolling.

Run: `npm test -- web/src/project-versions.test.ts web/src/project-management.test.ts && npm run typecheck -w web`

Expected: PASS.

- [ ] **Step 6: Commit version management UI**

```bash
git add web/src/project-versions.tsx web/src/project-versions.test.ts web/src/project-management.tsx web/src/associations.css
git commit -m "feat: manage project versions in the UI"
```

### Task 10: Add Version-Aware Requirement And Application UI

**Files:**
- Create: `web/src/new-requirement.tsx`
- Create: `web/src/new-requirement.test.ts`
- Modify: `web/src/requirement-projects.tsx`
- Modify: `web/src/requirement-projects.test.ts`
- Create: `web/src/version-application-view.ts`
- Create: `web/src/version-application-view.test.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/associations.css`

- [ ] **Step 1: Write failing dependent-selection tests**

Test project changes clearing stale versions, no-version guidance, generated-code behavior, delivery/context version rules, queue position, and local-resolution labels:

```ts
it("clears a selected version when the project changes", () => {
  const next = selectRequirementProject({ primaryProjectId: "api", primaryProjectVersionId: "v-api" }, "web");
  expect(next).toEqual({ primaryProjectId: "web", primaryProjectVersionId: "" });
});

it("renders the human-resolution state", () => {
  expect(versionApplicationView({ status: "awaiting_local_resolution", queuePosition: 0 })).toMatchObject({
    label: "等待本地提交或撤销", canApply: false, showRecheck: true
  });
});
```

- [ ] **Step 2: Run requirement UI tests and verify RED**

Run: `npm test -- web/src/new-requirement.test.ts web/src/requirement-projects.test.ts web/src/version-application-view.test.ts`

Expected: FAIL because dependent project/version controls and version application helpers are absent.

- [ ] **Step 3: Extract and implement the new requirement form**

Move `NewRequirement` out of `main.tsx`. Load active projects first, then `GET /projects/:id/versions?status=active`. Disable save until both IDs are present. If the project has no active versions, show a single command that closes the modal and navigates to that project's version section.

Submit this exact payload:

```ts
{
  title, businessProblem, expectedOutcome, priority,
  primaryProjectId,
  primaryProjectVersionId
}
```

Do not render an editable requirement code field; display the returned `REQ-0001` after creation through the existing detail navigation/refresh flow.

- [ ] **Step 4: Add version controls to association editing**

For every `usage="delivery"` row, lazily load active versions for that project and require one selection. Switching to context clears `projectVersionId`; switching back to delivery requires explicit version selection. Changing a version after technical design shows the existing invalidation warning.

- [ ] **Step 5: Replace free target branch UI with version application state**

For versioned requirements, remove the integration target `<select>`. Show target version name/branch/worktree, source `ai/REQ`, base commit, pending owner, queue position, test results, and “重新检测本地处理结果”. Preserve the legacy display only for historical records that have no version snapshot.

- [ ] **Step 6: Run frontend regression and typecheck**

Run: `npm test -- web/src/new-requirement.test.ts web/src/requirement-projects.test.ts web/src/version-application-view.test.ts web/src/navigation-view.test.ts web/src/integration-view.test.ts && npm run typecheck -w web`

Expected: PASS.

- [ ] **Step 7: Commit requirement and application UI**

```bash
git add web/src/new-requirement.tsx web/src/new-requirement.test.ts web/src/requirement-projects.tsx web/src/requirement-projects.test.ts web/src/version-application-view.ts web/src/version-application-view.test.ts web/src/main.tsx web/src/associations.css
git commit -m "feat: create and deliver versioned requirements"
```

### Task 11: Document, Verify, And Run The Two-Requirement Pilot

**Files:**
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `server/src/startup-acceptance.test.ts`

- [ ] **Step 1: Document reset, worktree layout, and recovery**

Document the `project-versions-v1` backup/reset, project/version/requirement relationship, `.ai-workflow-worktrees/<repo>/versions` and `requirements` paths, no-commit/no-push guarantee, application queue, manual commit/revert detection, and how to remove an abandoned clean worktree using `git worktree remove` followed by `git worktree prune`.

- [ ] **Step 2: Run all automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit 0; Vitest reports zero failed files and tests; Vite emits a production bundle.

- [ ] **Step 3: Verify the real production startup reset**

Run: `npm test -- server/src/startup-acceptance.test.ts`

Expected: PASS and the child server proves an incompatible database is backed up, the new database is empty, and its marker is `project-versions-v1`.

- [ ] **Step 4: Run desktop and mobile browser acceptance**

Using temporary local Git repositories first, verify:

1. Create `2.2.1` from `prod` and confirm the main worktree branch/status are unchanged.
2. Register an existing `feature/2.2.2` branch as a second version.
3. Create two requirements and observe `REQ-0001` and `REQ-0002`.
4. Confirm no `ai/REQ` branch exists before coding.
5. Start both coding stages and confirm separate branches/worktrees; rerun one coding stage and confirm it reuses its original requirement worktree.
6. Apply REQ-0001 and confirm the version worktree has uncommitted changes and no new version commit.
7. Confirm REQ-0002 is blocked with its queue position.
8. Commit REQ-0001 manually, recheck, and confirm REQ-0002 becomes eligible.
9. Repeat with a manual revert and confirm the requirement returns to pending application.
10. Verify project/version/requirement screens at 390x844 and 1440x900 with no overflow or overlap.

Require zero application console errors.

- [ ] **Step 5: Run the Soto Dine pilot without automatic commits or pushes**

After temporary-repository acceptance passes:

1. Record Soto Dine main-worktree branch, HEAD, and porcelain status.
2. Create or register `feature/2.2.1` as a version.
3. Create two low-risk real requirements.
4. Run both through coding, Review, and tests in parallel.
5. Apply one requirement, inspect and manually resolve it, then apply the second.
6. Confirm Soto Dine main-worktree branch, HEAD, and pre-existing local status are unchanged.
7. Confirm no remote refs changed and no push/PR occurred.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/getting-started.md server/src/startup-acceptance.test.ts
git commit -m "docs: explain project version pilot workflow"
```

## Completion Gate

This feature is complete only when:

- project versions own validated long-lived local worktrees;
- requirement creation atomically assigns a global code and selected version;
- no requirement branch/worktree exists before coding;
- two requirements in one version can execute concurrently in isolated worktrees;
- one version accepts only one uncommitted application at a time;
- human commit/revert is detected and releases the queue correctly;
- conflicts, test failures, restart recovery, and ambiguous manual changes preserve evidence and ownership;
- the project main worktree is unchanged by version creation, coding, and application;
- the system never automatically commits the version branch or pushes any repository;
- full tests, typecheck, production build, browser acceptance, and the Soto Dine pilot pass.
