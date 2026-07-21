import { deliveryUnitStatuses } from "./delivery-unit.js";

export const aggregateDeliveryStatuses = [
  "in_progress",
  "awaiting_acceptance",
  "applying",
  "partially_applied",
  "completed",
  "blocked"
] as const;

export type AggregateDeliveryStatus = typeof aggregateDeliveryStatuses[number];
type DeliveryUnitStatus = typeof deliveryUnitStatuses[number];

export type AggregateDeliveryUnitInput = {
  status: DeliveryUnitStatus;
  required: boolean;
};

const blockingDeliveryUnitStatuses = new Set<DeliveryUnitStatus>([
  "potentially_stale",
  "conflicted",
  "failed"
]);

export function aggregateDeliveryStatus(
  units: readonly AggregateDeliveryUnitInput[]
): AggregateDeliveryStatus {
  const participatingUnits = units.filter((unit) => unit.required || unit.status !== "skipped");

  if (participatingUnits.every((unit) => unit.status === "applied")) return "completed";
  if (participatingUnits.some((unit) => unit.status === "applying")) return "applying";

  const requiredUnits = participatingUnits.filter((unit) => unit.required);
  if (
    requiredUnits.some((unit) => unit.status === "applied")
    && requiredUnits.some((unit) => unit.status !== "applied")
  ) return "partially_applied";

  if (participatingUnits.some((unit) => blockingDeliveryUnitStatuses.has(unit.status))) {
    return "blocked";
  }
  if (participatingUnits.every((unit) => unit.status === "ready_for_acceptance")) {
    return "awaiting_acceptance";
  }
  return "in_progress";
}
