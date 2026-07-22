import { execFile } from "node:child_process";
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { seedDeliveryPilot } from "./pilot-fixture.js";
import { WorkflowStore } from "./store.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("delivery pilot fixture", () => {
  it("creates an isolated two-unit paused and stale workflow through real repositories", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");

    const seeded = await seedDeliveryPilot(dataDir);
    const store = new WorkflowStore(seeded.databasePath);
    try {
      const requirements = store.listRequirements();
      expect(requirements).toHaveLength(1);
      expect(requirements[0]).toMatchObject({
        id: seeded.requirementId, code: "REQ-0001", stage: "implementation", status: "ai_ready"
      });

      const detail = store.deliveryUnitDetails.getForRequirement(seeded.requirementId);
      expect(detail.automation).toMatchObject({
        status: "paused",
        actor: "local-pilot",
        allowedActions: [{ type: "resume_automation", reasonRequired: true }]
      });
      expect(detail.units).toHaveLength(2);
      const backend = detail.units.find((unit) => unit.id === seeded.backendUnitId)!;
      const frontend = detail.units.find((unit) => unit.id === seeded.frontendUnitId)!;
      expect(backend).toMatchObject({
        status: "ready_for_acceptance",
        implementationEvidence: expect.any(Object),
        codeReviewEvidence: { result: "passed" },
        automatedTestingEvidence: { result: "passed" }
      });
      expect(frontend).toMatchObject({
        status: "potentially_stale",
        implementationEvidence: expect.any(Object),
        automation: { status: "paused" },
        allowedActions: []
      });
      expect(detail.dependencies).toEqual([
        expect.objectContaining({
          upstreamUnitId: seeded.backendUnitId,
          downstreamUnitId: seeded.frontendUnitId,
          releasedByEvidenceVersion: 1
        })
      ]);
      const persistedPaths = [
        ...store.listProjects().map((project) => project.repoPath),
        ...store.listProjects().flatMap((project) => store.listProjectVersions(project.id, "all")
          .map((version) => version.worktreePath)),
        ...(store as any).db.prepare("SELECT repo_path, worktree_path FROM delivery_unit_snapshots").all()
          .flatMap((row: { repo_path: string; worktree_path: string }) => [row.repo_path, row.worktree_path])
      ];
      expect(persistedPaths.every((path) => path.startsWith(`${dataDir}/`))).toBe(true);
      expect(persistedPaths.every((path) => lstatSync(path).isDirectory())).toBe(true);
      expect(readFileSync(`${seeded.databasePath}.schema-version`, "utf8"))
        .toBe("phase-3-application-sequence-v15");
    } finally {
      store.close();
    }
  });

  it("refuses to overwrite a previously seeded database", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-existing-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    const seeded = await seedDeliveryPilot(dataDir);

    await expect(seedDeliveryPilot(dataDir)).rejects.toThrow("PILOT_DATABASE_EXISTS");

    const store = new WorkflowStore(seeded.databasePath);
    try {
      expect(store.listRequirements()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it.each([
    ["schema marker", "workflow.db.schema-version"],
    ["WAL", "workflow.db-wal"],
    ["SHM", "workflow.db-shm"],
    ["ordinary file", "notes.txt"]
  ])("preserves an explicitly nonempty target containing %s", async (_label, entry) => {
    const dataDir = mkdtempSync(join(tmpdir(), "flowgate-pilot-nonempty-"));
    directories.push(dataDir);
    const path = join(dataDir, entry);
    const original = Buffer.from("original-user-bytes");
    writeFileSync(path, original);

    await expect(seedDeliveryPilot(dataDir)).rejects.toThrow("PILOT_DATA_DIR_EXISTS");

    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(dataDir)).toEqual([entry]);
  });

  it("preserves the original database bytes when the target already owns a database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "flowgate-pilot-database-"));
    directories.push(dataDir);
    const databasePath = join(dataDir, "workflow.db");
    const original = Buffer.from("not-a-pilot-database");
    writeFileSync(databasePath, original);

    await expect(seedDeliveryPilot(dataDir)).rejects.toThrow("PILOT_DATABASE_EXISTS");

    expect(readFileSync(databasePath)).toEqual(original);
    expect(readdirSync(dataDir)).toEqual(["workflow.db"]);
  });

  it.each([
    ["mutation", { afterFirstMutation: () => { throw new Error("PILOT_MUTATION_INJECTED"); } }],
    ["marker", { writeMarker: async () => { throw new Error("PILOT_MARKER_INJECTED"); } }],
    ["publish", { beforeAtomicPublish: async () => { throw new Error("PILOT_PUBLISH_INJECTED"); } }]
  ] as const)("cleans owned staging after a %s failure and remains retryable", async (_label, fault) => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-fault-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");

    await expect(seedDeliveryPilot(dataDir, fault as any)).rejects.toThrow(/PILOT_.*_INJECTED/);

    expect(() => lstatSync(dataDir)).toThrow();
    expect(readdirSync(parent).filter((entry) => entry.includes("pilot-staging"))).toEqual([]);
    await expect(seedDeliveryPilot(dataDir)).resolves.toMatchObject({ dataDir });
  });

  it("fails closed when the empty target changes before atomic publish", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-race-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    const racedFile = join(dataDir, "arrived-during-seed.txt");

    await expect(seedDeliveryPilot(dataDir, {
      beforePublish: () => {
        mkdirSync(dataDir);
        writeFileSync(racedFile, "user-race");
      }
    })).rejects.toThrow("PILOT_PUBLISH_CONFLICT");

    expect(readFileSync(racedFile, "utf8")).toBe("user-race");
    expect(readdirSync(dataDir)).toEqual(["arrived-during-seed.txt"]);
    expect(readdirSync(parent).filter((entry) => entry.includes("pilot-staging"))).toEqual([]);
  });

  it("reports a publish conflict when a database appears after the initial validation", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-database-race-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    const racedDatabase = join(dataDir, "workflow.db");

    await expect(seedDeliveryPilot(dataDir, {
      beforePublish: () => {
        mkdirSync(dataDir);
        writeFileSync(racedDatabase, "user-database-race");
      }
    })).rejects.toThrow("PILOT_PUBLISH_CONFLICT");

    expect(readFileSync(racedDatabase, "utf8")).toBe("user-database-race");
    expect(readdirSync(parent).filter((entry) => entry.includes("pilot-staging"))).toEqual([]);
  });

  it("never replaces an empty directory that takes ownership before publish", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-empty-owner-race-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    let replacement!: { dev: number; ino: number; entries: string[] };

    await expect(seedDeliveryPilot(dataDir, {
      beforePublish: () => {
        mkdirSync(dataDir);
        const stat = lstatSync(dataDir);
        replacement = { dev: stat.dev, ino: stat.ino, entries: readdirSync(dataDir) };
      }
    })).rejects.toThrow("PILOT_PUBLISH_CONFLICT");

    const preserved = lstatSync(dataDir);
    expect({ dev: preserved.dev, ino: preserved.ino, entries: readdirSync(dataDir) }).toEqual(replacement);
    expect(readdirSync(parent).filter((entry) => entry.includes("pilot-staging"))).toEqual([]);
    rmSync(dataDir, { recursive: true });
    await expect(seedDeliveryPilot(dataDir)).resolves.toMatchObject({ dataDir });
  });

  it("never replaces a symlink that takes ownership after target validation", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-symlink-owner-race-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    const replacementTarget = join(parent, "replacement-target");
    mkdirSync(replacementTarget);
    writeFileSync(join(replacementTarget, "owner.txt"), "replacement-owner");
    let replacement!: { dev: number; ino: number };

    await expect(seedDeliveryPilot(dataDir, {
      beforeAtomicPublish: async () => {
        symlinkSync(replacementTarget, dataDir);
        const stat = lstatSync(dataDir);
        replacement = { dev: stat.dev, ino: stat.ino };
      }
    })).rejects.toThrow("PILOT_PUBLISH_CONFLICT");

    const preserved = lstatSync(dataDir);
    expect(preserved.isSymbolicLink()).toBe(true);
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual(replacement);
    expect(readFileSync(join(dataDir, "owner.txt"), "utf8")).toBe("replacement-owner");
    expect(readdirSync(parent).filter((entry) => entry.includes("pilot-staging"))).toEqual([]);
  });

  it("rejects a replaced staging identity without deleting or publishing the replacement", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-staging-replaced-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    let replacementPath = "";

    await expect(seedDeliveryPilot(dataDir, {
      beforeAtomicPublish: (stagingDir) => {
        renameSync(stagingDir, `${stagingDir}.original`);
        mkdirSync(stagingDir, { mode: 0o700 });
        replacementPath = join(stagingDir, "important.txt");
        writeFileSync(replacementPath, "keep replacement");
      }
    })).rejects.toThrow("PILOT_STAGING_CLEANUP_FAILED");

    expect(readFileSync(replacementPath, "utf8")).toBe("keep replacement");
    expect(() => lstatSync(dataDir)).toThrow();
  });

  it("requires an explicit nonempty target before any filesystem access", async () => {
    await expect(seedDeliveryPilot("")).rejects.toThrow("PILOT_DATA_DIR_REQUIRED");
    await expect(seedDeliveryPilot("   ")).rejects.toThrow("PILOT_DATA_DIR_REQUIRED");
  });

  it("rejects an existing group-writable direct parent before creating staging", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-untrusted-parent-"));
    directories.push(parent);
    chmodSync(parent, 0o770);
    const dataDir = join(parent, "pilot-data");

    await expect(seedDeliveryPilot(dataDir)).rejects.toThrow("PILOT_PARENT_UNTRUSTED");

    expect(readdirSync(parent)).toEqual([]);
  });

  it("quarantines by identity and never removes a cleanup-time replacement", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowgate-pilot-cleanup-race-"));
    directories.push(parent);
    const dataDir = join(parent, "pilot-data");
    let replacementPath = "";

    await expect(seedDeliveryPilot(dataDir, {
      beforeAtomicPublish: async () => { throw new Error("PILOT_PUBLISH_INJECTED"); },
      beforeCleanupAtomicMove: (stagingDir: string) => {
        renameSync(stagingDir, `${stagingDir}.original`);
        mkdirSync(stagingDir, { mode: 0o700 });
        replacementPath = join(stagingDir, "important.txt");
        writeFileSync(replacementPath, "keep replacement");
      }
    } as any)).rejects.toThrow("PILOT_STAGING_CLEANUP_FAILED");

    expect(readFileSync(replacementPath, "utf8")).toBe("keep replacement");
    expect(() => lstatSync(dataDir)).toThrow();
  });

  it("emits a stable CLI error and never falls back to cwd/data", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flowgate-pilot-cli-"));
    directories.push(cwd);
    const entry = new URL("./pilot-fixture.ts", import.meta.url).pathname;
    const tsxLoader = resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs");

    const result = await execFileAsync(process.execPath, ["--import", tsxLoader, entry], {
      cwd, env: { ...process.env, PILOT_DATA_DIR: "" }
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error: any) => ({ exitCode: error.code, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") })
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      'FLOWGATE_PILOT_ERROR {"code":"PILOT_DATA_DIR_REQUIRED"}'
    );
    expect(readdirSync(cwd)).toEqual([]);
  });
});
