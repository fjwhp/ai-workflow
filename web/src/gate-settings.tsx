import { configurableMandatoryHumanStages, stageLabels, type GateConfig } from "@ai-workflow/shared";

type Props = {
  stages: GateConfig["mandatoryHumanStages"];
  disabled: boolean;
  onChange: (stages: GateConfig["mandatoryHumanStages"]) => void;
};

export function MandatoryHumanStageSettings({ stages, disabled, onChange }: Props) {
  const stage = configurableMandatoryHumanStages[0];
  return <div className="mandatory-stages">
    <b>需求 AI 额外人工阶段</b>
    <span>仅需求定义可配置；方案设计始终需要人工审批</span>
    <div><label><input type="checkbox" checked={stages.includes(stage)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [stage] : [])}/>{stageLabels[stage]}</label></div>
  </div>;
}
