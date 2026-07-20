import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface TrustedSubprocessOptions {
  timeoutMs: number;
  termGraceMs: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

export interface TrustedSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
}

export function runTrustedSubprocess(
  file: string,
  args: string[],
  options: TrustedSubprocessOptions
): Promise<TrustedSubprocessResult> {
  validateInput(file, args, options);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputOverflow = false;
    let terminating = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, options.termGraceMs);
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = options.maxOutputBytes - capturedBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        capturedBytes = options.maxOutputBytes;
        outputOverflow = true;
        terminate();
        return;
      }
      target.push(chunk);
      capturedBytes += chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: timedOut || outputOverflow ? -1 : code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputOverflow
      });
    });
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, options.timeoutMs - options.termGraceMs));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

function validateInput(file: string, args: string[], options: TrustedSubprocessOptions) {
  if (!isAbsolute(file) || file.includes("\0") || !Array.isArray(args)
    || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || !Number.isSafeInteger(options.termGraceMs) || options.termGraceMs < 0
    || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0
    || (options.cwd !== undefined && (!isAbsolute(options.cwd) || options.cwd.includes("\0")))) {
    throw new Error("TRUSTED_SUBPROCESS_INPUT_INVALID");
  }
}
