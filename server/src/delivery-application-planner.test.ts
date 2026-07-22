import { describe, expect, it } from "vitest";
import {
  MAX_DELIVERY_PLAN_DEPENDENCIES,
  MAX_DELIVERY_PLAN_UNITS,
  type DeliveryUnitStatus
} from "@ai-workflow/shared";
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

function oversizedUnits(): DeliveryApplicationUnitInput[] {
  return Array.from({ length: MAX_DELIVERY_PLAN_UNITS + 1 }, (_, index) => unit(`unit-${index}`, index));
}

function oversizedDependencies(): DeliveryApplicationDependencyInput[] {
  return Array.from({ length: MAX_DELIVERY_PLAN_DEPENDENCIES + 1 }, () => dependency("a", "b"));
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

  it.each([
    ["self edge", [dependency("a", "a")], "DELIVERY_DEPENDENCY_SELF_EDGE"],
    ["duplicate edge", [dependency("a", "b"), dependency("a", "b")], "DELIVERY_DEPENDENCY_DUPLICATE_EDGE"],
    ["cycle", [dependency("a", "b"), dependency("b", "a")], "DELIVERY_DEPENDENCY_CYCLE"]
  ])("validates a skipped-only %s before filtering incident edges", (_, dependencies, error) => {
    expect(() => buildApplicationPlan({
      units: [
        unit("a", 0, { required: false, status: "skipped" }),
        unit("b", 1, { required: false, status: "skipped" })
      ],
      dependencies
    })).toThrow(error);
  });

  it("enforces the shared unit limit before filtering skipped units", () => {
    expect(() => buildApplicationPlan({
      units: Array.from({ length: MAX_DELIVERY_PLAN_UNITS + 1 }, (_, index) => unit(`unit-${index}`, index, {
        required: false,
        status: "skipped"
      })),
      dependencies: []
    })).toThrow("DELIVERY_PLAN_UNIT_LIMIT");
  });

  it("enforces the shared dependency limit before filtering skipped incident edges", () => {
    const skipped = [
      unit("a", 0, { required: false, status: "skipped" }),
      unit("b", 1, { required: false, status: "skipped" })
    ];
    expect(() => buildApplicationPlan({
      units: skipped,
      dependencies: Array.from({ length: MAX_DELIVERY_PLAN_DEPENDENCIES + 1 }, () => dependency("a", "b"))
    })).toThrow("DELIVERY_PLAN_DEPENDENCY_LIMIT");
  });

  it.each([
    ["dense-array scanning", () => new Array<DeliveryApplicationUnitInput>(MAX_DELIVERY_PLAN_UNITS + 1)],
    ["element validation", () => {
      const units = oversizedUnits();
      units[MAX_DELIVERY_PLAN_UNITS] = null as never;
      return units;
    }],
    ["accessor element inspection", () => {
      const units = oversizedUnits();
      Object.defineProperty(units, MAX_DELIVERY_PLAN_UNITS, {
        configurable: true,
        get(): never { throw new Error("UNIT_ELEMENT_ACCESSED"); }
      });
      return units;
    }],
    ["mapping", () => {
      const units = oversizedUnits();
      Object.defineProperty(units, "map", {
        configurable: true,
        get(): never { throw new Error("UNIT_MAPPING_STARTED"); }
      });
      return units;
    }]
  ])("rejects oversized units before %s", (_, makeUnits) => {
    expect(() => buildApplicationPlan({ units: makeUnits(), dependencies: [] }))
      .toThrow("DELIVERY_PLAN_UNIT_LIMIT");
  });

  it.each([
    ["dense-array scanning", () => new Array<DeliveryApplicationDependencyInput>(
      MAX_DELIVERY_PLAN_DEPENDENCIES + 1
    )],
    ["element validation", () => {
      const dependencies = oversizedDependencies();
      dependencies[MAX_DELIVERY_PLAN_DEPENDENCIES] = null as never;
      return dependencies;
    }],
    ["accessor element inspection", () => {
      const dependencies = oversizedDependencies();
      Object.defineProperty(dependencies, MAX_DELIVERY_PLAN_DEPENDENCIES, {
        configurable: true,
        get(): never { throw new Error("DEPENDENCY_ELEMENT_ACCESSED"); }
      });
      return dependencies;
    }],
    ["mapping", () => {
      const dependencies = oversizedDependencies();
      Object.defineProperty(dependencies, "map", {
        configurable: true,
        get(): never { throw new Error("DEPENDENCY_MAPPING_STARTED"); }
      });
      return dependencies;
    }]
  ])("rejects oversized dependencies before %s", (_, makeDependencies) => {
    expect(() => buildApplicationPlan({
      units: [unit("a", 0), unit("b", 1)],
      dependencies: makeDependencies()
    })).toThrow("DELIVERY_PLAN_DEPENDENCY_LIMIT");
  });

  it("gives the unit limit precedence when both raw arrays are oversized", () => {
    expect(() => buildApplicationPlan({
      units: new Array<DeliveryApplicationUnitInput>(MAX_DELIVERY_PLAN_UNITS + 1),
      dependencies: new Array<DeliveryApplicationDependencyInput>(MAX_DELIVERY_PLAN_DEPENDENCIES + 1)
    })).toThrow("DELIVERY_PLAN_UNIT_LIMIT");
  });

  it("does not read dependency length after detecting oversized units", () => {
    const dependencies = new Proxy([] as DeliveryApplicationDependencyInput[], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("DEPENDENCY_LENGTH_ACCESSED");
        return Reflect.get(target, property, receiver);
      }
    });

    expect(() => buildApplicationPlan({ units: oversizedUnits(), dependencies }))
      .toThrow("DELIVERY_PLAN_UNIT_LIMIT");
  });

  it("does not inspect unit elements after detecting oversized dependencies", () => {
    const units = [unit("a", 0)];
    Object.defineProperty(units, 0, {
      configurable: true,
      get(): never { throw new Error("UNIT_ELEMENT_ACCESSED"); }
    });

    expect(() => buildApplicationPlan({ units, dependencies: oversizedDependencies() }))
      .toThrow("DELIVERY_PLAN_DEPENDENCY_LIMIT");
  });

  it.each([
    ["own map override", () => {
      const units = [unit("backend", 0)];
      Object.defineProperty(units, "map", { configurable: true, value: () => [] });
      return units;
    }],
    ["inherited map override", () => {
      const units = [unit("backend", 0)];
      Object.setPrototypeOf(units, { map: () => [] });
      return units;
    }],
    ["own map accessor", () => {
      const units = [unit("backend", 0)];
      Object.defineProperty(units, "map", {
        configurable: true,
        get(): never { throw new Error("UNIT_MAP_ACCESSED"); }
      });
      return units;
    }]
  ])("copies units before using a %s", (_, makeUnits) => {
    expect(buildApplicationPlan({ units: makeUnits(), dependencies: [] })).toEqual(["backend"]);
  });

  it.each([
    ["own map override", () => {
      const dependencies = [dependency("backend", "frontend")];
      Object.defineProperty(dependencies, "map", { configurable: true, value: () => [] });
      return dependencies;
    }],
    ["inherited map override", () => {
      const dependencies = [dependency("backend", "frontend")];
      Object.setPrototypeOf(dependencies, { map: () => [] });
      return dependencies;
    }],
    ["own map accessor", () => {
      const dependencies = [dependency("backend", "frontend")];
      Object.defineProperty(dependencies, "map", {
        configurable: true,
        get(): never { throw new Error("DEPENDENCY_MAP_ACCESSED"); }
      });
      return dependencies;
    }]
  ])("copies dependencies before using a %s", (_, makeDependencies) => {
    expect(buildApplicationPlan({
      units: [unit("frontend", 0), unit("backend", 1)],
      dependencies: makeDependencies()
    })).toEqual(["backend", "frontend"]);
  });

  it.each([
    ["unit", () => {
      const units = [unit("backend", 0)];
      Object.defineProperty(units, 0, {
        configurable: true,
        get(): never { throw new Error("UNIT_ELEMENT_ACCESSED"); }
      });
      return { units, dependencies: [] };
    }],
    ["dependency", () => {
      const dependencies = [dependency("backend", "frontend")];
      Object.defineProperty(dependencies, 0, {
        configurable: true,
        get(): never { throw new Error("DEPENDENCY_ELEMENT_ACCESSED"); }
      });
      return { units: [unit("backend", 0), unit("frontend", 1)], dependencies };
    }]
  ])("rejects a within-limit %s element accessor without executing it", (_, makeInput) => {
    expect(() => buildApplicationPlan(makeInput())).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
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
    ["leading whitespace", " backend"],
    ["trailing whitespace", "backend "],
    ["NUL-containing", "back\0end"],
    ["overlong", "x".repeat(257)]
  ])("rejects a %s unit ID", (_, id) => {
    expect(() => buildApplicationPlan({ units: [unit(id, 0)], dependencies: [] }))
      .toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["empty upstream", dependency("", "b")],
    ["blank downstream", dependency("a", "   ")],
    ["leading-whitespace upstream", dependency(" a", "b")],
    ["trailing-whitespace downstream", dependency("a", "b ")],
    ["NUL-containing endpoint", dependency("a\0", "b")],
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
    ["missing required", {
      units: [{ id: "backend", position: 0, status: "ready_for_acceptance" }],
      dependencies: []
    }],
    ["non-boolean required", {
      units: [{ id: "backend", position: 0, required: "yes", status: "ready_for_acceptance" }],
      dependencies: []
    }],
    ["missing status", {
      units: [{ id: "backend", position: 0, required: true }],
      dependencies: []
    }],
    ["null status", {
      units: [{ id: "backend", position: 0, required: true, status: null }],
      dependencies: []
    }],
    ["non-string status", {
      units: [{ id: "backend", position: 0, required: true, status: 1 }],
      dependencies: []
    }],
    ["out-of-enum status", {
      units: [{ id: "backend", position: 0, required: true, status: "verified" }],
      dependencies: []
    }],
    ["missing release condition", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [{ upstreamUnitId: "a", downstreamUnitId: "b" }]
    }],
    ["null release condition", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [{ upstreamUnitId: "a", downstreamUnitId: "b", releaseCondition: null }]
    }],
    ["numeric release condition", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [{ upstreamUnitId: "a", downstreamUnitId: "b", releaseCondition: 1 }]
    }],
    ["wrong release condition", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [{ upstreamUnitId: "a", downstreamUnitId: "b", releaseCondition: "manual" }]
    }],
    ["sparse units", { units: new Array<DeliveryApplicationUnitInput>(1), dependencies: [] }],
    ["sparse dependencies", {
      units: [unit("backend", 0)],
      dependencies: new Array<DeliveryApplicationDependencyInput>(1)
    }]
  ])("rejects a %s shape", (_, input) => {
    expect(() => buildApplicationPlan(input as never)).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["input", Object.create({ units: [], dependencies: [] })],
    ["unit", {
      units: [Object.create(unit("backend", 0))],
      dependencies: []
    }],
    ["dependency", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [Object.create(dependency("a", "b"))]
    }]
  ])("rejects a %s with prototype-inherited fields", (_, input) => {
    expect(() => buildApplicationPlan(input as never)).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it.each([
    ["input", {
      get units(): never { throw new Error("INPUT_ACCESSOR_EXECUTED"); },
      dependencies: []
    }],
    ["unit", {
      units: [{
        id: "backend",
        position: 0,
        required: true,
        get status(): never { throw new Error("UNIT_ACCESSOR_EXECUTED"); }
      }],
      dependencies: []
    }],
    ["dependency", {
      units: [unit("a", 0), unit("b", 1)],
      dependencies: [{
        upstreamUnitId: "a",
        downstreamUnitId: "b",
        get releaseCondition(): never { throw new Error("DEPENDENCY_ACCESSOR_EXECUTED"); }
      }]
    }]
  ])("rejects a %s accessor without executing it", (_, input) => {
    expect(() => buildApplicationPlan(input as never)).toThrow("DELIVERY_APPLICATION_PLAN_INVALID");
  });

  it("accepts plain null-prototype input records", () => {
    const backend = Object.assign(Object.create(null), unit("backend", 0));
    const frontend = Object.assign(Object.create(null), unit("frontend", 1));
    const edge = Object.assign(Object.create(null), dependency("backend", "frontend"));
    const input = Object.assign(Object.create(null), {
      units: [backend, frontend],
      dependencies: [edge]
    });

    expect(buildApplicationPlan(input)).toEqual(["backend", "frontend"]);
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
