import { describe,expect,it } from "vitest";
import { groupReworkItems } from "./rework-view.js";
describe("groupReworkItems",()=>{it("groups severe items first",()=>{const groups=groupReworkItems([{severity:"S2"},{severity:"S0"},{severity:"S1"}] as any);expect(groups.map(group=>group.severity)).toEqual(["S0","S1","S2"]);})});
