import { describe, expect, it } from "vitest";
import { parseApiResponse } from "./api.js";

describe("parseApiResponse", () => {
  it("reports an empty upstream response without throwing a JSON syntax error", async () => {
    const response = new Response("", { status: 502, statusText: "Bad Gateway" });
    await expect(parseApiResponse(response)).rejects.toThrow("服务暂时不可用");
  });

  it("parses a normal JSON response", async () => {
    const response = new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(parseApiResponse(response)).resolves.toEqual({ ok: true });
  });
});
