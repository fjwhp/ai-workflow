import { describe, expect, it } from "vitest";
import { buildReworkContext } from "./rework-context.js";

describe("buildReworkContext",()=>{
  it("normalizes and severity-sorts structured findings",()=>{
    const context=buildReworkContext({approval:{id:"a1",stage:"quality_verification",target_stage:"implementation",actor_type:"ai_gate",created_at:"now",comment:"return"},artifact:{id:"art",content:{findings:[{title:"minor",severity:"S2"},{title:"critical",severity:"S0"}],risks:["risk"],openQuestions:["question"]}}});
    expect(context.items.map((item:any)=>item.severity)).toEqual(["S0","S2"]);
    expect(context.items[0].id).toBe(context.items[0].id);
    expect(context.unstructured).toBe(false);
  });

  it("falls back to the approval comment when no artifact exists",()=>{
    const context=buildReworkContext({approval:{id:"a2",stage:"quality_verification",target_stage:"implementation",actor_type:"human",created_at:"now",comment:"补充测试"}});
    expect(context.unstructured).toBe(true);
    expect(context.items[0].title).toBe("补充测试");
  });
});
