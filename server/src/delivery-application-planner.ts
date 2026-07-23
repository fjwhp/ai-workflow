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

export interface FrozenApplicationPlanEntry {
  readonly unitId: string;
  readonly evidenceVersion: number;
}

export interface FrozenApplicationUnitState extends DeliveryApplicationUnitInput {
  readonly evidenceVersion: number;
}

export interface FrozenApplicationDependencyState extends DeliveryApplicationDependencyInput {
  readonly releasedByEvidenceVersion: number | null;
  readonly releasedAt: string | null;
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

export function frozenApplicationRetryPlanValid(input: {
  entries: readonly FrozenApplicationPlanEntry[];
  cursor: number;
  targetUnitId: string;
  units: readonly FrozenApplicationUnitState[];
  dependencies: readonly FrozenApplicationDependencyState[];
}): boolean {
  try {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor >= input.entries.length
      || input.entries[input.cursor]?.unitId !== input.targetUnitId) return false;
    const unitIds = new Set(input.units.map((unit) => unit.id));
    if (unitIds.size !== input.units.length) return false;
    const allOrderedIds = orderUnitIds(input.units.map((unit, sourceIndex) => ({ unit, sourceIndex })));
    validateDeliveryGraph(allOrderedIds, mapGraphDependencies([...input.dependencies]));
    const skipped = new Set(input.units
      .filter((unit) => !unit.required && unit.status === "skipped")
      .map((unit) => unit.id));
    const participating = input.units.filter((unit) => !skipped.has(unit.id));
    const orderedIds = allOrderedIds.filter((unitId) => !skipped.has(unitId));
    const participatingDependencies = input.dependencies.filter((dependency) => {
      const bothEndpointsExist = unitIds.has(dependency.upstreamUnitId)
        && unitIds.has(dependency.downstreamUnitId);
      return !bothEndpointsExist
        || (!skipped.has(dependency.upstreamUnitId) && !skipped.has(dependency.downstreamUnitId));
    });
    const expected = validateDeliveryGraph(
      orderedIds,
      mapGraphDependencies(participatingDependencies)
    ).order;
    if (expected.length !== input.entries.length
      || expected.some((unitId, index) => input.entries[index]?.unitId !== unitId)) return false;
    const byId = new Map(input.units.map((unit) => [unit.id, unit]));
    for (const [index, entry] of input.entries.entries()) {
      const unit = byId.get(entry.unitId);
      if (!unit || unit.evidenceVersion !== entry.evidenceVersion
        || (index < input.cursor && unit.status !== "applied")
        || (index > input.cursor && unit.status !== "ready_for_acceptance")) return false;
    }
    const plannedIds = new Set(input.entries.map((entry) => entry.unitId));
    return !input.dependencies.some((dependency) => {
      if (!plannedIds.has(dependency.upstreamUnitId) || !plannedIds.has(dependency.downstreamUnitId)) return false;
      const upstream = byId.get(dependency.upstreamUnitId);
      return !upstream || dependency.releasedAt === null
        || dependency.releasedByEvidenceVersion !== upstream.evidenceVersion;
    });
  } catch {
    return false;
  }
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
  if (unitCount > MAX_DELIVERY_PLAN_UNITS) throw new Error("DELIVERY_PLAN_UNIT_LIMIT");
  const dependencyCount = dependencies.length;
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
