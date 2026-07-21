import { existsSync } from "node:fs";
import { resolve } from "node:path";

const packagedInstaller = resolve(import.meta.dirname, "dist/native/install-pilot-atomic-publish.mjs");

if (existsSync(packagedInstaller)) {
  const { installPilotAtomicPublish } = await import("./dist/native/install-pilot-atomic-publish.mjs");
  await installPilotAtomicPublish();
} else {
  await import("./scripts/build-pilot-atomic-publish.mjs");
}
