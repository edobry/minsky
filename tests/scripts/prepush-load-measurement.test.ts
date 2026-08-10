import { describe, expect, test } from "bun:test";
import {
  deriveVerdict,
  median,
  parseCompletionSummary,
  parseFailingTests,
  parseSelectionLine,
  selectedCount,
  straddleCheck,
  summarizeCommitSelection,
  summarizeCondition,
  type CommitSelection,
  type RunOutcome,
  type ShapeResult,
} from "../../scripts/prepush-load-measurement";

/**
 * The selection-line fixtures below are VERBATIM bun 1.3.14 output captured on
 * 2026-08-10 in the mt#3871 session, not strings written from memory of bun's
 * format. That matters: the whole measurement rests on reading this line, so a
 * fixture invented to match the parser would make these tests agree with the
 * parser about a format neither had observed.
 */
const SELECTION_RUNNING = "--changed: 22 changed files, running 3/3 test files";
const SELECTION_UNAFFECTED = "--changed: 6 changed files, but no test files are affected";
const SELECTION_EMPTY = "--changed: no changed files, nothing to run";

function run(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    shape: "a",
    condition: "idle",
    passed: true,
    exitCode: 0,
    wallMs: 1000,
    loadStart: 2,
    loadEnd: 2,
    selection: null,
    summary: null,
    failures: [],
    ...overrides,
  };
}

describe("parseSelectionLine (bun 1.3.14 grammar)", () => {
  test("reads the selecting shape, keeping selected and candidate counts apart", () => {
    const report = parseSelectionLine(`bun test v1.3.14\n${SELECTION_RUNNING}\n`);
    expect(report).toEqual({
      kind: "selected",
      changedFiles: 22,
      selected: 3,
      candidates: 3,
    });
    expect(selectedCount(report)).toBe(3);
  });

  test("distinguishes a real diff that selects nothing from an empty diff", () => {
    const unaffected = parseSelectionLine(SELECTION_UNAFFECTED);
    expect(unaffected).toEqual({ kind: "no-affected-tests", changedFiles: 6 });

    const empty = parseSelectionLine(SELECTION_EMPTY);
    expect(empty).toEqual({ kind: "no-changed-files" });

    // Both select zero, but they answer different questions and must not collapse.
    expect(selectedCount(unaffected)).toBe(0);
    expect(selectedCount(empty)).toBe(0);
    expect(unaffected).not.toEqual(empty);
  });

  test("survives bun's colorized output", () => {
    const colorized = `\x1b[2m--changed: 22 changed files, running 3/3 test files\x1b[0m`;
    expect(parseSelectionLine(colorized)).toEqual({
      kind: "selected",
      changedFiles: 22,
      selected: 3,
      candidates: 3,
    });
  });

  test("returns null rather than guessing when no selection line is present", () => {
    expect(parseSelectionLine("Ran 5 tests across 2 files.")).toBeNull();
  });
});

describe("parseCompletionSummary", () => {
  test("parses plural and singular forms", () => {
    expect(parseCompletionSummary("Ran 11063 tests across 775 files. [167.09s]")).toEqual({
      tests: 11063,
      files: 775,
    });
    expect(parseCompletionSummary("Ran 1 test across 1 file. [0.22s]")).toEqual({
      tests: 1,
      files: 1,
    });
  });

  test("returns null on a truncated run with no summary at all", () => {
    expect(parseCompletionSummary("bun test v1.3.14\n 0 pass\n")).toBeNull();
  });
});

describe("parseFailingTests", () => {
  /** Verbatim from mt#3501's recorded failure output. */
  const FAILURES = [
    "(fail) startTranscriptSweepBackstop (mt#2321) > tick calls ingestAll then embeddings and records observability [508.25ms]",
    "(fail) startTranscriptSweepBackstop (mt#2321) > ingest is called on each tick (idempotency delegated to ingestAll) [2004.45ms]",
    "(pass) something that worked [1.20ms]",
  ].join("\n");

  test("captures each failure's per-test elapsed, which is the direct quantity", () => {
    const failures = parseFailingTests(FAILURES);
    expect(failures).toHaveLength(2);
    expect(failures[0]?.elapsedMs).toBe(508.25);
    expect(failures[1]?.elapsedMs).toBe(2004.45);
    // 508.25ms against mt#3501's 500ms deadline is an 8ms miss — the margin a
    // suite wall time cannot show.
    expect((failures[0]?.elapsedMs ?? 0) - 500).toBeCloseTo(8.25, 2);
  });

  test("does not mistake a passing line for a failure", () => {
    expect(parseFailingTests(FAILURES).map((f) => f.name)).not.toContain("something that worked");
  });

  test("keeps a failure that printed no elapsed", () => {
    const failures = parseFailingTests("(fail) a test with no bracket");
    expect(failures).toEqual([{ name: "a test with no bracket", elapsedMs: null }]);
  });
});

describe("median", () => {
  test("averages the middle pair on an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("takes the middle element on an odd count", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("summarizeCondition", () => {
  test("aggregates wall time, load range, and the worst observed failure elapsed", () => {
    const summary = summarizeCondition([
      run({ wallMs: 300, loadStart: 2, loadEnd: 3 }),
      run({
        wallMs: 900,
        loadStart: 20,
        loadEnd: 24,
        passed: false,
        failures: [{ name: "t1", elapsedMs: 508.25 }],
      }),
      run({
        wallMs: 600,
        loadStart: 18,
        loadEnd: 19,
        passed: false,
        failures: [
          { name: "t1", elapsedMs: 2004.45 },
          { name: "t2", elapsedMs: null },
        ],
      }),
    ]);

    expect(summary.runs).toBe(3);
    expect(summary.failedRuns).toBe(2);
    expect(summary.wallMs).toEqual({ min: 300, median: 600, max: 900 });
    expect(summary.load).toEqual({ min: 2, max: 24 });
    expect(summary.failingTestNames).toEqual(["t1", "t2"]);
    expect(summary.worstFailureElapsedMs).toBe(2004.45);
  });

  test("reports no worst-elapsed when nothing failed", () => {
    expect(summarizeCondition([run(), run()]).worstFailureElapsedMs).toBeNull();
  });
});

describe("straddleCheck (mem#821)", () => {
  test("classifies an all-pass pair as same-regime, not as evidence of independence", () => {
    const verdict = straddleCheck([run(), run()], [run({ condition: "loaded" })]);
    expect(verdict).toEqual({ kind: "same-regime", regime: "all-pass" });
  });

  test("classifies an all-fail pair as same-regime too", () => {
    const failed = run({ passed: false });
    expect(straddleCheck([failed], [{ ...failed, condition: "loaded" }])).toEqual({
      kind: "same-regime",
      regime: "all-fail",
    });
  });

  test("only a pair with outcomes on both sides straddles the boundary", () => {
    const verdict = straddleCheck(
      [run(), run()],
      [run({ condition: "loaded", passed: false }), run({ condition: "loaded" })]
    );
    expect(verdict).toEqual({ kind: "straddles", idleFailedRuns: 0, loadedFailedRuns: 1 });
  });

  test("an empty condition is insufficient data, never a same-regime conclusion", () => {
    expect(straddleCheck([], [run()])).toEqual({ kind: "insufficient-data" });
  });
});

describe("deriveVerdict", () => {
  const insensitiveStable: ShapeResult = {
    shape: "a",
    selectsLoadSensitive: false,
    straddle: { kind: "same-regime", regime: "all-pass" },
  };

  test("an unreached failing regime is inconclusive, NOT met", () => {
    // The trap this branch exists for: every run passed, which looks like
    // success and is actually a statement about the load generator.
    const report = deriveVerdict([
      insensitiveStable,
      {
        shape: "b",
        selectsLoadSensitive: true,
        straddle: { kind: "same-regime", regime: "all-pass" },
      },
    ]);
    expect(report.verdict).toBe("inconclusive");
    expect(report.rationale).toContain("no positive control established");
  });

  test("load-dependence confined to the sensitive shape is met-conditionally", () => {
    const report = deriveVerdict([
      insensitiveStable,
      {
        shape: "b",
        selectsLoadSensitive: true,
        straddle: { kind: "straddles", idleFailedRuns: 0, loadedFailedRuns: 4 },
      },
    ]);
    expect(report.verdict).toBe("met-conditionally");
  });

  test("load-dependence in a shape that selects no load-sensitive test is not-met", () => {
    const report = deriveVerdict([
      {
        shape: "a",
        selectsLoadSensitive: false,
        straddle: { kind: "straddles", idleFailedRuns: 0, loadedFailedRuns: 2 },
      },
      {
        shape: "b",
        selectsLoadSensitive: true,
        straddle: { kind: "straddles", idleFailedRuns: 0, loadedFailedRuns: 5 },
      },
    ]);
    expect(report.verdict).toBe("not-met");
  });

  test("a sensitive shape that reached failure but never varied still bounds the claim", () => {
    const report = deriveVerdict([
      insensitiveStable,
      {
        shape: "b",
        selectsLoadSensitive: true,
        straddle: { kind: "same-regime", regime: "all-fail" },
      },
    ]);
    expect(report.verdict).toBe("met-conditionally");
  });

  test("a failing unscoped control turns an all-pass scoped result into met", () => {
    // This is the pairing the measurement turns on: the control proves the load
    // condition CAN break these tests, so the scoped runs passing under it is a
    // fact about scoping rather than about a weak load generator.
    const report = deriveVerdict(
      [
        insensitiveStable,
        {
          shape: "b",
          selectsLoadSensitive: true,
          straddle: { kind: "same-regime", regime: "all-pass" },
        },
      ],
      { runs: 2, failedRuns: 2 }
    );
    expect(report.verdict).toBe("met");
    expect(report.rationale).toContain("2/2");
  });

  test("a control that never failed leaves the result inconclusive", () => {
    const report = deriveVerdict(
      [
        insensitiveStable,
        {
          shape: "b",
          selectsLoadSensitive: true,
          straddle: { kind: "same-regime", regime: "all-pass" },
        },
      ],
      { runs: 2, failedRuns: 0 }
    );
    expect(report.verdict).toBe("inconclusive");
  });

  test("measuring no sensitive shape at all cannot produce a verdict", () => {
    expect(deriveVerdict([insensitiveStable]).verdict).toBe("inconclusive");
    expect(deriveVerdict([]).verdict).toBe("inconclusive");
  });
});

describe("summarizeCommitSelection (per-commit replay)", () => {
  function commit(overrides: Partial<CommitSelection> = {}): CommitSelection {
    return { sha: "a".repeat(40), filesReplayed: 3, filesMissing: 0, selected: 0, ...overrides };
  }

  test("scores a commit as selecting when its diff reaches any load-sensitive file", () => {
    const fraction = summarizeCommitSelection([
      commit({ sha: "1", selected: 0 }),
      commit({ sha: "2", selected: 1 }),
      commit({ sha: "3", selected: 3 }),
      commit({ sha: "4", selected: 0 }),
    ]);
    expect(fraction).toEqual({
      commitsExamined: 4,
      commitsSelecting: 2,
      fraction: 0.5,
      commitsUnreplayable: 0,
    });
  });

  test("excludes unreplayable commits from the denominator rather than scoring them zero", () => {
    // A commit whose files are all gone proves nothing either way. Counting it as
    // non-selecting would silently deflate the fraction — the same masking error
    // that made the two-ref differential unusable.
    const fraction = summarizeCommitSelection([
      commit({ sha: "1", selected: 1 }),
      commit({ sha: "2", filesReplayed: 0, filesMissing: 4, selected: 0 }),
    ]);
    expect(fraction.commitsExamined).toBe(1);
    expect(fraction.commitsSelecting).toBe(1);
    expect(fraction.fraction).toBe(1);
    expect(fraction.commitsUnreplayable).toBe(1);
  });

  test("reports NaN rather than 0 when nothing could be examined", () => {
    const fraction = summarizeCommitSelection([commit({ filesReplayed: 0, filesMissing: 2 })]);
    expect(Number.isNaN(fraction.fraction)).toBe(true);
  });
});
