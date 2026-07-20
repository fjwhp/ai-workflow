import { describe, expect, it } from "vitest";
import { redactSensitive } from "./redaction.js";

describe("redactSensitive", () => {
  it("redacts sensitive keys and credential text without mutating input", () => {
    const input = { apiKey: "secret", nested: { authorization: "Bearer abc123", note: "token=xyz" } };
    expect(redactSensitive(input)).toEqual({ apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]", note: "token=[REDACTED]" } });
    expect(input.apiKey).toBe("secret");
  });

  it("redacts private keys and configured patterns", () => {
    const value = "file .env contains -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----";
    expect(redactSensitive(value, [".env"])).not.toContain("PRIVATE KEY");
    expect(redactSensitive(value, [".env"])).not.toContain(".env");
  });

  it("redacts common provider, cloud, URL, and connection credentials", () => {
    const secrets = [
      "dXNlcjpwYXNz", "bearer-secret", "AKIAABCDEFGHIJKLMNOP",
      "aws-secret-value", "aws-session-value", "sk-proj-openai-secret",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "url-password", "database-password"
    ];
    const input = {
      clientSecret: "structured-secret",
      output: [
        "Authorization: Basic dXNlcjpwYXNz",
        "Authorization: Bearer bearer-secret",
        "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
        "AWS_SECRET_ACCESS_KEY=aws-secret-value",
        "AWS_SESSION_TOKEN=aws-session-value",
        "OPENAI_API_KEY=sk-proj-openai-secret",
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "https://alice:url-password@example.com/private",
        "postgres://dbuser:database-password@localhost/app"
      ]
    };

    const serialized = JSON.stringify(redactSensitive(input));

    for (const secret of ["structured-secret", ...secrets]) expect(serialized).not.toContain(secret);
  });

  it.each([
    ["depth", { nested: { nested: { value: "too deep" } } }, { maxDepth: 2 }],
    ["nodes", { first: 1, second: 2 }, { maxNodes: 2 }],
    ["string", "oversized", { maxStringCodePoints: 4 }],
    ["collection", [1, 2], { maxCollectionItems: 1 }],
    ["bytes", { value: "too large" }, { maxBytes: 4 }]
  ])("fails closed when the %s redaction budget is exceeded", (_name, value, limits) => {
    expect(() => redactSensitive(value, [], limits)).toThrow("REDACTION_LIMIT_EXCEEDED");
  });

  it("stops traversing an array as soon as its serialized byte budget is exceeded", () => {
    const reads: number[] = [];
    const input = new Array(100);
    for (let index = 0; index < input.length; index += 1) {
      Object.defineProperty(input, index, {
        enumerable: true,
        get() { reads.push(index); return "abcdefghij"; }
      });
    }

    expect(() => redactSensitive(input, [], { maxBytes: 12 })).toThrow("REDACTION_LIMIT_EXCEEDED");
    expect(reads).toEqual([0]);
  });

  it("accounts for multibyte UTF-8 and escaped string bytes", () => {
    expect(redactSensitive("界", [], { maxBytes: 5 })).toBe("界");
    expect(() => redactSensitive("界", [], { maxBytes: 4 })).toThrow("REDACTION_LIMIT_EXCEEDED");
    expect(redactSensitive('"', [], { maxBytes: 4 })).toBe('"');
    expect(() => redactSensitive('"', [], { maxBytes: 3 })).toThrow("REDACTION_LIMIT_EXCEEDED");
  });

  it("accounts for object keys and container punctuation", () => {
    expect(redactSensitive({ 界: true }, [], { maxBytes: 12 })).toEqual({ 界: true });
    expect(() => redactSensitive({ 界: true }, [], { maxBytes: 11 }))
      .toThrow("REDACTION_LIMIT_EXCEEDED");
    expect(redactSensitive([null, 12, false], [], { maxBytes: 15 })).toEqual([null, 12, false]);
    expect(() => redactSensitive([null, 12, false], [], { maxBytes: 14 }))
      .toThrow("REDACTION_LIMIT_EXCEEDED");
  });
});
