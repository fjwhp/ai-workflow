import OpenAI from "openai";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isAllowedCommand, runCommand } from "./command-policy.js";
import { createIsolatedWorktree, getWorktreeDiff } from "./repository.js";

const execFileAsync = promisify(execFile);

export function resolveWorktreePath(worktree: string, requested: string) {
  if (isAbsolute(requested)) throw new Error("文件路径必须位于工作区内");
  const target = resolve(worktree, requested);
  const rel = relative(resolve(worktree), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("文件路径必须位于工作区内");
  return target;
}

type CodingProject = { id: string; repoPath: string; defaultBranch: string; allowedCommands: { command: string; argsPrefix?: string[] }[] };

export async function runCodingAgent(input: { requirement: any; artifacts: any[]; project: CodingProject }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("未配置 OPENAI_API_KEY");
  if (process.env.OPENAI_API_MODE !== "chat") throw new Error("编码代理当前要求 OPENAI_API_MODE=chat");
  const runId = crypto.randomUUID();
  const worktree = await createIsolatedWorktree(input.project.repoPath, input.project.defaultBranch, input.requirement.code, runId);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  const commands: any[] = [];
  const tools: any[] = [
    tool("search_code", "在仓库中搜索文本", { query: { type: "string" } }, ["query"]),
    tool("read_file", "读取仓库相对路径文件", { path: { type: "string" } }, ["path"]),
    tool("write_file", "写入仓库相对路径文件的完整内容", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    tool("run_command", "运行项目白名单中的验证命令", { command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, ["command", "args"]),
    tool("git_diff", "读取当前未提交差异", {}, [])
  ];
  const messages: any[] = [{ role: "system", content: "你是谨慎的 Java 编码代理。先搜索和读取相关代码，再做最小修改并运行允许的测试。不得修改需求范围，不得提交、合并或推送。完成后总结变更、测试和残余风险。" }, {
    role: "user", content: JSON.stringify({ requirement: input.requirement, approvedArtifacts: input.artifacts })
  }];

  for (let round = 0; round < 16; round++) {
    const response = await client.chat.completions.create({ model: process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL!, messages, tools, tool_choice: "auto" });
    const message: any = response.choices[0]?.message;
    if (!message) throw new Error("编码模型未返回消息");
    messages.push(message);
    if (!message.tool_calls?.length) {
      const diff = await getWorktreeDiff(worktree.worktreePath);
      return { ...worktree, runId, summary: message.content || "编码代理已完成", diff, commands };
    }
    for (const call of message.tool_calls) {
      let result: unknown;
      try { result = await executeTool(call.function.name, JSON.parse(call.function.arguments || "{}"), worktree.worktreePath, input.project.allowedCommands, commands); }
      catch (error) { result = { error: error instanceof Error ? error.message : "工具执行失败" }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("编码代理超过最大工具调用轮次");
}

function tool(name: string, description: string, properties: any, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

async function executeTool(name: string, args: any, worktree: string, allowed: CodingProject["allowedCommands"], commands: any[]) {
  if (name === "search_code") {
    const { stdout } = await execFileAsync("rg", ["-n", "--hidden", "-g", "!.git", "-g", "!target", "-F", String(args.query), "."], { cwd: worktree, maxBuffer: 1024 * 1024 });
    return stdout.split("\n").slice(0, 120).join("\n");
  }
  if (name === "read_file") return (await readFile(resolveWorktreePath(worktree, String(args.path)), "utf8")).slice(0, 60000);
  if (name === "write_file") {
    const target = resolveWorktreePath(worktree, String(args.path));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, String(args.content), "utf8");
    return { written: args.path };
  }
  if (name === "run_command") {
    const command = String(args.command), commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    if (!isAllowedCommand(command, commandArgs, allowed)) throw new Error("命令不在项目白名单中");
    const result = await runCommand(worktree, command, commandArgs);
    commands.push({ command, args: commandArgs, ...result });
    return { ...result, stdout: result.stdout.slice(-20000), stderr: result.stderr.slice(-20000) };
  }
  if (name === "git_diff") return (await getWorktreeDiff(worktree)).slice(0, 80000);
  throw new Error("未知工具");
}
