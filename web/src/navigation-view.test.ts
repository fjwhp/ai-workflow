import { describe,expect,it } from "vitest";
import { filterRequirements,navigationTarget,type QueueFilter } from "./navigation-view.js";

const items:any[]=[
  {id:"1",status:"awaiting_approval"},{id:"2",status:"ai_ready"},{id:"3",status:"ai_running"},{id:"4",status:"blocked"},{id:"5",status:"returned"},{id:"6",status:"completed"}
];

describe("navigation view",()=>{
  it.each<[QueueFilter,string[]]>([["approvals",["1"]],["ready",["2"]],["running",["3"]],["blocked",["4","5"]]])("filters %s requirements",(filter,ids)=>{
    expect(filterRequirements(items,filter).map(item=>item.id)).toEqual(ids);
  });
  it("returns all requirements without a queue filter",()=>expect(filterRequirements(items,null)).toEqual(items));
  it("clears selected detail and queue filter for primary navigation",()=>expect(navigationTarget("projects")).toEqual({page:"projects",selected:null,queueFilter:null}));
  it("opens requirements with the selected queue",()=>expect(navigationTarget("requirements","running")).toEqual({page:"requirements",selected:null,queueFilter:"running"}));
});
