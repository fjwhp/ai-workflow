const REDACTED = "[REDACTED]";
const sensitiveKeyPart = /(?:api.?key|authorization|cookie|credential|password|passwd|pwd|secret|token)/i;
const exactSensitiveKeys = new Set([
  "awsaccesskeyid", "awssecretaccesskey", "awssessiontoken", "connectionstring",
  "databaseurl", "dsn", "githubtoken", "openaikey", "openaiapikey", "setcookie"
]);

export interface RedactionLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringCodePoints: number;
  maxCollectionItems: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: RedactionLimits = {
  maxDepth: 24,
  maxNodes: 50_000,
  maxStringCodePoints: 1_048_576,
  maxCollectionItems: 20_000,
  maxBytes: 16 * 1024 * 1024
};

function redactText(value: string, patterns: string[]) {
  let result = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, `$1${REDACTED}`)
    .replace(/\b((?:aws_(?:access_key_id|secret_access_key|session_token)|openai_api_key|github_token|token|api[_-]?key|secret|password|passwd|pwd)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g, REDACTED)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, `$1${REDACTED}:${REDACTED}@`);
  for (const pattern of patterns.filter(Boolean)) result = result.split(pattern).join(REDACTED);
  return result;
}

export function redactSensitive(
  value: unknown,
  patterns: string[] = [],
  requestedLimits: Partial<RedactionLimits> = {}
): any {
  const limits = redactionLimits(requestedLimits);
  if (!Array.isArray(patterns) || patterns.length > 256
    || patterns.some((pattern) => typeof pattern !== "string" || exceedsCodePoints(pattern, 4096))) {
    throw new Error("REDACTION_LIMIT_EXCEEDED");
  }
  let nodes = 0;
  let serializedBytes = 0;
  const ancestors = new Set<object>();

  const charge = (value: string | number) => {
    serializedBytes += typeof value === "number" ? value : Buffer.byteLength(value, "utf8");
    if (serializedBytes > limits.maxBytes) throw new Error("REDACTION_LIMIT_EXCEEDED");
  };

  const serializedPrimitive = (item: string | number | boolean | null) => {
    const serialized = JSON.stringify(item);
    if (serialized === undefined) throw new Error("REDACTION_LIMIT_EXCEEDED");
    charge(serialized);
    return item;
  };

  const visit = (item: unknown, depth: number): any => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw new Error("REDACTION_LIMIT_EXCEEDED");
    if (typeof item === "string") {
      if (exceedsCodePoints(item, limits.maxStringCodePoints)) throw new Error("REDACTION_LIMIT_EXCEEDED");
      return serializedPrimitive(redactText(item, patterns));
    }
    if (item === null || typeof item === "boolean") return serializedPrimitive(item);
    if (typeof item === "number") {
      return serializedPrimitive(Number.isFinite(item) ? item : REDACTED);
    }
    if (typeof item === "undefined" || typeof item === "bigint"
      || typeof item === "function" || typeof item === "symbol") return serializedPrimitive(REDACTED);
    if (ancestors.has(item)) throw new Error("REDACTION_VALUE_INVALID");
    if (Array.isArray(item)) {
      if (item.length > limits.maxCollectionItems) throw new Error("REDACTION_LIMIT_EXCEEDED");
      ancestors.add(item);
      try {
        charge(1);
        const result = [];
        for (let index = 0; index < item.length; index += 1) {
          if (index > 0) charge(1);
          result.push(visit(item[index], depth + 1));
        }
        charge(1);
        return result;
      }
      finally { ancestors.delete(item); }
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(descriptors);
    if (keys.length > limits.maxCollectionItems) throw new Error("REDACTION_LIMIT_EXCEEDED");
    ancestors.add(item);
    try {
      charge(1);
      const entries: Array<[string, unknown]> = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (index > 0) charge(1);
        charge(JSON.stringify(key));
        charge(1);
        const descriptor = descriptors[key]!;
        entries.push([
          key,
          isSensitiveKey(key) || !("value" in descriptor)
            ? serializedPrimitive(REDACTED)
            : visit(descriptor.value, depth + 1)
        ]);
      }
      charge(1);
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(item);
    }
  };

  const redacted = visit(value, 0);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.maxBytes) {
    throw new Error("REDACTION_LIMIT_EXCEEDED");
  }
  return redacted;
}

function redactionLimits(requested: Partial<RedactionLimits>): RedactionLimits {
  const limits = { ...DEFAULT_LIMITS, ...requested };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("REDACTION_LIMIT_EXCEEDED");
  }
  return limits;
}

function isSensitiveKey(key: string) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return exactSensitiveKeys.has(normalized) || sensitiveKeyPart.test(key);
}

function exceedsCodePoints(value: string, maximum: number) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}
