import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const MAX_SAFE_FILE_BYTES = 10 * 1024 * 1024;
const UNSAFE_PATH = "CODING_FILE_PATH_UNSAFE";
const NOT_TEXT = "CODING_FILE_NOT_TEXT";

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

function unsafePath(): never {
  throw new Error(UNSAFE_PATH);
}

function isContainedPath(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalRoot(worktree: string) {
  const root = await realpath(resolve(worktree)).catch(unsafePath);
  const entry = await lstat(root).catch(unsafePath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) unsafePath();
  return root;
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
      if (!createMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") unsafePath();
      try { await mkdir(current); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") unsafePath();
      }
      entry = await lstat(current).catch(unsafePath);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) unsafePath();
    const canonical = await realpath(current).catch(() => "");
    if (!canonical || !isContainedPath(root, canonical)) unsafePath();
  }
}

async function regularFileEntry(target: string, allowMissing = false) {
  let entry;
  try { entry = await lstat(target); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    unsafePath();
  }
  if (entry.isSymbolicLink() || !entry.isFile()) unsafePath();
  return entry;
}

async function verifyOpenRegularFile(
  root: string,
  target: string,
  handle: Awaited<ReturnType<typeof open>>,
  enforceReadLimit: boolean
) {
  await safeParentPath(root, target, false);
  const [entry, opened, canonicalTarget] = await Promise.all([
    lstat(target).catch(() => null),
    handle.stat().catch(() => null),
    realpath(target).catch(() => "")
  ]);
  if (!entry || !opened || entry.isSymbolicLink() || !entry.isFile() || !opened.isFile()
    || entry.dev !== opened.dev || entry.ino !== opened.ino
    || (enforceReadLimit && opened.size > MAX_SAFE_FILE_BYTES)
    || !canonicalTarget || !isContainedPath(root, canonicalTarget)) {
    unsafePath();
  }
}

export async function safeReadWorktreeFileBuffer(worktree: string, requested: string) {
  const root = await canonicalRoot(worktree);
  const target = resolveWorktreePath(root, requested);
  await safeParentPath(root, target, false);
  await regularFileEntry(target);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(target, flags).catch(unsafePath);
  try {
    await verifyOpenRegularFile(root, target, handle, true);
    return await handle.readFile().catch(unsafePath);
  } finally {
    await handle.close();
  }
}

export async function safeReadWorktreeFile(worktree: string, requested: string) {
  const content = await safeReadWorktreeFileBuffer(worktree, requested);
  if (content.includes(0)) throw new Error(NOT_TEXT);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
  catch { throw new Error(NOT_TEXT); }
}

export async function safeWriteWorktreeFile(worktree: string, requested: string, content: string) {
  const root = await canonicalRoot(worktree);
  const target = resolveWorktreePath(root, requested);
  await safeParentPath(root, target, true);
  const exists = await regularFileEntry(target, true) !== null;
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    | (exists ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(target, flags, 0o666).catch(unsafePath);
  try {
    await verifyOpenRegularFile(root, target, handle, false);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
