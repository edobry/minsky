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
});

// mt#3081: a FORCE_COLOR-carrying shell environment wraps bun test's
// completion-summary and "<N> fail" lines in ANSI escape codes, which
// defeated the (previously un-stripped) anchored `^ *\d+ fail$` regex.
// Reproduced live via `scripts/run-related-tests.ts` during mt#3072
// (2026-07-23): a genuinely passing run ("82 pass, 0 fail") was rejected as
// "the '<N> fail' line could not be found — refusing to assume 0 failures".
describe("evaluateBunTestSummary (mt#3081 — ANSI-wrapped output)", () => {
  test("passes a 0-fail run whose fail line is ANSI-wrapped (FORCE_COLOR reproduction)", () => {
    // Byte-for-byte the shape captured from the mt#3072 incident: the fail
    // line wrapped in reset+dim codes, the pass line in green.
    const output =
      "\x1b[0m\x1b[32m 82 pass\x1b[0m\n\x1b[0m\x1b[2m 0 fail\x1b[0m\n 187 expect() calls\n" +
      "Ran 82 tests across 6 files. \x1b[0m\x1b[2m[96.00ms]\x1b[0m";
    expect(evaluateBunTestSummary(output, 0)).toEqual({ ok: true, reason: "" });
  });

  test("still detects a real failure when the fail line is ANSI-wrapped", () => {
    const output =
      "\x1b[0m\x1b[32m 4 pass\x1b[0m\n\x1b[0m\x1b[31m 1 fail\x1b[0m\n" +
      "Ran 5 tests across 2 files. \x1b[0m\x1b[2m[12.00ms]\x1b[0m";
    const r = evaluateBunTestSummary(output, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("1 failing test");
  });

  test("recognizes an ANSI-wrapped completion-summary line", () => {
    const output =
      "0 fail\nRan \x1b[1m5\x1b[0m tests across \x1b[1m2\x1b[0m files. \x1b[2m[12.00ms]\x1b[0m";
    expect(evaluateBunTestSummary(output, 0)).toEqual({ ok: true, reason: "" });
  });

  test("is unaffected by ANSI codes elsewhere in the output that don't touch the summary lines", () => {
    const output =
      "\x1b[33msome colorized log line\x1b[0m\n5 pass\n0 fail\nRan 5 tests across 2 files.";
    expect(evaluateBunTestSummary(output, 0)).toEqual({ ok: true, reason: "" });
  });
});
