/**
 * Diversity-axis tests for the `truncated-outcome-read` calibration kind (mt#4096).
 *
 * Split out of `calibration-sweep.test.ts` rather than appended to it: that file was already
 * at the 1500-line ceiling, and this repo has established per-concern siblings for exactly this
 * reason (`calibration-sweep-wall-of-text.test.ts`, `calibration-sweep.review-due.test.ts`).
 *
 * Why these exist at all — PR #2960 R1. The record-shape doc declared `mutatingCommand`/`filter`
 * as this kind's diversity axis while `extractDistinctPhrases()` had no branch for it, so the
 * records fell to the matches-shaped `else`, added nothing, and the log would have measured zero
 * diversity forever. The negative control below pins that pre-fix state so the branch cannot be
 * silently removed and read as "still passing".
 */

import { describe, test, expect } from "bun:test";
import { extractDistinctPhrases, type CalibrationRecord } from "./calibration-sweep";

describe("extractDistinctPhrases — truncated-outcome-read (mt#4096, PR #2960 R1)", () => {
  test("uses the violation SHAPE from detectorFields as the diversity axis", () => {
    const records: CalibrationRecord[] = [
      {
        timestamp: "t",
        matches: [],
        detectorFields: { mutatingCommand: "minsky session commit --task mt#1", filter: "tail" },
      },
      {
        timestamp: "t",
        matches: [],
        detectorFields: { mutatingCommand: "minsky git push --session a", filter: "head" },
      },
      // Same shape as the first — must NOT add a second entry.
      {
        timestamp: "t",
        matches: [],
        detectorFields: { mutatingCommand: "minsky session commit --task mt#1", filter: "tail" },
      },
    ] as unknown as CalibrationRecord[];

    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
    expect(distinct.has("minsky session commit --task mt#1|tail")).toBe(true);
    expect(distinct.has("minsky git push --session a|head")).toBe(true);
  });

  test("without the clause these records contribute NOTHING — the mt#3781 inert-sweep defect", () => {
    // The negative control for the branch above: a record carrying neither field
    // falls through to the matches-shaped `else`, and a matches-shaped record with
    // an empty `matches` adds nothing. That is exactly the state this kind was in
    // before R1 — documented diversity axis, zero measured diversity, forever.
    const records: CalibrationRecord[] = [
      { timestamp: "t", matches: [] },
    ] as unknown as CalibrationRecord[];
    expect(extractDistinctPhrases(records).size).toBe(0);
  });

  test("a partial record does not fabricate a shape", () => {
    // Only one of the two fields present: the branch must not fire and emit a
    // half-shape like "undefined|tail", which would inflate diversity with noise.
    const records: CalibrationRecord[] = [
      { timestamp: "t", matches: [], detectorFields: { filter: "tail" } },
      { timestamp: "t", matches: [], detectorFields: { mutatingCommand: "minsky git push" } },
    ] as unknown as CalibrationRecord[];
    expect(extractDistinctPhrases(records).size).toBe(0);
  });
});
