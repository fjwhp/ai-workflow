import OpenAI from "openai";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createOrReuseRequirementWorktree, getWorktreeDiff, getWorktreeSnapshot } from "./repository.js";

const execFileAsync = promisify(execFile);

export function resolveWorktreePath(worktree: string, requested: string) {
  if (isAbsolute(requested)) throw new Error("文件路径必须位于工作区内");
  const target = resolve(worktree, requested);
  const rel = relative(resolve(worktree), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("文件路径必须位于工作区内");
  const containsGitMetadata = rel.split(sep).some((segment) =>
    segment.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === ".git");
  if (containsGitMetadata) throw new Error("禁止访问工作区 Git 元数据");
  return target;
}

function isContainedPath(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function safeParentPath(root: string, target: string, createMissing: boolean) {
  const parentRelative = relative(root, resolve(target, ".."));
  const segments = parentRelative ? parentRelative.split(sep) : [];
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (!createMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CODING_FILE_PATH_UNSAFE");
      try { await mkdir(current); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("CODING_FILE_PATH_UNSAFE");
      }
      try { entry = await lstat(current); }
      catch { throw new Error("CODING_FILE_PATH_UNSAFE"); }
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("CODING_FILE_PATH_UNSAFE");
    const canonical = await realpath(current).catch(() => "");
    if (!canonical || !isContainedPath(root, canonical)) throw new Error("CODING_FILE_PATH_UNSAFE");
  }
}

async function verifyOpenRegularFile(root: string, target: string, handle: Awaited<ReturnType<typeof open>>) {
  await safeParentPath(root, target, false);
  const [entry, opened, canonicalTarget] = await Promise.all([
    lstat(target).catch(() => null),
    handle.stat().catch(() => null),
    realpath(target).catch(() => "")
  ]);
  if (!entry || !opened || entry.isSymbolicLink() || !entry.isFile() || !opened.isFile()
    || entry.dev !== opened.dev || entry.ino !== opened.ino
    || !canonicalTarget || !isContainedPath(root, canonicalTarget)) {
    throw new Error("CODING_FILE_PATH_UNSAFE");
  }
}

async function safeReadWorktreeFile(worktree: string, requested: string) {
  const root = await realpath(resolve(worktree));
  const target = resolveWorktreePath(root, requested);
  await safeParentPath(root, target, false);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .catch(() => { throw new Error("CODING_FILE_PATH_UNSAFE"); });
  try {
    await verifyOpenRegularFile(root, target, handle);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function safeWriteWorktreeFile(worktree: string, requested: string, content: string) {
  const root = await realpath(resolve(worktree));
  const target = resolveWorktreePath(root, requested);
  await safeParentPath(root, target, true);
  let exists = true;
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("CODING_FILE_PATH_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else throw error instanceof Error && error.message === "CODING_FILE_PATH_UNSAFE"
      ? error : new Error("CODING_FILE_PATH_UNSAFE");
  }
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    | (exists ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(target, flags, 0o666).catch(() => { throw new Error("CODING_FILE_PATH_UNSAFE"); });
  try {
    await verifyOpenRegularFile(root, target, handle);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

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
}

export async function prepareCodingWorktree(project: CodingProject, version: CodingVersion, requirementCode: string) {
  if (version.projectId !== project.id) throw new Error("REQUIREMENT_VERSION_PROJECT_MISMATCH");
  if (version.status !== "active") throw new Error("PROJECT_VERSION_NOT_ACTIVE");
  return createOrReuseRequirementWorktree(project.repoPath, version.branch, requirementCode, version.headCommit);
}

export async function runCodingAgent(input: CodingAgentInput): Promise<CodingAgentResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error("未配置 OPENAI_API_KEY");
  if (process.env.OPENAI_API_MODE !== "chat") throw new Error("编码代理当前要求 OPENAI_API_MODE=chat");
  const runId = crypto.randomUUID();
  const worktree = await prepareCodingWorktree(input.project, input.version, input.requirement.code);
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
    const response = await client.chat.completions.create({ model: process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL!, messages, tools, tool_choice: "auto" });
    const message: any = response.choices[0]?.message;
    if (!message) throw new Error("编码模型未返回消息");
    messages.push(message);
    if (!message.tool_calls?.length) {
      const snapshot = await getWorktreeSnapshot(worktree.worktreePath);
      return { ...worktree, ...snapshot, runId, summary: message.content || "编码代理已完成", commands: [] };
    }
    for (const call of message.tool_calls) {
      let result: unknown;
      try { result = await executeTool(call.function.name, JSON.parse(call.function.arguments || "{}"), worktree.worktreePath); }
      catch (error) { result = { error: error instanceof Error ? error.message : "工具执行失败" }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("编码代理超过最大工具调用轮次");
}

function tool(name: string, description: string, properties: any, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

async function executeTool(name: string, args: any, worktree: string) {
  if (name === "search_code") {
    const { stdout } = await execFileAsync("rg", ["-n", "--hidden", "-g", "!.git", "-g", "!target", "-F", "--", String(args.query), "."], { cwd: worktree, maxBuffer: 1024 * 1024 });
    return stdout.split("\n").slice(0, 120).join("\n");
  }
  if (name === "read_file") return (await safeReadWorktreeFile(worktree, String(args.path))).slice(0, 60000);
  if (name === "write_file") {
    await safeWriteWorktreeFile(worktree, String(args.path), String(args.content));
    return { written: args.path };
  }
  if (name === "git_diff") return (await getWorktreeDiff(worktree)).slice(0, 80000);
  throw new Error("未知工具");
}
