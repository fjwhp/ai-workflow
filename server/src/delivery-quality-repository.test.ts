import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowStore } from "./store.js";

function fixture(path = ":memory:") {
  const store = new WorkflowStore(path);
  const project = store.createProject({
    name: "Quality", repoPath: "/tmp/quality", defaultBranch: "main",
    allowedCommands: [{ command: "npm", argsPrefix: ["test"] }], sensitivePatterns: []
  });
  const version = store.createProjectVersion({
    projectId: project.id, name: "v1", branch: "feature/v1", baseBranch: "main",
    worktreePath: "/tmp/quality-v1", headCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  const requirement = store.createRequirement({
    title: "Quality evidence", businessProblem: "Need independent gates", expectedOutcome: "Auditable quality",
    priority: "high", primaryProjectId: project.id, primaryProjectVersionId: version.id
  });
  store.replaceRequirementProjects(requirement.id, [{
    projectId: project.id, projectVersionId: version.id, role: "primary", usage: "delivery",
    deliveryRequired: true, moduleMode: "all", moduleIds: [], position: 0
  }]);
  const plan = store.deliveryUnits.createPlan({
    requirementId: requirement.id, snapshot: store.createRequirementProjectSnapshot(requirement.id),
    plan: { units: [{ projectId: project.id, moduleIds: ["src"], acceptanceCriteria: ["Tests pass"] }], dependencies: [] }
  });
  const unit = plan.units[0]!;
  const claim = store.deliveryExecutions.claimImplementation(unit.id, "test-model");
  store.deliveryExecutions.completeImplementation(claim, {
    branch: "ai/REQ-0001", worktreePath: "/tmp/quality-run", baseCommit: version.headCommit,
    commands: [], diff: "diff", diffHash: "abc123", originalChars: 4, truncated: false,
    files: ["src/index.ts"], additions: 1, deletions: 0, diagnostics: "", output: {}
  });
  return { store, requirement, unit };
}

describe("delivery quality evidence schema", () => {
  it("has independent quality-run claims and immutable terminal evidence", () => {
    const store = new WorkflowStore(":memory:");
    try {
      const db = (store as any).db;
      const runColumns = db.prepare("PRAGMA table_info(delivery_quality_runs)").all();
      const evidenceColumns = db.prepare("PRAGMA table_info(delivery_quality_evidence)").all();
      expect(runColumns.map((column: any) => column.name)).toEqual(expect.arrayContaining([
        "delivery_unit_id", "evidence_version", "kind", "status"
      ]));
      expect(evidenceColumns.map((column: any) => column.name)).toEqual(expect.arrayContaining([
        "delivery_unit_id", "evidence_version", "kind", "result",
        "input_coding_evidence_id", "input_evidence_version", "input_diff_hash", "content_json"
      ]));
    } finally {
      store.close();
    }
  });

  it("claims review and testing independently but deduplicates the same kind", () => {
    const { store, unit } = fixture();
    try {
      const review = store.deliveryQuality.claim(unit.id, 1, "code_review");
      const testing = store.deliveryQuality.claim(unit.id, 1, "automated_testing");
      expect(review).toMatchObject({ kind: "code_review", evidenceVersion: 1 });
      expect(testing).toMatchObject({ kind: "automated_testing", evidenceVersion: 1 });
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review"))
        .toThrow("DELIVERY_QUALITY_RUN_ACTIVE");
    } finally {
      store.close();
    }
  });

  it("resumes a running claim only for the same automation job token", () => {
    const { store, unit } = fixture();
    try {
      const first = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-1");
      const resumed = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-1");
      expect(resumed.id).toBe(first.id);
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review", "other-job"))
        .toThrow("DELIVERY_QUALITY_RUN_ACTIVE");
      const evidence = store.deliveryQuality.complete(resumed, { result: "passed", content: { summary: "ok" } });
      const settled = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-1");
      expect(settled).toMatchObject({ id: first.id, settledEvidence: { id: evidence.id, result: "passed" } });
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review", "other-job"))
        .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    } finally {
      store.close();
    }
  });

  it("persists separate terminal evidence and makes it immutable", () => {
    const { store, unit } = fixture();
    try {
      const review = store.deliveryQuality.claim(unit.id, 1, "code_review");
      const testing = store.deliveryQuality.claim(unit.id, 1, "automated_testing");
      store.deliveryQuality.complete(review, { result: "passed", content: { summary: "ok" } });
      store.deliveryQuality.complete(testing, {
        result: "failed", content: { summary: "failed" },
        commandResults: [{ id: "verify-1", exitCode: 1 }],
        acceptanceTrace: [{ criterion: "Tests pass", commandIds: ["verify-1"], passed: false }]
      });
      expect(store.deliveryQuality.latest(unit.id, "code_review")).toMatchObject({
        result: "passed", inputCodingEvidenceId: review.input.codingEvidence.id,
        inputEvidenceVersion: 1, inputDiffHash: "abc123"
      });
      expect(store.deliveryQuality.latest(unit.id, "automated_testing")).toMatchObject({
        result: "failed", commandResults: [{ id: "verify-1", exitCode: 1 }]
      });
      const db = (store as any).db;
      expect(() => db.prepare("UPDATE delivery_quality_evidence SET result = 'failed' WHERE id = ?")
        .run(store.deliveryQuality.latest(unit.id, "code_review")!.id))
        .toThrow("DELIVERY_QUALITY_EVIDENCE_IMMUTABLE");
    } finally {
      store.close();
    }
  });

  it("serializes same-kind claims across file-backed SQLite connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "delivery-quality-concurrency-"));
    const path = join(directory, "workflow.db");
    const { store: first, unit } = fixture(path);
    const second = new WorkflowStore(path);
    try {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => first.deliveryQuality.claim(unit.id, 1, "code_review")),
        Promise.resolve().then(() => second.deliveryQuality.claim(unit.id, 1, "code_review"))
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ message: "DELIVERY_QUALITY_RUN_ACTIVE" }) })
      ]);
      expect(() => second.deliveryQuality.claim(unit.id, 1, "automated_testing")).not.toThrow();
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects evidence whose input hash does not identify its coding evidence", () => {
    const { store, requirement, unit } = fixture();
    try {
      const claim = store.deliveryQuality.claim(unit.id, 1, "code_review");
      const db = (store as any).db;
      expect(() => db.prepare(`INSERT INTO delivery_quality_evidence
        (id, run_id, requirement_id, delivery_unit_id, evidence_version, kind, result,
         input_coding_evidence_id, input_evidence_version, input_diff_hash, content_json,
         command_results_json, acceptance_trace_json, created_at, completed_at)
        VALUES ('bad-evidence', ?, ?, ?, 1, 'code_review', 'passed', ?, 1, 'wrong-hash', '{}', '[]', '[]', ?, ?)`)
        .run(claim.id, requirement.id, unit.id, claim.input.codingEvidence.id,
          "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z"))
        .toThrow("DELIVERY_QUALITY_EVIDENCE_OWNER_MISMATCH");
    } finally {
      store.close();
    }
  });
});
