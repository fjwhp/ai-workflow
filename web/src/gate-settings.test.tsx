import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MandatoryHumanStageSettings } from "./gate-settings.js";

describe("requirement AI gate settings", () => {
  it("offers only definition while keeping solution design explicitly human-only", () => {
    const markup = renderToStaticMarkup(React.createElement(MandatoryHumanStageSettings, {
      stages: [],
      disabled: false,
      onChange: () => undefined
    }));

    expect(markup).toContain("需求 AI");
    expect(markup).toContain("需求定义");
    expect(markup).toContain("方案设计始终需要人工审批");
    expect(markup).not.toContain("实现</label>");
    expect(markup).not.toContain("质量验证</label>");
    expect(markup).not.toContain("验收交付</label>");
  });
});
