/**
 * Tests for the mt#4134 backtest CLI's argument parsing
 * (`scripts/backtest-diff-guard.ts`).
 *
 * Numeric validation is the subject (PR #3001 R1): `Number.parseInt("foo")` is
 * `NaN`, and an unvalidated `NaN` reaches git as `--max-count=NaN` and reaches
 * the report as a `NaN`-valued window description.
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "./backtest-diff-guard";

describe("parseArgs", () => {
  test("defaults when no ceilings are given", () => {
    const args = parseArgs(["--guard", "stale-signal-sweep"]);
    expect(args.guard).toBe("stale-signal-sweep");
    expect(args.days).toBe(60);
    expect(args.limit).toBe(400);
    expect(args.revRange).toBeUndefined();
    expect(args.json).toBe(false);
    expect(args.includeTerminal).toBe(false);
  });

  test("reads a rev-range and the boolean flags", () => {
    const args = parseArgs([
      "--guard",
      "unrendered-result-field-scan",
      "--rev-range",
      "abc^..def",
      "--json",
      "--include-terminal",
    ]);
    expect(args.revRange).toBe("abc^..def");
    expect(args.json).toBe(true);
    expect(args.includeTerminal).toBe(true);
  });

  test("accepts positive integer ceilings", () => {
    const args = parseArgs(["--guard", "g", "--days", "14", "--limit", "50"]);
    expect(args.days).toBe(14);
    expect(args.limit).toBe(50);
  });

  test("refuses a non-numeric ceiling by name rather than yielding NaN", () => {
    expect(() => parseArgs(["--guard", "g", "--limit", "foo"])).toThrow("--limit");
    expect(() => parseArgs(["--guard", "g", "--days", "foo"])).toThrow("--days");
  });

  test("refuses a zero or negative ceiling", () => {
    expect(() => parseArgs(["--guard", "g", "--limit", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["--guard", "g", "--days", "-5"])).toThrow("positive integer");
  });
});
