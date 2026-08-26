/**
 * Tests for the durable judge-verdict projection (mt#2746).
 */

import { describe, expect, test } from "bun:test";

import { projectRunArtifact } from "./extract-judge-verdicts";

const RUN = {
  corpusVersion: "v1",
  runStartedAt: "2026-08-25T23:20:00.000Z",
  panel: ["openai:gpt-5", "anthropic:claude-sonnet-4-6"],
  candidateCount: 3,
  judgedCount: 3,
  disagreementCount: 2,
  disagreementSubset: [{ id: "a" }, { id: "c" }],
  judgeVerdicts: {
    a: { perJudge: [{ verdict: "VALID" }, { verdict: "NOISE" }] },
    b: { perJudge: [{ verdict: "VALID" }, { verdict: "VALID" }] },
    c: { perJudge: [{ verdict: "VALID", parseError: "402 no credits" }, { verdict: "NOISE" }] },
  },
};

describe("projectRunArtifact", () => {
  test("keeps the verdicts and the selection, drops the full rows", () => {
    const out = projectRunArtifact(RUN);
    expect(out.selectedIds).toEqual(["a", "c"]);
    expect(Object.keys(out.judgeVerdicts).sort()).toEqual(["a", "b", "c"]);
    // The corpus already carries finding text and code context under the same
    // row ids; re-committing them here would duplicate ~600KB.
    expect(out).not.toHaveProperty("disagreementSubset");
  });

  test("precomputes which rows a failed judge contaminated", () => {
    // Not derivable by eye: the fallback verdict is a real verdict (mt#4616).
    expect(projectRunArtifact(RUN).contaminatedIds).toEqual(["c"]);
  });

  test("carries the panel forward so a kappa can name its raters", () => {
    const out = projectRunArtifact(RUN);
    expect(out.panel).toEqual(["openai:gpt-5", "anthropic:claude-sonnet-4-6"]);
    expect(out.judgedCount).toBe(3);
  });

  test("refuses an artifact written before verdicts were persisted", () => {
    expect(() => projectRunArtifact({ ...RUN, judgeVerdicts: {} })).toThrow(/no judgeVerdicts/);
    expect(() => projectRunArtifact({ ...RUN, judgeVerdicts: undefined })).toThrow(
      /no judgeVerdicts/
    );
  });
});
