import { describe, expect, it } from "vitest";
import { classifyProductUnknown } from "./product-policy.js";

describe("classifyProductUnknown",()=>{
  it("separates evidence, reversible defaults and blocking decisions",()=>{
    expect(classifyProductUnknown({topic:"现有接口是否支持备注",impact:"可从项目源码确认"})).toBe("evidence_gap");
    expect(classifyProductUnknown({topic:"默认分页数量",impact:"可随时调整"})).toBe("reversible_assumption");
    expect(classifyProductUnknown({topic:"用户数据永久删除",impact:"不可恢复"})).toBe("blocking_decision");
  });
});
