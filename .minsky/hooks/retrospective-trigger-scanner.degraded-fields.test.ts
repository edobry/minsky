/**
 * mt#5051 — the scanner's calibration record carries the degraded CAUSE, not only a label.
 *
 * `nominationDegradedFields` is the one writer every record site (three in the scanner, one in
 * `turn-end-retro-scan.ts`) spreads, so pinning it here pins what the record carries. Split out
 * of `retrospective-trigger-scanner.test.ts`, which sits at its `max-lines` budget.
 */
import { describe, expect, test } from "bun:test";
import { nominationDegradedFields } from "./retrospective-trigger-scanner";

const PROVIDER_UNCONFIGURED = "provider-unconfigured";

describe("nominationDegradedFields (mt#5051)", () => {
  test("an unavailable provider records its reason and the provider-plus-cause detail", () => {
    expect(nominationDegradedFields("provider-unavailable", "openai: model not found")).toEqual({
      nomination_degraded: "provider-unavailable",
      nomination_degraded_detail: "openai: model not found",
    });
  });

  test("the healthy no-key state records the label alone — nothing went wrong to explain", () => {
    expect(nominationDegradedFields(PROVIDER_UNCONFIGURED, undefined)).toEqual({
      nomination_degraded: PROVIDER_UNCONFIGURED,
    });
  });

  test("a bootstrap failure is its own label, no longer misreported as unconfigured", () => {
    const fields = nominationDegradedFields("bootstrap-failed", "Configuration not initialized.");
    expect(fields.nomination_degraded).toBe("bootstrap-failed");
    expect(fields.nomination_degraded).not.toBe(PROVIDER_UNCONFIGURED);
    expect(fields.nomination_degraded_detail).toBe("Configuration not initialized.");
  });

  test("no degradation writes no fields, so a healthy record stays unchanged", () => {
    expect(nominationDegradedFields(undefined, undefined)).toEqual({});
  });
});
