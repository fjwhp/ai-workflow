import { describe, expect, it } from "vitest";
import { validateDeliveryGraph } from "./delivery-unit.js";

describe("validateDeliveryGraph", () => {
  it("orders an acyclic backend-to-frontend graph", () => {
    expect(validateDeliveryGraph(["backend", "frontend"], [{
      upstreamProjectId: "backend",
      downstreamProjectId: "frontend",
      releaseCondition: "automated_testing_passed"
    }]).order).toEqual(["backend", "frontend"]);
  });

  it("uses the original project order to break ties", () => {
    expect(validateDeliveryGraph(["docs", "backend", "frontend"], [{
      upstreamProjectId: "backend",
      downstreamProjectId: "frontend",
      releaseCondition: "automated_testing_passed"
    }]).order).toEqual(["docs", "backend", "frontend"]);
  });

  it("reorders current candidates when a dependency becomes available", () => {
    expect(validateDeliveryGraph(["backend", "frontend", "docs"], [{
      upstreamProjectId: "backend",
      downstreamProjectId: "frontend",
      releaseCondition: "automated_testing_passed"
    }]).order).toEqual(["backend", "frontend", "docs"]);
  });

  it("rejects a dependency cycle", () => {
    expect(() => validateDeliveryGraph(["a", "b"], [
      { upstreamProjectId: "a", downstreamProjectId: "b", releaseCondition: "automated_testing_passed" },
      { upstreamProjectId: "b", downstreamProjectId: "a", releaseCondition: "automated_testing_passed" }
    ])).toThrow("DELIVERY_DEPENDENCY_CYCLE");
  });

  it("rejects a self dependency", () => {
    expect(() => validateDeliveryGraph(["backend"], [{
      upstreamProjectId: "backend",
      downstreamProjectId: "backend",
      releaseCondition: "automated_testing_passed"
    }])).toThrow("DELIVERY_DEPENDENCY_SELF_EDGE");
  });

  it("rejects a duplicate dependency", () => {
    const dependency = {
      upstreamProjectId: "backend",
      downstreamProjectId: "frontend",
      releaseCondition: "automated_testing_passed" as const
    };
    expect(() => validateDeliveryGraph(["backend", "frontend"], [dependency, dependency]))
      .toThrow("DELIVERY_DEPENDENCY_DUPLICATE_EDGE");
  });

  it.each([
    ["missing upstream", "missing", "frontend"],
    ["missing downstream", "backend", "missing"]
  ])("rejects a %s endpoint", (_, upstreamProjectId, downstreamProjectId) => {
    expect(() => validateDeliveryGraph(["backend", "frontend"], [{
      upstreamProjectId,
      downstreamProjectId,
      releaseCondition: "automated_testing_passed"
    }])).toThrow("DELIVERY_DEPENDENCY_MISSING_ENDPOINT");
  });
});
