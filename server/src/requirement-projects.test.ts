import { describe, expect, it } from "vitest";
import {
  hasMaterialAssociationChange,
  normalizeModuleId,
  validateRequirementProjects
} from "./requirement-projects.js";

const primary = { projectId: "web", role: "primary" as const, usage: "context" as const, deliveryRequired: false, moduleMode: "auto" as const, moduleIds: [], position: 0 };
const delivery = { projectId: "api", projectVersionId: "api-v1", role: "collaborator" as const, usage: "delivery" as const, deliveryRequired: true, moduleMode: "all" as const, moduleIds: [], position: 1 };
const projects = [{ id: "web", status: "active" as const }, { id: "api", status: "active" as const }];
const versions = new Map([
  ["api-v1", { id: "api-v1", projectId: "api", status: "active" }],
  ["api-closed", { id: "api-closed", projectId: "api", status: "closed" }],
  ["web-v1", { id: "web-v1", projectId: "web", status: "active" }]
]);

describe("requirement project domain", () => {
  it("validates a context primary with a delivery collaborator", () => {
    expect(validateRequirementProjects([primary, delivery], { projects, versions })).toEqual([primary, delivery]);
  });

  it.each([
    [[{ ...primary, role: "collaborator" }], "Exactly one primary project is required"],
    [[primary, { ...delivery, projectId: "web", projectVersionId: "web-v1" }], "Project IDs must be unique"],
    [[primary, { ...delivery, projectId: "missing" }], "PROJECT_NOT_ACTIVE"],
  ])("rejects invalid association collections", (items, error) => {
    expect(() => validateRequirementProjects(items as any, { projects, versions })).toThrow(error);
  });

  it("rejects archived projects", () => {
    expect(() => validateRequirementProjects([primary], { projects: [{ id: "web", status: "archived" }], versions })).toThrow("PROJECT_NOT_ACTIVE");
  });

  it("enforces version ownership and lifecycle with stable domain errors", () => {
    expect(() => validateRequirementProjects([{ ...delivery, projectVersionId: undefined }], { projects, versions }))
      .toThrow("REQUIREMENT_VERSION_REQUIRED");
    expect(() => validateRequirementProjects([{ ...primary, projectVersionId: "web-v1" }], { projects, versions }))
      .toThrow("CONTEXT_PROJECT_VERSION_NOT_ALLOWED");
    expect(() => validateRequirementProjects([{ ...primary, projectVersionName: "display-only" } as any], { projects, versions }))
      .toThrow("CONTEXT_PROJECT_VERSION_NOT_ALLOWED");
    expect(() => validateRequirementProjects([{ ...delivery, projectVersionId: "missing" }], { projects, versions }))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(() => validateRequirementProjects([{ ...delivery, projectVersionId: "web-v1" }], { projects, versions }))
      .toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(() => validateRequirementProjects([{ ...delivery, projectVersionId: "api-closed" }], { projects, versions }))
      .toThrow("PROJECT_VERSION_NOT_ACTIVE");
  });

  it("normalizes and validates selected module identities", () => {
    const selected = { ...primary, moduleMode: "selected" as const, moduleIds: [" ./src\\orders/ "] };
    expect(normalizeModuleId(selected.moduleIds[0]!)).toBe("src/orders");
    expect(validateRequirementProjects([selected], { projects, versions, modulesByProject: new Map([["web", ["src/orders"]]]) })[0]!.moduleIds).toEqual(["src/orders"]);
    expect(() => validateRequirementProjects([{ ...selected, moduleIds: ["src/missing"] }], { projects, versions, modulesByProject: new Map([["web", ["src/orders"]]]) })).toThrow("MODULE_NOT_FOUND");
    expect(() => validateRequirementProjects([selected], { projects, versions })).toThrow("MODULE_INDEX_REQUIRED");
    try {
      validateRequirementProjects([{ ...selected, moduleIds: ["src/orders", "./src/orders"] }], { projects, versions, modulesByProject: new Map([["web", ["src/orders"]]]) });
      throw new Error("expected duplicate rejection");
    } catch (error) {
      expect(error).toMatchObject({ message: "DUPLICATE_MODULE_ID", path: ["moduleIds", 1] });
    }
    expect(() => validateRequirementProjects([{ ...selected, moduleIds: [" ./ "] }], { projects, versions, modulesByProject: new Map([["web", ["src/orders"]]]) })).toThrow("MODULE_ID_INVALID");
    expect(() => validateRequirementProjects([{ ...selected, moduleIds: ["../orders"] }], { projects, versions })).toThrow("MODULE_ID_INVALID");
  });

  it("accepts auto and all modes without a module index", () => {
    expect(validateRequirementProjects([primary], { projects, versions })).toEqual([primary]);
    expect(validateRequirementProjects([{ ...primary, moduleMode: "all" }], { projects, versions })).toEqual([{ ...primary, moduleMode: "all" }]);
  });

  it("detects only material association changes", () => {
    const before = [{ ...delivery, moduleMode: "selected" as const, moduleIds: ["b", "a"], id: "old", createdAt: "old" }];
    expect(hasMaterialAssociationChange(before, [{ ...before[0]!, position: 9, id: "new", createdAt: "new", moduleIds: ["a", "b"] }])).toBe(false);
    for (const after of [
      [{ ...before[0]!, projectId: "worker" }],
      [{ ...before[0]!, projectVersionId: "api-v2" }],
      [{ ...before[0]!, role: "primary" as const }],
      [{ ...before[0]!, usage: "context" as const }],
      [{ ...before[0]!, deliveryRequired: false }],
      [{ ...before[0]!, moduleMode: "all" as const, moduleIds: [] }],
      [{ ...before[0]!, moduleIds: ["c"] }]
    ]) expect(hasMaterialAssociationChange(before, after)).toBe(true);
  });
});
