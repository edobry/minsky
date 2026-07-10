/**
 * Tests for normalizeTaskSubjectId — mt#2562 (PR #1755 R1 fix).
 *
 * Proves the presence subject-id canonicalizer collapses every surface form of
 * the same task to ONE key (so write/read can't fragment) while keeping
 * different backends distinct.
 */

import { describe, test, expect } from "bun:test";
import { normalizeTaskSubjectId } from "./normalize";

describe("normalizeTaskSubjectId", () => {
  test("collapses every surface form of an mt task to one canonical key", () => {
    const forms = ["mt#2562", "MT#2562", "mt-2562", "mt2562", "#2562", "2562", "  mt#2562  "];
    const canonical = forms.map(normalizeTaskSubjectId);
    // Every form maps to the same key — this is the anti-fragmentation contract.
    for (const k of canonical) {
      expect(k).toBe("mt2562");
    }
  });

  test("collapses the reviewer-flagged mt#2562 == 2562 case specifically", () => {
    expect(normalizeTaskSubjectId("mt#2562")).toBe(normalizeTaskSubjectId("2562"));
  });

  test("preserves backend prefix so different backends stay distinct", () => {
    expect(normalizeTaskSubjectId("md#160")).toBe("md160");
    expect(normalizeTaskSubjectId("gh#160")).toBe("gh160");
    // Same number, different backend → different keys (no false collapse).
    expect(normalizeTaskSubjectId("md#160")).not.toBe(normalizeTaskSubjectId("mt#160"));
  });

  test("a bare number defaults to the mt backend (global mt#N numbering)", () => {
    expect(normalizeTaskSubjectId("160")).toBe("mt160");
    expect(normalizeTaskSubjectId("#160")).toBe("mt160");
  });

  test("returns empty string for non-string / empty inputs", () => {
    expect(normalizeTaskSubjectId(undefined)).toBe("");
    expect(normalizeTaskSubjectId(null)).toBe("");
    expect(normalizeTaskSubjectId(2562)).toBe("");
    expect(normalizeTaskSubjectId("")).toBe("");
    expect(normalizeTaskSubjectId("   ")).toBe("");
  });
});
