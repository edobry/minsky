/**
 * Unit tests for the pure helpers in paired-eval-runner.ts (mt#2726
 * Milestone A, wave 3).
 *
 * All tests exercise fixture inputs directly — no live GitHub API calls, no
 * model calls, no network. The I/O-bound orchestration (`main`,
 * `runSingleAttempt`, `fetchIterationContext`) is intentionally NOT
 * unit-tested here; it is exercised via `--dry-run` (see the PR body for
 * that output) and, for the live path, by the main agent's bounded live run.
 */

import { describe, expect, test } from "bun:test";
import type { CorpusRow } from "../src/eval-corpus";
import type { FlatFinding } from "../src/replay-summary";
import {
  groupCorpusRowsByPr,
  isPositiveGroundTruth,
  samplePrNumbers,
  scoreModelFindings,
} from "./paired-eval-runner";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let nextRowId = 0;

function makeRow(overrides: {
  prNumber?: number;
  file?: string;
  line?: number;
  severity?: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  labelValue?: CorpusRow["label"]["value"];
  confidence?: CorpusRow["label"]["confidence"];
}): CorpusRow {
  const id = `row-${nextRowId++}`;
  return {
    id,
    corpusVersion: "v1",
    source: "git-diff-mined",
    prNumber: overrides.prNumber ?? 100,
    round: 1,
    finding: {
      file: overrides.file ?? "src/foo.ts",
      severity: overrides.severity ?? "BLOCKING",
      line: overrides.line ?? 10,
      text: "some finding text",
    },
    codeContextWindow: "context",
    label: {
      value: overrides.labelValue ?? "git-diff-fixed",
      provenance: "deterministic",
      confidence: overrides.confidence ?? "noisy-positive",
    },
    minedAt: "2026-01-01T00:00:00.000Z",
  };
}

function positiveRow(overrides: Parameters<typeof makeRow>[0] = {}): CorpusRow {
  return makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive", ...overrides });
}

function negativeRow(overrides: Parameters<typeof makeRow>[0] = {}): CorpusRow {
  return makeRow({ labelValue: "dismissed-no-change", confidence: "noisy-negative", ...overrides });
}

function finding(overrides: Partial<FlatFinding> = {}): FlatFinding {
  return { file: "src/foo.ts", severity: "BLOCKING", line: 10, ...overrides };
}

// ---------------------------------------------------------------------------
// isPositiveGroundTruth
// ---------------------------------------------------------------------------

describe("isPositiveGroundTruth", () => {
  test("gold confidence is positive", () => {
    expect(isPositiveGroundTruth(makeRow({ confidence: "gold" }))).toBe(true);
  });

  test("noisy-positive confidence is positive", () => {
    expect(isPositiveGroundTruth(makeRow({ confidence: "noisy-positive" }))).toBe(true);
  });

  test("noisy-negative confidence is not positive", () => {
    expect(isPositiveGroundTruth(makeRow({ confidence: "noisy-negative" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupCorpusRowsByPr / samplePrNumbers
// ---------------------------------------------------------------------------

describe("groupCorpusRowsByPr", () => {
  test("groups rows by prNumber, preserving row order within a group", () => {
    const r1 = positiveRow({ prNumber: 5 });
    const r2 = positiveRow({ prNumber: 7 });
    const r3 = positiveRow({ prNumber: 5 });

    const grouped = groupCorpusRowsByPr([r1, r2, r3]);

    expect(grouped.size).toBe(2);
    expect(grouped.get(5)).toEqual([r1, r3]);
    expect(grouped.get(7)).toEqual([r2]);
  });

  test("empty input produces an empty map", () => {
    expect(groupCorpusRowsByPr([]).size).toBe(0);
  });
});

describe("samplePrNumbers", () => {
  test("returns ascending PR numbers, capped at sampleSize", () => {
    const grouped = groupCorpusRowsByPr([
      positiveRow({ prNumber: 30 }),
      positiveRow({ prNumber: 10 }),
      positiveRow({ prNumber: 20 }),
    ]);
    expect(samplePrNumbers(grouped, 2)).toEqual([10, 20]);
  });

  test("sampleSize larger than the corpus returns every PR", () => {
    const grouped = groupCorpusRowsByPr([
      positiveRow({ prNumber: 1 }),
      positiveRow({ prNumber: 2 }),
    ]);
    expect(samplePrNumbers(grouped, 10)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// scoreModelFindings
// ---------------------------------------------------------------------------

describe("scoreModelFindings", () => {
  test("exact-location match against a positive row -> tp, verdict BUG_HIT", () => {
    const gt = positiveRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 10 })], [gt]);

    expect(result.tp).toBe(1);
    expect(result.fp).toBe(0);
    expect(result.fn).toBe(0);
    expect(result.tn).toBe(0);
    expect(result.verdicts).toEqual(["BUG_HIT"]);
    expect(result.matches).toEqual([{ producedIndex: 0, groundTruthIndex: 0 }]);
  });

  test("proximity match within the +/-5 line window counts as a match", () => {
    const gt = positiveRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 15 })], [gt]);

    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
  });

  test("line distance beyond the +/-5 window does NOT match", () => {
    const gt = positiveRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 16 })], [gt]);

    // Produced finding matched nothing -> fp; the positive gt row went
    // unmatched -> fn.
    expect(result.tp).toBe(0);
    expect(result.fp).toBe(1);
    expect(result.fn).toBe(1);
    expect(result.verdicts).toEqual(["VALID"]);
  });

  test("different file never matches regardless of line proximity", () => {
    const gt = positiveRow({ file: "src/a.ts", line: 10 });
    const result = scoreModelFindings([finding({ file: "src/b.ts", line: 10 })], [gt]);

    expect(result.tp).toBe(0);
    expect(result.fp).toBe(1);
    expect(result.fn).toBe(1);
  });

  test("produced finding matching a negative row -> fp, fpMatchingNegative, verdict NOISE", () => {
    const gt = negativeRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 10 })], [gt]);

    expect(result.tp).toBe(0);
    expect(result.fp).toBe(1);
    expect(result.fpMatchingNegative).toBe(1);
    expect(result.fn).toBe(0); // negative rows never contribute to fn
    expect(result.tn).toBe(0); // matched, so NOT a true negative
    expect(result.verdicts).toEqual(["NOISE"]);
  });

  test("produced finding matching nothing at all -> fp, verdict VALID (no ground truth)", () => {
    const result = scoreModelFindings([finding({ file: "src/nowhere.ts" })], []);

    expect(result.tp).toBe(0);
    expect(result.fp).toBe(1);
    expect(result.fpMatchingNegative).toBe(0);
    expect(result.verdicts).toEqual(["VALID"]);
  });

  test("no produced findings -> every positive row is an fn, every negative row is a tn", () => {
    const gt1 = positiveRow({ line: 10 });
    const gt2 = negativeRow({ line: 50 });
    const result = scoreModelFindings([], [gt1, gt2]);

    expect(result.tp).toBe(0);
    expect(result.fp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.tn).toBe(1);
    expect(result.matches).toEqual([]);
  });

  test("unmatched negative row counts as a true negative", () => {
    const gt = negativeRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 999 })], [gt]);

    expect(result.tn).toBe(1);
    expect(result.fp).toBe(1); // the produced finding still matched nothing positive
  });

  test("two produced findings both matching the same positive row both count as tp", () => {
    const gt = positiveRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: 10 }), finding({ line: 12 })], [gt]);

    expect(result.tp).toBe(2);
    expect(result.fn).toBe(0);
    expect(result.matches.length).toBe(2);
  });

  test("severityCounts buckets tp/fn by the ground-truth finding's severity", () => {
    const blockingHit = positiveRow({ line: 10, severity: "BLOCKING" });
    const blockingMiss = positiveRow({ line: 200, severity: "BLOCKING" });
    const nonBlockingMiss = positiveRow({ line: 300, severity: "NON-BLOCKING" });

    const result = scoreModelFindings(
      [finding({ line: 10, severity: "BLOCKING" })],
      [blockingHit, blockingMiss, nonBlockingMiss]
    );

    expect(result.severityCounts["BLOCKING"]).toEqual({ tp: 1, fn: 1 });
    expect(result.severityCounts["NON-BLOCKING"]).toEqual({ tp: 0, fn: 1 });
  });

  test("a finding with no line number matches any line in the same file (file-only fallback)", () => {
    const gt = positiveRow({ line: 10 });
    const result = scoreModelFindings([finding({ line: undefined })], [gt]);

    expect(result.tp).toBe(1);
  });
});
