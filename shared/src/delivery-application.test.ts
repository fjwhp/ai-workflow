import { describe, expect, expectTypeOf, it } from "vitest";
import {
  aggregateDeliveryStatuses,
  aggregateDeliveryStatus,
  deliveryUnitStatuses,
  type AggregateDeliveryStatus,
  type AggregateDeliveryUnitInput,
  type DeliveryUnitStatus
} from "./index.js";

const required = (status: AggregateDeliveryUnitInput["status"]): AggregateDeliveryUnitInput => ({
  status,
  required: true
});

const optional = (status: AggregateDeliveryUnitInput["status"]): AggregateDeliveryUnitInput => ({
  status,
  required: false
});

describe("aggregate delivery application contract", () => {
  it("exports the aggregate and delivery unit contracts from the public barrel", () => {
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
    expectTypeOf<AggregateDeliveryUnitInput["status"]>().toEqualTypeOf<DeliveryUnitStatus>();
  });

  const requiredStatusExpectations = {
    waiting_dependency: "in_progress",
    ready: "in_progress",
    running: "in_progress",
    awaiting_gate: "in_progress",
    returned: "in_progress",
    potentially_stale: "blocked",
    ready_for_acceptance: "awaiting_acceptance",
    applying: "applying",
    applied: "completed",
    conflicted: "blocked",
    failed: "blocked",
    skipped: "in_progress"
  } satisfies Record<DeliveryUnitStatus, AggregateDeliveryStatus>;

  const optionalStatusExpectations = {
    waiting_dependency: "in_progress",
    ready: "in_progress",
    running: "in_progress",
    awaiting_gate: "in_progress",
    returned: "in_progress",
    potentially_stale: "blocked",
    ready_for_acceptance: "awaiting_acceptance",
    applying: "applying",
    applied: "completed",
    conflicted: "blocked",
    failed: "blocked",
    skipped: "completed"
  } satisfies Record<DeliveryUnitStatus, AggregateDeliveryStatus>;

  it.each(deliveryUnitStatuses)("aggregates a required %s unit", (status) => {
    expect(aggregateDeliveryStatus([required(status)])).toBe(requiredStatusExpectations[status]);
  });

  it.each(deliveryUnitStatuses)("aggregates an optional %s unit", (status) => {
    expect(aggregateDeliveryStatus([optional(status)])).toBe(optionalStatusExpectations[status]);
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
