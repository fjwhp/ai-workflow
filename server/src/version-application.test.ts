import { describe, expect, it } from "vitest";
import { classifyLocalResolution } from "./version-application.js";

const before = "a".repeat(40);
const after = "b".repeat(40);

describe("classifyLocalResolution", () => {
  it("keeps a dirty version pending", () => {
    expect(classifyLocalResolution({
      statusPorcelain: " M src/app.ts\n", preApplyHead: before, currentHead: after
    })).toEqual({ status: "pending" });
  });

  it("classifies a clean version at the pre-apply head as reverted", () => {
    expect(classifyLocalResolution({
      statusPorcelain: "", preApplyHead: before, currentHead: before
    })).toEqual({ status: "reverted" });
  });

  it("classifies a clean version at a valid advanced head as committed", () => {
    expect(classifyLocalResolution({
      statusPorcelain: "", preApplyHead: before, currentHead: after
    })).toEqual({ status: "committed", commit: after });
  });

  it.each(["", "not-a-commit", "c".repeat(39), "g".repeat(40)])(
    "classifies an empty or invalid current head %j as ambiguous",
    (currentHead) => {
      expect(classifyLocalResolution({
        statusPorcelain: "", preApplyHead: before, currentHead
      })).toEqual({ status: "ambiguous", currentHead });
    }
  );
});
