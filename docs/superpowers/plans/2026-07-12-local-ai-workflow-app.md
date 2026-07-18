# Local AI Workflow App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可本机长期使用的 AI 研发工作流 Web 应用，支持 SQLite、OpenAI、人工门禁和隔离 Git worktree 执行。

**Architecture:** npm workspaces 管理 `web`、`server`、`shared`。Fastify 服务负责领域规则、SQLite、AI 调用、SSE 与本地执行；React 页面只通过类型化 API 操作。领域状态和结构化输出 Schema 放在 shared，避免前后端规则漂移。

**Tech Stack:** Node.js 22、TypeScript、React、Vite、Fastify、Drizzle ORM、SQLite、Zod、OpenAI SDK、Vitest、Testing Library、Playwright。

---

### Task 1: Workspace and shared domain

**Files:** Create root npm configuration, `shared/src/domain.ts`, `shared/src/schemas.ts`, and shared tests.

- [ ] Add workspace scripts, TypeScript configuration, lint-safe defaults, and ignored local data.
- [ ] Define stages, statuses, approval decisions, severities, and transition validation.
- [ ] Add Zod schemas for requirements, AI artifacts, findings, approvals, and project commands.
- [ ] Verify shared unit tests and typecheck.

### Task 2: Server persistence and workflow API

**Files:** Create `server/src/db`, `server/src/services/workflow-service.ts`, route modules, migrations, and tests.

- [ ] Define SQLite tables for projects, requirements, stage runs, artifacts, findings, approvals, trace links, executions, attachments, and settings.
- [ ] Implement requirement creation, stage transitions, immutable artifact versions, approvals, and history queries.
- [ ] Expose REST endpoints with Zod validation and consistent error responses.
- [ ] Verify integration tests against temporary SQLite databases.

### Task 3: OpenAI orchestration

**Files:** Create agent profiles, prompt assembly, OpenAI adapter, structured output parsing, run service, and tests.

- [ ] Seed product, engineering, design, coding, review, and test agent profiles from existing prompts.
- [ ] Build context preview and redaction, requiring user confirmation before execution.
- [ ] Call the Responses API through an adapter and validate structured output before creating artifacts.
- [ ] Persist attempts, usage, errors, retries, and SSE progress events.
- [ ] Verify with a fake OpenAI client; live API remains opt-in.

### Task 4: Git worktree and command runner

**Files:** Create repository service, worktree service, command policy, process runner, routes, and tests.

- [ ] Validate registered repositories and default branches.
- [ ] Create per-run branches/worktrees outside the source checkout.
- [ ] Enforce executable-plus-argument command policies without shell interpolation.
- [ ] Stream and persist stdout, stderr, exit status, Git status, and diff summaries.
- [ ] Block destructive Git operations and commands outside the worktree.

### Task 5: React workflow UI

**Files:** Create app shell, dashboard, requirements, project settings, stage detail, approval, execution logs, and responsive styles.

- [ ] Build dashboard queues and requirement list.
- [ ] Build requirement creation form and stage timeline.
- [ ] Build AI context preview, manual start, streamed run view, artifact rendering, findings, and approval actions.
- [ ] Build project registration, sensitive path rules, and command allowlist editor.
- [ ] Add loading, empty, failure, interrupted, and narrow-screen states.

### Task 6: Backup, pilot data, and end-to-end verification

**Files:** Create backup service/routes, Soto Dine sample seed, E2E tests, and operating documentation.

- [ ] Implement backup manifest, hashes, export, validation, and restore.
- [ ] Add optional `REQ-DINE-001` pilot data without modifying the Soto Dine repository.
- [ ] Verify the full manual workflow, approval and rejection paths, interrupted runs, worktree isolation, and backup restore.
- [ ] Run typecheck, unit/integration tests, production build, Playwright desktop/mobile screenshots, and canvas/pixel nonblank checks where applicable.
- [ ] Document environment variables, startup, data locations, backup, and Soto Dine onboarding.
