export const deliveryUnitPhases = ["implementation", "quality_verification", "acceptance_delivery"] as const;

export const deliveryUnitStatuses = [
  "waiting_dependency", "ready", "running", "awaiting_gate", "returned",
  "potentially_stale", "ready_for_acceptance", "applying", "applied",
  "conflicted", "failed", "skipped"
] as const;

export const deliveryReleaseConditions = ["automated_testing_passed"] as const;
export const automationActions = ["implement", "review", "test", "apply"] as const;

export type AutomationAction = typeof automationActions[number];

export type DeliveryDependencyInput = {
  upstreamProjectId: string;
  downstreamProjectId: string;
  releaseCondition: "automated_testing_passed";
};

export function validateDeliveryGraph(
  projectIds: string[],
  dependencies: DeliveryDependencyInput[]
): { order: string[] } {
  const projectIdSet = new Set(projectIds);
  const adjacency = new Map(projectIds.map((projectId) => [projectId, [] as string[]]));
  const inDegrees = new Map(projectIds.map((projectId) => [projectId, 0]));
  const seenEdges = new Map<string, Set<string>>();

  for (const dependency of dependencies) {
    const { upstreamProjectId, downstreamProjectId } = dependency;
    if (!projectIdSet.has(upstreamProjectId) || !projectIdSet.has(downstreamProjectId)) {
      throw new Error("DELIVERY_DEPENDENCY_MISSING_ENDPOINT");
    }
    if (upstreamProjectId === downstreamProjectId) {
      throw new Error("DELIVERY_DEPENDENCY_SELF_EDGE");
    }

    const downstreamIds = seenEdges.get(upstreamProjectId) ?? new Set<string>();
    if (downstreamIds.has(downstreamProjectId)) {
      throw new Error("DELIVERY_DEPENDENCY_DUPLICATE_EDGE");
    }
    downstreamIds.add(downstreamProjectId);
    seenEdges.set(upstreamProjectId, downstreamIds);

    adjacency.get(upstreamProjectId)!.push(downstreamProjectId);
    inDegrees.set(downstreamProjectId, inDegrees.get(downstreamProjectId)! + 1);
  }

  const projectPositions = new Map(projectIds.map((projectId, index) => [projectId, index]));
  const candidates = projectIds.filter((projectId) => inDegrees.get(projectId) === 0);
  const order: string[] = [];

  while (candidates.length > 0) {
    const upstreamProjectId = candidates.shift()!;
    order.push(upstreamProjectId);
    for (const downstreamProjectId of adjacency.get(upstreamProjectId)!) {
      const inDegree = inDegrees.get(downstreamProjectId)! - 1;
      inDegrees.set(downstreamProjectId, inDegree);
      if (inDegree === 0) candidates.push(downstreamProjectId);
    }
    candidates.sort((left, right) => projectPositions.get(left)! - projectPositions.get(right)!);
  }

  if (order.length !== projectIds.length) {
    throw new Error("DELIVERY_DEPENDENCY_CYCLE");
  }

  return { order };
}
