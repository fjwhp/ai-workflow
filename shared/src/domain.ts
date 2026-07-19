export const workflowStages = [
  "definition", "solution_design", "implementation",
  "quality_verification", "acceptance_delivery"
] as const;

export const workflowStatuses = [
  "ai_ready", "ai_running", "awaiting_approval", "returned",
  "blocked", "completed", "closed", "cancelled"
] as const;

export type WorkflowStage = typeof workflowStages[number];
export type WorkflowStatus = typeof workflowStatuses[number];

const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  ai_ready: ["ai_running", "blocked", "cancelled"],
  ai_running: ["awaiting_approval", "blocked"],
  awaiting_approval: ["ai_ready", "returned", "blocked", "completed"],
  returned: ["ai_ready", "cancelled"],
  blocked: ["ai_ready", "cancelled"],
  completed: ["closed"],
  closed: [],
  cancelled: []
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return transitions[from].includes(to);
}

export function previousStage(stage: WorkflowStage): WorkflowStage {
  const index = workflowStages.indexOf(stage);
  return index > 0 ? workflowStages[index - 1]! : "definition";
}

export function returnStage(stage: WorkflowStage): WorkflowStage {
  const routes: Record<WorkflowStage, WorkflowStage> = {
    definition: "definition",
    solution_design: "definition",
    implementation: "solution_design",
    quality_verification: "implementation",
    acceptance_delivery: "quality_verification"
  };
  return routes[stage];
}

export const stageLabels: Record<WorkflowStage, string> = {
  definition: "需求定义",
  solution_design: "方案设计",
  implementation: "实现",
  quality_verification: "质量验证",
  acceptance_delivery: "验收交付"
};

export const statusLabels: Record<WorkflowStatus, string> = {
  ai_ready: "AI 待启动", ai_running: "AI 处理中",
  awaiting_approval: "待人工审批", returned: "已打回", blocked: "已阻塞",
  completed: "已完成", closed: "已关闭", cancelled: "已取消"
};
