import { describe,expect,it } from "vitest";
import { filterRequirements,navigationTarget,type QueueFilter } from "./navigation-view.js";

const items:any[]=[
  {id:"1",stage:"definition",status:"awaiting_approval"},
  {id:"2",stage:"solution_design",status:"ai_ready"},
  {id:"3",stage:"definition",status:"ai_running"},
  {id:"4",stage:"implementation",status:"ai_ready"},
  {id:"5",stage:"quality_verification",status:"ai_running"},
  {id:"6",stage:"acceptance_delivery",status:"awaiting_approval"},
  {id:"7",stage:"implementation",status:"blocked"},
  {id:"8",stage:"quality_verification",status:"returned"},
  {id:"9",stage:"acceptance_delivery",status:"completed"}
];

describe("navigation view",()=>{
  it.each<[QueueFilter,string[]]>([["approvals",["1"]],["ready",["2"]],["running",["3"]],["automation",["4","5","6"]],["blocked",["7","8"]]])("filters %s requirements",(filter,ids)=>{
    expect(filterRequirements(items,filter).map(item=>item.id)).toEqual(ids);
  });
  it("returns all requirements without a queue filter",()=>expect(filterRequirements(items,null)).toEqual(items));
  it("clears selected detail and queue filter for primary navigation",()=>expect(navigationTarget("projects")).toEqual({page:"projects",selected:null,queueFilter:null}));
  it("opens requirements with the selected queue",()=>expect(navigationTarget("requirements","running")).toEqual({page:"requirements",selected:null,queueFilter:"running"}));
});
