/**
 * Unit tests for kind normalization (ADR-006)
 */
import { describe, test, expect } from "bun:test";
import { normalizeClientInfoNameToKind, isValidKind, KNOWN_KINDS } from "./kinds";

describe("normalizeClientInfoNameToKind", () => {
  const cases: Array<[string | undefined, (typeof KNOWN_KINDS)[keyof typeof KNOWN_KINDS]]> = [
    // Empirically verified (mt#953 live capture)
    ["claude-code", KNOWN_KINDS.CLAUDE_CODE],
    // OpenAI Codex variants
    ["codex-tui", KNOWN_KINDS.CODEX],
    ["codex_vscode", KNOWN_KINDS.CODEX],
    // Other known harnesses
    ["cursor", KNOWN_KINDS.CURSOR],
    ["zed", KNOWN_KINDS.ZED],
    // Unknown / fallback
    ["unknown-harness", KNOWN_KINDS.UNKNOWN],
    ["", KNOWN_KINDS.UNKNOWN],
    [undefined, KNOWN_KINDS.UNKNOWN],
    // Case-insensitive matching
    ["Claude-Code", KNOWN_KINDS.CLAUDE_CODE],
    ["CURSOR", KNOWN_KINDS.CURSOR],
    // Whitespace trimming
    ["  claude-code  ", KNOWN_KINDS.CLAUDE_CODE],
  ];

  test.each(cases)("normalizes %s → %s", (input, expected) => {
    expect(normalizeClientInfoNameToKind(input)).toBe(expected);
  });
});

describe("isValidKind", () => {
  test("accepts known kinds", () => {
    for (const kind of Object.values(KNOWN_KINDS)) {
      expect(isValidKind(kind)).toBe(true);
    }
  });

  test("accepts forward-compatible reverse-domain strings", () => {
    expect(isValidKind("com.some.new-harness")).toBe(true);
    expect(isValidKind("minsky.native-subagent")).toBe(true);
    expect(isValidKind("github-app")).toBe(true);
  });

  test("rejects strings containing delimiters", () => {
    expect(isValidKind("bad:kind")).toBe(false);
    expect(isValidKind("bad@kind")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidKind("")).toBe(false);
  });

  test("rejects whitespace", () => {
    expect(isValidKind("bad kind")).toBe(false);
    expect(isValidKind(" ")).toBe(false);
  });
});
