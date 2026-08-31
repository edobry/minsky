/**
 * mt#4702 — `deferralOverlap` is projected at the top level of the parsed
 * record, not left nested in `detectorFields`.
 *
 * The field exists to COMPARE two producers (`untaken-action`, mt#4407, and
 * `operator-deferral`, mt#4702). mem#827 is the recorded incident of a reviewer
 * reading `detectorFields` as the whole record and reporting present fields as
 * missing — which is exactly the failure a nested projection invites here.
 */
import { describe, expect, test } from "bun:test";
import { parseCalibrationRecord } from "./calibration-sweep";

const OPERATOR_DEFERRAL = "operator-deferral" as const;

const base = {
  timestamp: "2026-08-31T22:00:00.000Z",
  session_id: "s1",
  matches: [{ category: "capability-deferral-prose", phrase: "say the word" }],
};

describe("mt#4702 — deferralOverlap projection", () => {
  test("true is projected at the top level", () => {
    const parsed = parseCalibrationRecord(
      JSON.stringify({ ...base, deferralOverlap: true }),
      OPERATOR_DEFERRAL
    );
    expect(parsed?.deferralOverlap).toBe(true);
  });

  test("false is projected too — the field discriminates", () => {
    const parsed = parseCalibrationRecord(
      JSON.stringify({ ...base, deferralOverlap: false }),
      OPERATOR_DEFERRAL
    );
    expect(parsed?.deferralOverlap).toBe(false);
  });

  test("the same lift applies to untaken-action, so the pair is comparable", () => {
    const parsed = parseCalibrationRecord(
      JSON.stringify({
        timestamp: base.timestamp,
        matches: [{ family: "ill-action", phrase: "I'll open the PR" }],
        deferralOverlap: true,
      }),
      "untaken-action"
    );
    expect(parsed?.deferralOverlap).toBe(true);
  });

  test("ABSENT stays absent — it means not-measured, never no-overlap", () => {
    const parsed = parseCalibrationRecord(JSON.stringify(base), OPERATOR_DEFERRAL);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("deferralOverlap");
  });

  test("a non-boolean is DROPPED rather than coerced", () => {
    // Coercing "yes" to true would manufacture a measurement from a malformed
    // record — the accessor-that-synthesizes hazard.
    const parsed = parseCalibrationRecord(
      JSON.stringify({ ...base, deferralOverlap: "yes" }),
      OPERATOR_DEFERRAL
    );
    expect(parsed).not.toHaveProperty("deferralOverlap");
  });
});
