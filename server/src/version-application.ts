import type { LocalResolution } from "@ai-workflow/shared";

const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function classifyLocalResolution(input: {
  statusPorcelain: string;
  preApplyHead: string;
  currentHead: string;
}): LocalResolution {
  if (input.statusPorcelain.length > 0) return { status: "pending" };
  if (!gitObjectId.test(input.currentHead)) {
    return { status: "ambiguous", currentHead: input.currentHead };
  }
  if (input.currentHead === input.preApplyHead) return { status: "reverted" };
  return { status: "committed", commit: input.currentHead };
}
