import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDeliveryPilot } from "./pilot-fixture.js";
import { WorkflowStore } from "./store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("delivery pilot fixture", () => {
  it("creates an isolated two-unit paused and stale workflow through real repositories", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "flowgate-pilot-"));
    directories.push(dataDir);

    const seeded = await seedDeliveryPilot(dataDir);
    const store = new WorkflowStore(seeded.databasePath);
    try {
      const requirements = store.listRequirements();
      expect(requirements).toHaveLength(1);
      expect(requirements[0]).toMatchObject({ id: seeded.requirementId, code: "REQ-0001" });

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
      expect(readFileSync(`${seeded.databasePath}.schema-version`, "utf8"))
        .toBe("phase-2-quality-attempt-v14");
    } finally {
      store.close();
    }
  });

  it("refuses to overwrite a previously seeded database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "flowgate-pilot-existing-"));
    directories.push(dataDir);
    const seeded = await seedDeliveryPilot(dataDir);

    await expect(seedDeliveryPilot(dataDir)).rejects.toThrow("PILOT_DATABASE_EXISTS");

    const store = new WorkflowStore(seeded.databasePath);
    try {
      expect(store.listRequirements()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
