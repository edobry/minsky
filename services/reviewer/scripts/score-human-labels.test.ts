/**
 * Tests for the human-label vs judge kappa join (mt#2746).
 *
 * The exclusion rules carry most of the weight. Each held-out population is
 * one whose inclusion would produce a kappa that reads as a measurement
 * without being one, so every exclusion is asserted both for its effect on
 * the pairing AND for being counted rather than silently dropped.
 */

import { describe, expect, test } from "bun:test";

import {
  humanLabelToBinary,
  judgeVerdictToBinary,
  readExportedRecord,
  scoreLabels,
  type ExportedLabel,
} from "./score-human-labels";

// Extracted so the literal appears once: the lint rule flags a repeated
// magic string, and these labels are the script's own configured option set.
const VALID_NONBLOCKING = "valid_nonblocking";

const cleanJudge = (aggregate: string) => ({
  aggregate,
  agreement: true,
  perJudge: [
    { provider: "openai", model: "gpt-5", verdict: aggregate },
    { provider: "anthropic", model: "claude-sonnet-4-6", verdict: aggregate },
  ],
});

describe("humanLabelToBinary", () => {
  test("collapses both valid_* labels onto VALID", () => {
    expect(humanLabelToBinary("valid_blocking")).toBe("VALID");
    expect(humanLabelToBinary(VALID_NONBLOCKING)).toBe("VALID");
  });

  test("maps false_positive to NOISE", () => {
    expect(humanLabelToBinary("false_positive")).toBe("NOISE");
  });

  test("returns null for cant_tell rather than inventing a rating", () => {
    expect(humanLabelToBinary("cant_tell")).toBeNull();
  });
});

describe("judgeVerdictToBinary", () => {
  test("treats BUG_HIT as VALID — it is the stronger claim", () => {
    expect(judgeVerdictToBinary("BUG_HIT")).toBe("VALID");
    expect(judgeVerdictToBinary("VALID")).toBe("VALID");
  });

  test("maps NOISE to NOISE and rejects anything else", () => {
    expect(judgeVerdictToBinary("NOISE")).toBe("NOISE");
    expect(judgeVerdictToBinary("MAYBE")).toBeNull();
  });
});

describe("scoreLabels", () => {
  test("computes kappa over the paired rows", () => {
    // 4 rows, all agreeing: po = 1. Marginals 0.5/0.5 each => pe = 0.5,
    // kappa = 1.
    const labels: ExportedLabel[] = [
      { rowId: "a", label: "valid_blocking" },
      { rowId: "b", label: VALID_NONBLOCKING },
      { rowId: "c", label: "false_positive" },
      { rowId: "d", label: "false_positive" },
    ];
    const result = scoreLabels(labels, {
      a: cleanJudge("VALID"),
      b: cleanJudge("BUG_HIT"),
      c: cleanJudge("NOISE"),
      d: cleanJudge("NOISE"),
    });

    expect(result.paired).toBe(4);
    expect(result.kappa.kappa).toBeCloseTo(1, 10);
    expect(result.confusion).toEqual({ hvJv: 2, hvJn: 0, hnJv: 0, hnJn: 2 });
  });

  test("holds out cant_tell and counts it", () => {
    const result = scoreLabels(
      [
        { rowId: "a", label: "valid_blocking" },
        { rowId: "b", label: "cant_tell" },
        { rowId: "c", label: "false_positive" },
      ],
      { a: cleanJudge("VALID"), b: cleanJudge("NOISE"), c: cleanJudge("NOISE") }
    );
    expect(result.paired).toBe(2);
    expect(result.excluded.cantTell).toBe(1);
  });

  test("holds out a row whose judge aggregate includes a FAILED judge", () => {
    // mt#4616: judgeFinding returns verdict "VALID" with a parseError when a
    // judge call fails, and "VALID" is a real verdict — so the aggregate
    // carries a phantom vote. Row "b" would otherwise score as agreement.
    const result = scoreLabels(
      [
        { rowId: "a", label: "valid_blocking" },
        { rowId: "b", label: "valid_blocking" },
      ],
      {
        a: cleanJudge("VALID"),
        b: {
          aggregate: "VALID",
          agreement: true,
          perJudge: [
            { provider: "openai", model: "gpt-5", verdict: "VALID", parseError: "402 no credits" },
            { provider: "anthropic", model: "claude-sonnet-4-6", verdict: "VALID" },
          ],
        },
      }
    );
    expect(result.paired).toBe(1);
    expect(result.excluded.contaminatedJudge).toBe(1);
  });

  test("counts rows present on only one side of the join", () => {
    const result = scoreLabels(
      [
        { rowId: "a", label: "valid_blocking" },
        { rowId: "orphan", label: "false_positive" },
      ],
      { a: cleanJudge("VALID"), unlabeled: cleanJudge("NOISE") }
    );
    expect(result.excluded.labelOnly).toBe(1);
    expect(result.excluded.judgeOnly).toBe(1);
  });

  test("records an unrecognized judge verdict instead of scoring it", () => {
    // Two rows so one still pairs — with zero pairs the kappa guard fires
    // first and the tally would never be observable.
    const result = scoreLabels(
      [
        { rowId: "a", label: "valid_blocking" },
        { rowId: "b", label: "false_positive" },
      ],
      {
        a: { aggregate: "WAT", agreement: true, perJudge: [] },
        b: cleanJudge("NOISE"),
      }
    );
    expect(result.paired).toBe(1);
    expect(result.excluded.unreadable[0]?.rowId).toBe("a");
    expect(result.excluded.unreadable[0]?.reason).toMatch(/unrecognized judge verdict/);
  });

  test("throws rather than reporting a kappa when nothing paired", () => {
    // An all-cant_tell export must not yield "kappa 0" — that reads as
    // chance-level agreement when it is actually the absence of a measurement.
    expect(() =>
      scoreLabels([{ rowId: "a", label: "cant_tell" }], { a: cleanJudge("VALID") })
    ).toThrow(/0 paired items/);
  });

  test("surfaces single-category degeneracy from an all-VALID pairing", () => {
    const result = scoreLabels(
      [
        { rowId: "a", label: "valid_blocking" },
        { rowId: "b", label: VALID_NONBLOCKING },
      ],
      { a: cleanJudge("VALID"), b: cleanJudge("VALID") }
    );
    expect(result.kappa.kappa).toBeNull();
    expect(result.kappa.degenerate).toBe("single-category");
  });
});

describe("readExportedRecord", () => {
  test("reads a bare string label from `expected`", () => {
    const read = readExportedRecord({
      input: { rowId: "pr-1-r1-f0" },
      expected: "valid_blocking",
    });
    expect(read).toEqual({ ok: true, value: { rowId: "pr-1-r1-f0", label: "valid_blocking" } });
  });

  test("falls back through metadata.rowId and id for the row id", () => {
    expect(readExportedRecord({ metadata: { rowId: "m" }, expected: "cant_tell" })).toEqual({
      ok: true,
      value: { rowId: "m", label: "cant_tell" },
    });
    expect(readExportedRecord({ id: "i", expected: "false_positive" })).toEqual({
      ok: true,
      value: { rowId: "i", label: "false_positive" },
    });
  });

  test("reports an unlabeled record as a reason, not a throw", () => {
    const read = readExportedRecord({ input: { rowId: "a" } });
    expect(read).toEqual({ ok: false, reason: "unlabeled (no `expected` value)" });
  });

  test("refuses a label outside the configured option set", () => {
    const read = readExportedRecord({ input: { rowId: "a" }, expected: "looks_fine" });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/unrecognized label/);
  });

  test("refuses a record with no usable row id", () => {
    const read = readExportedRecord({ expected: "valid_blocking" });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/no rowId/);
  });
});
