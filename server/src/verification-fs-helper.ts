import type { EvidenceManifest } from "./evidence-tree.js";
import { runTrustedSubprocess } from "./trusted-subprocess.js";

interface MaterializationLimits {
  maxEntries: number;
  maxInodes: number;
  maxDirectories: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface MaterializationOptions {
  timeoutMs: number;
  sensitivePatterns: string[];
  limits?: Partial<MaterializationLimits>;
  signal?: AbortSignal;
}

interface MaterializationDependencies {
  runSubprocess?: typeof runTrustedSubprocess;
}

const DEFAULT_LIMITS: MaterializationLimits = {
  maxEntries: 20_000,
  maxInodes: 30_000,
  maxDirectories: 10_000,
  maxDepth: 32,
  maxPathBytes: 4096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024
};

const HELPER_OUTPUT_BYTES = 4096;

export async function materializeVerificationManifest(
  root: string,
  manifest: EvidenceManifest,
  options: MaterializationOptions,
  dependencies: MaterializationDependencies = {}
) {
  if (options.signal?.aborted) throw new Error("AUTOMATED_TEST_ABORTED");
  const limits = materializationLimits(options.limits);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("AUTOMATED_TEST_DEADLINE_EXCEEDED");
  }
  const config = JSON.stringify({
    root,
    manifest,
    sensitivePatterns: options.sensitivePatterns,
    limits,
    deadline: Date.now() + options.timeoutMs
  });
  let result: Awaited<ReturnType<typeof runTrustedSubprocess>>;
  try {
    result = await (dependencies.runSubprocess ?? runTrustedSubprocess)(process.execPath, [
      "--input-type=commonjs", "--eval", verificationFsHelperSource
    ], {
      timeoutMs: options.timeoutMs,
      termGraceMs: 250,
      maxOutputBytes: HELPER_OUTPUT_BYTES,
      input: config,
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
  if (result.outputOverflow) throw new Error("AUTOMATED_TEST_MATERIALIZATION_FAILED");
  if (result.exitCode === 0) return;
  const code = result.stderr.trim();
  if ([
    "CODING_EVIDENCE_MANIFEST_INVALID",
    "CODING_EVIDENCE_MANIFEST_SENSITIVE",
    "AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED",
    "AUTOMATED_TEST_DEADLINE_EXCEEDED"
  ].includes(code)) throw new Error(code);
  throw new Error("AUTOMATED_TEST_MATERIALIZATION_FAILED");
}

function materializationLimits(requested: Partial<MaterializationLimits> | undefined) {
  const limits = { ...DEFAULT_LIMITS, ...requested };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
  }
  return limits;
}

function verificationFsHelperMain() {
  const fs = require("node:fs/promises");
  const crypto = require("node:crypto");
  const pathModule = require("node:path");
  const posix = pathModule.posix;

  const fail = (code: string) => { throw new Error(code); };
  const readInput = async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 64 * 1024 * 1024) fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return fail("CODING_EVIDENCE_MANIFEST_INVALID"); }
  };
  const safePath = (value: unknown) => typeof value === "string" && value.length > 0
    && value === posix.normalize(value) && !posix.isAbsolute(value)
    && value !== ".." && !value.startsWith("../")
    && !value.split("/").some((segment: string) => segment.toLowerCase() === ".git");
  const globMatches = (pattern: string, value: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0")
      .replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\0", ".*");
    return new RegExp(`^(?:${escaped})$`).test(value) || new RegExp(`(?:^|/)${escaped}$`).test(value);
  };
  const main = async () => {
    const config = await readInput();
    if (!config || typeof config !== "object" || !pathModule.isAbsolute(config.root)
      || !Number.isFinite(config.deadline) || !config.limits || typeof config.limits !== "object"
      || !Array.isArray(config.sensitivePatterns)
      || config.sensitivePatterns.some((pattern: unknown) => typeof pattern !== "string")) {
      fail("CODING_EVIDENCE_MANIFEST_INVALID");
    }
    const check = () => {
      if (Date.now() >= config.deadline) fail("AUTOMATED_TEST_DEADLINE_EXCEEDED");
    };
    const step = async (operation: Promise<unknown>) => {
      check();
      const result = await operation;
      check();
      return result;
    };
    const limits = config.limits;
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || (value as number) < 1)) {
      fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
    }
    const manifest = config.manifest;
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
      fail("CODING_EVIDENCE_MANIFEST_INVALID");
    }
    if (manifest.entries.length > limits.maxEntries) fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
    const paths = new Set<string>();
    const symlinkPaths = new Set<string>();
    const directories = new Set<string>([""]);
    const decoded = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const entry of manifest.entries) {
      check();
      if (!entry || typeof entry !== "object" || !safePath(entry.path) || paths.has(entry.path)) {
        fail("CODING_EVIDENCE_MANIFEST_INVALID");
      }
      if (Buffer.byteLength(entry.path) > limits.maxPathBytes
        || entry.path.split("/").length > limits.maxDepth) {
        fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
      }
      for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) {
        directories.add(parent);
        if (directories.size > limits.maxDirectories) fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
      }
      paths.add(entry.path);
      if (entry.type === "file") {
        if ((entry.mode !== "100644" && entry.mode !== "100755")
          || !Number.isSafeInteger(entry.size) || entry.size < 0
          || typeof entry.contentBase64 !== "string" || typeof entry.sha256 !== "string") {
          fail("CODING_EVIDENCE_MANIFEST_INVALID");
        }
        const content = Buffer.from(entry.contentBase64, "base64");
        if (content.length !== entry.size
          || crypto.createHash("sha256").update(content).digest("hex") !== entry.sha256) {
          fail("CODING_EVIDENCE_MANIFEST_INVALID");
        }
        if (content.length > limits.maxFileBytes) fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
        decoded.set(entry.path, content);
        totalBytes += content.length;
      } else if (entry.type === "symlink") {
        if (entry.mode !== "120000" || typeof entry.target !== "string" || pathModule.isAbsolute(entry.target)
          || crypto.createHash("sha256").update(Buffer.from(entry.target)).digest("hex") !== entry.sha256) {
          fail("CODING_EVIDENCE_MANIFEST_INVALID");
        }
        symlinkPaths.add(entry.path);
        totalBytes += Buffer.byteLength(entry.target);
      } else {
        fail("CODING_EVIDENCE_MANIFEST_INVALID");
      }
      if (totalBytes > limits.maxTotalBytes) fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
    }
    if (directories.size > limits.maxDirectories
      || directories.size + manifest.entries.length > limits.maxInodes) {
      fail("AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED");
    }
    const excluded = new Set<string>();
    for (const entry of manifest.entries) {
      if (config.sensitivePatterns.some((pattern: string) => globMatches(pattern, entry.path))) excluded.add(entry.path);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of manifest.entries) {
        if (entry.type !== "symlink" || excluded.has(entry.path)) continue;
        const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
        if (excluded.has(target)
          || config.sensitivePatterns.some((pattern: string) => globMatches(pattern, target))) {
          excluded.add(entry.path); changed = true;
        }
      }
    }
    if (excluded.size) fail("CODING_EVIDENCE_MANIFEST_SENSITIVE");
    for (const entry of manifest.entries) {
      if (entry.type !== "symlink") continue;
      const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (!safePath(target) || (!paths.has(target) && ![...paths].some((value) => value.startsWith(`${target}/`)))) {
        fail("CODING_EVIDENCE_MANIFEST_INVALID");
      }
    }
    for (const entry of manifest.entries) {
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        if (symlinkPaths.has(segments.slice(0, index).join("/"))) fail("CODING_EVIDENCE_MANIFEST_INVALID");
      }
    }
    check();
    await step(fs.mkdir(config.root, { recursive: true, mode: 0o700 }));
    for (const directory of [...directories].filter(Boolean).sort()) {
      await step(fs.mkdir(pathModule.join(config.root, ...directory.split("/")), { recursive: true, mode: 0o700 }));
    }
    for (const entry of manifest.entries.filter((value: any) => value.type === "file")) {
      const target = pathModule.join(config.root, ...entry.path.split("/"));
      await step(fs.writeFile(target, decoded.get(entry.path), { flag: "wx" }));
      await step(fs.chmod(target, entry.mode === "100755" ? 0o755 : 0o644));
    }
    for (const entry of manifest.entries.filter((value: any) => value.type === "symlink")) {
      await step(fs.symlink(entry.target, pathModule.join(config.root, ...entry.path.split("/"))));
    }
  };
  return main();
}

const verificationFsHelperSource = `(${verificationFsHelperMain.toString()})().catch((error) => {
  const allowed = new Set([
    "CODING_EVIDENCE_MANIFEST_INVALID",
    "CODING_EVIDENCE_MANIFEST_SENSITIVE",
    "AUTOMATED_TEST_MATERIALIZATION_LIMIT_EXCEEDED",
    "AUTOMATED_TEST_DEADLINE_EXCEEDED"
  ]);
  const code = error instanceof Error && allowed.has(error.message)
    ? error.message : "AUTOMATED_TEST_MATERIALIZATION_FAILED";
  process.stderr.write(code);
  process.exitCode = 1;
})`;
