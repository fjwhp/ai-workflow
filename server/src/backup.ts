import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export async function createBackup(databasePath: string, targetDir: string) {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const target = resolve(targetDir, `workflow-${timestamp}.db`);
  await copyFile(databasePath, target);
  const bytes = await readFile(target);
  const manifest = { version: 1, createdAt: new Date().toISOString(), database: basename(target), sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifestPath = `${target}.json`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { databasePath: target, manifestPath, manifest };
}

export async function verifyBackup(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const bytes = await readFile(resolve(dirname(manifestPath), manifest.database));
  return createHash("sha256").update(bytes).digest("hex") === manifest.sha256;
}
