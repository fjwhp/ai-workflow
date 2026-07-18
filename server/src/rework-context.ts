import { createHash } from "node:crypto";

const severityRank: Record<string,number>={S0:0,S1:1,S2:2,S3:3};
const stableId=(approvalId:string,index:number,title:string)=>createHash("sha256").update(`${approvalId}:${index}:${title}`).digest("hex").slice(0,16);

export function buildReworkContext({approval,artifact}:{approval:any;artifact?:any}){
  const findings=Array.isArray(artifact?.content?.findings)?artifact.content.findings:[];
  const rawItems=findings.length?findings:[{title:approval.comment||"按打回意见返工",severity:"S1",evidence:"审批意见",impact:"当前流程无法继续",recommendation:approval.comment||"检查并修正问题",targetStage:approval.target_stage}];
  const items=rawItems.map((item:any,index:number)=>({id:stableId(approval.id,index,item.title||"返工项"),status:"open",title:item.title||"返工项",severity:item.severity||"S2",evidence:item.evidence||"",impact:item.impact||"",recommendation:item.recommendation||"",targetStage:item.targetStage||approval.target_stage}))
    .sort((a:any,b:any)=>(severityRank[a.severity]??9)-(severityRank[b.severity]??9));
  return {approvalId:approval.id,artifactId:artifact?.id||null,sourceStage:approval.stage,targetStage:approval.target_stage,actorType:approval.actor_type||"human",decisionAt:approval.created_at,unstructured:!findings.length,items,risks:artifact?.content?.risks||[],openQuestions:artifact?.content?.openQuestions||[]};
}
