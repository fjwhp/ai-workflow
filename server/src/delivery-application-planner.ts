import {
  deliveryUnitStatuses,
  validateDeliveryGraph,
  type DeliveryUnitStatus
} from "@ai-workflow/shared";

const MAX_DELIVERY_UNIT_ID_LENGTH = 256;
const deliveryUnitStatusSet = new Set<DeliveryUnitStatus>(deliveryUnitStatuses);

export interface DeliveryApplicationUnitInput {
  readonly id: string;
  readonly position: number;
  readonly required: boolean;
  readonly status: DeliveryUnitStatus;
}

export interface DeliveryApplicationDependencyInput {
  readonly upstreamUnitId: string;
  readonly downstreamUnitId: string;
  readonly releaseCondition?: "automated_testing_passed";
}

export interface DeliveryApplicationPlanInput {
  readonly units: readonly DeliveryApplicationUnitInput[];
  readonly dependencies: readonly DeliveryApplicationDependencyInput[];
}

export function buildApplicationPlan(input: DeliveryApplicationPlanInput): string[] {
  const { units, dependencies } = validateInput(input);
  const unitIds = new Set<string>();
  const validatedUnits = units.map((value, sourceIndex) => {
    const unit = validateUnit(value);
    if (unitIds.has(unit.id)) invalidPlan();
    unitIds.add(unit.id);
    return { unit, sourceIndex };
  });
  const validatedDependencies = dependencies.map(validateDependency);

  const skippedUnitIds = new Set(validatedUnits
    .filter(({ unit }) => !unit.required && unit.status === "skipped")
    .map(({ unit }) => unit.id));
  const participatingUnits = validatedUnits.filter(({ unit }) => !skippedUnitIds.has(unit.id));

  if (participatingUnits.some(({ unit }) => unit.status !== "ready_for_acceptance")) {
    throw new Error("DELIVERY_UNIT_NOT_VERIFIED");
  }

  const orderedUnitIds = participatingUnits
    .slice()
    .sort((left, right) => left.unit.position - right.unit.position || left.sourceIndex - right.sourceIndex)
    .map(({ unit }) => unit.id);
  const graphDependencies = validatedDependencies
    .filter((dependency) => {
      const bothEndpointsExist = unitIds.has(dependency.upstreamUnitId)
        && unitIds.has(dependency.downstreamUnitId);
      return !bothEndpointsExist
        || (!skippedUnitIds.has(dependency.upstreamUnitId)
          && !skippedUnitIds.has(dependency.downstreamUnitId));
    })
    .map(({ upstreamUnitId, downstreamUnitId }) => ({
      upstreamProjectId: upstreamUnitId,
      downstreamProjectId: downstreamUnitId,
      releaseCondition: "automated_testing_passed" as const
    }));

  return validateDeliveryGraph(orderedUnitIds, graphDependencies).order;
}

function validateInput(input: unknown): {
  units: unknown[];
  dependencies: unknown[];
} {
  if (!isObject(input)
    || !Array.isArray(input.units)
    || !Array.isArray(input.dependencies)
    || !isDenseArray(input.units)
    || !isDenseArray(input.dependencies)) {
    invalidPlan();
  }
  return { units: input.units, dependencies: input.dependencies };
}

function validateUnit(value: unknown): DeliveryApplicationUnitInput {
  if (!isObject(value)
    || !validId(value.id)
    || !Number.isSafeInteger(value.position)
    || typeof value.required !== "boolean"
    || typeof value.status !== "string"
    || !deliveryUnitStatusSet.has(value.status as DeliveryUnitStatus)) {
    invalidPlan();
  }
  return value as unknown as DeliveryApplicationUnitInput;
}

function validateDependency(value: unknown): DeliveryApplicationDependencyInput {
  if (!isObject(value) || !validId(value.upstreamUnitId) || !validId(value.downstreamUnitId)) invalidPlan();
  return value as unknown as DeliveryApplicationDependencyInput;
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_DELIVERY_UNIT_ID_LENGTH
    && !value.includes("\0");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDenseArray(value: unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function invalidPlan(): never {
  throw new Error("DELIVERY_APPLICATION_PLAN_INVALID");
}
