/**
 * Tests for the ANSI escape stripper (mt#3322).
 *
 * The load-bearing fixture is the `/model` slash command's captured stdout,
 * copied verbatim from a real transcript — it is the payload that rendered as
 * replacement glyphs in the cockpit conversation view.
 */
import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./strip-ansi";

const ESC = "\u001b";

describe("stripAnsi", () => {
  test("strips SGR bold/reset pairs from real captured command output", () => {
    const input = `Set model to ${ESC}[1mFable 5${ESC}[22m for this session only`;
    expect(stripAnsi(input)).toBe("Set model to Fable 5 for this session only");
  });

  test("leaves the escape's visible residue nowhere in the output", () => {
    const output = stripAnsi(`${ESC}[1mbold${ESC}[22m`);
    expect(output).toBe("bold");
    expect(output).not.toContain(ESC);
    expect(output).not.toContain("[1m");
  });

  test("strips color and multi-parameter sequences", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[1;32;40mstyled${ESC}[0m`)).toBe("styled");
  });

  test("strips cursor-movement and clear sequences, not just color", () => {
    expect(stripAnsi(`before${ESC}[2Kafter`)).toBe("beforeafter");
    expect(stripAnsi(`${ESC}[HHome`)).toBe("Home");
  });

  test("strips OSC sequences terminated by BEL", () => {
    expect(stripAnsi(`${ESC}]0;window-title\u0007text`)).toBe("text");
  });

  test("returns text with no escapes unchanged (the common case)", () => {
    const plain = "Set model to Fable 5 for this session only";
    expect(stripAnsi(plain)).toBe(plain);
  });

  test("does not strip bracket-digit text that is NOT an escape sequence", () => {
    // Operator prose discussing terminal codes must survive verbatim — only a
    // real ESC/CSI introducer triggers stripping.
    const prose = "The [1m sequence sets bold; [22m resets it.";
    expect(stripAnsi(prose)).toBe(prose);
  });

  test("handles empty and whitespace input without throwing", () => {
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi("   ")).toBe("   ");
  });
});
