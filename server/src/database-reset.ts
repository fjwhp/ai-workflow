import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";

export interface DatabaseResetOptions {
  now?: () => Date;
  copyFile?: typeof copyFile;
  removeFile?: typeof rm;
}

export interface DatabaseResetResult {
  reset: boolean;
  backupPath: string | null;
  sidecarBackupPaths?: string[];
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
  const copyDatabaseFile = options.copyFile ?? copyFile;
  const removeFile = options.removeFile ?? rm;
  const databaseExists = await exists(dbPath);
  const markerPath = markerPathFor(dbPath);
  let currentVersion: string | null = null;
  try {
    currentVersion = await readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!databaseExists) {
    await removeFile(`${dbPath}-wal`, { force: true });
    await removeFile(`${dbPath}-shm`, { force: true });
    if (currentVersion !== null && currentVersion !== expectedVersion) await removeFile(markerPath, { force: true });
    return { reset: false, backupPath: null };
  }
  if (currentVersion === expectedVersion) return { reset: false, backupPath: null };

  const sourcePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const existingSources = (await Promise.all(sourcePaths.map(async (path) => ({ path, exists: await exists(path) })))).filter((item) => item.exists);
  const backupBase = `${dbPath}.backup-${safeTimestamp((options.now ?? (() => new Date()))())}`;
  let backupPath = backupBase;
  let backupPaths: string[] = [];
  for (let attempt = 0; ; attempt += 1) {
    backupPath = attempt === 0 ? backupBase : `${backupBase}-${attempt}`;
    const createdPaths: string[] = [];
    try {
      for (const source of existingSources) {
        const suffix = source.path.slice(dbPath.length);
        const target = `${backupPath}${suffix}`;
        await copyDatabaseFile(source.path, target, constants.COPYFILE_EXCL);
        createdPaths.push(target);
      }
      backupPaths = createdPaths;
      break;
    } catch (error) {
      await Promise.all(createdPaths.map((path) => removeFile(path, { force: true })));
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  await removeFile(`${dbPath}-wal`, { force: true });
  await removeFile(`${dbPath}-shm`, { force: true });
  await removeFile(markerPath, { force: true });
  await removeFile(dbPath, { force: true });
  return { reset: true, backupPath, sidecarBackupPaths: backupPaths.slice(1) };
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
