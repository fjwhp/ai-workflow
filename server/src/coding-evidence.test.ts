import { describe, expect, it } from "vitest";
import { buildCodingEvidence, hashDiff } from "./coding-evidence.js";

describe("coding evidence", () => {
  it("creates a stable SHA-256 hash", () => {
    expect(hashDiff("same")).toBe(hashDiff("same"));
    expect(hashDiff("same")).not.toBe(hashDiff("different"));
    expect(hashDiff("same")).toHaveLength(64);
  });

  it("preserves metadata and marks oversized diffs as truncated", () => {
    const evidence = buildCodingEvidence({ diff: "x".repeat(200), maxDiffChars: 60, files: ["a.ts"], additions: 3, deletions: 1 });
    expect(evidence.truncated).toBe(true);
    expect(evidence.originalChars).toBe(200);
    expect(evidence.diff.length).toBeLessThanOrEqual(80);
    expect(evidence.files).toEqual(["a.ts"]);
  });
});
