/**
 * Unit tests for the pure helpers in run-judge-pass.ts (mt#2726 Milestone A
 * wave 3 — PR #2151 R1 fix, success criterion 3 completeness gap).
 *
 * All tests exercise fixture inputs directly — no live model calls, no
 * network. The I/O-bound orchestration (`main`) is intentionally NOT
 * unit-tested here; it is exercised via `--dry-run` (see the PR body for
 * that output) and, for the live path, by the main agent's bounded live run.
 */

import { describe, expect, test } from "bun:test";
import type { CorpusRow } from "../src/eval-corpus";
import { selectJudgeCandidateRows } from "./run-judge-pass";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let nextRowId = 0;

function makeRow(overrides: {
  labelValue?: CorpusRow["label"]["value"];
  confidence?: CorpusRow["label"]["confidence"];
}): CorpusRow {
  const id = `row-${nextRowId++}`;
  return {
    id,
    corpusVersion: "v1",
    source: "git-diff-mined",
    prNumber: 100,
    round: 1,
    finding: {
      file: "src/foo.ts",
      severity: "BLOCKING",
      line: 10,
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

// ---------------------------------------------------------------------------
// selectJudgeCandidateRows
// ---------------------------------------------------------------------------

describe("selectJudgeCandidateRows", () => {
  test("selects git-diff-fixed rows", () => {
    const row = makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" });
    expect(selectJudgeCandidateRows([row])).toEqual([row]);
  });

  test("selects carried-forward-unchanged rows", () => {
    const row = makeRow({ labelValue: "carried-forward-unchanged", confidence: "noisy-negative" });
    expect(selectJudgeCandidateRows([row])).toEqual([row]);
  });

  test("excludes dismissed-no-change rows (the dominant, uncontested negative bucket)", () => {
    const row = makeRow({ labelValue: "dismissed-no-change", confidence: "noisy-negative" });
    expect(selectJudgeCandidateRows([row])).toEqual([]);
  });

  test("excludes injected-exact rows (gold, unambiguous ground truth)", () => {
    const row = makeRow({ labelValue: "injected-exact", confidence: "gold" });
    expect(selectJudgeCandidateRows([row])).toEqual([]);
  });

  test("filters a mixed corpus down to just the ambiguous label values", () => {
    const fixed = makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" });
    const carried = makeRow({
      labelValue: "carried-forward-unchanged",
      confidence: "noisy-negative",
    });
    const dismissed = makeRow({ labelValue: "dismissed-no-change", confidence: "noisy-negative" });
    const injected = makeRow({ labelValue: "injected-exact", confidence: "gold" });

    const result = selectJudgeCandidateRows([fixed, carried, dismissed, injected]);
    expect(result).toEqual([fixed, carried]);
  });

  test("with no sample argument, returns every candidate", () => {
    const rows = Array.from({ length: 5 }, () =>
      makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" })
    );
    expect(selectJudgeCandidateRows(rows)).toHaveLength(5);
  });

  test("--sample caps the returned row count, taking the first N in corpus order", () => {
    const rows = Array.from({ length: 5 }, () =>
      makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" })
    );
    const result = selectJudgeCandidateRows(rows, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual(rows.slice(0, 3));
  });

  test("sample larger than the candidate count returns every candidate", () => {
    const rows = [makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" })];
    expect(selectJudgeCandidateRows(rows, 10)).toEqual(rows);
  });

  test("empty input produces an empty result", () => {
    expect(selectJudgeCandidateRows([])).toEqual([]);
  });
});
