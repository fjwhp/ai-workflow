import { redactSensitive } from "./redaction.js";

const MAX_STRUCTURED_BYTES = 1_048_576;

export function serializeApplicationData(
  value: unknown,
  field: string,
  requireArray = false
): string {
  try {
    if (requireArray && !Array.isArray(value)) throw new Error("invalid");
    const normalized = cloneJsonValue(value, new Set(), 0);
    const json = JSON.stringify(normalized);
    if (json === undefined) throw new Error("invalid");
    if (Buffer.byteLength(json) > MAX_STRUCTURED_BYTES) {
      throw new Error(`DELIVERY_APPLICATION_${field}_LIMIT`);
    }
    return json;
  } catch (error) {
    if (error instanceof Error && error.message === `DELIVERY_APPLICATION_${field}_LIMIT`) throw error;
    throw new Error(`DELIVERY_APPLICATION_${field}_INVALID`);
  }
}

export function sanitizeApplicationData(value: unknown, patterns: string[]): unknown {
  try {
    return redactSensitive(value, patterns, {
      maxDepth: 64, maxNodes: 50_000, maxStringCodePoints: MAX_STRUCTURED_BYTES,
      maxCollectionItems: 20_000, maxBytes: MAX_STRUCTURED_BYTES
    });
  } catch (error) {
    throw new Error("DELIVERY_APPLICATION_EVIDENCE_INVALID", { cause: error });
  }
}

export function parseApplicationSensitivePatterns(json: string): string[] {
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value) && value.length <= 256 && value.every((item) =>
      typeof item === "string" && item.length <= 4_096 && !item.includes("\0"))) return value;
  } catch {}
  throw new Error("DELIVERY_APPLICATION_SENSITIVE_PATTERNS_INVALID");
}

export function isApplicationRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function applicationOwnData(
  record: Record<string, any>,
  key: string,
  error: string
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(error);
    return descriptor.value;
  } catch (cause) {
    if (cause instanceof Error && cause.message === error) throw cause;
    throw new Error(error, { cause });
  }
}

export function applicationOwnOptionalData(
  record: Record<string, any>,
  key: string,
  error: string
): unknown {
  try {
    if (!Object.hasOwn(record, key)) return undefined;
    return applicationOwnData(record, key, error);
  } catch (cause) {
    if (cause instanceof Error && cause.message === error) throw cause;
    throw new Error(error, { cause });
  }
}

function cloneJsonValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (depth > 64) throw new Error("invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("invalid");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  const expectedPrototype = array ? Array.prototype : Object.prototype;
  if (prototype !== expectedPrototype && prototype !== null) throw new Error("invalid");
  if (prototype && Object.getOwnPropertyDescriptor(prototype, "toJSON")) throw new Error("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  ancestors.add(value);
  try {
    if (array) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new Error("invalid");
      }
      const length = lengthDescriptor.value as number;
      const dataKeys = keys.filter((key) => key !== "length");
      if (dataKeys.length !== length) throw new Error("invalid");
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid");
        result.push(cloneJsonValue(descriptor.value, ancestors, depth + 1));
      }
      return result;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string" || key === "toJSON" || key.includes("\0")) throw new Error("invalid");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid");
      result[key] = cloneJsonValue(descriptor.value, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
