/**
 * Unit tests for the edit-pattern pure helpers.
 *
 * mt#2400: the fail-closed guards in the MCP edit tools rely on
 * `hasExistingCodeMarkers` and `exceedsGrowthThreshold`. These tests pin the
 * primitives so the guard semantics can't drift.
 *
 * mt#3248: `preserveTrailingNewline` is the shared post-process for BOTH apply
 * paths (`applyEditPattern` and `executeFastApply`). Its whole purpose is a
 * byte-level property — the original's trailing-newline state survives the
 * trim — so these tests assert on exact strings rather than on shape.
 */
import { describe, test, expect } from "bun:test";
import {
  EXISTING_CODE_MARKER,
  hasExistingCodeMarkers,
  exceedsGrowthThreshold,
  preserveTrailingNewline,
  REPLACE_ALL_GROWTH_REFUSAL_FACTOR,
  detectSuspiciousCollapse,
  COLLAPSE_GUARD_MIN_ORIGINAL_LINES,
  COLLAPSE_GUARD_SHRINK_RATIO,
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

describe("preserveTrailingNewline", () => {
  test("AT1: restores a single trailing newline when the original had one", () => {
    expect(preserveTrailingNewline("  x  \n\n", "a\n")).toBe("x\n");
  });

  test("AT2: adds no trailing newline when the original had none", () => {
    expect(preserveTrailingNewline("  x  \n\n", "a")).toBe("x");
  });

  test("AT3: equals trim() modulo the original's trailing-newline state", () => {
    const modelOutputs = [
      "const a = 1;",
      "\nconst a = 1;\n",
      "  \n  const a = 1;\n  \n",
      "line one\nline two",
      "line one\nline two\n\n\n",
    ];

    for (const output of modelOutputs) {
      expect(preserveTrailingNewline(output, "orig")).toBe(output.trim());
      expect(preserveTrailingNewline(output, "orig\n")).toBe(`${output.trim()}\n`);
    }
  });

  test("AT4: whitespace-only model output stays empty rather than becoming a lone newline", () => {
    // Fabricating a "\n" here would turn a legitimately-emptied file into a
    // 1-byte one, so the empty result is preserved for BOTH original states.
    expect(preserveTrailingNewline("", "a\n")).toBe("");
    expect(preserveTrailingNewline("   \n\n  ", "a\n")).toBe("");
    expect(preserveTrailingNewline("", "a")).toBe("");
  });

  test("interior newlines and indentation are untouched", () => {
    const body = "function f() {\n  return 1;\n}";
    expect(preserveTrailingNewline(`\n${body}\n`, "orig\n")).toBe(`${body}\n`);
  });

  test("an original that is itself only a newline still counts as newline-terminated", () => {
    expect(preserveTrailingNewline("x", "\n")).toBe("x\n");
  });

  test("a CRLF original gets CRLF back, not a bare LF", () => {
    // trim() strips \r as readily as \n, so rebuilding with a hardcoded "\n"
    // would silently convert the last line's ending and leave mixed endings.
    expect(preserveTrailingNewline("const a = 1;\r\n", "orig\r\n")).toBe("const a = 1;\r\n");
    expect(preserveTrailingNewline("  const a = 1;  \r\n\r\n", "a\r\nb\r\n")).toBe(
      "const a = 1;\r\n"
    );
  });

  test("a CRLF file's interior line endings survive the transform", () => {
    const body = "line one\r\nline two\r\nline three";
    expect(preserveTrailingNewline(`\r\n${body}\r\n`, "orig\r\n")).toBe(`${body}\r\n`);
  });

  test("a lone-CR original gets CR back", () => {
    expect(preserveTrailingNewline("x", "orig\r")).toBe("x\r");
  });
});

/**
 * mt#3674: the collapse guard moved here from `session-file-edit-operation.ts` so BOTH
 * apply-model partial-edit surfaces consume one decision. These pin the predicate itself;
 * the per-tool refusal behavior is pinned in each tool's own suite.
 */
describe("detectSuspiciousCollapse", () => {
  const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  test("thresholds are the mt#2577 values", () => {
    expect(COLLAPSE_GUARD_MIN_ORIGINAL_LINES).toBe(40);
    expect(COLLAPSE_GUARD_SHRINK_RATIO).toBe(0.6);
  });

  test("fires on the observed 999 -> 517 disaster", () => {
    expect(detectSuspiciousCollapse(makeLines(999), makeLines(517))).toEqual({
      originalLines: 999,
      finalLines: 517,
    });
  });

  test("reproduces the mt#3339 spec-destruction shape", () => {
    // The real incident: a ~26,000-character, ~380-line spec replaced by the 7-character
    // string `mt#3672`. This is the case the guard exists to refuse — asserted here so the
    // predicate cannot drift below the severity that actually destroyed a durable artifact.
    expect(detectSuspiciousCollapse(makeLines(380), "mt#3672")).toEqual({
      originalLines: 380,
      finalLines: 1,
    });
  });

  test("does not fire on an unchanged or grown document", () => {
    expect(detectSuspiciousCollapse(makeLines(999), makeLines(999))).toBeNull();
    expect(detectSuspiciousCollapse(makeLines(100), makeLines(400))).toBeNull();
  });

  test("does not fire below the small-document floor", () => {
    expect(detectSuspiciousCollapse(makeLines(30), makeLines(5))).toBeNull();
  });

  test("boundary: exactly the ratio passes, one line below fires", () => {
    expect(detectSuspiciousCollapse(makeLines(100), makeLines(60))).toBeNull();
    expect(detectSuspiciousCollapse(makeLines(100), makeLines(59))).toEqual({
      originalLines: 100,
      finalLines: 59,
    });
  });

  test("trailing blank lines on either side do not move the verdict", () => {
    expect(detectSuspiciousCollapse(makeLines(100), `${makeLines(100)}\n\n\n\n\n`)).toBeNull();
    expect(detectSuspiciousCollapse(`${makeLines(100)}\n\n\n\n\n`, makeLines(100))).toBeNull();
  });

  test("an empty original is never a collapse — nothing to lose", () => {
    expect(detectSuspiciousCollapse("", "")).toBeNull();
    expect(detectSuspiciousCollapse("", "anything")).toBeNull();
  });
});
