import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");
const outputDir = resolve(serverRoot, "dist/native");
const output = resolve(outputDir, "pilot-atomic-publish");

mkdirSync(outputDir, { recursive: true, mode: 0o700 });
if (process.platform !== "darwin" && process.platform !== "linux") {
  rmSync(output, { force: true });
  process.stdout.write(`FLOWGATE_PILOT_ATOMIC_PUBLISH_UNAVAILABLE ${process.platform}\n`);
  process.exit(0);
}

const temporary = resolve(outputDir, `.pilot-atomic-publish-${process.pid}`);
let available = true;
try {
  execFileSync("cc", [
    "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    resolve(serverRoot, "native/pilot-atomic-publish.c"), "-o", temporary
  ], { stdio: "pipe" });
  chmodSync(temporary, 0o700);
  renameSync(temporary, output);
} catch {
  available = false;
  rmSync(output, { force: true });
} finally {
  rmSync(temporary, { force: true });
}
if (!available) process.stdout.write("FLOWGATE_PILOT_ATOMIC_PUBLISH_UNAVAILABLE compiler\n");
