const protectedBranches=new Set(["prod","production","main","master"]);

export function integrationView(status:string,preflight:any,run:any,targetBranch="",confirmation=""){
  const runStatus=run?.status;
  const label=runStatus==="conflict"?"应用冲突":runStatus==="completed"||status==="completed"?"已完成":status==="merge_test_failed"||runStatus==="test_failed"?"本地应用后测试失败":runStatus==="running"?"应用中":"待应用";
  const disabledReasons=(preflight?.checks||[]).filter((check:any)=>!check.ok).map((check:any)=>`${check.label}${check.detail?`：${check.detail}`:""}`);
  if(status==="awaiting_merge"&&!preflight)disabledReasons.push("请先完成应用预检");
  else if(status==="awaiting_merge"&&!preflight?.allowed&&!disabledReasons.length)disabledReasons.push(preflight.message||"应用预检未通过");
  const protectedTarget=protectedBranches.has(targetBranch.toLowerCase());
  const showRecheck=status==="awaiting_merge",showIntegrate=status==="awaiting_merge",showRerun=status==="merge_test_failed";
  return {label,actionLabel:runStatus==="conflict"?"重新应用到本地":"应用到本地工作区",safetyLabel:"保留为本地未提交改动，不会 commit，不会 push",showRecheck,showIntegrate,showRerun,canIntegrate:showIntegrate&&Boolean(preflight?.allowed)&&runStatus!=="running",canRerunTests:showRerun&&runStatus!=="running",disabledReasons,protectedTarget,confirmationValid:!protectedTarget||confirmation===targetBranch};
}
