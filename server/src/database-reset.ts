import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface DatabaseResetOptions {
  now?: () => Date;
}

export interface DatabaseResetResult {
  reset: boolean;
  backupPath: string | null;
}

const markerPathFor = (dbPath: string) => `${dbPath}.schema-version`;

async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function prepareCleanDatabase(
  dbPath: string,
  expectedVersion: string,
  options: DatabaseResetOptions = {}
): Promise<DatabaseResetResult> {
  if (!await exists(dbPath)) return { reset: false, backupPath: null };

  const markerPath = markerPathFor(dbPath);
  let currentVersion: string | null = null;
  try {
    currentVersion = await readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (currentVersion === expectedVersion) return { reset: false, backupPath: null };

  const backupPath = `${dbPath}.backup-${safeTimestamp((options.now ?? (() => new Date()))())}`;
  await copyFile(dbPath, backupPath);
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(markerPath, { force: true })
  ]);
  return { reset: true, backupPath };
}

export async function writeDatabaseVersionMarker(dbPath: string, version: string) {
  const markerPath = markerPathFor(dbPath);
  const temporaryPath = `${markerPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, version, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, markerPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return markerPath;
}
