import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AtomicPilotPublishOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  trustedRoot?: string;
  inspectPath?: typeof lstatSync;
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
  const trustedRoot = options.trustedRoot ?? (options.helperPath
    ? resolve(helper, "..")
    : resolve(import.meta.dirname, ".."));
  assertTrustedHelper(helper, trustedRoot, options.inspectPath ?? lstatSync);
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

function assertTrustedHelper(path: string, trustedRoot: string, inspectPath: typeof lstatSync) {
  try {
    const root = resolve(trustedRoot);
    const helper = resolve(path);
    const pathFromRoot = relative(root, helper);
    if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)) {
      throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    const segments = pathFromRoot.split(sep);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const stat = inspectPath(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
        throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
      }
      current = resolve(current, segment);
    }
    const parent = inspectPath(current);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
      throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    }
    const stat = inspectPath(helper);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o111) === 0
      || (stat.mode & 0o022) !== 0) throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_ATOMIC_PUBLISH_UNAVAILABLE") throw error;
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE", { cause: error });
  }
}
