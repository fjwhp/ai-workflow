import { describe, expect, it } from "vitest";
import {
  hasMaterialAssociationChange,
  normalizeModuleId,
  resolveSoleDeliveryProject,
  validateRequirementProjects
} from "./requirement-projects.js";

const primary = { projectId: "web", role: "primary" as const, usage: "context" as const, deliveryRequired: false, moduleMode: "auto" as const, moduleIds: [], position: 0 };
const delivery = { projectId: "api", role: "collaborator" as const, usage: "delivery" as const, deliveryRequired: true, moduleMode: "all" as const, moduleIds: [], position: 1 };
const projects = [{ id: "web", status: "active" as const }, { id: "api", status: "active" as const }];

describe("requirement project domain", () => {
  it("validates a context primary with a delivery collaborator", () => {
    expect(validateRequirementProjects([primary, delivery], { projects })).toEqual([primary, delivery]);
    expect(resolveSoleDeliveryProject([{ ...primary, status: "active" }, { ...delivery, status: "active" }])).toMatchObject({ projectId: "api" });
  });

  it("rejects ambiguous and absent delivery resolution with stable errors", () => {
    expect(() => resolveSoleDeliveryProject([{ ...delivery, status: "active" }, { ...delivery, projectId: "worker", status: "active" }])).toThrow("MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED");
    expect(resolveSoleDeliveryProject([{ ...primary, status: "active" }])).toBeNull();
  });

  it.each([
    [[{ ...primary, role: "collaborator" }], "Exactly one primary project is required"],
    [[primary, { ...delivery, projectId: "web" }], "Project IDs must be unique"],
    [[primary, { ...delivery, projectId: "missing" }], "PROJECT_NOT_ACTIVE"],
  ])("rejects invalid association collections", (items, error) => {
    expect(() => validateRequirementProjects(items as any, { projects })).toThrow(error);
  });

  it("rejects archived projects", () => {
    expect(() => validateRequirementProjects([primary], { projects: [{ id: "web", status: "archived" }] })).toThrow("PROJECT_NOT_ACTIVE");
  });

  it("normalizes and validates selected module identities", () => {
    const selected = { ...primary, moduleMode: "selected" as const, moduleIds: [" ./src\\orders/ "] };
    expect(normalizeModuleId(selected.moduleIds[0]!)).toBe("src/orders");
    expect(validateRequirementProjects([selected], { projects, modulesByProject: new Map([["web", ["src/orders"]]]) })[0]!.moduleIds).toEqual(["src/orders"]);
    expect(() => validateRequirementProjects([{ ...selected, moduleIds: ["src/missing"] }], { projects, modulesByProject: new Map([["web", ["src/orders"]]]) })).toThrow("MODULE_NOT_FOUND");
    expect(() => validateRequirementProjects([selected], { projects })).toThrow("MODULE_INDEX_REQUIRED");
  });

  it("detects only material association changes", () => {
    const before = [{ ...delivery, moduleMode: "selected" as const, moduleIds: ["b", "a"], id: "old", createdAt: "old" }];
    expect(hasMaterialAssociationChange(before, [{ ...before[0]!, position: 9, id: "new", createdAt: "new", moduleIds: ["a", "b"] }])).toBe(false);
    for (const after of [
      [{ ...before[0]!, role: "primary" as const }],
      [{ ...before[0]!, usage: "context" as const }],
      [{ ...before[0]!, moduleIds: ["c"] }]
    ]) expect(hasMaterialAssociationChange(before, after)).toBe(true);
  });
});
