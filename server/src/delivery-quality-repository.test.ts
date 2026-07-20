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
    changedFiles: [], identity: {
      repositoryPath: "/tmp/quality", gitCommonDir: "/tmp/quality/.git",
      worktreePath: "/tmp/quality-run", branch: "ai/REQ-0001", headCommit: version.headCommit
    }, manifest: { version: 1, entries: [] }, manifestHash: "manifest-hash",
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
      expect(settled).toMatchObject({
        id: first.id, status: "completed", evidence: { id: evidence.id, result: "passed" }
      });
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review", "other-job"))
        .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    } finally {
      store.close();
    }
  });

  it("idempotently reclaims an aborted run only for the same automation job token", () => {
    const { store, unit } = fixture();
    try {
      const first = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-aborted");
      store.deliveryQuality.abort(first, "IMPLEMENTATION_EVIDENCE_STALE");

      expect((store as any).db.prepare("SELECT status, error FROM delivery_quality_runs WHERE id = ?")
        .get(first.id)).toEqual({ status: "aborted", error: "IMPLEMENTATION_EVIDENCE_STALE" });

      expect(store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-aborted"))
        .toMatchObject({
          id: first.id, status: "aborted", error: "IMPLEMENTATION_EVIDENCE_STALE"
        });
      expect(store.deliveryQuality.latest(unit.id, "code_review")).toBeNull();
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review", "other-job"))
        .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    } finally {
      store.close();
    }
  });

  it.each([
    ["unit status", "UPDATE delivery_units SET status = 'returned' WHERE id = ?"],
    ["evidence version", "UPDATE delivery_units SET evidence_version = 2 WHERE id = ?"]
  ])("reclaims an aborted run after the live %s changes", (_label, mutation) => {
    const { store, unit } = fixture();
    try {
      const first = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-terminal");
      store.deliveryQuality.abort(first, "IMPLEMENTATION_EVIDENCE_STALE");
      (store as any).db.prepare(mutation).run(unit.id);

      expect(store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-terminal"))
        .toMatchObject({
          id: first.id, status: "aborted", error: "IMPLEMENTATION_EVIDENCE_STALE"
        });
      expect(() => store.deliveryQuality.claim(unit.id, 1, "code_review", "other-job"))
        .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
    } finally {
      store.close();
    }
  });

  it.each(["passed", "failed"] as const)(
    "idempotently reclaims a %s run with its real quality evidence",
    (result) => {
      const { store, unit } = fixture();
      try {
        const first = store.deliveryQuality.claim(unit.id, 1, "code_review", `job-review-${result}`);
        const evidence = store.deliveryQuality.complete(first, { result, content: { summary: result } });

        expect(store.deliveryQuality.claim(unit.id, 1, "code_review", `job-review-${result}`))
          .toMatchObject({
            id: first.id,
            status: result === "passed" ? "completed" : "failed",
            evidence: { id: evidence.id, result }
          });
      } finally {
        store.close();
      }
    }
  );

  it.each(["passed", "failed"] as const)(
    "directly replays the same sanitized %s completion without consulting live unit state",
    (result) => {
      const { store, unit } = fixture();
      try {
        const claim = store.deliveryQuality.claim(unit.id, 1, "code_review", `direct-${result}`);
        if (claim.status !== "running") throw new Error("expected running claim");
        const first = store.deliveryQuality.complete(claim, {
          result,
          content: { summary: result, nested: { alpha: 1, beta: 2 }, authorization: "Bearer first-secret" },
          commandResults: [{ command: "test", exitCode: 0 }],
          acceptanceTrace: [{ criterion: "works", passed: true }]
        });
        (store as any).db.prepare("UPDATE delivery_units SET evidence_version = 2 WHERE id = ?").run(unit.id);

        const replay = store.deliveryQuality.complete(claim, {
          result,
          content: { authorization: "Bearer second-secret", nested: { beta: 2, alpha: 1 }, summary: result },
          commandResults: [{ exitCode: 0, command: "test" }],
          acceptanceTrace: [{ passed: true, criterion: "works" }]
        });

        expect(replay).toEqual(first);
        expect((store as any).db.prepare(
          "SELECT COUNT(*) AS count FROM delivery_quality_evidence WHERE run_id = ?"
        ).get(claim.id).count).toBe(1);
      } finally {
        store.close();
      }
    }
  );

  it.each([
    ["result", { result: "failed" as const, content: { summary: "original" }, commandResults: [], acceptanceTrace: [] }],
    ["content", { result: "passed" as const, content: { summary: "changed" }, commandResults: [], acceptanceTrace: [] }],
    ["command results", { result: "passed" as const, content: { summary: "original" }, commandResults: [{ exitCode: 1 }], acceptanceTrace: [] }],
    ["acceptance trace", { result: "passed" as const, content: { summary: "original" }, commandResults: [], acceptanceTrace: [{ passed: false }] }]
  ])("fails closed when direct terminal replay %s conflicts after sanitization", (_field, conflicting) => {
    const { store, unit } = fixture();
    try {
      const claim = store.deliveryQuality.claim(unit.id, 1, "code_review", "direct-conflict");
      if (claim.status !== "running") throw new Error("expected running claim");
      const first = store.deliveryQuality.complete(claim, {
        result: "passed", content: { summary: "original" }, commandResults: [], acceptanceTrace: []
      });

      expect(() => store.deliveryQuality.complete(claim, conflicting))
        .toThrow("DELIVERY_QUALITY_REPLAY_CONFLICT");
      expect(() => store.deliveryQuality.complete({ ...claim, deliveryUnitId: "different" }, {
        result: "passed", content: { summary: "original" }, commandResults: [], acceptanceTrace: []
      })).toThrow("DELIVERY_QUALITY_RUN_STALE");
      expect(store.deliveryQuality.latest(unit.id, "code_review")).toEqual(first);
    } finally {
      store.close();
    }
  });

  it("does not turn an aborted run without evidence into a terminal replay", () => {
    const { store, unit } = fixture();
    try {
      const claim = store.deliveryQuality.claim(unit.id, 1, "code_review", "direct-aborted");
      if (claim.status !== "running") throw new Error("expected running claim");
      store.deliveryQuality.abort(claim, "IMPLEMENTATION_EVIDENCE_STALE");

      expect(() => store.deliveryQuality.complete(claim, { result: "passed", content: {} }))
        .toThrow("DELIVERY_QUALITY_RUN_SETTLED");
      expect(store.deliveryQuality.latest(unit.id, "code_review")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reclaims real terminal evidence without consulting the live unit", () => {
    const { store, unit } = fixture();
    try {
      const first = store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-evidence");
      const evidence = store.deliveryQuality.complete(first, {
        result: "failed", content: { summary: "business failure" }
      });
      (store as any).db.prepare(
        "UPDATE delivery_units SET status = 'returned', evidence_version = 2 WHERE id = ?"
      ).run(unit.id);

      expect(store.deliveryQuality.claim(unit.id, 1, "code_review", "job-review-evidence"))
        .toMatchObject({ id: first.id, status: "failed", evidence: { id: evidence.id } });
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
      expect(review.status).toBe("running");
      expect(testing.status).toBe("running");
      if (review.status !== "running" || testing.status !== "running") {
        throw new Error("expected running claims");
      }
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

  it("deep-redacts every untrusted quality completion field at the persistence boundary", () => {
    const { store, unit } = fixture();
    try {
      const claim = store.deliveryQuality.claim(unit.id, 1, "automated_testing");
      if (claim.status !== "running") throw new Error("expected running claim");
      const probes = [
        "basic-persist-probe", "bearer-persist-probe", "aws-persist-probe",
        "openai-persist-probe", "github-persist-probe", "url-persist-probe",
        "database-persist-probe", "structured-persist-probe"
      ];
      store.deliveryQuality.complete(claim, {
        result: "failed",
        content: {
          clientSecret: "structured-persist-probe",
          error: "Authorization: Basic basic-persist-probe"
        },
        commandResults: [{
          stdout: "Authorization: Bearer bearer-persist-probe\nAWS_SECRET_ACCESS_KEY=aws-persist-probe",
          stderr: "OPENAI_API_KEY=sk-proj-openai-persist-probe GITHUB_TOKEN=ghp_github-persist-probe"
        }],
        acceptanceTrace: [{
          criterion: "https://user:url-persist-probe@example.com",
          detail: "postgres://user:database-persist-probe@localhost/app"
        }]
      });

      const row = (store as any).db.prepare(`SELECT content_json, command_results_json, acceptance_trace_json
        FROM delivery_quality_evidence WHERE run_id = ?`).get(claim.id);
      const persisted = JSON.stringify(row);
      for (const probe of probes) expect(persisted).not.toContain(probe);
      expect(persisted).toContain("[REDACTED]");
    } finally {
      store.close();
    }
  });

  it("rolls back quality completion when bounded sanitization overflows", () => {
    const { store, unit } = fixture();
    try {
      const claim = store.deliveryQuality.claim(unit.id, 1, "code_review");
      if (claim.status !== "running") throw new Error("expected running claim");
      let trailingReads = 0;
      const content = ["x".repeat(600_000), "y".repeat(600_000), "z".repeat(600_000), "unused"];
      Object.defineProperty(content, 3, {
        enumerable: true,
        get() { trailingReads += 1; return "must not be visited"; }
      });

      expect(() => store.deliveryQuality.complete(claim, {
        result: "passed", content
      })).toThrow("DELIVERY_QUALITY_PERSISTENCE_LIMIT");

      expect(trailingReads).toBe(0);
      expect((store as any).db.prepare("SELECT COUNT(*) AS count FROM delivery_quality_evidence WHERE run_id = ?")
        .get(claim.id)).toEqual({ count: 0 });
      expect((store as any).db.prepare("SELECT status FROM delivery_quality_runs WHERE id = ?")
        .get(claim.id)).toEqual({ status: "running" });
    } finally {
      store.close();
    }
  });

  it("makes the persisted coding evidence tree immutable", () => {
    const { store, unit } = fixture();
    try {
      const evidence = store.deliveryExecutions.getCodingEvidence(unit.id, 1) as { id: string };
      const db = (store as any).db;
      expect(() => db.prepare("UPDATE coding_evidence SET manifest_json = ? WHERE id = ?")
        .run('{"version":1,"entries":[]}', evidence.id))
        .toThrow("CODING_EVIDENCE_IMMUTABLE");
      expect(() => db.prepare("DELETE FROM coding_evidence WHERE id = ?").run(evidence.id))
        .toThrow("CODING_EVIDENCE_IMMUTABLE");
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
      expect(claim.status).toBe("running");
      if (claim.status !== "running") throw new Error("expected running claim");
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
