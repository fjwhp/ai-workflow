import { createHash } from "node:crypto";

export type KnowledgeCandidate={subjectKey:string;projectId:string;requirementId:string;layer:"source_fact"|"project_rule"|"decision"|"requirement_experience";type:string;title:string;content:string;modules:string[];tags:string[];sourceStage:string;confidence:number;riskLevel:"normal"|"high";publishDecision:"auto_publish"|"human_review";evidence:{artifactId:string;stage:string;version:number;source?:string}[]};

const sensitive=/(权限|越权|安全|隐私|合规|资金|支付|删除|不可逆|permission|security|privacy|compliance)/i;
function key(layer:string,type:string,title:string){return createHash("sha256").update(`${layer}:${type}:${title.trim().toLowerCase()}`).digest("hex")}
function tagsOf(text:string){return [...new Set(text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(value=>value.length>1))].slice(0,20)}

export function extractKnowledgeCandidates(input:{projectId:string;requirement:any;artifacts:any[];approvals:any[]}){
  const approved=new Set(input.approvals.filter(item=>item.decision==="approve").map(item=>item.artifact_id||item.artifactId).filter(Boolean));
  const approvedStages=new Set(input.approvals.filter(item=>item.decision==="approve").map(item=>item.stage));
  const records:KnowledgeCandidate[]=[];
  const add=(artifact:any,layer:KnowledgeCandidate["layer"],type:string,title:string,content:string,source?:string)=>{
    if(!title?.trim()||!content?.trim())return;
    const riskLevel=sensitive.test(`${title} ${content}`)?"high":"normal";
    records.push({subjectKey:key(layer,type,title),projectId:input.projectId,requirementId:input.requirement.id,layer,type,title:title.trim(),content:content.trim(),modules:[],tags:tagsOf(`${title} ${content}`),sourceStage:artifact.stage,confidence:Number(artifact.content?.confidence||0.85),riskLevel,publishDecision:riskLevel==="high"?"human_review":"auto_publish",evidence:[{artifactId:artifact.id,stage:artifact.stage,version:artifact.version||1,source}]});
  };
  for(const artifact of input.artifacts.filter(item=>approved.has(item.id)||approvedStages.has(item.stage))){
    const content=artifact.content||{};
    for(const decision of content.productDecisions||[])add(artifact,"decision","product_decision",decision.decision,String(decision.rationale||decision.decision),String(decision.evidence||""));
    for(const fact of (content.facts||[]).slice(0,20))add(artifact,"source_fact","workflow_fact",String(fact),String(fact));
    for(const risk of (content.risks||[]).slice(0,12))add(artifact,"requirement_experience","risk",String(risk),String(risk));
    for(const criterion of (content.acceptanceCriteria||[]).slice(0,20))add(artifact,"project_rule","acceptance_rule",String(criterion),String(criterion));
    for(const finding of (content.findings||[]).slice(0,20))add(artifact,"requirement_experience","review_finding",String(finding.title||finding.recommendation||"评审结论"),String(finding.recommendation||finding.impact||finding.evidence||finding.title));
  }
  const unique=new Map<string,KnowledgeCandidate>();
  for(const record of records)if(!unique.has(record.subjectKey))unique.set(record.subjectKey,record);
  return [...unique.values()].slice(0,100);
}
