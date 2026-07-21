import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));

describe("dashboard stats layout", () => {
  it("renders five stats and lets only an odd final item span narrow two-column grids", async () => {
    vi.stubGlobal("document", { getElementById: () => null });
    const main = await import("./main.js");
    const Dashboard = (main as any).Dashboard;
    expect(Dashboard).toBeTypeOf("function");

    const queues = {
      approvals: [], ready: [], running: [], automation: [], blocked: []
    };
    const markup = renderToStaticMarkup(React.createElement(Dashboard, {
      items: [], queues, queueFilter: null,
      onQueue: () => undefined, onClearFilter: () => undefined, onOpen: () => undefined
    }));
    expect(markup.match(/class="stat"/g)).toHaveLength(5);
    expect(markup).toContain("交付自动化");
    expect(markup).not.toContain("自动化待接管");

    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const tabletRule = css.split("\n").find((line) => line.startsWith("@media(max-width:900px){") && line.includes(".stats{"));
    const mobileRule = css.split("\n").find((line) => line.startsWith("@media(max-width:620px){") && line.includes(".stats{"));

    expect(css).toContain(".stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))");
    expect(tabletRule).toContain(".stats{grid-template-columns:repeat(2,1fr)}");
    expect(mobileRule).toContain(".stats{grid-template-columns:1fr 1fr;gap:8px}");
    expect(tabletRule).toContain(".stats>:last-child:nth-child(odd){grid-column:1/-1}");
    expect(css).not.toMatch(/\.stats>:last-child\{[^}]*grid-column:1\/-1/);
  });
});
