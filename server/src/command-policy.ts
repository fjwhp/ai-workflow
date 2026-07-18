import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

const blocked = new Set(["rm", "sudo", "sh", "bash", "zsh"]);

export function isAllowedCommand(command: string, args: string[], allowed: { command: string; argsPrefix?: string[] }[]) {
  if (blocked.has(command) || args.some((arg) => arg.includes("--force") || arg === "reset")) return false;
  return allowed.some((rule) => rule.command === command && (rule.argsPrefix ?? []).every((part, i) => args[i] === part));
}

export async function runCommand(cwd: string, command: string, args: string[]) {
  const safeCwd = await realpath(cwd);
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: safeCwd, shell: false, env: { ...process.env, FORCE_COLOR: "0" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
