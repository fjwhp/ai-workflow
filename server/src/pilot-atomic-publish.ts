import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AtomicPilotPublishOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  execute?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; windowsHide: boolean; shell: false }
  ) => Promise<unknown>;
}

export async function atomicPilotPublish(
  source: string,
  target: string,
  options: AtomicPilotPublishOptions = {}
) {
  validatePath(source);
  validatePath(target);
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
  }
  const helper = options.helperPath ?? resolve(import.meta.dirname, basename(import.meta.dirname) === "dist"
    ? "native/pilot-atomic-publish"
    : "../dist/native/pilot-atomic-publish");
  assertTrustedHelper(helper);
  try {
    await (options.execute ?? execFileAsync)(helper, [source, target], {
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
      shell: false
    });
  } catch (error: any) {
    if (error?.code === 10) throw new Error("PILOT_PUBLISH_CONFLICT", { cause: error });
    if (error?.code === 11 || error?.code === 64
      || error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "ENOEXEC") {
      throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE", { cause: error });
    }
    throw new Error("PILOT_PUBLISH_FAILED", { cause: error });
  }
}

function validatePath(path: string) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length === 0 || path.includes("\0")) {
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
  }
}

function assertTrustedHelper(path: string) {
  try {
    const stat = lstatSync(path);
    const getuid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0
      || (stat.mode & 0o022) !== 0 || (getuid !== undefined && stat.uid !== getuid)) {
      throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_ATOMIC_PUBLISH_UNAVAILABLE") throw error;
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE", { cause: error });
  }
}
