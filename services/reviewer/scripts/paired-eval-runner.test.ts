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
  armLabel,
  groupCorpusRowsByPr,
  isPositiveGroundTruth,
  samplePrNumbers,
  scoreModelFindings,
  splitModelSpec,
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

// ---------------------------------------------------------------------------
// --model arm parsing, including the reasoning-effort suffix (mt#4554)
// ---------------------------------------------------------------------------

describe("splitModelSpec", () => {
  test("parses a two-segment spec with no effort pinned", () => {
    const result = splitModelSpec("openai:gpt-5");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({ provider: "openai", model: "gpt-5" });
    // Absent, not null/undefined-valued: an unpinned arm must be
    // indistinguishable from a pre-mt#4554 arm at the call site.
    expect("reasoningEffort" in result.value).toBe(false);
  });

  test.each(["low", "medium", "high"] as const)("parses %s as a pinned effort", (effort) => {
    const result = splitModelSpec(`openai:gpt-5:${effort}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: effort,
    });
  });

  test("keeps a dotted model id intact when an effort follows it", () => {
    // gpt-5.6-luna is the arm mt#4554 exists to test; a naive split would
    // mangle it or drop the effort.
    const result = splitModelSpec("openai:gpt-5.6-luna:high");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.model).toBe("gpt-5.6-luna");
    expect(result.value.reasoningEffort).toBe("high");
  });

  test("rejects an unrecognized effort instead of folding it into the model id", () => {
    // The failure this guards: "minimal" is not in the ReasoningEffort union
    // (providers.ts:376). Folding it into the model name would send a request
    // for a model called "gpt-5:minimal" and surface as an opaque provider
    // 404 rather than an argument error.
    const result = splitModelSpec("openai:gpt-5:minimal");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("minimal");
    expect(result.error).toContain("low|medium|high");
  });

  test("rejects an unknown provider", () => {
    const result = splitModelSpec("cohere:command-r");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("openai|google|anthropic");
  });

  test.each([
    ["no colon", "gpt-5"],
    ["empty provider", ":gpt-5"],
    ["empty model", "openai:"],
  ])("rejects a malformed spec (%s)", (_label, raw) => {
    const result = splitModelSpec(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects an effort suffix with no model id", () => {
    const result = splitModelSpec("openai::high");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no model id");
  });
});

describe("armLabel", () => {
  test("omits the effort when none is pinned, matching pre-mt#4554 labels", () => {
    // Load-bearing for comparability: results artifacts written before this
    // change key arms as "<provider>:<model>", and an unpinned arm must still
    // produce that exact string or old and new runs cannot be joined.
    expect(armLabel({ provider: "openai", model: "gpt-5" })).toBe("openai:gpt-5");
  });

  test("carries the effort when one is pinned", () => {
    expect(armLabel({ provider: "openai", model: "gpt-5", reasoningEffort: "high" })).toBe(
      "openai:gpt-5:high"
    );
  });

  test("distinguishes two arms that differ only in effort", () => {
    // The factorial this change exists to enable: same model, two efforts, one
    // artifact. Equal labels would collapse them into one row.
    const low = armLabel({ provider: "openai", model: "gpt-5", reasoningEffort: "low" });
    const high = armLabel({ provider: "openai", model: "gpt-5", reasoningEffort: "high" });
    expect(low).not.toBe(high);
  });

  test("round-trips through splitModelSpec", () => {
    for (const raw of ["openai:gpt-5", "openai:gpt-5:high", "anthropic:claude-sonnet-4-6"]) {
      const result = splitModelSpec(raw);
      if (!result.ok) throw new Error(`expected ${raw} to parse`);
      expect(armLabel(result.value)).toBe(raw);
    }
  });
});
