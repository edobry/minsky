/**
 * mt#4702 / PR #3531 R2 — `deferralOverlap`, the field and the caller that fills it.
 *
 * Split out of `operator-deferral-detector.test.ts` rather than added to it: the
 * merge of this branch with main (mt#4769's artifact-body surface, which brought
 * its own tests) pushed that file past the 1500-line `max-lines` ERROR ceiling.
 * Both sets of tests are wanted, so the file divides along the seam that owns a
 * distinct subject — the calibration record's overlap measurement — rather than
 * either side being trimmed to fit.
 *
 * Fixtures come from `operator-deferral-fixtures.ts`, a plain module both files
 * import, so `askTurn` and the ask#6754 justification it encodes have exactly one
 * definition — and so importing them does not re-register the parent's ~194 tests
 * into this file's run, which a `.test.ts` import would.
 */
import { describe, expect, test } from "bun:test";
import { buildCalibrationRecord, run } from "./operator-deferral-detector";
import {
  ASK_OPTION_LABEL,
  DEFERRAL_PROSE,
  FIXTURE_PATH,
  R5_LABEL,
  askTurn,
  assistantText,
  ctxWith,
  userPrompt,
} from "./operator-deferral-fixtures";
import type { ClaudeHookInput } from "./types";

describe("mt#4702 — deferralOverlap makes this pair's overlap measurable", () => {
  // The matches are incidental here — `buildCalibrationRecord` only maps them,
  // and the field under test is derived from the TURN TEXT beside them.
  const matches = [
    { surface: ASK_OPTION_LABEL, matchedPhrase: R5_LABEL, context: R5_LABEL },
  ] as Parameters<typeof buildCalibrationRecord>[1];

  test("the field is ABSENT when no turn text was supplied", () => {
    // Absent means "not measured", never "no overlap". A `false` written on a
    // caller that never had the text would be a claim rather than a
    // measurement — and every record written before this shipped is in exactly
    // that position.
    expect(buildCalibrationRecord("s1", matches, "prose-turn")).not.toHaveProperty(
      "deferralOverlap"
    );
  });

  test("true when ask-routing-deferral fires on the same prose", () => {
    const record = buildCalibrationRecord(
      "s1",
      matches,
      "prose-turn",
      "Want me to take mt#4621, or leave it?"
    );
    expect(record.deferralOverlap).toBe(true);
  });

  test("false when it does not — the field discriminates, it is not a constant", () => {
    const record = buildCalibrationRecord(
      "s1",
      matches,
      "prose-turn",
      "Rebased and pushed; checks are green."
    );
    expect(record.deferralOverlap).toBe(false);
  });

  test("mt#4702's own suppression is reflected here: an override is not an overlap", () => {
    // The end-to-end tie between the two halves of this task — the same
    // sentence that stopped being an offer also stops counting as an overlap.
    const record = buildCalibrationRecord(
      "s1",
      matches,
      "prose-turn",
      "I'll take mt#4465 next unless you'd rather I clear mt#4716 first."
    );
    expect(record.deferralOverlap).toBe(false);
  });

  test("EMPTY text is not-measured either — the field is absent, not false", () => {
    // PR #3531 R2. Over an empty string `detectDeferralPhrases` can only ever
    // return `[]`, so the `false` this used to write was a CONSTANT, not a
    // measurement — the fabricated negative the optional parameter exists to
    // prevent, arriving through the one caller shape that has no prose at all.
    expect(buildCalibrationRecord("s1", matches, "prose-turn", "")).not.toHaveProperty(
      "deferralOverlap"
    );
  });
});

describe("PR #3531 R2 — the PRODUCTION path, not just the builder", () => {
  // The three tests above call `buildCalibrationRecord` directly and omit the
  // argument, so they stayed green while `run()` supplied `?? ""` on every
  // prose-turn record. That is the gap the reviewer found: the only caller
  // that decides what "no prose" means was untested. These call `run()`.

  test("a turn that fires on a TOOL CALL alone records no overlap field", () => {
    // Surface E fires off the `asks_create` input, not off assistant prose, so
    // `extractAssistantText` returns "" for this turn. Before the fix every
    // such record carried `deferralOverlap: false`.
    const outcome = run(
      { session_id: "s-empty", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("open the ask"), ...askTurn({}), userPrompt("next")])
    );
    expect(outcome?.calibration?.["matches"]).toBeDefined();
    expect(outcome?.calibration).not.toHaveProperty("deferralOverlap");
  });

  // Negative controls. A guard that dropped the field unconditionally would
  // pass the test above and quietly destroy the measurement mt#4702 shipped —
  // so both VALUES have to survive on a turn that actually carries prose.
  test("a prose turn with no overlap records a real false, not an absence", () => {
    const outcome = run(
      { session_id: "s-prose-false", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([userPrompt("go"), assistantText(DEFERRAL_PROSE), userPrompt("next")])
    );
    expect(outcome?.calibration).toHaveProperty("deferralOverlap");
    expect(outcome?.calibration?.["deferralOverlap"]).toBe(false);
  });

  test("a prose turn the sibling also fires on records true", () => {
    const outcome = run(
      { session_id: "s-prose-true", transcript_path: FIXTURE_PATH } as ClaudeHookInput,
      ctxWith([
        userPrompt("go"),
        assistantText(`${DEFERRAL_PROSE} Want me to file it, or leave it?`),
        userPrompt("next"),
      ])
    );
    expect(outcome?.calibration?.["deferralOverlap"]).toBe(true);
  });
});
