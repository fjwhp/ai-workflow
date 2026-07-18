import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { getWorktreeSnapshot } from "./repository.js";
import { hashDiff } from "./coding-evidence.js";
import { buildVerificationPlan, type VerificationCommand } from "./verification-plan.js";

const execFileAsync = promisify(execFile);
type Input = { repoPath: string; defaultBranch: string; worktreePath: string; sourceBranch: string; evidenceDiffHash: string; sourceCommit?: string; changedFiles?: string[]; fallbackCommands?: VerificationCommand[] };
type Check = { id: string; label: string; ok: boolean; detail: string };

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
}

async function getCommitEvidence(worktreePath: string, commit: string) {
  const parent = `${commit}^`;
  const tracked = (await git(worktreePath, ["diff", "--diff-filter=MD", parent, commit, "--", "."])).stdout;
  const addedOutput = await execFileAsync("git", ["-C", worktreePath, "diff", "--name-only", "--diff-filter=A", "-z", parent, commit, "--", "."], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any });
  const added = Buffer.from(addedOutput.stdout as any).toString("utf8").split("\0").filter(Boolean);
  const patches: string[] = [tracked];
  for (const file of added) {
    const content = (await git(worktreePath, ["show", `${commit}:${file}`])).stdout;
    const lines = content.split("\n");
    patches.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
  }
  return { diff: patches.filter(Boolean).join("\n"), files: [...new Set([...added, ...(await git(worktreePath, ["diff", "--name-only", "--diff-filter=MD", parent, commit, "--", "."])).stdout.trim().split("\n").filter(Boolean)])] };
}

export async function preflightLocalIntegration(input: Input) {
  const checks: Check[] = [];
  let evidenceMode: "worktree" | "commit" | undefined;
  let resolvedSourceCommit: string | undefined;
  try {
    const repoRoot = (await git(input.repoPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    checks.push({ id: "target_repo", label: "目标仓库有效", ok: await realpath(repoRoot) === await realpath(input.repoPath), detail: repoRoot });
  } catch { checks.push({ id: "target_repo", label: "目标仓库有效", ok: false, detail: "目标仓库不存在或不可访问" }); }
  try {
    const branch = (await git(input.repoPath, ["branch", "--show-current"])).stdout.trim();
    checks.push({ id: "target_branch", label: "目标分支正确", ok: branch === input.defaultBranch, detail: branch || "游离 HEAD" });
    const status = (await git(input.repoPath, ["status", "--porcelain"])).stdout;
    checks.push({ id: "target_clean", label: "目标工作树干净", ok: status.length === 0, detail: status || "没有本地修改" });
  } catch { checks.push({ id: "target_branch", label: "目标分支正确", ok: false, detail: "无法读取目标分支" }); }
  try {
    const branch = (await git(input.worktreePath, ["branch", "--show-current"])).stdout.trim();
    checks.push({ id: "source_branch", label: "AI 分支匹配", ok: branch === input.sourceBranch, detail: branch || "游离 HEAD" });
    if (input.sourceCommit) {
      const commit = (await git(input.worktreePath, ["rev-parse", "--verify", `${input.sourceCommit}^{commit}`])).stdout.trim();
      await git(input.worktreePath, ["merge-base", "--is-ancestor", commit, input.sourceBranch]);
      const evidence = await getCommitEvidence(input.worktreePath, commit);
      const patchHash = hashDiff(evidence.diff);
      checks.push({ id: "source_changes", label: "存在待合并变更", ok: evidence.files.length > 0 && evidence.diff.length > 0, detail: `${evidence.files.length} 个文件（已提交）` });
      checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: patchHash === input.evidenceDiffHash, detail: patchHash.slice(0, 12) });
      evidenceMode = "commit";
      resolvedSourceCommit = commit;
    } else {
      const snapshot = await getWorktreeSnapshot(input.worktreePath);
      checks.push({ id: "source_changes", label: "存在待合并变更", ok: snapshot.files.length > 0 && snapshot.diff.length > 0, detail: `${snapshot.files.length} 个文件` });
      checks.push({ id: "evidence_valid", label: "编码证据仍有效", ok: hashDiff(snapshot.diff) === input.evidenceDiffHash, detail: hashDiff(snapshot.diff).slice(0, 12) });
      evidenceMode = "worktree";
    }
  } catch { checks.push({ id: "source_branch", label: "AI 分支匹配", ok: false, detail: "AI worktree 不存在或不可访问" }); }
  const plan=input.changedFiles?await buildVerificationPlan({repoPath:input.repoPath,changedFiles:input.changedFiles,fallbackCommands:input.fallbackCommands||[]}):{changedModules:[],plannedCommands:input.fallbackCommands||[],commandSource:"project_fallback" as const};
  if(input.changedFiles)checks.push({id:"verification_plan",label:"自动测试计划",ok:plan.plannedCommands.length>0,detail:plan.plannedCommands.length?`${plan.plannedCommands.length} 条命令`:"未识别到安全测试命令"});
  return { allowed: checks.length >= 6 && checks.every((entry) => entry.ok), checks, ...plan, evidenceMode, sourceCommit: resolvedSourceCommit, sourceBranch: input.sourceBranch, targetBranch: input.defaultBranch, worktreePath: input.worktreePath, repoPath: input.repoPath };
}

export async function executeLocalIntegration(input: Input & { commitMessage: string; commands: VerificationCommand[] }) {
  const preflight = await preflightLocalIntegration({...input,fallbackCommands:input.fallbackCommands||input.commands});
  if (!preflight.allowed) return { status: "failed" as const, preflight, error: "应用预检未通过", commandResults: [] };
  let sourceCommit: string | undefined = preflight.sourceCommit;
  const targetCommit = (await git(input.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  try {
    if (!sourceCommit) {
      await git(input.worktreePath, ["add", "--all"]);
      await git(input.worktreePath, ["commit", "-m", input.commitMessage]);
      sourceCommit = (await git(input.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    }
    await git(input.repoPath, ["cherry-pick", "--no-commit", sourceCommit]);
  } catch (error: any) {
    let conflictFiles: string[] = [];
    try { conflictFiles = (await git(input.repoPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean); } catch { /* Preserve the original error. */ }
    try { await git(input.repoPath, ["cherry-pick", "--abort"]); } catch { /* No active cherry-pick. */ }
    await git(input.repoPath, ["reset", "--hard", targetCommit]);
    return { status: "conflict" as const, preflight, sourceCommit, conflictFiles, error: String(error?.stderr || error?.message || error), commandResults: [] };
  }
  const commandResults: any[] = [];
  const commands=input.changedFiles?preflight.plannedCommands:input.commands;
  for (const item of commands) {
    try {
      const result = await execFileAsync(item.command, item.argsPrefix, { cwd: input.repoPath, maxBuffer: 10 * 1024 * 1024 });
      commandResults.push({ command: item.command, args: item.argsPrefix, code: 0, stdout: result.stdout, stderr: result.stderr });
    } catch (error: any) {
      commandResults.push({ command: item.command, args: item.argsPrefix, code: error?.code ?? 1, stdout: error?.stdout || "", stderr: error?.stderr || error?.message || "" });
      return { status: "test_failed" as const, preflight, sourceCommit, targetCommit, commandResults, error: "本地应用后测试失败" };
    }
  }
  return { status: "completed" as const, preflight, sourceCommit, targetCommit, commandResults, error: null };
}

export async function rerunIntegrationTests(repoPath: string, commands: { command: string; argsPrefix: string[] }[]) {
  const commandResults: any[] = [];
  for (const item of commands) {
    try { const result = await execFileAsync(item.command, item.argsPrefix, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }); commandResults.push({ command: item.command, args: item.argsPrefix, code: 0, stdout: result.stdout, stderr: result.stderr }); }
    catch (error: any) { commandResults.push({ command: item.command, args: item.argsPrefix, code: error?.code ?? 1, stdout: error?.stdout || "", stderr: error?.stderr || error?.message || "" }); return { status: "test_failed" as const, commandResults }; }
  }
  return { status: "completed" as const, commandResults };
}
