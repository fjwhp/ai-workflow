import { randomUUID } from "node:crypto";
import { projectVersionInputSchema } from "@ai-workflow/shared";
import type { FastifyInstance } from "fastify";
import {
  createProjectVersionWorktree,
  inspectProjectVersion,
  inspectVersionWorktree
} from "./project-version-service.js";
import { cleanupFailedManagedWorktreeCreation, withRepoWorktreeMutationLock } from "./repository.js";
import type { WorkflowStore } from "./store.js";

type RouteOptions = { store: WorkflowStore };

const badRequestCodes = new Set([
  "PROJECT_VERSION_BRANCH_INVALID",
  "PROJECT_VERSION_BASE_BRANCH_INVALID",
  "PROJECT_VERSION_BASE_BRANCH_NOT_FOUND",
  "PROJECT_VERSION_REPOSITORY_INVALID",
  "PROJECT_VERSION_ID_INVALID",
  "PROJECT_VERSION_PATH_ESCAPE"
]);

const conflictCodes = new Set([
  "PROJECT_ARCHIVED",
  "PROJECT_NOT_ACTIVE",
  "PROJECT_VERSION_NOT_ACTIVE",
  "PROJECT_VERSION_NAME_EXISTS",
  "PROJECT_VERSION_BRANCH_EXISTS",
  "PROJECT_VERSION_WORKTREE_EXISTS",
  "PROJECT_VERSION_BRANCH_IN_USE",
  "PROJECT_VERSION_PATH_IN_USE",
  "PROJECT_VERSION_REUSE_NOT_CONFIRMED",
  "PROJECT_VERSION_WORKTREE_MISMATCH",
  "PROJECT_VERSION_WORKTREE_IDENTITY_MISMATCH",
  "PROJECT_VERSION_MODE_MISMATCH",
  "PROJECT_VERSION_WORKTREE_CREATE_FAILED",
  "PROJECT_VERSION_WORKTREE_POSTCONDITION_FAILED",
  "PROJECT_VERSION_GIT_UNAVAILABLE",
  "PROJECT_VERSION_PERSISTENCE_FAILED",
  "PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS",
  "PROJECT_VERSION_WORKTREE_INVALID",
  "PROJECT_VERSION_WORKTREE_DIRTY"
]);

function errorCode(error: unknown, fallback = "PROJECT_VERSION_OPERATION_FAILED") {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : fallback;
}

function sendError(reply: any, error: unknown, details?: unknown) {
  const internalCode = errorCode(error);
  const code = internalCode === "PROJECT_NOT_ACTIVE" ? "PROJECT_ARCHIVED" : internalCode;
  if (code === "PROJECT_NOT_FOUND" || code === "PROJECT_VERSION_NOT_FOUND") {
    return reply.code(404).send({ error: code, ...(details === undefined ? {} : { details }) });
  }
  if (badRequestCodes.has(code)) {
    return reply.code(400).send({ error: code, ...(details === undefined ? {} : { details }) });
  }
  if (conflictCodes.has(code)) {
    return reply.code(409).send({ error: code, ...(details === undefined ? {} : { details }) });
  }
  return reply.code(409).send({
    error: "PROJECT_VERSION_OPERATION_FAILED",
    ...(details === undefined ? {} : { details })
  });
}

function routeId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireProject(store: WorkflowStore, projectId: string, active: boolean) {
  const project = store.getProject(projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (active && project.status !== "active") throw new Error("PROJECT_ARCHIVED");
  return project;
}

function requireVersion(store: WorkflowStore, versionId: string) {
  const version = store.getProjectVersion(versionId);
  if (!version) throw new Error("PROJECT_VERSION_NOT_FOUND");
  return version;
}

function ensureNoDuplicate(store: WorkflowStore, projectId: string, name: string, branch: string) {
  const versions = store.listProjectVersions(projectId, "all");
  if (versions.some((version) => version.name === name)) throw new Error("PROJECT_VERSION_NAME_EXISTS");
  if (versions.some((version) => version.branch === branch)) throw new Error("PROJECT_VERSION_BRANCH_EXISTS");
}

async function rollbackCreatedGitState(input: {
  repoPath: string;
  branch: string;
  worktreePath: string;
  expectedBranchHead?: string;
  createdBranch: boolean;
  createdWorktree: boolean;
}) {
  if (!input.createdBranch && !input.createdWorktree) return;
  await withRepoWorktreeMutationLock(input.repoPath, async () => {
    await cleanupFailedManagedWorktreeCreation({
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      branch: input.branch,
      ownedHead: input.createdBranch ? input.expectedBranchHead : undefined,
      targetReserved: input.createdWorktree,
      worktreeAddAttempted: input.createdWorktree,
      worktreeAdded: input.createdWorktree,
      requireClean: true
    });
  });
}

export async function registerProjectVersionRoutes(app: FastifyInstance, { store }: RouteOptions) {
  app.get("/api/projects/:projectId/versions", async (request: any, reply) => {
    const projectId = routeId(request.params?.projectId);
    if (!projectId) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    const status = request.query?.status ?? "active";
    if (typeof status !== "string" || !["active", "closed", "all"].includes(status)) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", message: "Invalid project version status" });
    }
    try {
      requireProject(store, projectId, false);
      return store.listProjectVersions(projectId, status as "active" | "closed" | "all");
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/versions/validate", async (request: any, reply) => {
    const projectId = routeId(request.params?.projectId);
    if (!projectId) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    const parsed = projectVersionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
    }
    try {
      const project = requireProject(store, projectId, true);
      ensureNoDuplicate(store, projectId, parsed.data.name, parsed.data.branch);
      return await inspectProjectVersion({ repoPath: project.repoPath, ...parsed.data });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/versions", async (request: any, reply) => {
    const projectId = routeId(request.params?.projectId);
    if (!projectId) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    const parsed = projectVersionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
    }
    try {
      const project = requireProject(store, projectId, true);
      ensureNoDuplicate(store, projectId, parsed.data.name, parsed.data.branch);
      const inspection = await inspectProjectVersion({ repoPath: project.repoPath, ...parsed.data });
      if (!inspection.valid || !inspection.mode) throw new Error("PROJECT_VERSION_MODE_MISMATCH");
      const versionId = randomUUID();
      const created = await createProjectVersionWorktree({
        repoPath: project.repoPath,
        versionId,
        branch: parsed.data.branch,
        baseBranch: parsed.data.baseBranch,
        mode: inspection.mode,
        existingWorktreePath: inspection.existingWorktreePath,
        reuseExistingWorktree: parsed.data.reuseExistingWorktree
      });
      try {
        const version = store.createProjectVersion({
          id: versionId,
          projectId,
          name: parsed.data.name,
          branch: parsed.data.branch,
          baseBranch: parsed.data.baseBranch,
          worktreePath: created.worktreePath,
          headCommit: created.headCommit
        });
        return reply.code(201).send(version);
      } catch (persistenceError) {
        try {
          await rollbackCreatedGitState({
            repoPath: project.repoPath,
            branch: parsed.data.branch,
            worktreePath: created.worktreePath,
            expectedBranchHead: created.createdBranchHead,
            createdBranch: created.createdBranch,
            createdWorktree: created.createdWorktree
          });
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, persistenceError }, "Project version persistence rollback failed");
        }
        const candidate = errorCode(persistenceError, "");
        const code = badRequestCodes.has(candidate) || conflictCodes.has(candidate) ||
          candidate === "PROJECT_NOT_FOUND" || candidate === "PROJECT_VERSION_NOT_FOUND"
          ? candidate
          : "PROJECT_VERSION_PERSISTENCE_FAILED";
        throw new Error(code, { cause: persistenceError });
      }
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/project-versions/:id", async (request: any, reply) => {
    const id = routeId(request.params?.id);
    if (!id) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    try { return requireVersion(store, id); }
    catch (error) { return sendError(reply, error); }
  });

  app.post("/api/project-versions/:id/recheck", async (request: any, reply) => {
    const id = routeId(request.params?.id);
    if (!id) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    try {
      const version = requireVersion(store, id);
      if (version.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
      const project = requireProject(store, version.projectId, true);
      const inspection = await inspectVersionWorktree({
        repoPath: project.repoPath,
        worktreePath: version.worktreePath,
        branch: version.branch
      });
      if (!inspection.valid) {
        return sendError(reply, new Error("PROJECT_VERSION_WORKTREE_INVALID"), { status: inspection.status });
      }
      requireProject(store, version.projectId, true);
      const currentVersion = requireVersion(store, version.id);
      if (currentVersion.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
      const updated = store.updateProjectVersionHead(version.id, inspection.headCommit);
      if (!updated) {
        const latest = store.getProjectVersion(version.id);
        if (!latest) throw new Error("PROJECT_VERSION_NOT_FOUND");
        requireProject(store, latest.projectId, true);
        if (latest.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
        throw new Error("PROJECT_VERSION_OPERATION_FAILED");
      }
      return { version: updated, inspection };
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/project-versions/:id/close", async (request: any, reply) => {
    const id = routeId(request.params?.id);
    if (!id) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    try {
      const version = requireVersion(store, id);
      if (version.status === "closed") return version;
      const project = requireProject(store, version.projectId, true);
      const inspection = await inspectVersionWorktree({
        repoPath: project.repoPath,
        worktreePath: version.worktreePath,
        branch: version.branch
      });
      if (!inspection.valid) {
        return sendError(reply, new Error("PROJECT_VERSION_WORKTREE_INVALID"), { status: inspection.status });
      }
      if (!inspection.clean) {
        return sendError(reply, new Error("PROJECT_VERSION_WORKTREE_DIRTY"), { status: inspection.status });
      }
      requireProject(store, version.projectId, true);
      return store.closeProjectVersion(version.id);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/project-versions/:id/requirements", async (request: any, reply) => {
    const id = routeId(request.params?.id);
    if (!id) return reply.code(400).send({ error: "VALIDATION_ERROR" });
    try {
      requireVersion(store, id);
      return store.listVersionRequirements(id);
    } catch (error) { return sendError(reply, error); }
  });
}
