const sensitiveKey = /(^|_)(api_?key|authorization|cookie|token|secret|password)($|_)/i;

function redactText(value: string, patterns: string[]) {
  let result = value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]");
  for (const pattern of patterns.filter(Boolean)) result = result.split(pattern).join("[REDACTED]");
  return result;
}

export function redactSensitive(value: unknown, patterns: string[] = []): any {
  if (typeof value === "string") return redactText(value, patterns);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, patterns));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitiveKey.test(key) ? "[REDACTED]" : redactSensitive(item, patterns)
  ]));
  return value;
}
