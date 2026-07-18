import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import {
  associationSummary, associationApiErrors, associationReducer, availableProjectChoices,
  activeAssociations, historyAssociations, moveAssociation, requirementProjectsPayload,
  hasMaterialAssociationEdit, initialAssociationState, phaseOneDeliveryGate,
  setPrimary, setUsage, validateAssociations, type Association
} from "./requirement-projects.js";

const primary: Association = { projectId: "web", projectName: "Web", role: "primary", usage: "context", deliveryRequired: false, moduleMode: "auto", moduleIds: [], position: 0, status: "active", projectStatus: "active" };
const delivery: Association = { projectId: "api", projectName: "API", role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 1, status: "active", projectStatus: "active" };

describe("requirement project helpers", () => {
  it("summarizes a context primary and delivery count", () => expect(associationSummary([primary, delivery])).toMatchObject({ primaryName: "Web", primaryUsage: "context", deliveryCount: 1 }));
  it("gates zero, one, and multiple delivery projects", () => {
    expect(phaseOneDeliveryGate([]).kind).toBe("missing");
    expect(phaseOneDeliveryGate([delivery]).kind).toBe("ready");
    expect(phaseOneDeliveryGate([delivery, { ...delivery, projectId: "mobile" }])).toMatchObject({ kind: "phase2", message: "多项目编码将在第二期启用；当前可继续完善总体技术设计" });
  });
  it("excludes archived projects from choices but retains history", () => {
    const archived = { id: "old", name: "Old", status: "archived" as const };
    expect(availableProjectChoices([{ id: "web", name: "Web", status: "active" }, archived], [primary])).toEqual([]);
    expect(associationSummary([{ ...primary, projectId: "old", status: "archived", projectStatus: "archived" }]).archivedCount).toBe(1);
  });
  it("classifies archived projects as history and excludes them from gate and payload", () => {
    const archived = { ...delivery, projectId: "old", projectStatus: "archived" as const };
    expect(activeAssociations([primary, archived])).toEqual([primary]);
    expect(historyAssociations([primary, archived])).toEqual([archived]);
    expect(phaseOneDeliveryGate([primary, archived]).kind).toBe("missing");
    expect(requirementProjectsPayload([primary, archived])).toEqual([{ projectId: "web", role: "primary", usage: "context", deliveryRequired: false, moduleMode: "auto", moduleIds: [], position: 0 }]);
  });
  it("summarizes total and required delivery projects", () => expect(associationSummary([primary, delivery, { ...delivery, projectId: "mobile", deliveryRequired: false }])).toMatchObject({ deliveryCount: 2, requiredDeliveryCount: 1 }));
  it("offers every eligible active unassociated project", () => expect(availableProjectChoices([{ id: "api", name: "API", status: "active" }, { id: "mobile", name: "Mobile", status: "active" }, { id: "old", name: "Old", status: "archived" }], [primary])).toEqual([{ id: "api", name: "API", status: "active" }, { id: "mobile", name: "Mobile", status: "active" }]));
  it("reorders active rows deterministically without moving history", () => {
    const archived = { ...delivery, projectId: "old", projectStatus: "archived" as const };
    expect(moveAssociation([primary, archived, delivery], "api", -1).map(item => [item.projectId, item.position])).toEqual([["api", 0], ["web", 1], ["old", 1]]);
  });
  it("enforces one primary and clears required delivery for context", () => {
    expect(setPrimary([primary, delivery], "api").map(item => item.role)).toEqual(["collaborator", "primary"]);
    expect(setUsage([delivery], "api", "context")[0]).toMatchObject({ usage: "context", deliveryRequired: false });
  });
  it("validates selected modules while accepting auto and all", () => {
    expect(validateAssociations([{ ...primary, moduleMode: "selected", moduleIds: [] }], { web: { status: "ready", modules: ["src"] } }).rows[0]?.moduleIds).toBeTruthy();
    expect(validateAssociations([{ ...primary, moduleMode: "selected", moduleIds: ["gone"] }], { web: { status: "ready", modules: ["src"] } }).rows[0]?.moduleIds).toContain("不可用");
    expect(validateAssociations([primary], {}).valid).toBe(true);
    expect(validateAssociations([{ ...primary, moduleMode: "all" }], {}).valid).toBe(true);
    expect(validateAssociations([{ ...primary, moduleMode: "selected", moduleIds: ["src"] }], { web: { status: "error", modules: [], error: "offline" } }).rows[0]?.moduleIds).toContain("不可用");
  });
  it("reports duplicate projects and zero or two primaries", () => {
    expect(validateAssociations([primary, { ...delivery, projectId: "web" }], {}).rows[1]?.projectId).toContain("重复");
    expect(validateAssociations([{ ...primary, role: "collaborator" }], {}).rows[0]?.role).toBeTruthy();
    expect(validateAssociations([primary, { ...delivery, role: "primary" }], {}).rows[1]?.role).toBeTruthy();
  });
  it("warns on material edits at or after a frozen technical design", () => {
    expect(hasMaterialAssociationEdit([primary], [{ ...primary, moduleMode: "all" }], "technical_design", { version: 1 })).toBe(true);
    expect(hasMaterialAssociationEdit([primary], [{ ...primary, position: 4 }], "coding", { version: 1 })).toBe(false);
    expect(hasMaterialAssociationEdit([primary], [{ ...primary, moduleMode: "all" }], "prd", { version: 1 })).toBe(false);
  });
  it("maps API row issues and general errors", () => {
    expect(associationApiErrors(new ApiError("VALIDATION_ERROR", "invalid", { issues: [{ path: [1, "moduleIds"], message: "bad module" }] })).rows[1]?.moduleIds).toBe("bad module");
    expect(associationApiErrors(new Error("offline")).general).toBe("offline");
  });
  it("ignores stale async completion and blocks duplicate submission", () => {
    let state = associationReducer(initialAssociationState([primary]), { type: "submit", requestId: 2 });
    expect(state.busy).toBe(true);
    expect(associationReducer(state, { type: "submit", requestId: 3 })).toBe(state);
    state = associationReducer(state, { type: "failure", requestId: 1, error: "old" });
    expect(state.busy).toBe(true);
    expect(associationReducer(state, { type: "failure", requestId: 2, error: "new" })).toMatchObject({ busy: false, error: "new" });
  });
});
