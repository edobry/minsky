/**
 * The `outcome` convention gets a parse branch (mt#5048).
 *
 * 15 of the 31 logs in mt#5048's census carry an `outcome` field on every record
 * and no `matches` key. They had been recording whether they found something all
 * along; the parser did not know the convention existed, so every one of them
 * fell to the shared matches-shape fallback, got `matches: []` synthesized, and
 * read as "never matched anything" to `isEvaluationOnlyRecord`.
 *
 * Measured over the live logs 2026-09-10: **30,695 `clean`** (correctly
 * evaluation-only) against **946 `matched`/`flagged`** that are real findings and
 * were misfiled.
 *
 * **Fixtures are the VERBATIM production shape**, read 2026-09-10 from
 * `claim-provenance-scan-calibration.jsonl` — per mem#1020, a fixture invented
 * from a field name can parse into a shape the real writer never produces, then
 * pass while production still reports the gap. Note what the real records show
 * and an invented one would not: the `matched` record carries NO `reason`, while
 * the `clean` one does. That asymmetry is what the phrase-fallback exists for.
 */

import { describe, expect, test } from "bun:test";
import {
  FINDINGS_FREE_CALIBRATION_LOGS,
  OUTCOME_MEANS_EVALUATED,
  OUTCOME_MEANS_FIRE,
  isEvaluationOnlyRecord,
  parseCalibrationRecord,
  type CalibrationRecord,
} from "./calibration-sweep";

/** The kind these logs are synthesized with — none of them is in the `kind` union. */
const GENERIC = "generic-matches" as Parameters<typeof parseCalibrationRecord>[1];

/** A real `outcome: "matched"` record. Carries `kinds` + `excerpt`, and NO `reason`. */
const REAL_MATCHED = JSON.stringify({
  ts: "2026-08-30T19:54:17.868Z",
  sessionId: "2560b3bc-5b66-4e4d-a783-f45f2e85f573",
  toolName: "mcp__minsky__tasks_spec_patch",
  outcome: "matched",
  kinds: ["a file-level collision"],
  excerpt:
    "## Summary\n\n`extractTrackingTaskRefs` has two consumers pulling in opposite directions",
});

/** A real `outcome: "clean"` record from the same log. Carries `reason`. */
const REAL_CLEAN = JSON.stringify({
  ts: "2026-08-30T19:47:59.094Z",
  sessionId: "4c6882c0-15d9-45bf-94a0-a20c7b23b101",
  toolName: "mcp__minsky__tasks_create",
  outcome: "clean",
  reason: "every claim matched a call",
});

function parsed(line: string): CalibrationRecord {
  const record = parseCalibrationRecord(line, GENERIC);
  if (!record) throw new Error("fixture failed to parse");
  return record;
}

describe("mt#5048 — a record with an `outcome` is classified by it", () => {
  test("a real `matched` record is NOT evaluation-only", () => {
    // The defect, stated as an assertion: before this branch it was.
    const record = parsed(REAL_MATCHED);
    expect(isEvaluationOnlyRecord(record)).toBe(false);
    expect("matches" in record && record.matches.length).toBe(1);
  });

  test("a real `clean` record IS evaluation-only, and correctly so", () => {
    // The other direction, and the one that must not move: 30,695 of the 31,641
    // records reached by this branch are `clean`, and the fallback was already
    // right about them. A change that only reclassified would be a regression.
    const record = parsed(REAL_CLEAN);
    expect(isEvaluationOnlyRecord(record)).toBe(true);
  });

  test("the phrase falls back to the outcome token when the writer gives no reason", () => {
    // Real behaviour, not a wish: the production `matched` record has no
    // `reason`. This pins what that yields so the LIMITATION is visible — see
    // the diversity note below.
    const record = parsed(REAL_MATCHED);
    if (!("matches" in record)) throw new Error("expected a matches-shape record");
    expect(record.matches[0]?.phrase).toBe("matched");
    expect(record.matches[0]?.family).toBe("matched");
  });

  test("the phrase is the writer's reason when there is one", () => {
    const withReason = JSON.stringify({ ts: "t", outcome: "flagged", reason: "no spec section" });
    const record = parsed(withReason);
    if (!("matches" in record)) throw new Error("expected a matches-shape record");
    expect(record.matches[0]?.phrase).toBe("no spec section");
  });

  test("this fixes CLASSIFICATION, not diversity — stated as a test, not a hope", () => {
    // Two `matched` records with no reason collapse to ONE distinct phrase. That
    // is the honest limit of this branch: giving these logs a meaningful
    // diversity axis is mt#3789's registry-derived declaration, and mt#5048's
    // `## Scope` puts it out of scope. Pinned so a reader does not mistake the
    // classification fix for a diversity fix.
    const a = parsed(REAL_MATCHED);
    const b = parsed(JSON.stringify({ ts: "t2", outcome: "matched", kinds: ["other"] }));
    if (!("matches" in a) || !("matches" in b)) throw new Error("expected matches-shape records");
    expect(new Set([a.matches[0]?.phrase, b.matches[0]?.phrase]).size).toBe(1);
  });
});

describe("mt#5048 — the branch is deliberately narrow", () => {
  test("an unrecognized outcome token falls through UNCHANGED", () => {
    // `gated`, `declined`, `inserted`, `reconciled`, `unmatched-shape` each
    // appear in exactly ONE log and mean something local to it. Classifying them
    // from the token alone would be the guess-from-shape move this task exists
    // to remove, so they keep per-log verdicts and reach the old fallback.
    for (const outcome of ["gated", "declined", "inserted", "reconciled", "unmatched-shape"]) {
      const record = parsed(JSON.stringify({ ts: "t", outcome, reason: "r" }));
      expect(isEvaluationOnlyRecord(record)).toBe(true);
    }
  });

  test("a record that HAS `matches` is untouched by the new branch", () => {
    // The guard that makes this change safe for every existing log: the branch
    // only reaches records the fallback was already going to synthesize an empty
    // match set for.
    const withMatches = JSON.stringify({
      timestamp: "t",
      outcome: "clean",
      matches: [{ family: "f", phrase: "p" }],
    });
    const record = parsed(withMatches);
    if (!("matches" in record)) throw new Error("expected a matches-shape record");
    expect(record.matches[0]?.phrase).toBe("p");
    expect(isEvaluationOnlyRecord(record)).toBe(false);
  });

  test("a record with no `outcome` at all is untouched", () => {
    const record = parsed(JSON.stringify({ timestamp: "t", claims: [] }));
    expect(isEvaluationOnlyRecord(record)).toBe(true);
  });
});

describe("mt#5048 SC4 — a fallback-correct verdict is DECLARED, not inferred", () => {
  test("every findings-free log carries a non-empty reason", () => {
    // SC4's whole point: a future reader must be able to tell "verified as
    // genuinely findings-free" from "nobody has looked at this one yet". An
    // entry with an empty reason would read as the first while being the second.
    const entries = Object.entries(FINDINGS_FREE_CALIBRATION_LOGS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [log, reason] of entries) {
      expect(log).not.toBe("");
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("the two outcome vocabularies are disjoint", () => {
    // A token in both sets would make classification order-dependent, which is
    // the kind of silent ambiguity this branch replaces.
    for (const token of OUTCOME_MEANS_FIRE) {
      expect(OUTCOME_MEANS_EVALUATED.includes(token)).toBe(false);
    }
    expect(OUTCOME_MEANS_FIRE.length).toBeGreaterThan(0);
    expect(OUTCOME_MEANS_EVALUATED.length).toBeGreaterThan(0);
  });
});
