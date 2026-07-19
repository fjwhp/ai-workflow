export const workflowStages = [
  "intake", "prd", "requirement_review", "technical_design",
  "coding", "code_review", "testing", "acceptance", "integration"
] as const;

export const workflowStatuses = [
  "draft", "ai_ready", "ai_running", "awaiting_approval", "approved",
  "returned", "blocked", "awaiting_merge", "merge_test_failed", "awaiting_local_resolution",
  "manual_resolution_required", "completed", "closed", "cancelled"
] as const;

export type WorkflowStage = typeof workflowStages[number];
export type WorkflowStatus = typeof workflowStatuses[number];

const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  draft: ["ai_ready", "cancelled"],
  ai_ready: ["ai_running", "blocked", "cancelled"],
  ai_running: ["awaiting_approval", "blocked"],
  awaiting_approval: ["approved", "returned", "blocked"],
  approved: ["ai_ready", "completed"],
  returned: ["ai_ready", "cancelled"],
  blocked: ["ai_ready", "cancelled"],
  awaiting_merge: ["merge_test_failed", "awaiting_local_resolution", "cancelled"],
  merge_test_failed: ["awaiting_local_resolution", "cancelled"],
  awaiting_local_resolution: ["completed", "awaiting_merge", "manual_resolution_required", "cancelled"],
  manual_resolution_required: ["completed", "awaiting_merge", "cancelled"],
  completed: ["closed"],
  closed: [],
  cancelled: []
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return transitions[from].includes(to);
}

export function previousStage(stage: WorkflowStage): WorkflowStage {
  const index = workflowStages.indexOf(stage);
  return index > 0 ? workflowStages[index - 1]! : "intake";
}

export function returnStage(stage: WorkflowStage): WorkflowStage {
  const routes: Record<WorkflowStage, WorkflowStage> = {
    intake: "intake",
    prd: "intake",
    requirement_review: "prd",
    technical_design: "requirement_review",
    coding: "technical_design",
    code_review: "coding",
    testing: "coding",
    acceptance: "testing",
    integration: "acceptance"
  };
  return routes[stage];
}

export const stageLabels: Record<WorkflowStage, string> = {
  intake: "运营提需", prd: "产品 PRD", requirement_review: "研发评审",
  technical_design: "技术设计", coding: "编码自测", code_review: "代码 Review",
  testing: "自动化测试", acceptance: "运营验收", integration: "本地应用"
};

export const statusLabels: Record<WorkflowStatus, string> = {
  draft: "草稿", ai_ready: "AI 待启动", ai_running: "AI 处理中",
  awaiting_approval: "待人工审批", approved: "已批准", returned: "已打回",
  blocked: "已阻塞", awaiting_merge: "待应用", merge_test_failed: "应用后测试失败",
  awaiting_local_resolution: "待处理本地变更", manual_resolution_required: "需手动处理",
  completed: "已完成", closed: "已关闭", cancelled: "已取消"
};
