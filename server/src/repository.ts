import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const protectedBranches=new Set(["prod","production","main","master"]);

export function isProtectedBranch(branch:string){return protectedBranches.has(branch.toLowerCase());}

export async function getLocalBranches(repoPath:string){
  const [{stdout:currentOutput},{stdout:branchesOutput}]=await Promise.all([
    execFileAsync("git",["-C",repoPath,"branch","--show-current"]),
    execFileAsync("git",["-C",repoPath,"branch","--format=%(refname:short)"])
  ]);
  const currentBranch=currentOutput.trim();
  const names=branchesOutput.split("\n").map(item=>item.trim()).filter(Boolean).sort((a,b)=>a.localeCompare(b));
  return {currentBranch,branches:names.map(name=>({name,current:name===currentBranch,protected:isProtectedBranch(name)}))};
}

export async function validateRepository(repoPath: string) {
  try {
    const [actualPath, { stdout }] = await Promise.all([
      realpath(resolve(repoPath)),
      execFileAsync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"])
    ]);
    return await realpath(stdout.trim()) === actualPath;
  } catch {
    return false;
  }
}

export async function createIsolatedWorktree(repoPath: string, defaultBranch: string, requirementCode: string, runId: string) {
  const root = resolve(repoPath, "..", ".ai-workflow-worktrees", basename(repoPath));
  await mkdir(root, { recursive: true });
  const branch = `ai/${requirementCode.toLowerCase()}-${runId.slice(0, 8)}`;
  const worktreePath = resolve(root, branch.replaceAll("/", "-"));
  await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath, defaultBranch]);
  return { branch, worktreePath };
}

export async function getWorktreeDiff(worktreePath: string) {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function getWorktreeSnapshot(worktreePath: string) {
  const { stdout: tracked } = await execFileAsync("git", ["-C", worktreePath, "diff", "--", "."], { maxBuffer: 10 * 1024 * 1024 });
  const { stdout: status } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain", "-z"], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any });
  const entries = Buffer.from(status as any).toString("utf8").split("\0").filter(Boolean);
  const { stdout: untrackedOutput } = await execFileAsync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: 2 * 1024 * 1024, encoding: "buffer" as any });
  const untracked = Buffer.from(untrackedOutput as any).toString("utf8").split("\0").filter(Boolean);
  const trackedFiles = entries.filter((entry) => !entry.startsWith("?? ")).map((entry) => entry.slice(3)).filter(Boolean);
  const files = [...new Set([...trackedFiles, ...untracked])];
  const patches: string[] = [tracked];
  for (const file of untracked) {
    const content = await readFile(resolve(worktreePath, file), "utf8");
    const lines = content.split("\n");
    patches.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
  }
  const diff = patches.filter(Boolean).join("\n");
  const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return { diff, files, additions, deletions };
}
