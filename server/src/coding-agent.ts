import OpenAI from "openai";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { posix } from "node:path";
import {
  cleanupCodingAttemptWorktree,
  createCodingAttemptWorktree,
  createOrReuseRequirementWorktree,
  getWorktreeSnapshot,
  publishCodingAttemptDiff
} from "./repository.js";
import {
  captureImplementationPatchSync,
  inspectImplementationChangedPathsSync,
  type ImplementationChangedPath
} from "./implementation-publication.js";
import { resolveWorktreePath, safeReadWorktreeFile, safeWriteWorktreeFile } from "./worktree-file-safety.js";
import { evidenceFingerprint, matchesSensitivePath, type EvidenceChangedFile, type EvidenceManifest } from "./evidence-tree.js";

export { resolveWorktreePath } from "./worktree-file-safety.js";

const execFileAsync = promisify(execFile);

export type CodingProject = { id: string; repoPath: string; defaultBranch: string; allowedCommands: { command: string; argsPrefix?: string[] }[] };
export type CodingVersion = { id: string; projectId: string; branch: string; worktreePath: string; status: "active" | "closed"; headCommit?: string };
export interface CodingDeliveryContext {
  deliveryUnitId: string;
  requirementId: string;
  evidenceVersion: number;
  moduleIds: string[];
  acceptanceCriteria: string[];
  sensitivePatterns: string[];
  allowedCommands: { command: string; argsPrefix?: string[] }[];
  projectKnowledgeVersionId: string | null;
}
export interface CodingAgentInput {
  requirement: any;
  artifacts: any[];
  project: CodingProject;
  version: CodingVersion;
  deliveryContext: CodingDeliveryContext;
  attemptWorkspace?: {
    branch: string;
    worktreePath: string;
    baseCommit: string;
    reused: false;
  };
}
export interface CodingAgentResult {
  runId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  reused: boolean;
  summary: string;
  diff: string;
  commands: readonly [];
  files: string[];
  additions: number;
  deletions: number;
  diagnostics?: string[] | string;
  codexThreadId?: string;
  events?: unknown[];
  evidenceSnapshot: Awaited<ReturnType<typeof getWorktreeSnapshot>>;
}

export async function prepareCodingWorktree(project: CodingProject, version: CodingVersion, requirementCode: string) {
  if (version.projectId !== project.id) throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
  if (version.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
  return createOrReuseRequirementWorktree(project.repoPath, version.branch, requirementCode, version.headCommit);
}

export async function prepareDeliveryImplementationAttempt(input: CodingAgentInput, signal?: AbortSignal) {
  throwIfCodingAborted(signal);
  const authoritative = await prepareCodingWorktree(input.project, input.version, input.requirement.code);
  const workspace = await createCodingAttemptWorktree(
    input.project.repoPath,
    input.version.headCommit ?? authoritative.baseCommit,
    signal
  );
  let publication: Awaited<ReturnType<typeof publishCodingAttemptDiff>> | undefined;
  return {
    workspace,
    async preparePublication(result: CodingAgentResult, publishSignal?: AbortSignal) {
      throwIfCodingAborted(publishSignal);
      validateAttemptResult(result, workspace);
      const before = inspectImplementationChangedPathsSync(workspace.worktreePath);
      assertPublishableChangedPaths(before, input.deliveryContext.sensitivePatterns);
      let captured: Awaited<ReturnType<typeof getWorktreeSnapshot>>;
      try {
        captured = await getWorktreeSnapshot(workspace.worktreePath);
      } catch (error) {
        if (error instanceof Error && error.message === "CODING_EVIDENCE_SIZE_LIMIT") {
          throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES", { cause: error });
        }
        throw error;
      }
      assertPublicationEvidenceMatches(before, captured.changedFiles, captured.manifest);
      const patch = captureImplementationPatchSync(workspace.worktreePath);
      const after = inspectImplementationChangedPathsSync(workspace.worktreePath);
      if (JSON.stringify(after) !== JSON.stringify(before)
        || !captureImplementationPatchSync(workspace.worktreePath).equals(patch)) {
        throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
      }
      const identity = {
        ...captured.identity,
        worktreePath: authoritative.worktreePath,
        branch: authoritative.branch,
        headCommit: authoritative.baseCommit
      };
      const evidenceSnapshot = {
        ...captured,
        identity,
        evidenceHash: evidenceFingerprint({
          identity,
          manifestHash: captured.manifestHash,
          diff: captured.diff,
          changedFiles: captured.changedFiles
        })
      };
      return {
        result: {
          ...result,
          branch: authoritative.branch,
          worktreePath: authoritative.worktreePath,
          baseCommit: authoritative.baseCommit,
          diff: captured.diff,
          files: captured.files,
          additions: captured.additions,
          deletions: captured.deletions,
          evidenceSnapshot
        },
        input: {
          repoPath: input.project.repoPath,
          authoritativeWorktreePath: authoritative.worktreePath,
          attemptPath: workspace.worktreePath,
          attemptDev: workspace.attemptIdentity.dev,
          attemptIno: workspace.attemptIdentity.ino,
          attemptUid: workspace.attemptIdentity.uid,
          attemptNonce: workspace.attemptIdentity.nonce,
          patch
        }
      };
    },
    async publish(result: CodingAgentResult, publishSignal?: AbortSignal) {
      throwIfCodingAborted(publishSignal);
      validateAttemptResult(result, workspace);
      publication = await publishCodingAttemptDiff({
        repoPath: input.project.repoPath,
        authoritativeWorktreePath: authoritative.worktreePath,
        baseCommit: authoritative.baseCommit,
        diff: result.evidenceSnapshot.diff,
        signal: publishSignal
      });
      try {
        throwIfCodingAborted(publishSignal);
      } catch (error) {
        await publication.rollback();
        throw error;
      }
      return {
        ...result,
        branch: authoritative.branch,
        worktreePath: authoritative.worktreePath,
        baseCommit: authoritative.baseCommit,
        diff: publication.snapshot.diff,
        files: publication.snapshot.files,
        additions: publication.snapshot.additions,
        deletions: publication.snapshot.deletions,
        evidenceSnapshot: publication.snapshot
      };
    },
    async rollback() {
      await publication?.rollback();
    },
    async cleanup() {
      await publication?.discard();
      await cleanupCodingAttemptWorktree(input.project.repoPath, workspace.worktreePath);
    }
  };
}

function assertPublishableChangedPaths(changes: ImplementationChangedPath[], sensitivePatterns: string[]) {
  if (changes.some((change) => change.ignored
    || matchesSensitivePath(change.path, sensitivePatterns)
    || matchesSensitivePath(`${change.path}/__flowgate_probe__`, sensitivePatterns))) {
    throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
  }
}

function assertPublicationEvidenceMatches(
  changes: ImplementationChangedPath[],
  changedFiles: EvidenceChangedFile[],
  manifest: EvidenceManifest
) {
  const expected = changes.map(({ path, status }) => ({ path, status }));
  const actual = changedFiles.map(({ path, status }) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
  }
  const manifestByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const changed of changedFiles) {
    const entry = manifestByPath.get(changed.path);
    if (changed.status === "deleted") {
      if (entry) throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
      continue;
    }
    if (!entry) throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
    const hash = changed.kind === "binary" ? changed.sha256
      : createHash("sha256").update(changed.content).digest("hex");
    if (hash !== entry.sha256) throw new Error("IMPLEMENTATION_UNPUBLISHABLE_CHANGES");
  }
}

function validateAttemptResult(
  result: CodingAgentResult,
  workspace: Awaited<ReturnType<typeof createCodingAttemptWorktree>>
) {
  if (result.worktreePath !== workspace.worktreePath || result.baseCommit !== workspace.baseCommit
    || result.evidenceSnapshot.identity.worktreePath !== workspace.worktreePath
    || result.evidenceSnapshot.identity.headCommit !== workspace.baseCommit) {
    throw new Error("IMPLEMENTATION_ATTEMPT_IDENTITY_MISMATCH");
  }
}

export async function runCodingAgent(input: CodingAgentInput, signal?: AbortSignal): Promise<CodingAgentResult> {
  throwIfCodingAborted(signal);
  if (!process.env.OPENAI_API_KEY) throw new Error("未配置 OPENAI_API_KEY");
  if (process.env.OPENAI_API_MODE !== "chat") throw new Error("编码代理当前要求 OPENAI_API_MODE=chat");
  const runId = crypto.randomUUID();
  const worktree = input.attemptWorkspace
    ?? await prepareCodingWorktree(input.project, input.version, input.requirement.code);
  throwIfCodingAborted(signal);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  const tools: any[] = [
    tool("search_code", "在仓库中搜索文本", { query: { type: "string" } }, ["query"]),
    tool("read_file", "读取仓库相对路径文件", { path: { type: "string" } }, ["path"]),
    tool("write_file", "写入仓库相对路径文件的完整内容", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    tool("git_diff", "读取当前未提交差异", {}, [])
  ];
  const messages: any[] = [{ role: "system", content: "你是谨慎的编码代理。先搜索和读取相关代码，再做最小修改。实现节点不执行构建、测试或其他项目命令；冻结的验证命令由后续独立自动化测试节点执行。不得修改需求范围，不得提交、合并或推送。完成后总结变更和残余风险，不得声称已运行测试。" }, {
    role: "user", content: JSON.stringify({
      requirement: input.requirement,
      approvedArtifacts: input.artifacts,
      deliveryContext: input.deliveryContext
    })
  }];

  for (let round = 0; round < 16; round++) {
    const response = await client.chat.completions.create(
      { model: process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL!, messages, tools, tool_choice: "auto" },
      { signal }
    );
    throwIfCodingAborted(signal);
    const message: any = response.choices[0]?.message;
    if (!message) throw new Error("编码模型未返回消息");
    messages.push(message);
    if (!message.tool_calls?.length) {
      const snapshot = await getWorktreeSnapshot(worktree.worktreePath, {
        sensitivePatterns: input.deliveryContext.sensitivePatterns
      });
      throwIfCodingAborted(signal);
      return {
        ...worktree, diff: snapshot.diff, files: snapshot.files, additions: snapshot.additions,
        deletions: snapshot.deletions, evidenceSnapshot: snapshot,
        runId, summary: message.content || "编码代理已完成", commands: []
      };
    }
    for (const call of message.tool_calls) {
      let result: unknown;
      try {
        result = await executeTool(call.function.name, JSON.parse(call.function.arguments || "{}"),
          worktree.worktreePath, input.deliveryContext.sensitivePatterns, signal);
      }
      catch (error) {
        throwIfCodingAborted(signal);
        result = { error: error instanceof Error ? error.message : "工具执行失败" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("编码代理超过最大工具调用轮次");
}

function tool(name: string, description: string, properties: any, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

async function executeTool(
  name: string,
  args: any,
  worktree: string,
  sensitivePatterns: string[],
  signal?: AbortSignal
) {
  throwIfCodingAborted(signal);
  if (name === "search_code") {
    const exclusions = sensitivePatterns.flatMap((pattern) => ["-g", `!${pattern}`]);
    const { stdout } = await execFileAsync("rg", ["-n", "--hidden", "-g", "!.git", "-g", "!target",
      ...exclusions, "-F", "--", String(args.query), "."], {
      cwd: worktree, maxBuffer: 1024 * 1024, signal
    });
    throwIfCodingAborted(signal);
    return stdout.split("\n").slice(0, 120).join("\n");
  }
  const requestedPath = typeof args.path === "string" ? posix.normalize(args.path.replaceAll("\\", "/")) : "";
  if ((name === "read_file" || name === "write_file") && matchesSensitivePath(requestedPath, sensitivePatterns)) {
    throw new Error("CODING_FILE_PATH_SENSITIVE");
  }
  if (name === "read_file") {
    const content = await safeReadWorktreeFile(worktree, String(args.path));
    throwIfCodingAborted(signal);
    return content.slice(0, 60000);
  }
  if (name === "write_file") {
    await safeWriteWorktreeFile(worktree, String(args.path), String(args.content));
    throwIfCodingAborted(signal);
    return { written: args.path };
  }
  if (name === "git_diff") {
    const snapshot = await getWorktreeSnapshot(worktree, { sensitivePatterns });
    throwIfCodingAborted(signal);
    return snapshot.diff.slice(0, 80000);
  }
  throw new Error("未知工具");
}

function throwIfCodingAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("DELIVERY_IMPLEMENTATION_ABORTED");
}
