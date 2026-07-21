import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function installPilotAtomicPublish(options = {}) {
  const platform = options.platform ?? process.platform;
  const outputDir = resolve(options.outputDir ?? import.meta.dirname);
  const output = resolve(outputDir, "pilot-atomic-publish");
  const source = resolve(options.sourcePath ?? resolve(outputDir, "pilot-atomic-publish.c"));
  const report = options.report ?? ((payload) => {
    process.stderr.write(`FLOWGATE_PILOT_HELPER_UNAVAILABLE ${JSON.stringify(payload)}\n`);
  });
  if (platform !== "darwin" && platform !== "linux") {
    removeIncompatibleHelper(outputDir, output);
    report({ reason: "unsupported_platform", platform });
    return { available: false, reason: "unsupported_platform" };
  }

  const temporary = resolve(outputDir, `.pilot-atomic-publish-${randomUUID()}`);
  try {
    assertTrustedDirectory(outputDir, true);
    assertTrustedSource(source);
    execFileSync(options.compiler ?? "cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", temporary
    ], { stdio: "pipe" });
    chmodSync(temporary, 0o700);
    assertTrustedHelper(temporary);
    renameSync(temporary, output);
    return { available: true };
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!options.preserveExistingOnFailure) removeIncompatibleHelper(outputDir, output);
    const reason = error?.code === "ENOENT" ? "compiler_unavailable" : "compilation_failed";
    report({ reason, platform });
    return { available: false, reason };
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertTrustedDirectory(path, repairMode) {
  let stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
  }
  if ((stat.mode & 0o022) !== 0) {
    if (!repairMode) throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
    chmodSync(path, 0o700);
    stat = lstatSync(path);
    if ((stat.mode & 0o777) !== 0o700) throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
  }
  return stat;
}

function assertTrustedSource(path) {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0) throw new Error("PILOT_HELPER_SOURCE_UNTRUSTED");
}

function assertTrustedHelper(path) {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o777) !== 0o700) throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
}

function removeIncompatibleHelper(outputDir, output) {
  try {
    assertTrustedDirectory(outputDir, true);
    rmSync(output, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])); }
  catch { return false; }
}

if (isDirectExecution()) await installPilotAtomicPublish();
