import { describe, expect, it } from "vitest";
import { productArtifactSchema } from "./schemas.js";

describe("productArtifactSchema", () => {
  it("accepts autonomous product decisions and structured blockers", () => {
    const result=productArtifactSchema.safeParse({
      conclusion:"pass",confidence:0.9,summary:"完整 PRD",facts:[],openQuestions:[],risks:[],findings:[],
      underlyingGoal:"降低运营建号成本",targetUsers:["平台运营"],
      productDecisions:[{decision:"默认分页 20 条",rationale:"沿用系统惯例",evidence:"UserController.java"}],
      assumptions:[{assumption:"沿用错误码",rationale:"可逆",validation:"接口评审",impactIfWrong:"调整映射"}],
      scope:{mvp:["创建用户"],nonGoals:["批量导入"]},flows:{primary:["填写并提交"],exceptions:["重复账号提示"]},
      acceptanceCriteria:["合法输入创建成功"],evidence:[{source:"UserController.java",fact:"已有用户接口"}],blockingQuestions:[]
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single evidence reference for each product decision",()=>{
    const result=productArtifactSchema.parse({
      conclusion:"pass",confidence:0.9,summary:"完整 PRD",facts:[],openQuestions:[],risks:[],findings:[],underlyingGoal:"降低成本",targetUsers:["运营"],
      productDecisions:[{decision:"沿用权限体系",rationale:"项目已有规则",evidence:"SysUserController.java"}],
      assumptions:[],scope:{mvp:["创建用户"],nonGoals:[]},flows:{primary:["提交"],exceptions:[]},acceptanceCriteria:["创建成功"],evidence:[],blockingQuestions:[]
    });
    expect(result.productDecisions[0]?.evidence).toBe("SysUserController.java");
  });
});
