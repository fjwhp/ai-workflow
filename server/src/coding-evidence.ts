import { createHash } from "node:crypto";

export function hashDiff(diff: string) { return createHash("sha256").update(diff).digest("hex"); }

export function buildCodingEvidence(input: { diff: string; maxDiffChars?: number; files?: string[]; additions?: number; deletions?: number }) {
  const max = input.maxDiffChars ?? 120000;
  const truncated = input.diff.length > max;
  const marker = "\n... [DIFF TRUNCATED] ...\n";
  const half = Math.floor((max - marker.length) / 2);
  const diff = truncated ? `${input.diff.slice(0, half)}${marker}${input.diff.slice(-half)}` : input.diff;
  return { diffHash: hashDiff(input.diff), diff, originalChars: input.diff.length, truncated,
    files: input.files ?? [], fileCount: input.files?.length ?? 0, additions: input.additions ?? 0, deletions: input.deletions ?? 0 };
}
