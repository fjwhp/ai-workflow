import {
  deliveryUnitStatuses,
  MAX_DELIVERY_PLAN_DEPENDENCIES,
  MAX_DELIVERY_PLAN_UNITS,
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
  readonly releaseCondition: "automated_testing_passed";
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
  const orderedUnitIds = orderUnitIds(validatedUnits);
  const allGraphDependencies = mapGraphDependencies(validatedDependencies);

  validateDeliveryGraph(orderedUnitIds, allGraphDependencies);

  const skippedUnitIds = new Set(validatedUnits
    .filter(({ unit }) => !unit.required && unit.status === "skipped")
    .map(({ unit }) => unit.id));
  const participatingUnits = validatedUnits.filter(({ unit }) => !skippedUnitIds.has(unit.id));

  if (participatingUnits.some(({ unit }) => unit.status !== "ready_for_acceptance")) {
    throw new Error("DELIVERY_UNIT_NOT_VERIFIED");
  }

  const participatingUnitIds = orderUnitIds(participatingUnits);
  const participatingDependencies = validatedDependencies
    .filter((dependency) => {
      const bothEndpointsExist = unitIds.has(dependency.upstreamUnitId)
        && unitIds.has(dependency.downstreamUnitId);
      return !bothEndpointsExist
        || (!skippedUnitIds.has(dependency.upstreamUnitId)
          && !skippedUnitIds.has(dependency.downstreamUnitId));
    });

  return validateDeliveryGraph(
    participatingUnitIds,
    mapGraphDependencies(participatingDependencies)
  ).order;
}

function validateInput(input: unknown): {
  units: unknown[];
  dependencies: unknown[];
} {
  if (!isPlainRecord(input)) invalidPlan();
  const units = ownDataValue(input, "units");
  const dependencies = ownDataValue(input, "dependencies");
  if (!Array.isArray(units) || !Array.isArray(dependencies)) invalidPlan();
  const unitCount = units.length;
  const dependencyCount = dependencies.length;
  if (unitCount > MAX_DELIVERY_PLAN_UNITS) throw new Error("DELIVERY_PLAN_UNIT_LIMIT");
  if (dependencyCount > MAX_DELIVERY_PLAN_DEPENDENCIES) {
    throw new Error("DELIVERY_PLAN_DEPENDENCY_LIMIT");
  }
  return {
    units: copyDenseArray(units, unitCount),
    dependencies: copyDenseArray(dependencies, dependencyCount)
  };
}

function validateUnit(value: unknown): DeliveryApplicationUnitInput {
  if (!isPlainRecord(value)) invalidPlan();
  const id = ownDataValue(value, "id");
  const position = ownDataValue(value, "position");
  const required = ownDataValue(value, "required");
  const status = ownDataValue(value, "status");
  if (!validId(id)
    || typeof position !== "number"
    || !Number.isSafeInteger(position)
    || typeof required !== "boolean"
    || typeof status !== "string"
    || !deliveryUnitStatusSet.has(status as DeliveryUnitStatus)) {
    invalidPlan();
  }
  return { id, position, required, status: status as DeliveryUnitStatus };
}

function validateDependency(value: unknown): DeliveryApplicationDependencyInput {
  if (!isPlainRecord(value)) invalidPlan();
  const upstreamUnitId = ownDataValue(value, "upstreamUnitId");
  const downstreamUnitId = ownDataValue(value, "downstreamUnitId");
  const releaseCondition = ownDataValue(value, "releaseCondition");
  if (!validId(upstreamUnitId)
    || !validId(downstreamUnitId)
    || releaseCondition !== "automated_testing_passed") {
    invalidPlan();
  }
  return { upstreamUnitId, downstreamUnitId, releaseCondition };
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value.length <= MAX_DELIVERY_UNIT_ID_LENGTH
    && !value.includes("\0");
}

function orderUnitIds(units: Array<{
  unit: DeliveryApplicationUnitInput;
  sourceIndex: number;
}>): string[] {
  return units
    .slice()
    .sort((left, right) => left.unit.position - right.unit.position || left.sourceIndex - right.sourceIndex)
    .map(({ unit }) => unit.id);
}

function mapGraphDependencies(dependencies: DeliveryApplicationDependencyInput[]) {
  return dependencies.map(({ upstreamUnitId, downstreamUnitId, releaseCondition }) => ({
    upstreamProjectId: upstreamUnitId,
    downstreamProjectId: downstreamUnitId,
    releaseCondition
  }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    invalidPlan();
  }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) invalidPlan();
  return descriptor.value;
}

function copyDenseArray(value: unknown[], length: number): unknown[] {
  const copy = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, index);
    } catch {
      invalidPlan();
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) invalidPlan();
    copy[index] = descriptor.value;
  }
  return copy;
}

function invalidPlan(): never {
  throw new Error("DELIVERY_APPLICATION_PLAN_INVALID");
}
