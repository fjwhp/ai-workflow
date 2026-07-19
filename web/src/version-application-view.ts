export type VersionApplicationViewInput = {
  status: string;
  queuePosition?: number;
  pendingOwner?: string;
  preflightAllowed?: boolean;
  runStatus?: string;
};

type VersionAssociation = {
  projectId: string;
  usage: string;
  status?: string;
  projectVersionId?: string;
  projectVersionName?: string;
  projectVersionBranch?: string;
  projectVersionStatus?: string;
  projectVersionWorktreePath?: string;
  projectVersionHead?: string;
};

export function requirementApplicationContext(item: {
  projectSnapshot?: { associations?: VersionAssociation[] } | null;
  projects?: VersionAssociation[];
}) {
  if (!item.projectSnapshot) return { mode: "legacy" as const, target: null };
  const associations = Array.isArray(item.projectSnapshot.associations) ? item.projectSnapshot.associations : [];
  const delivery = associations.filter((entry) => entry.status !== "archived" && entry.usage === "delivery");
  const target = delivery.length === 1 && delivery[0]?.projectVersionId ? delivery[0] : null;
  return { mode: "versioned" as const, target };
}

export function versionApplicationView(input: VersionApplicationViewInput) {
  const queuePosition = input.queuePosition || 0;
  const waitingBehindOwner = input.status === "awaiting_merge" && queuePosition > 1;
  const labels: Record<string, string> = {
    awaiting_local_resolution: "等待本地提交或撤销",
    manual_resolution_required: "需要人工处理本地状态",
    merge_test_failed: "本地应用后测试失败",
    completed: "已完成"
  };
  const label = waitingBehindOwner ? `队列第 ${queuePosition} 位` : input.runStatus === "conflict" ? "应用冲突" : labels[input.status] || "待应用";
  return {
    label,
    queueLabel: queuePosition ? `应用队列第 ${queuePosition} 位` : "当前不在应用队列",
    canApply: input.status === "awaiting_merge" && !waitingBehindOwner && input.preflightAllowed === true && input.runStatus !== "running",
    showRecheck: input.status === "awaiting_local_resolution" || input.status === "manual_resolution_required",
    showPreflight: input.status === "awaiting_merge" && !waitingBehindOwner,
    showApply: input.status === "awaiting_merge" && !waitingBehindOwner,
    showRerunTests: input.status === "merge_test_failed",
    pendingOwnerLabel: input.pendingOwner ? `待本地处理：${input.pendingOwner}` : ""
  };
}
