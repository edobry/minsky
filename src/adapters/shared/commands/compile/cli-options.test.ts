/**
 * Unit tests for the shared compile CLI-option helpers (mt#2992 review R1).
 *
 * `parseCliSizeBudgetChars` is the fix for the BLOCKING finding: a bare
 * `Number(opts.warnChars)` on an unvalidated CLI string silently produces
 * `NaN` on a typo, which then WINS over the real default in
 * `resolveSizeBudget`'s `??` merge (`??` only falls through on
 * null/undefined) — so a bad `--warn-chars`/`--fail-chars` value silently
 * disabled the size-budget guard entirely, with no error. These tests pin
 * the reject-don't-coerce behavior for every invalid-input class named in
 * the review: non-numeric, non-positive (zero and negative), non-integer.
 */

import { describe, it, expect } from "bun:test";
import {
  parseCliSizeBudgetChars,
  buildSizeBudgetOverride,
  resolveMemoryLoadingMode,
} from "./cli-options";

describe("parseCliSizeBudgetChars()", () => {
  it("returns undefined when the flag was not supplied", () => {
    expect(parseCliSizeBudgetChars("--warn-chars", undefined)).toBeUndefined();
  });

  it("parses a valid numeric string into a number", () => {
    expect(parseCliSizeBudgetChars("--warn-chars", "1000")).toBe(1000);
  });

  it("accepts an already-numeric value unchanged", () => {
    expect(parseCliSizeBudgetChars("--fail-chars", 5000)).toBe(5000);
  });

  it("REJECTS a non-numeric string (the originating BLOCKING failure mode)", () => {
    expect(() => parseCliSizeBudgetChars("--warn-chars", "abc")).toThrow(
      /Invalid --warn-chars value "abc": must be a positive integer/
    );
  });

  it("REJECTS zero (not strictly positive)", () => {
    expect(() => parseCliSizeBudgetChars("--fail-chars", "0")).toThrow(
      /Invalid --fail-chars value "0": must be a positive integer/
    );
  });

  it("REJECTS a negative value", () => {
    expect(() => parseCliSizeBudgetChars("--fail-chars", "-5")).toThrow(
      /Invalid --fail-chars value "-5": must be a positive integer/
    );
  });

  it("REJECTS a non-integer value", () => {
    expect(() => parseCliSizeBudgetChars("--warn-chars", "1000.5")).toThrow(
      /Invalid --warn-chars value "1000.5": must be a positive integer/
    );
  });

  it("REJECTS a literal NaN passed as a number", () => {
    expect(() => parseCliSizeBudgetChars("--warn-chars", Number.NaN)).toThrow(
      /must be a positive integer/
    );
  });

  it("REJECTS Infinity (finite check)", () => {
    expect(() => parseCliSizeBudgetChars("--fail-chars", Number.POSITIVE_INFINITY)).toThrow(
      /must be a positive integer/
    );
  });

  it("REJECTS an empty string (Number('') is 0, not NaN — still non-positive)", () => {
    expect(() => parseCliSizeBudgetChars("--warn-chars", "")).toThrow(/must be a positive integer/);
  });

  it("error message names the offending flag AND the invalid value — never silently coerces", () => {
    let caught: Error | undefined;
    try {
      parseCliSizeBudgetChars("--fail-chars", "not-a-number");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("--fail-chars");
    expect(caught?.message).toContain("not-a-number");
  });
});

describe("buildSizeBudgetOverride()", () => {
  it("returns undefined when both fields are undefined", () => {
    expect(buildSizeBudgetOverride(undefined, undefined)).toBeUndefined();
  });

  it("includes only warnChars when only warnChars is supplied", () => {
    expect(buildSizeBudgetOverride(1000, undefined)).toEqual({ warnChars: 1000 });
  });

  it("includes only failChars when only failChars is supplied", () => {
    expect(buildSizeBudgetOverride(undefined, 2000)).toEqual({ failChars: 2000 });
  });

  it("includes both when both are supplied", () => {
    expect(buildSizeBudgetOverride(1000, 2000)).toEqual({ warnChars: 1000, failChars: 2000 });
  });

  it("never includes an explicit undefined key (would defeat resolveSizeBudget's ?? fallback)", () => {
    const result = buildSizeBudgetOverride(1000, undefined);
    expect(result).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(result, "failChars")).toBe(false);
  });
});

describe("resolveMemoryLoadingMode()", () => {
  it("resolves without throwing regardless of config-provider availability", async () => {
    const mode = await resolveMemoryLoadingMode();
    expect(mode === undefined || mode === "on_demand" || mode === "legacy").toBe(true);
  });
});
