/**
 * Unit tests for the pure helpers in judge.ts (mt#2726 Milestone A, wave 3).
 *
 * All tests exercise fixture inputs directly — no live model calls, no
 * network. `judgeFinding` itself (the live cross-provider panel call) is
 * intentionally NOT unit-tested here; it is a thin orchestration wrapper
 * around `callReviewer` + the pure functions tested below, exercised
 * instead by the main agent's bounded live run.
 */

import { describe, expect, test } from "bun:test";
import type { CorpusLabel, CorpusRow } from "./eval-corpus";
import type { FindingVerdict } from "./eval-metrics";
import {
  aggregateVerdicts,
  findDisagreementWeightedSubset,
  judgeVerdictDisagreesWithLabel,
  parseJudgeResponseText,
  type JudgeResult,
  type PerJudgeVerdict,
} from "./judge";

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

function positiveRow(): CorpusRow {
  return makeRow({ labelValue: "git-diff-fixed", confidence: "noisy-positive" });
}

function negativeRow(): CorpusRow {
  return makeRow({ labelValue: "dismissed-no-change", confidence: "noisy-negative" });
}

function positiveLabel(): CorpusLabel {
  return { value: "git-diff-fixed", provenance: "deterministic", confidence: "noisy-positive" };
}

function negativeLabel(): CorpusLabel {
  return {
    value: "dismissed-no-change",
    provenance: "deterministic",
    confidence: "noisy-negative",
  };
}

function judgeVerdict(
  verdict: FindingVerdict,
  overrides: Partial<PerJudgeVerdict> = {}
): PerJudgeVerdict {
  return { provider: "openai", model: "gpt-5", verdict, rationale: "because", ...overrides };
}

function judgeResult(verdict: FindingVerdict, agreement: boolean): JudgeResult {
  return { verdict, agreement, perJudge: [judgeVerdict(verdict)] };
}

// ---------------------------------------------------------------------------
// parseJudgeResponseText
// ---------------------------------------------------------------------------

describe("parseJudgeResponseText", () => {
  test("parses a well-formed response", () => {
    const result = parseJudgeResponseText("VERDICT: BUG_HIT\nRATIONALE: null deref on line 10");
    expect(result).toEqual({ verdict: "BUG_HIT", rationale: "null deref on line 10" });
  });

  test("is case-insensitive on the VERDICT keyword and value", () => {
    const result = parseJudgeResponseText("verdict: noise\nrationale: not a real issue");
    expect(result.verdict).toBe("NOISE");
    expect(result.rationale).toBe("not a real issue");
  });

  test("tolerates leading narration before the VERDICT line", () => {
    const result = parseJudgeResponseText(
      "Let me think about this.\nVERDICT: VALID\nRATIONALE: style nit, not a bug"
    );
    expect(result.verdict).toBe("VALID");
    expect(result.parseError).toBeUndefined();
  });

  test("falls back to VALID with a parseError when no VERDICT line is present", () => {
    const result = parseJudgeResponseText("I'm not sure about this one.");
    expect(result.verdict).toBe("VALID");
    expect(result.parseError).toBeDefined();
  });

  test("falls back to VALID with a parseError on an empty response", () => {
    const result = parseJudgeResponseText("");
    expect(result.verdict).toBe("VALID");
    expect(result.parseError).toBeDefined();
    expect(result.rationale).toBe("(empty response)");
  });

  test("missing RATIONALE line still parses the verdict, with a placeholder rationale", () => {
    const result = parseJudgeResponseText("VERDICT: BUG_HIT");
    expect(result.verdict).toBe("BUG_HIT");
    expect(result.rationale).toBe("(no rationale provided)");
    expect(result.parseError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aggregateVerdicts
// ---------------------------------------------------------------------------

describe("aggregateVerdicts", () => {
  test("unanimous panel returns the shared verdict", () => {
    expect(aggregateVerdicts(["BUG_HIT", "BUG_HIT", "BUG_HIT"])).toBe("BUG_HIT");
  });

  test("2-1 majority wins over the minority vote", () => {
    expect(aggregateVerdicts(["BUG_HIT", "BUG_HIT", "NOISE"])).toBe("BUG_HIT");
    expect(aggregateVerdicts(["NOISE", "NOISE", "VALID"])).toBe("NOISE");
  });

  test("a 1-1 tie between two judges resolves via the ordinal median (lower of the two)", () => {
    // BUG_HIT (ordinal 2) vs NOISE (ordinal 0): sorted [0, 2], lower-middle
    // (index 0 for an even-length list) is 0 -> NOISE.
    expect(aggregateVerdicts(["BUG_HIT", "NOISE"])).toBe("NOISE");
  });

  test("a full 3-way tie (one vote each) resolves to the true ordinal median (VALID)", () => {
    expect(aggregateVerdicts(["BUG_HIT", "VALID", "NOISE"])).toBe("VALID");
  });

  test("empty panel returns the neutral VALID default", () => {
    expect(aggregateVerdicts([])).toBe("VALID");
  });
});

// ---------------------------------------------------------------------------
// judgeVerdictDisagreesWithLabel
// ---------------------------------------------------------------------------

describe("judgeVerdictDisagreesWithLabel", () => {
  test("positive label + NOISE verdict -> disagreement", () => {
    expect(judgeVerdictDisagreesWithLabel("NOISE", positiveLabel())).toBe(true);
  });

  test("positive label + BUG_HIT verdict -> agreement", () => {
    expect(judgeVerdictDisagreesWithLabel("BUG_HIT", positiveLabel())).toBe(false);
  });

  test("positive label + VALID verdict -> not treated as disagreement", () => {
    expect(judgeVerdictDisagreesWithLabel("VALID", positiveLabel())).toBe(false);
  });

  test("negative label + BUG_HIT verdict -> disagreement", () => {
    expect(judgeVerdictDisagreesWithLabel("BUG_HIT", negativeLabel())).toBe(true);
  });

  test("negative label + NOISE verdict -> agreement", () => {
    expect(judgeVerdictDisagreesWithLabel("NOISE", negativeLabel())).toBe(false);
  });

  test("negative label + VALID verdict -> not treated as disagreement", () => {
    expect(judgeVerdictDisagreesWithLabel("VALID", negativeLabel())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findDisagreementWeightedSubset
// ---------------------------------------------------------------------------

describe("findDisagreementWeightedSubset", () => {
  test("selects a row when the judge panel disagrees among itself, even if the aggregate agrees with the label", () => {
    const row = positiveRow();
    const result: JudgeResult = {
      verdict: "BUG_HIT",
      agreement: false,
      perJudge: [judgeVerdict("BUG_HIT"), judgeVerdict("NOISE")],
    };

    expect(findDisagreementWeightedSubset([row], [result])).toEqual([row]);
  });

  test("selects a row when the panel is unanimous but disagrees with the row's deterministic label", () => {
    const row = positiveRow(); // label says "real"
    const result = judgeResult("NOISE", true); // judges unanimously say "spurious"

    expect(findDisagreementWeightedSubset([row], [result])).toEqual([row]);
  });

  test("excludes a row when the panel is unanimous AND agrees with the label", () => {
    const row = positiveRow();
    const result = judgeResult("BUG_HIT", true);

    expect(findDisagreementWeightedSubset([row], [result])).toEqual([]);
  });

  test("excludes a negative-label row whose unanimous panel verdict is NOISE (agreement)", () => {
    const row = negativeRow();
    const result = judgeResult("NOISE", true);

    expect(findDisagreementWeightedSubset([row], [result])).toEqual([]);
  });

  test("processes multiple rows independently", () => {
    const agreeRow = positiveRow();
    const disagreeRow = positiveRow();
    const results = [judgeResult("BUG_HIT", true), judgeResult("NOISE", true)];

    expect(findDisagreementWeightedSubset([agreeRow, disagreeRow], results)).toEqual([disagreeRow]);
  });

  test("a length mismatch only scores the overlapping prefix", () => {
    const row1 = positiveRow();
    const row2 = positiveRow();
    // Only one JudgeResult supplied for two rows — row2 is unscored (dropped).
    const results = [judgeResult("NOISE", true)];

    expect(findDisagreementWeightedSubset([row1, row2], results)).toEqual([row1]);
  });
});
