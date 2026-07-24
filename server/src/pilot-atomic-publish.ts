import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PilotFilesystemIdentity {
  dev: number;
  ino: number;
  uid: number;
}

export interface AtomicPilotPublishOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  trustedRoot?: string;
  inspectPath?: typeof lstatSync;
  parentIdentity?: PilotFilesystemIdentity;
  sourceIdentity?: PilotFilesystemIdentity;
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
  const inspectPath = options.inspectPath ?? lstatSync;
  const parent = dirname(source);
  if (dirname(target) !== parent || resolve(parent, basename(source)) !== source
    || resolve(parent, basename(target)) !== target || basename(source) === basename(target)) {
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
  }
  const parentIdentity = options.parentIdentity ?? inspectPath(parent);
  const sourceIdentity = options.sourceIdentity ?? inspectPath(source);
  assertTrustedMoveIdentity(parent, source, parentIdentity, sourceIdentity, inspectPath);
  try {
    await (options.execute ?? execFileAsync)(helper, [
      parent,
      String(parentIdentity.dev),
      String(parentIdentity.ino),
      basename(source),
      String(sourceIdentity.dev),
      String(sourceIdentity.ino),
      basename(target)
    ], {
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

function assertTrustedMoveIdentity(
  parentPath: string,
  sourcePath: string,
  expectedParent: PilotFilesystemIdentity,
  expectedSource: PilotFilesystemIdentity,
  inspectPath: typeof lstatSync
) {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    const parent = inspectPath(parentPath);
    const source = inspectPath(sourcePath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid
      || (parent.mode & 0o022) !== 0 || parent.dev !== expectedParent.dev
      || parent.ino !== expectedParent.ino || parent.uid !== expectedParent.uid
      || !source.isDirectory() || source.isSymbolicLink() || source.uid !== uid
      || (source.mode & 0o777) !== 0o700 || source.dev !== expectedSource.dev
      || source.ino !== expectedSource.ino || source.uid !== expectedSource.uid) {
      throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_ATOMIC_PUBLISH_UNAVAILABLE") throw error;
    throw new Error("PILOT_ATOMIC_PUBLISH_UNAVAILABLE", { cause: error });
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
