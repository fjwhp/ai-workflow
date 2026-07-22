import { describe, expect, it } from "vitest";
import type { DeliveryUnitStatus } from "@ai-workflow/shared";
import {
  buildApplicationPlan,
  type DeliveryApplicationDependencyInput,
  type DeliveryApplicationUnitInput
} from "./delivery-application-planner.js";

function unit(
  id: string,
  position: number,
  options: { required?: boolean; status?: DeliveryUnitStatus } = {}
): DeliveryApplicationUnitInput {
  return {
    id,
    position,
    required: options.required ?? true,
    status: options.status ?? "ready_for_acceptance"
  };
}

function dependency(
  upstreamUnitId: string,
  downstreamUnitId: string
): DeliveryApplicationDependencyInput {
  return { upstreamUnitId, downstreamUnitId, releaseCondition: "automated_testing_passed" };
}

describe("buildApplicationPlan", () => {
  it("orders backend before frontend and preserves position and source order for peers", () => {
    const backend = unit("backend", 10);
    const firstWorker = unit("worker-a", 20);
    const secondWorker = unit("worker-b", 20);
    const frontend = unit("frontend", 30);

    expect(buildApplicationPlan({
      units: [frontend, firstWorker, backend, secondWorker],
      dependencies: [dependency("backend", "frontend")]
    })).toEqual(["backend", "worker-a", "worker-b", "frontend"]);
  });

  it.each([
    ["required", unit("backend", 0, { status: "failed" })],
    ["optional unskipped", unit("docs", 0, { required: false, status: "failed" })]
  ])("rejects a %s unit that is not ready for acceptance", (_, unverified) => {
    expect(() => buildApplicationPlan({ units: [unverified], dependencies: [] }))
      .toThrow("DELIVERY_UNIT_NOT_VERIFIED");
  });

  it("omits optional skipped units and their incident dependencies", () => {
    expect(buildApplicationPlan({
      units: [
        unit("frontend", 30),
        unit("docs", 20, { required: false, status: "skipped" }),
        unit("backend", 10)
      ],
      dependencies: [dependency("backend", "docs"), dependency("docs", "frontend")]
    })).toEqual(["backend", "frontend"]);
  });

  it("does not omit a required skipped unit", () => {
    expect(() => buildApplicationPlan({
      units: [unit("backend", 0, { status: "skipped" })],
      dependencies: []
    })).toThrow("DELIVERY_UNIT_NOT_VERIFIED");
  });

  it.each([
    ["cycle", [dependency("a", "b"), dependency("b", "a")], "DELIVERY_DEPENDENCY_CYCLE"],
    ["duplicate edge", [dependency("a", "b"), dependency("a", "b")], "DELIVERY_DEPENDENCY_DUPLICATE_EDGE"],
    ["self edge", [dependency("a", "a")], "DELIVERY_DEPENDENCY_SELF_EDGE"],
    ["missing endpoint", [dependency("a", "missing")], "DELIVERY_DEPENDENCY_MISSING_ENDPOINT"]
  ])("preserves the shared graph error for a %s", (_, dependencies, error) => {
    expect(() => buildApplicationPlan({ units: [unit("a", 0), unit("b", 1)], dependencies }))
      .toThrow(error);
  });

  it("does not hide a missing endpoint behind a known skipped unit", () => {
    expect(() => buildApplicationPlan({
      units: [unit("docs", 0, { required: false, status: "skipped" })],
      dependencies: [dependency("docs", "missing")]
    })).toThrow("DELIVERY_DEPENDENCY_MISSING_ENDPOINT");
  });

  it("rejects duplicate unit IDs with the planner input error", () => {
    expect(() => buildApplicationPlan({
      units: [unit("backend", 0), unit("backend", 1)],
      dependencies: []
    })).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects a %s unit position", (_, position) => {
    expect(() => buildApplicationPlan({ units: [unit("backend", position)], dependencies: [] }))
      .toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["overlong", "x".repeat(257)]
  ])("rejects a %s unit ID", (_, id) => {
    expect(() => buildApplicationPlan({ units: [unit(id, 0)], dependencies: [] }))
      .toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["empty upstream", dependency("", "b")],
    ["blank downstream", dependency("a", "   ")],
    ["overlong endpoint", dependency("x".repeat(257), "b")]
  ])("rejects a dependency with an %s", (_, invalidDependency) => {
    expect(() => buildApplicationPlan({
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [invalidDependency]
    })).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["null input", null],
    ["null units", { units: null, dependencies: [] }],
    ["null dependencies", { units: [], dependencies: null }],
    ["null unit", { units: [null], dependencies: [] }],
    ["null dependency", { units: [unit("backend", 0)], dependencies: [null] }],
    ["sparse units", { units: new Array<DeliveryApplicationUnitInput>(1), dependencies: [] }],
    ["sparse dependencies", {
      units: [unit("backend", 0)],
      dependencies: new Array<DeliveryApplicationDependencyInput>(1)
    }]
  ])("rejects a %s shape", (_, input) => {
    expect(() => buildApplicationPlan(input as never)).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it("does not mutate frozen input arrays or objects", () => {
    const units = Object.freeze([
      Object.freeze(unit("frontend", 2)),
      Object.freeze(unit("backend", 1))
    ]);
    const dependencies = Object.freeze([
      Object.freeze(dependency("backend", "frontend"))
    ]);
    const input = Object.freeze({ units, dependencies });

    expect(buildApplicationPlan(input)).toEqual(["backend", "frontend"]);
    expect(input.units).toEqual([unit("frontend", 2), unit("backend", 1)]);
    expect(input.dependencies).toEqual([dependency("backend", "frontend")]);
  });

  it("returns deterministic output across repeated calls", () => {
    const input = {
      units: [unit("c", 1), unit("a", 1), unit("b", 1)],
      dependencies: [dependency("a", "b")]
    } as const;

    const first = buildApplicationPlan(input);
    expect(Array.from({ length: 10 }, () => buildApplicationPlan(input)))
      .toEqual(Array.from({ length: 10 }, () => first));
  });

  it.each([
    ["empty", { units: [], dependencies: [] }],
    ["all optional skipped", {
      units: [
        unit("docs", 0, { required: false, status: "skipped" }),
        unit("examples", 1, { required: false, status: "skipped" })
      ],
      dependencies: [dependency("docs", "examples")]
    }]
  ])("returns an empty plan for %s input", (_, input) => {
    expect(buildApplicationPlan(input)).toEqual([]);
  });
});
