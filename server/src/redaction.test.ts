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
});
