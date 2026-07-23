import { describe, test, expect } from "bun:test";
import { evaluateBunTestSummary } from "../../scripts/run-tests-gated";

// mt#2716: these fixtures assert the FAIL-CLOSED behavior of the pre-push test
// gate. The summary-block shapes below match real `bun test` 1.2.21 output
// (pinned by mt#2665 against live macOS + GitHub Actions logs): a leading space
// before each count, and "Ran N tests across M file(s)" with singular "file"
// for a single-file run.

// Shared completion-summary "Ran …" line, reused across fixtures so the count
// stays consistent (and to satisfy custom/no-magic-string-duplication).
const ranLine = "Ran 512 tests across 87 files. [12.30s]";

const cleanSummary = [" 512 pass", " 0 fail", " 1200 expect() calls", ranLine].join("\n");

const failingSummary = [" 510 pass", " 2 fail", " 1198 expect() calls", ranLine].join("\n");

const singleFileSummary = ["1 pass", "0 fail", "Ran 1 tests across 1 file. [0.10s]"].join("\n");

// mt#3014 finding: real bun 1.2.21 output singularizes "test" independently of
// "file" -- a run with exactly ONE test prints "Ran 1 test across 1 file."
// (verified empirically), NOT "Ran 1 tests across 1 file." as the fixture
// above (pre-existing, kept for regression coverage of the broader pattern)
// assumed. That mismatch meant the "singular file" test above was accidentally
// passing without ever exercising bun's real singular-test text -- a format-
// alignment gap (see .claude/rules/bun-test-patterns.md's "Format Alignment
// Pattern"). This fixture reproduces the REAL singular form.
const singleTestSingleFileSummary = ["1 pass", "0 fail", "Ran 1 test across 1 file. [0.10s]"].join(
  "\n"
);

// The exact failure this gate exists to catch: a run that exits 0 but never
// prints the completion summary (silent truncation).
const truncatedOutput = [
  "bun test v1.2.21",
  "src/foo.test.ts:",
  "(pass) foo > does a thing [0.5ms]",
].join("\n");

describe("evaluateBunTestSummary (mt#2716 fail-closed pre-push gate)", () => {
  test("passes a clean run: summary present, 0 fail, exit 0", () => {
    expect(evaluateBunTestSummary(cleanSummary, 0)).toEqual({ ok: true, reason: "" });
  });

  test('passes a single-file run (singular "1 file", no trailing s)', () => {
    expect(evaluateBunTestSummary(singleFileSummary, 0).ok).toBe(true);
  });

  test('passes a REAL single-test single-file run (singular "1 test", no trailing s, mt#3014)', () => {
    expect(evaluateBunTestSummary(singleTestSingleFileSummary, 0).ok).toBe(true);
  });

  test("FAILS a truncated run (no completion summary) even on exit 0 — the core mt#2716 fix", () => {
    const r = evaluateBunTestSummary(truncatedOutput, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no completion summary");
  });

  test("FAILS when the summary reports failing tests", () => {
    const r = evaluateBunTestSummary(failingSummary, 1);
    expect(r.ok).toBe(false);
    // Exact emitted phrasing (`bun test reported N failing test(s)`), not a loose substring.
    expect(r.reason).toContain("2 failing test(s)");
  });

  test("FAILS closed when the summary is clean but the exit code is non-zero", () => {
    const r = evaluateBunTestSummary(cleanSummary, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exited 1 despite a clean summary");
  });

  test('FAILS closed when the Ran-line is present but the "<N> fail" line is absent', () => {
    const onlyRanLine = "Ran 512 tests across 87 files. [12.30s]";
    const r = evaluateBunTestSummary(onlyRanLine, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('"<N> fail" line could not be found');
  });

  test("does not mistake a test NAME containing 'fail' for the summary line", () => {
    // A test title line must not satisfy the anchored /^ *\\d+ fail$/ pattern.
    const withDecoyName = [
      "(pass) handles the 0 fail edge case [1ms]",
      " 3 pass",
      " 0 fail",
      "Ran 3 tests across 1 file. [0.05s]",
    ].join("\n");
    expect(evaluateBunTestSummary(withDecoyName, 0).ok).toBe(true);
  });

  // mt#3078: a colorizing shell (FORCE_COLOR set, inherited by the spawned
  // subprocess) wraps each summary line in ANSI codes — real fixture captured
  // from a live `bun test` run under `FORCE_COLOR=3`. Pre-fix, the exact-line
  // regexes never matched the colorized " 0 fail" line and this genuinely
  // clean run was fail-closed as "the <N> fail line could not be found".
  test("passes a clean run whose summary lines are ANSI-colorized (FORCE_COLOR, mt#3078)", () => {
    const colorizedSummary = [
      "\x1b[0m\x1b[1mbun test \x1b[2mv1.2.21 (7c45ed97)\x1b[0m",
      "\x1b[0m\x1b[32m 133 pass\x1b[0m",
      "\x1b[0m\x1b[2m 0 fail\x1b[0m",
      " 361 expect() calls",
      "Ran 133 tests across 3 files. \x1b[0m\x1b[2m[\x1b[1m102.00ms\x1b[0m\x1b[2m]\x1b[0m",
    ].join("\n");
    expect(evaluateBunTestSummary(colorizedSummary, 0)).toEqual({ ok: true, reason: "" });
  });

  test("still FAILS closed on an ANSI-colorized run reporting real failures (mt#3078)", () => {
    const colorizedFailing = [
      "\x1b[0m\x1b[32m 5 pass\x1b[0m",
      "\x1b[0m\x1b[31m 2 fail\x1b[0m",
      "Ran 7 tests across 1 file. [0.05s]",
    ].join("\n");
    const r = evaluateBunTestSummary(colorizedFailing, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2 failing test(s)");
  });
});
