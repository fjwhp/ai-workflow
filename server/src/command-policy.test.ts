import { describe, expect, it } from "vitest";
import { isAllowedCommand } from "./command-policy.js";

const allowed = [{ command: "mvn", argsPrefix: ["test", "-pl", "dine-service/dine-product-service"] }];

describe("command policy", () => {
  it("allows a configured Maven command", () => {
    expect(isAllowedCommand("mvn", ["test", "-pl", "dine-service/dine-product-service", "-Dtest=OrderTest"], allowed)).toBe(true);
  });
  it("blocks shells and force flags", () => {
    expect(isAllowedCommand("bash", ["-c", "mvn test"], allowed)).toBe(false);
    expect(isAllowedCommand("mvn", ["test", "--force"], allowed)).toBe(false);
  });
  it("blocks commands outside the allowlist", () => {
    expect(isAllowedCommand("git", ["push"], allowed)).toBe(false);
  });
});
