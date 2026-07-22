import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { safeReadWorktreeFileBuffer } from "./worktree-file-safety.js";

const execFileAsync = promisify(execFile);
export const MAX_EVIDENCE_TOTAL_BYTES = 32 * 1024 * 1024;

export interface EvidenceOptions {
  sensitivePatterns?: string[];
  maxTotalBytes?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}

function evidenceGitOptions(
  env: NodeJS.ProcessEnv,
  options: EvidenceOptions,
  extra: Record<string, unknown> = {}
) {
  const execution: Record<string, unknown> = { env, ...extra };
  if (options.signal) execution.signal = options.signal;
  if (options.deadlineAt !== undefined) {
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("CODING_EVIDENCE_DEADLINE_EXCEEDED");
    execution.timeout = remaining;
  }
  return execution;
}

export type EvidenceManifestEntry =
  | { path: string; type: "file"; mode: "100644" | "100755"; size: number; sha256: string; contentBase64: string }
  | { path: string; type: "symlink"; mode: "120000"; target: string; sha256: string };

export interface EvidenceManifest {
  version: 1;
  entries: EvidenceManifestEntry[];
}

export interface WorktreeEvidenceIdentity {
  repositoryPath: string;
  gitCommonDir: string;
  worktreePath: string;
  branch: string;
  headCommit: string;
}

export type EvidenceChangedFile =
  | { path: string; status: "deleted" }
  | { path: string; status: "added" | "modified"; kind: "text"; content: string }
  | { path: string; status: "added" | "modified"; kind: "binary"; size: number; sha256: string };

export async function captureWorktreeEvidence(
  worktreePath: string,
  env: NodeJS.ProcessEnv,
  options: EvidenceOptions = {}
) {
  const sensitivePatterns = options.sensitivePatterns ?? [];
  const maxTotalBytes = evidenceByteLimit(options.maxTotalBytes);
  const identity = await readEvidenceIdentity(worktreePath, env, options);
  const ignored = await readIgnoredPaths(identity.worktreePath, env, options);
  const [rawBaseEntries, rawFinalEntries] = await Promise.all([
    readHeadManifest(identity, env, sensitivePatterns, maxTotalBytes, options),
    readFilesystemManifest(identity.worktreePath, ignored, sensitivePatterns, maxTotalBytes)
  ]);
  const identityAfter = await readEvidenceIdentity(worktreePath, env, options);
  if (JSON.stringify(identityAfter) !== JSON.stringify(identity)) throw new Error("CODING_EVIDENCE_IDENTITY_CHANGED");
  return buildEvidenceSnapshot(identity, rawBaseEntries, rawFinalEntries, env, sensitivePatterns, maxTotalBytes, options);
}

export async function captureCommitEvidence(
  worktreePath: string,
  commit: string,
  env: NodeJS.ProcessEnv,
  options: EvidenceOptions = {}
) {
  const sensitivePatterns = options.sensitivePatterns ?? [];
  const maxTotalBytes = evidenceByteLimit(options.maxTotalBytes);
  const currentIdentity = await readEvidenceIdentity(worktreePath, env, options);
  const { stdout } = await execFileAsync("git", [
    "-C", currentIdentity.worktreePath, "rev-list", "--parents", "-n", "1", `${commit}^{commit}`
  ], evidenceGitOptions(env, options));
  const commits = stdout.trim().split(/\s+/).filter(Boolean);
  if (commits.length !== 2 || currentIdentity.headCommit !== commits[0]) {
    throw new Error("CODING_EVIDENCE_COMMIT_UNSUPPORTED");
  }
  const [rawBaseEntries, rawFinalEntries] = await Promise.all([
    readTreeManifest(currentIdentity, commits[1]!, env, sensitivePatterns, maxTotalBytes, options),
    readTreeManifest(currentIdentity, commits[0]!, env, sensitivePatterns, maxTotalBytes, options)
  ]);
  const identityAfter = await readEvidenceIdentity(worktreePath, env, options);
  if (JSON.stringify(identityAfter) !== JSON.stringify(currentIdentity)) {
    throw new Error("CODING_EVIDENCE_IDENTITY_CHANGED");
  }
  return buildEvidenceSnapshot(
    { ...currentIdentity, headCommit: commits[1]! }, rawBaseEntries, rawFinalEntries, env,
    sensitivePatterns, maxTotalBytes, options
  );
}

async function buildEvidenceSnapshot(
  identity: WorktreeEvidenceIdentity,
  rawBaseEntries: EvidenceManifestEntry[],
  rawFinalEntries: EvidenceManifestEntry[],
  env: NodeJS.ProcessEnv,
  sensitivePatterns: string[],
  maxTotalBytes: number,
  options: EvidenceOptions
) {
  const baseEntries = excludeSensitiveClosure(rawBaseEntries, sensitivePatterns);
  const finalEntries = excludeSensitiveClosure(rawFinalEntries, sensitivePatterns);
  const manifest: EvidenceManifest = { version: 1, entries: finalEntries };
  const manifestHash = hashCanonical(manifest);
  const diff = await buildSafeEvidenceDiff(baseEntries, finalEntries, env, options);
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const finalByPath = new Map(finalEntries.map((entry) => [entry.path, entry]));
  const files = [...new Set([...baseByPath.keys(), ...finalByPath.keys()])]
    .filter((path) => !sameManifestEntry(baseByPath.get(path), finalByPath.get(path))).sort();
  const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const changedFiles = files.map((file) => {
    const before = baseByPath.get(file);
    const entry = finalByPath.get(file);
    if (!entry) return { path: file, status: "deleted" as const };
    const status = before ? "modified" as const : "added" as const;
    if (entry.type === "symlink") return { path: file, status, kind: "text" as const, content: entry.target };
    const content = Buffer.from(entry.contentBase64, "base64");
    const text = decodeText(content);
    if (text !== undefined) return { path: file, status, kind: "text" as const, content: text };
    return { path: file, status, kind: "binary" as const, size: entry.size, sha256: entry.sha256 };
  });
  const evidenceHash = evidenceFingerprint({ identity, manifestHash, diff, changedFiles });
  assertEvidenceSize({ identity, manifest, diff, changedFiles }, maxTotalBytes);
  return { diff, files, changedFiles, additions, deletions, identity, manifest, manifestHash, evidenceHash };
}

async function readEvidenceIdentity(
  worktreePath: string,
  env: NodeJS.ProcessEnv,
  options: EvidenceOptions
): Promise<WorktreeEvidenceIdentity> {
  const canonicalWorktree = await realpath(resolve(worktreePath));
  const [{ stdout: topLevel }, { stdout: common }, branch] = await Promise.all([
    execFileAsync("git", ["-C", canonicalWorktree, "rev-parse", "--show-toplevel"], evidenceGitOptions(env, options)),
    execFileAsync("git", ["-C", canonicalWorktree, "rev-parse", "--git-common-dir"], evidenceGitOptions(env, options)),
    readEvidenceBranch(canonicalWorktree, env, options)
  ]);
  if (await realpath(resolve(canonicalWorktree, topLevel.trim())) !== canonicalWorktree) {
    throw new Error("CODING_EVIDENCE_REPOSITORY_MISMATCH");
  }
  let headCommit = "";
  try {
    headCommit = (await execFileAsync("git", ["-C", canonicalWorktree, "rev-parse", "--verify", "--quiet", "HEAD"],
      evidenceGitOptions(env, options))).stdout.trim();
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown };
    if (failure.code !== 1 || failure.signal) throw error;
  }
  const gitCommonDir = await realpath(resolve(canonicalWorktree, common.trim()));
  return {
    repositoryPath: resolve(gitCommonDir, ".."), gitCommonDir, worktreePath: canonicalWorktree,
    branch, headCommit
  };
}

async function readEvidenceBranch(worktreePath: string, env: NodeJS.ProcessEnv, options: EvidenceOptions) {
  try {
    return (await execFileAsync("git", ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      ...evidenceGitOptions(env, options)
    })).stdout.trim();
  } catch (error) {
    if ((error as { code?: unknown; signal?: unknown }).code === 1 && !(error as { signal?: unknown }).signal) {
      return "HEAD";
    }
    throw error;
  }
}

async function readIgnoredPaths(worktreePath: string, env: NodeJS.ProcessEnv, options: EvidenceOptions) {
  const { stdout } = await execFileAsync("git", [
    "-C", worktreePath, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"
  ], evidenceGitOptions(env, options, { encoding: "buffer" as any, maxBuffer: 10 * 1024 * 1024 }) as any);
  return new Set(Buffer.from(stdout as any).toString("utf8").split("\0").filter(Boolean)
    .map((path) => path.endsWith("/") ? path.slice(0, -1) : path));
}

async function readFilesystemManifest(
  root: string,
  ignored: Set<string>,
  sensitivePatterns: string[],
  maxTotalBytes: number
): Promise<EvidenceManifestEntry[]> {
  const entries: EvidenceManifestEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (isExcludedEvidencePath(path, ignored) || matchesSensitivePath(path, sensitivePatterns)) continue;
      const absolute = join(root, ...path.split("/"));
      const stat = await lstat(absolute);
      if (stat.isDirectory()) { await visit(absolute, path); continue; }
      if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > maxTotalBytes) throw new Error("CODING_EVIDENCE_SIZE_LIMIT");
        const content = await safeReadWorktreeFileBuffer(root, path);
        entries.push({
          path, type: "file", mode: stat.mode & 0o111 ? "100755" : "100644",
          size: content.length, sha256: sha256(content), contentBase64: content.toString("base64")
        });
        continue;
      }
      if (!stat.isSymbolicLink()) throw new Error("CODING_FILE_PATH_UNSAFE");
      const target = await readlink(absolute);
      totalBytes += Buffer.byteLength(target);
      if (totalBytes > maxTotalBytes) throw new Error("CODING_EVIDENCE_SIZE_LIMIT");
      if (isAbsolute(target)) throw new Error("CODING_FILE_PATH_UNSAFE");
      const lexicalTarget = resolve(absolute, "..", target);
      const targetPath = relative(root, lexicalTarget).split(sep).join("/");
      if (!isInsidePath(root, lexicalTarget) || isExcludedEvidencePath(targetPath, ignored)) {
        throw new Error("CODING_FILE_PATH_UNSAFE");
      }
      const canonicalTarget = await realpath(lexicalTarget).catch(() => "");
      if (!canonicalTarget || !isInsidePath(root, canonicalTarget)) throw new Error("CODING_FILE_PATH_UNSAFE");
      const targetEntry = await lstat(canonicalTarget);
      if (!targetEntry.isDirectory() && !targetEntry.isFile()) throw new Error("CODING_FILE_PATH_UNSAFE");
      entries.push({ path, type: "symlink", mode: "120000", target, sha256: sha256(Buffer.from(target)) });
    }
  };
  await visit(root, "");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function readHeadManifest(
  identity: WorktreeEvidenceIdentity,
  env: NodeJS.ProcessEnv,
  sensitivePatterns: string[],
  maxTotalBytes: number,
  options: EvidenceOptions
): Promise<EvidenceManifestEntry[]> {
  if (!identity.headCommit) return [];
  return readTreeManifest(identity, identity.headCommit, env, sensitivePatterns, maxTotalBytes, options);
}

async function readTreeManifest(
  identity: WorktreeEvidenceIdentity,
  commit: string,
  env: NodeJS.ProcessEnv,
  sensitivePatterns: string[],
  maxTotalBytes: number,
  options: EvidenceOptions
): Promise<EvidenceManifestEntry[]> {
  const { stdout } = await execFileAsync("git", [
    "-C", identity.worktreePath, "ls-tree", "-r", "-z", "--full-tree", commit
  ], evidenceGitOptions(env, options, { encoding: "buffer" as any, maxBuffer: 10 * 1024 * 1024 }) as any);
  const entries: EvidenceManifestEntry[] = [];
  let totalBytes = 0;
  for (const record of Buffer.from(stdout as any).toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== "blob") throw new Error("CODING_EVIDENCE_GIT_TREE_UNSUPPORTED");
    const [, mode, , objectId, path] = match;
    if (matchesSensitivePath(path!, sensitivePatterns)) continue;
    const output = await execFileAsync("git", ["-C", identity.worktreePath, "cat-file", "blob", objectId!], {
      ...evidenceGitOptions(env, options, { encoding: "buffer" as any, maxBuffer: 10 * 1024 * 1024 })
    } as any);
    const content = Buffer.from(output.stdout as any);
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) throw new Error("CODING_EVIDENCE_SIZE_LIMIT");
    if (mode === "120000") {
      const target = content.toString("utf8");
      entries.push({ path: path!, type: "symlink", mode: "120000", target, sha256: sha256(content) });
    } else if (mode === "100644" || mode === "100755") {
      entries.push({
        path: path!, type: "file", mode, size: content.length,
        sha256: sha256(content), contentBase64: content.toString("base64")
      });
    } else {
      throw new Error("CODING_EVIDENCE_GIT_TREE_UNSUPPORTED");
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function buildSafeEvidenceDiff(
  before: EvidenceManifestEntry[], after: EvidenceManifestEntry[], env: NodeJS.ProcessEnv,
  options: EvidenceOptions
) {
  const root = await mkdtemp(join(tmpdir(), "ai-workflow-evidence-diff-"));
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=evidence", "--template=", root],
      evidenceGitOptions(env, options));
    await mkdir(join(root, ".git", "info"), { recursive: true });
    const binaryPaths = [...before, ...after].filter((entry) => entry.type === "file"
      && decodeText(Buffer.from(entry.contentBase64, "base64")) === undefined).map((entry) => entry.path);
    const attributes = ["* -filter !diff !text !working-tree-encoding", ...new Set(binaryPaths)]
      .map((line) => line.includes(" -filter ") ? line : `${JSON.stringify(line)} -diff -text`).join("\n");
    await writeFile(join(root, ".git", "info", "attributes"), `${attributes}\n`);
    await materializeEvidenceManifest(root, { version: 1, entries: before });
    await execFileAsync("git", ["-C", root, "add", "--all", "--force"], evidenceGitOptions(env, options));
    await execFileAsync("git", ["-C", root, "-c", "user.name=Evidence", "-c", "user.email=evidence@invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "--allow-empty", "-m", "base"],
      evidenceGitOptions(env, options));
    for (const child of await readdir(root)) if (child !== ".git") await rm(join(root, child), { recursive: true, force: true });
    await materializeEvidenceManifest(root, { version: 1, entries: after });
    await execFileAsync("git", ["-C", root, "add", "--all", "--force"], evidenceGitOptions(env, options));
    const { stdout } = await execFileAsync("git", ["-C", root, "diff", "--cached", "--binary", "--full-index",
      "--no-ext-diff", "--no-textconv", "HEAD", "--", "."],
      evidenceGitOptions(env, options, { maxBuffer: 10 * 1024 * 1024 }));
    const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
    const binaryDetails = after.flatMap((entry) => {
      if (entry.type !== "file" || decodeText(Buffer.from(entry.contentBase64, "base64")) !== undefined
        || sameManifestEntry(entry, beforeByPath.get(entry.path))) return [];
        const prefix = beforeByPath.has(entry.path) ? `a/${entry.path}` : "/dev/null";
        return [`Binary files ${prefix} and b/${entry.path} differ\nbinary-size: ${entry.size}\nbinary-sha256: ${entry.sha256}\n`];
      }).join("");
    return [stdout, binaryDetails].filter(Boolean).join("\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function materializeEvidenceManifest(
  root: string,
  manifest: EvidenceManifest,
  options: EvidenceOptions = {}
) {
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
  if (excludeSensitiveClosure(manifest.entries, options.sensitivePatterns ?? []).length !== manifest.entries.length) {
    throw new Error("CODING_EVIDENCE_MANIFEST_SENSITIVE");
  }
  assertEvidenceSize(manifest, evidenceByteLimit(options.maxTotalBytes));
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || !safeManifestPath(entry.path) || paths.has(entry.path)) {
      throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
    }
    paths.add(entry.path);
  }
  for (const entry of manifest.entries) {
    if (entry.type === "symlink") {
      if (entry.mode !== "120000" || typeof entry.target !== "string" || isAbsolute(entry.target)) {
        throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
      }
      const targetPath = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (!safeManifestPath(targetPath) || (!paths.has(targetPath)
        && ![...paths].some((path) => path.startsWith(`${targetPath}/`)))
        || sha256(Buffer.from(entry.target)) !== entry.sha256) {
        throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
      }
    } else if (entry.type !== "file" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
    }
  }
  await mkdir(root, { recursive: true });
  for (const entry of manifest.entries) {
    const target = join(root, ...entry.path.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    if (entry.type === "symlink") await symlink(entry.target, target);
    else {
      const content = Buffer.from(entry.contentBase64, "base64");
      if (content.length !== entry.size || sha256(content) !== entry.sha256) throw new Error("CODING_EVIDENCE_MANIFEST_INVALID");
      await writeFile(target, content);
      await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

function safeManifestPath(path: string) {
  return path.length > 0 && path === posix.normalize(path) && !posix.isAbsolute(path)
    && path !== ".." && !path.startsWith("../")
    && !path.split("/").some((segment) => segment.toLowerCase() === ".git");
}

function sameManifestEntry(first: EvidenceManifestEntry | undefined, second: EvidenceManifestEntry | undefined) {
  return first !== undefined && second !== undefined && JSON.stringify(first) === JSON.stringify(second);
}

function isExcludedEvidencePath(path: string, ignored: Set<string>) {
  const segments = path.split("/");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return true;
  return [...ignored].some((item) => path === item || path.startsWith(`${item}/`));
}

function isInsidePath(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function decodeText(content: Buffer) {
  if (content.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
  catch { return undefined; }
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function evidenceByteLimit(requested: number | undefined) {
  if (requested === undefined) return MAX_EVIDENCE_TOTAL_BYTES;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("CODING_EVIDENCE_SIZE_LIMIT_INVALID");
  return Math.min(requested, MAX_EVIDENCE_TOTAL_BYTES);
}

function assertEvidenceSize(value: unknown, maxTotalBytes: number) {
  if (Buffer.byteLength(JSON.stringify(value)) > maxTotalBytes) throw new Error("CODING_EVIDENCE_SIZE_LIMIT");
}

export function hashCanonical(value: unknown) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

export function evidenceManifestHash(manifest: EvidenceManifest) {
  return hashCanonical(manifest);
}

export function evidenceFingerprint(input: {
  identity: WorktreeEvidenceIdentity;
  manifestHash: string;
  diff: string;
  changedFiles: EvidenceChangedFile[];
}) {
  return hashCanonical({ version: 1, ...input });
}

function excludeSensitiveClosure(entries: EvidenceManifestEntry[], patterns: string[]) {
  if (patterns.length === 0) return entries;
  const excluded = new Set(entries.filter((entry) => matchesSensitivePath(entry.path, patterns))
    .map((entry) => entry.path));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (entry.type !== "symlink" || excluded.has(entry.path)) continue;
      const targetPath = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (matchesSensitivePath(targetPath, patterns) || excluded.has(targetPath)) {
        excluded.add(entry.path);
        changed = true;
      }
    }
  }
  return entries.filter((entry) => !excluded.has(entry.path));
}

function globMatches(pattern: string, path: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0")
    .replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\0", ".*");
  return new RegExp(`^(?:${escaped})$`).test(path) || new RegExp(`(?:^|/)${escaped}$`).test(path);
}

export function matchesSensitivePath(path: string, patterns: string[]) {
  return patterns.some((pattern) => globMatches(pattern, path));
}
