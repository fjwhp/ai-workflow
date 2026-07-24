import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { installPilotAtomicPublish } from "../native/install-pilot-atomic-publish.mjs";

const serverRoot = resolve(import.meta.dirname, "..");
const outputDir = ensureTrustedOutputDirectory(serverRoot);
const packagedSource = resolve(outputDir, "pilot-atomic-publish.c");
const packagedInstaller = resolve(outputDir, "install-pilot-atomic-publish.mjs");
publishBuildInput(resolve(serverRoot, "native/pilot-atomic-publish.c"), packagedSource, 0o600);
publishBuildInput(resolve(serverRoot, "native/install-pilot-atomic-publish.mjs"), packagedInstaller, 0o600);
const installed = await installPilotAtomicPublish({
  outputDir, sourcePath: packagedSource, preserveExistingOnFailure: true, report: () => {}
});
if (!installed.available) {
  process.stdout.write(`FLOWGATE_PILOT_ATOMIC_PUBLISH_UNAVAILABLE ${installed.reason}\n`);
}

function ensureTrustedOutputDirectory(root) {
  assertTrustedOutputEntry(root, "directory");
  let current = root;
  for (const segment of ["dist", "native"]) {
    current = resolve(current, segment);
    try { lstatSync(current); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = assertTrustedOutputEntry(current, "directory", false, true);
    if ((stat.mode & 0o777) !== 0o700) {
      chmodSync(current, 0o700);
      assertTrustedOutputEntry(current, "directory", true);
    }
  }
  return current;
}

function assertTrustedOutputEntry(path, kind, exactMode = false, allowWritable = false) {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  const validKind = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!validKind || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)
    || (!allowWritable && (stat.mode & 0o022) !== 0)
    || (exactMode && (stat.mode & 0o777) !== 0o700)) {
    throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
  }
  return stat;
}

function publishBuildInput(source, destination, mode) {
  const temporary = resolve(outputDir, `.${randomUUID()}-${destination.split("/").at(-1)}`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    const stat = assertTrustedOutputEntry(temporary, "file");
    if ((stat.mode & 0o777) !== mode) throw new Error("PILOT_HELPER_OUTPUT_UNTRUSTED");
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
