/**
 * Unit tests for the edit-pattern pure helpers.
 *
 * mt#2400: the fail-closed guards in the MCP edit tools rely on
 * `hasExistingCodeMarkers` and `exceedsGrowthThreshold`. These tests pin the
 * primitives so the guard semantics can't drift.
 */
import { describe, test, expect } from "bun:test";
import {
  EXISTING_CODE_MARKER,
  hasExistingCodeMarkers,
  exceedsGrowthThreshold,
  REPLACE_ALL_GROWTH_REFUSAL_FACTOR,
} from "./edit-pattern-utils";

describe("hasExistingCodeMarkers", () => {
  test("detects the marker anywhere in the content", () => {
    expect(hasExistingCodeMarkers(`${EXISTING_CODE_MARKER}\nfoo`)).toBe(true);
    expect(hasExistingCodeMarkers(`foo\n${EXISTING_CODE_MARKER}\nbar`)).toBe(true);
  });

  test("returns false for marker-less content", () => {
    expect(hasExistingCodeMarkers("just some content\nwith no markers")).toBe(false);
    expect(hasExistingCodeMarkers("")).toBe(false);
  });
});

describe("exceedsGrowthThreshold", () => {
  test("default factor is 1.5", () => {
    expect(REPLACE_ALL_GROWTH_REFUSAL_FACTOR).toBe(1.5);
  });

  test("true only when output strictly exceeds factor x input", () => {
    expect(exceedsGrowthThreshold(100, 151)).toBe(true);
    expect(exceedsGrowthThreshold(100, 150)).toBe(false); // exactly 1.5x is allowed
    expect(exceedsGrowthThreshold(100, 120)).toBe(false);
    expect(exceedsGrowthThreshold(100, 100)).toBe(false);
    expect(exceedsGrowthThreshold(100, 80)).toBe(false); // shrink
  });

  test("honors a custom factor", () => {
    expect(exceedsGrowthThreshold(100, 201, 2)).toBe(true);
    expect(exceedsGrowthThreshold(100, 200, 2)).toBe(false);
  });

  test("a zero-length input rejects any non-empty output", () => {
    expect(exceedsGrowthThreshold(0, 1)).toBe(true);
    expect(exceedsGrowthThreshold(0, 0)).toBe(false);
  });
});
