import { describe, expect, expectTypeOf, it } from "vitest";
import {
  aggregateDeliveryStatuses,
  aggregateDeliveryStatus,
  type AggregateDeliveryStatus,
  type AggregateDeliveryUnitInput
} from "./delivery-application.js";

const required = (status: AggregateDeliveryUnitInput["status"]): AggregateDeliveryUnitInput => ({
  status,
  required: true
});

const optional = (status: AggregateDeliveryUnitInput["status"]): AggregateDeliveryUnitInput => ({
  status,
  required: false
});

describe("aggregate delivery application contract", () => {
  it("exposes only the planned aggregate statuses", () => {
    const statuses: readonly AggregateDeliveryStatus[] = aggregateDeliveryStatuses;

    expect(statuses).toEqual([
      "in_progress",
      "awaiting_acceptance",
      "applying",
      "partially_applied",
      "completed",
      "blocked"
    ]);
    expectTypeOf(aggregateDeliveryStatus([])).toEqualTypeOf<AggregateDeliveryStatus>();
  });

  it.each([
    [[required("ready_for_acceptance"), required("ready_for_acceptance")], "awaiting_acceptance"],
    [[required("applied"), required("conflicted")], "partially_applied"],
    [[required("applied"), required("applied")], "completed"]
  ] as const)("aggregates the plan example %# as %s", (units, expected) => {
    expect(aggregateDeliveryStatus(units)).toBe(expected);
  });

  it("treats no participating units as completed", () => {
    expect(aggregateDeliveryStatus([])).toBe("completed");
    expect(aggregateDeliveryStatus([optional("skipped"), optional("skipped")])).toBe("completed");
    expect(aggregateDeliveryStatus([required("applied"), optional("skipped")])).toBe("completed");
  });

  it("lets an unskipped optional unit block or keep delivery in progress", () => {
    expect(aggregateDeliveryStatus([required("ready_for_acceptance"), optional("failed")])).toBe("blocked");
    expect(aggregateDeliveryStatus([required("ready_for_acceptance"), optional("waiting_dependency")]))
      .toBe("in_progress");
  });

  it("gives applying precedence over partial application and blockers", () => {
    expect(aggregateDeliveryStatus([
      required("applied"),
      required("applying"),
      optional("failed")
    ])).toBe("applying");
  });

  it.each(["potentially_stale", "conflicted", "failed"] as const)(
    "blocks on a participating %s unit",
    (status) => {
      expect(aggregateDeliveryStatus([required(status)])).toBe("blocked");
      expect(aggregateDeliveryStatus([optional(status)])).toBe("blocked");
    }
  );

  it("gives partial application precedence over later conflicts and failures", () => {
    expect(aggregateDeliveryStatus([required("applied"), required("conflicted")]))
      .toBe("partially_applied");
    expect(aggregateDeliveryStatus([required("applied"), required("failed")]))
      .toBe("partially_applied");
  });

  it("requires both applied and unapplied required units for partial application", () => {
    expect(aggregateDeliveryStatus([optional("applied"), required("ready")])).toBe("in_progress");
    expect(aggregateDeliveryStatus([required("applied"), optional("ready")])).toBe("in_progress");
  });

  it("rejects aggregate statuses as delivery unit statuses at compile time", () => {
    if (false) {
      // @ts-expect-error aggregate statuses are not delivery unit statuses
      const invalidInput: AggregateDeliveryUnitInput = { status: "completed", required: true };
      expect(invalidInput).toBeDefined();
    }
  });
});
