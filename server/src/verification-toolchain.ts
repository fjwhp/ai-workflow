import { constants, createReadStream } from "node:fs";
import {
  access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, symlink
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface VerificationToolchainManifestEntry {
  path: string;
  type: "file" | "symlink";
  mode: number;
  size: number;
  sha256: string;
  target?: string;
}

export interface VerificationToolchainSnapshot {
  root: string;
  fingerprint: string;
  binDirectory: string;
  commands: Array<{
    id: string;
    configuredCommand: string;
    file: string;
    args: string[];
  }>;
  manifest: VerificationToolchainManifestEntry[];
}

interface ToolchainLimits {
  maxFiles: number;
  maxDirectories: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface SnapshotOptions {
  env?: NodeJS.ProcessEnv;
  limits?: Partial<ToolchainLimits>;
  afterCopy?: () => Promise<void>;
}

interface SourceEntry extends VerificationToolchainManifestEntry {
  sourcePath: string;
}

interface SourcePlan {
  entries: SourceEntry[];
  directories: string[];
  commands: Array<{
    id: string;
    configuredCommand: string;
    file: string;
    args: string[];
  }>;
}

const DEFAULT_LIMITS: ToolchainLimits = {
  maxFiles: 20_000,
  maxDirectories: 5_000,
  maxDepth: 32,
  maxFileBytes: 160 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
};
const MAX_SHEBANG_BYTES = 4096;
const TOOLCHAIN_HELPER_INPUT_BYTES = 1024 * 1024;
const TOOLCHAIN_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;

interface BoundedSnapshotOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface BoundedSnapshotDependencies {
  runSubprocess?: (
    file: string,
    args: string[],
    options: {
      timeoutMs: number; termGraceMs: number; maxOutputBytes: number; input: string; signal?: AbortSignal;
    }
  ) => Promise<{
    exitCode: number; stdout: string; stderr: string; timedOut: boolean; outputOverflow: boolean;
  }>;
}

export async function snapshotVerificationToolchainBounded(
  commands: Array<{ id: string; command: string; args: string[] }>,
  verificationRoot: string,
  options: BoundedSnapshotOptions,
  dependencies: BoundedSnapshotDependencies = {}
): Promise<VerificationToolchainSnapshot> {
  if (options.signal?.aborted) throw new Error("AUTOMATED_TEST_ABORTED");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("AUTOMATED_TEST_DEADLINE_EXCEEDED");
  }
  const input = JSON.stringify({
    commands, verificationRoot, env: { PATH: options.env?.PATH ?? process.env.PATH ?? "" }
  });
  if (Buffer.byteLength(input) > TOOLCHAIN_HELPER_INPUT_BYTES) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  }
  const runSubprocess = dependencies.runSubprocess
    ?? (await import("./trusted-subprocess.js")).runTrustedSubprocess;
  let result: Awaited<ReturnType<NonNullable<BoundedSnapshotDependencies["runSubprocess"]>>>;
  try {
    result = await runSubprocess(process.execPath, [
      "--input-type=commonjs", "--eval", verificationToolchainChildSource,
      await verificationToolchainModuleUrl()
    ], {
      timeoutMs: options.timeoutMs,
      termGraceMs: Math.min(250, Math.max(0, options.timeoutMs - 1)),
      maxOutputBytes: TOOLCHAIN_HELPER_OUTPUT_BYTES,
      input,
      signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted
      || (error instanceof Error && error.message === "TRUSTED_SUBPROCESS_ABORTED")) {
      throw new Error("AUTOMATED_TEST_ABORTED", { cause: error });
    }
    throw error;
  }
  if (result.timedOut) throw new Error("AUTOMATED_TEST_DEADLINE_EXCEEDED");
  if (result.outputOverflow) throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  if (result.exitCode !== 0) {
    const code = result.stderr.trim();
    if (/^AUTOMATED_TEST_TOOLCHAIN_(?:INVALID|CHANGED|LIMIT_EXCEEDED)$/.test(code)) {
      throw new Error(code);
    }
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED");
  }
  let snapshot: unknown;
  try { snapshot = JSON.parse(result.stdout); }
  catch (error) { throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED", { cause: error }); }
  return validateBoundedSnapshot(snapshot, commands, verificationRoot);
}

async function verificationToolchainModuleUrl() {
  const compiled = new URL("./verification-toolchain.js", import.meta.url);
  try {
    await access(fileURLToPath(compiled));
    return compiled.href;
  } catch {
    return new URL("./verification-toolchain.ts", import.meta.url).href;
  }
}

function validateBoundedSnapshot(
  value: unknown,
  commands: Array<{ id: string; command: string; args: string[] }>,
  verificationRoot: string
): VerificationToolchainSnapshot {
  const snapshot = value as VerificationToolchainSnapshot;
  if (!snapshot || typeof snapshot !== "object" || !/^[0-9a-f]{64}$/.test(snapshot.fingerprint)
    || snapshot.root !== join(resolve(verificationRoot), ".toolchain", snapshot.fingerprint)
    || snapshot.binDirectory !== join(snapshot.root, "bin")
    || !Array.isArray(snapshot.commands) || snapshot.commands.length !== commands.length
    || !Array.isArray(snapshot.manifest)) throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED");
  const paths = new Set<string>();
  const commandPaths: string[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const expected = commands[index]!;
    const actual = snapshot.commands[index];
    const prefixLength = actual && Array.isArray(actual.args)
      ? actual.args.length - expected.args.length : -1;
    if (!actual || actual.id !== expected.id || actual.configuredCommand !== expected.command
      || !isSnapshotPath(actual.file, snapshot.root) || !Array.isArray(actual.args)
      || actual.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
      || prefixLength < 0 || prefixLength > 1
      || expected.args.some((argument, argumentIndex) => actual.args[prefixLength + argumentIndex] !== argument)
      || (prefixLength === 1 && !isSnapshotPath(actual.args[0]!, snapshot.root))) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED");
    }
    commandPaths.push(actual.file);
    if (prefixLength === 1) commandPaths.push(actual.args[0]!);
  }
  for (const entry of snapshot.manifest) {
    if (!entry || typeof entry.path !== "string" || paths.has(entry.path)
      || isAbsolute(entry.path) || entry.path === ".." || entry.path.startsWith("../")
      || (entry.type !== "file" && entry.type !== "symlink")
      || !Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || (entry.type === "symlink" && typeof entry.target !== "string")) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED");
    }
    paths.add(entry.path);
  }
  if (commandPaths.some((path) => !paths.has(snapshotManifestPath(path, snapshot.root)))) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_FAILED");
  }
  return snapshot;
}

function isSnapshotPath(path: string, root: string) {
  return typeof path === "string" && isAbsolute(path)
    && (path === root || path.startsWith(`${root}${sep}`));
}

function snapshotManifestPath(path: string, root: string) {
  return relative(root, path).split(sep).join("/");
}

function verificationToolchainChildMain() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) process.exit(70);
    chunks.push(chunk);
  });
  process.stdin.on("end", async () => {
    try {
      const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!config || !Array.isArray(config.commands) || typeof config.verificationRoot !== "string"
        || !config.env || typeof config.env.PATH !== "string") throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
      const loadModule = new Function("specifier", "return import(specifier)");
      const module = await loadModule(process.argv[1]!);
      const snapshot = await module.snapshotVerificationToolchain(
        config.commands, config.verificationRoot, { env: config.env }
      );
      process.stdout.write(JSON.stringify(snapshot));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : "AUTOMATED_TEST_TOOLCHAIN_FAILED");
      process.exitCode = 1;
    }
  });
}

const verificationToolchainChildSource = `(${verificationToolchainChildMain.toString()})()`;

export async function snapshotVerificationToolchain(
  commands: Array<{ id: string; command: string; args: string[] }>,
  verificationRoot: string,
  options: SnapshotOptions = {}
): Promise<VerificationToolchainSnapshot> {
  const limits = toolchainLimits(options.limits);
  const env = options.env ?? process.env;
  const canonicalVerificationRoot = resolve(verificationRoot);
  const source = await buildSourcePlan(commands, env, limits);
  const identity = sourceIdentity(source);
  const fingerprint = sha256(Buffer.from(identity));
  const root = join(canonicalVerificationRoot, ".toolchain", fingerprint);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const directory of source.directories) await mkdir(join(root, ...directory.split("/")), { recursive: true, mode: 0o700 });
  for (const entry of source.entries) await copySourceEntry(entry, root);
  await options.afterCopy?.();

  const sourceAfter = await buildSourcePlan(commands, env, limits);
  if (sourceIdentity(sourceAfter) !== identity) throw new Error("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
  await verifySnapshotEntries(source.entries, root);
  await makeSnapshotReadOnly(root, source.directories, source.entries);
  const manifest = source.entries.map(({ sourcePath: _sourcePath, ...entry }) => ({
    ...entry,
    mode: entry.type === "file" ? entry.mode & 0o555 : 0o555
  }));
  await verifyManifest(manifest, root);

  return {
    root,
    fingerprint,
    binDirectory: join(root, "bin"),
    commands: source.commands.map((command) => ({
      ...command,
      file: join(root, ...command.file.split("/")),
      args: command.args.map((argument) => argument.startsWith("toolchain:")
        ? join(root, ...argument.slice("toolchain:".length).split("/"))
        : argument)
    })),
    manifest
  };
}

async function buildSourcePlan(
  commands: Array<{ id: string; command: string; args: string[] }>,
  env: NodeJS.ProcessEnv,
  limits: ToolchainLimits
): Promise<SourcePlan> {
  if (!Array.isArray(commands) || commands.length < 1) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  const entries = new Map<string, SourceEntry>();
  const directories = new Set<string>(["bin", "packages"]);
  const planned = [] as SourcePlan["commands"];
  for (const command of commands) {
    if (!command || typeof command.id !== "string" || typeof command.command !== "string"
      || !Array.isArray(command.args) || command.args.some((argument) => typeof argument !== "string")) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    }
    const entrypoint = await resolveExecutable(command.command, env);
    const shebang = await readShebang(entrypoint);
    if (shebang) {
      const interpreter = await resolveShebangInterpreter(shebang, env);
      const interpreterPath = await addStandaloneFile(interpreter, "bin", entries, directories, limits);
      const packageRoot = await nearestPackageRoot(entrypoint);
      const scriptPath = packageRoot
        ? await addPackage(packageRoot, entrypoint, entries, directories, limits)
        : await addStandaloneFile(entrypoint, "scripts", entries, directories, limits);
      planned.push({
        id: command.id, configuredCommand: command.command, file: interpreterPath,
        args: [`toolchain:${scriptPath}`, ...command.args]
      });
    } else {
      const executablePath = await addStandaloneFile(entrypoint, "bin", entries, directories, limits);
      planned.push({
        id: command.id, configuredCommand: command.command, file: executablePath, args: [...command.args]
      });
    }
  }
  const sortedEntries = [...entries.values()].sort((first, second) => first.path.localeCompare(second.path));
  enforceClosureLimits(sortedEntries, directories, limits);
  return { entries: sortedEntries, directories: [...directories].sort(), commands: planned };
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv) {
  if (!command || command.includes("\0") || /[\r\n]/.test(command)) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  }
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/")
      ? []
      : String(env.PATH ?? "").split(":").filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      const status = await lstat(canonical);
      if (!status.isFile()) continue;
      return canonical;
    } catch {}
  }
  throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
}

async function readShebang(path: string) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SHEBANG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) return null;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 || newline > MAX_SHEBANG_BYTES) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    const line = buffer.subarray(2, newline).toString("utf8").trim();
    if (!line || line.includes("\0")) throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    return line.split(/\s+/);
  } finally {
    await handle.close();
  }
}

async function resolveShebangInterpreter(parts: string[], env: NodeJS.ProcessEnv) {
  if (parts.length === 2 && parts[0] === "/usr/bin/env" && !parts[1]!.startsWith("-")) {
    return resolveExecutable(parts[1]!, env);
  }
  if (parts.length === 1 && isAbsolute(parts[0]!)) return resolveExecutable(parts[0]!, env);
  throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
}

async function nearestPackageRoot(entrypoint: string) {
  let current = dirname(entrypoint);
  for (let depth = 0; depth < 32; depth += 1) {
    const packagePath = join(current, "package.json");
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name) {
        throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
      }
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID", { cause: error });
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
}

async function addPackage(
  packageRoot: string,
  entrypoint: string,
  entries: Map<string, SourceEntry>,
  directories: Set<string>,
  limits: ToolchainLimits
) {
  const canonicalRoot = await realpath(packageRoot);
  const key = `${safeName(basename(canonicalRoot))}-${sha256(Buffer.from(canonicalRoot)).slice(0, 16)}`;
  const destinationRoot = `packages/${key}`;
  directories.add(destinationRoot);
  await visitSourceDirectory(canonicalRoot, destinationRoot, entries, directories, limits, 0);
  const entryRelative = relative(canonicalRoot, entrypoint).split(sep).join("/");
  if (!entryRelative || entryRelative.startsWith("../") || !entries.has(`${destinationRoot}/${entryRelative}`)) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  }
  return `${destinationRoot}/${entryRelative}`;
}

async function visitSourceDirectory(
  sourceRoot: string,
  destinationRoot: string,
  entries: Map<string, SourceEntry>,
  directories: Set<string>,
  limits: ToolchainLimits,
  depth: number
): Promise<void> {
  if (depth > limits.maxDepth) throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  const children = await readdir(sourceRoot, { withFileTypes: true });
  for (const child of children.sort((first, second) => first.name.localeCompare(second.name))) {
    const sourcePath = join(sourceRoot, child.name);
    const destinationPath = `${destinationRoot}/${child.name}`;
    if (child.isDirectory()) {
      directories.add(destinationPath);
      if (directories.size > limits.maxDirectories) throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
      await visitSourceDirectory(sourcePath, destinationPath, entries, directories, limits, depth + 1);
      continue;
    }
    await addSourceEntry(sourcePath, destinationPath, entries, limits, sourceRoot);
  }
}

async function addStandaloneFile(
  sourcePath: string,
  destinationDirectory: string,
  entries: Map<string, SourceEntry>,
  directories: Set<string>,
  limits: ToolchainLimits
) {
  directories.add(destinationDirectory);
  const destination = `${destinationDirectory}/${safeName(basename(sourcePath))}`;
  await addSourceEntry(sourcePath, destination, entries, limits);
  return destination;
}

async function addSourceEntry(
  sourcePath: string,
  destinationPath: string,
  entries: Map<string, SourceEntry>,
  limits: ToolchainLimits,
  symlinkRoot?: string
) {
  const status = await lstat(sourcePath);
  let entry: SourceEntry;
  if (status.isFile()) {
    if (status.size > limits.maxFileBytes) throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
    entry = {
      sourcePath, path: destinationPath, type: "file", mode: status.mode & 0o777,
      size: status.size, sha256: await hashFile(sourcePath)
    };
  } else if (status.isSymbolicLink() && symlinkRoot) {
    const target = await readlink(sourcePath);
    const resolvedTarget = resolve(dirname(sourcePath), target);
    const relativeTarget = relative(symlinkRoot, resolvedTarget);
    if (isAbsolute(target) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
    }
    entry = {
      sourcePath, path: destinationPath, type: "symlink", mode: 0o555,
      size: Buffer.byteLength(target), sha256: sha256(Buffer.from(target)), target
    };
  } else {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  }
  const prior = entries.get(destinationPath);
  if (prior && (prior.sourcePath !== entry.sourcePath || prior.sha256 !== entry.sha256)) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  }
  entries.set(destinationPath, entry);
  if (entries.size > limits.maxFiles) throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
}

function enforceClosureLimits(entries: SourceEntry[], directories: Set<string>, limits: ToolchainLimits) {
  if (entries.length > limits.maxFiles || directories.size > limits.maxDirectories
    || entries.reduce((total, entry) => total + entry.size, 0) > limits.maxTotalBytes) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  }
}

async function copySourceEntry(entry: SourceEntry, root: string) {
  const destination = join(root, ...entry.path.split("/"));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (entry.type === "symlink") await symlink(entry.target!, destination);
  else await copyFile(entry.sourcePath, destination, constants.COPYFILE_FICLONE);
}

async function verifySnapshotEntries(entries: SourceEntry[], root: string) {
  for (const entry of entries) {
    const destination = join(root, ...entry.path.split("/"));
    const status = await lstat(destination);
    if (entry.type === "file") {
      if (!status.isFile() || status.size !== entry.size || await hashFile(destination) !== entry.sha256) {
        throw new Error("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
      }
    } else if (!status.isSymbolicLink() || await readlink(destination) !== entry.target) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
    }
  }
}

async function makeSnapshotReadOnly(root: string, directories: string[], entries: SourceEntry[]) {
  for (const entry of entries) {
    if (entry.type === "file") await chmod(join(root, ...entry.path.split("/")), entry.mode & 0o555);
  }
  for (const directory of [...directories].sort((first, second) => second.length - first.length)) {
    await chmod(join(root, ...directory.split("/")), 0o555);
  }
  await chmod(root, 0o555);
}

async function verifyManifest(entries: VerificationToolchainManifestEntry[], root: string) {
  for (const entry of entries) {
    const path = join(root, ...entry.path.split("/"));
    const status = await lstat(path);
    if (entry.type === "file") {
      if (!status.isFile() || (status.mode & 0o777) !== entry.mode || status.size !== entry.size
        || await hashFile(path) !== entry.sha256) throw new Error("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
    } else if (!status.isSymbolicLink() || await readlink(path) !== entry.target) {
      throw new Error("AUTOMATED_TEST_TOOLCHAIN_CHANGED");
    }
  }
}

function sourceIdentity(plan: SourcePlan) {
  return JSON.stringify({
    version: 1,
    entries: plan.entries.map((entry) => ({
      sourcePath: entry.sourcePath, path: entry.path, type: entry.type, mode: entry.mode,
      size: entry.size, sha256: entry.sha256, ...(entry.target ? { target: entry.target } : {})
    })),
    commands: plan.commands
  });
}

function toolchainLimits(requested: Partial<ToolchainLimits> | undefined): ToolchainLimits {
  const limits = { ...DEFAULT_LIMITS, ...requested };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("AUTOMATED_TEST_TOOLCHAIN_LIMIT_EXCEEDED");
  }
  return limits;
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string) {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("AUTOMATED_TEST_TOOLCHAIN_INVALID");
  return safe;
}
