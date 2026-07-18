export type ProductUnknownClass="evidence_gap"|"reversible_assumption"|"blocking_decision";

const blocking=/权限|授权|资金|金额|支付|退款|计费|合规|法律|隐私|个人信息|永久删除|物理删除|不可恢复|不可逆|迁移|兼容|互斥|permission|payment|billing|compliance|privacy|delete permanently|irreversible/i;
const evidence=/源码|项目|接口|数据库|现有|当前|文档|测试|配置|可从|repository|source|api|schema|existing/i;

export function classifyProductUnknown(input:{topic:string;impact:string}):ProductUnknownClass{
  const text=`${input.topic} ${input.impact}`;
  if(blocking.test(text))return "blocking_decision";
  if(evidence.test(text))return "evidence_gap";
  return "reversible_assumption";
}
