import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCleanDatabase, writeDatabaseVersionMarker } from "./database-reset.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "workflow-reset-"));
  directories.push(directory);
  return join(directory, "workflow.db");
}

describe("prepareCleanDatabase", () => {
  it("backs up an incompatible database and removes its sidecars and marker", async () => {
    const path = await databasePath();
    await writeFile(path, "old database bytes");
    await writeFile(`${path}-wal`, "wal");
    await writeFile(`${path}-shm`, "shm");
    await writeFile(`${path}.schema-version`, "legacy-v1");

    const result = await prepareCleanDatabase(path, "multi-project-v1", {
      now: () => new Date("2026-07-18T10:11:12.345Z")
    });

    expect(result).toEqual({
      reset: true,
      backupPath: `${path}.backup-2026-07-18T10-11-12-345Z`,
      sidecarBackupPaths: [`${path}.backup-2026-07-18T10-11-12-345Z-wal`, `${path}.backup-2026-07-18T10-11-12-345Z-shm`]
    });
    await expect(readFile(result.backupPath!, "utf8")).resolves.toBe("old database bytes");
    await expect(readFile(`${result.backupPath}-wal`, "utf8")).resolves.toBe("wal");
    await expect(readFile(`${result.backupPath}-shm`, "utf8")).resolves.toBe("shm");
    for (const removedPath of [path, `${path}-wal`, `${path}-shm`, `${path}.schema-version`]) {
      await expect(readFile(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps a database with an exactly matching marker", async () => {
    const path = await databasePath();
    await writeFile(path, "current database");
    await writeFile(`${path}.schema-version`, "multi-project-v1");

    await expect(prepareCleanDatabase(path, "multi-project-v1")).resolves.toEqual({ reset: false, backupPath: null });
    await expect(readFile(path, "utf8")).resolves.toBe("current database");
  });

  it("does nothing when the database does not exist", async () => {
    const path = await databasePath();
    await expect(prepareCleanDatabase(path, "multi-project-v1")).resolves.toEqual({ reset: false, backupPath: null });
  });

  it("does not overwrite a colliding backup and retries with a unique name", async () => {
    const path = await databasePath();
    const firstBackup = `${path}.backup-2026-07-18T10-11-12-345Z`;
    await writeFile(path, "new backup bytes");
    await writeFile(firstBackup, "existing backup bytes");

    const result = await prepareCleanDatabase(path, "multi-project-v1", {
      now: () => new Date("2026-07-18T10:11:12.345Z")
    });

    await expect(readFile(firstBackup, "utf8")).resolves.toBe("existing backup bytes");
    expect(result.backupPath).toBe(`${firstBackup}-1`);
    await expect(readFile(result.backupPath!, "utf8")).resolves.toBe("new backup bytes");
  });

  it("preserves committed WAL data in a restorable backup set", async () => {
    const path = await databasePath();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('committed-in-wal')");
    await writeFile(`${path}.schema-version`, "legacy-v1");

    const result = await prepareCleanDatabase(path, "multi-project-v1", {
      now: () => new Date("2026-07-18T10:11:12.345Z")
    });
    db.close();

    const restoredPath = join(path, "..", "restored.db");
    await copyFile(result.backupPath!, restoredPath);
    await copyFile(`${result.backupPath}-wal`, `${restoredPath}-wal`);
    if (result.sidecarBackupPaths?.includes(`${result.backupPath}-shm`)) {
      await copyFile(`${result.backupPath}-shm`, `${restoredPath}-shm`);
    }
    const restored = new DatabaseSync(restoredPath);
    expect(restored.prepare("SELECT value FROM records").get()).toEqual({ value: "committed-in-wal" });
    restored.close();
  });
});

describe("writeDatabaseVersionMarker", () => {
  it("atomically writes a readable sibling marker without leaving its temp file", async () => {
    const path = await databasePath();
    const markerPath = await writeDatabaseVersionMarker(path, "multi-project-v1");

    expect(markerPath).toBe(`${path}.schema-version`);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("multi-project-v1");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(path, ".."))).filter((name) => name.includes("schema-version.tmp"))).toEqual([]);
  });
});
