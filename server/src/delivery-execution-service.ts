import { buildCodingEvidence } from "./coding-evidence.js";
import { runCodingAgent, type CodingAgentInput, type CodingAgentResult } from "./coding-agent.js";
import type { DeliveryExecutionPersistence } from "./delivery-execution-repository.js";

export type CodingAgent = (input: CodingAgentInput) => Promise<CodingAgentResult>;

export class DeliveryExecutionService {
  constructor(
    private readonly persistence: DeliveryExecutionPersistence,
    private readonly codingAgent: CodingAgent = runCodingAgent,
    private readonly model = process.env.OPENAI_CODING_MODEL || process.env.OPENAI_MODEL || "gpt-5.5"
  ) {}

  async implement(unitId: string) {
    const claim = this.persistence.claimImplementation(unitId, this.model);
    let result: CodingAgentResult;
    try {
      result = await this.codingAgent({
        requirement: claim.requirement,
        artifacts: claim.artifacts,
        project: claim.project,
        version: claim.version,
        deliveryContext: claim.deliveryContext
      });
    } catch (error) {
      try {
        this.persistence.failImplementation(claim, errorText(error));
      } catch (settlementError) {
        if (error && (typeof error === "object" || typeof error === "function")) {
          Object.defineProperty(error, "settlementError", { value: settlementError, configurable: true });
        }
      }
      throw error;
    }

    const evidence = buildCodingEvidence({
      diff: result.diff,
      files: result.files,
      additions: result.additions,
      deletions: result.deletions
    });
    const diagnostics = Array.isArray(result.diagnostics)
      ? result.diagnostics.map(String).join("\n")
      : String(result.diagnostics ?? "");
    return this.persistence.completeImplementation(claim, {
      branch: result.branch,
      worktreePath: result.worktreePath,
      baseCommit: result.baseCommit,
      commands: result.commands,
      diff: evidence.diff,
      diffHash: evidence.diffHash,
      originalChars: evidence.originalChars,
      truncated: evidence.truncated,
      files: evidence.files,
      additions: evidence.additions,
      deletions: evidence.deletions,
      diagnostics,
      codexThreadId: result.codexThreadId,
      events: result.events,
      output: { runId: result.runId, summary: result.summary }
    });
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
