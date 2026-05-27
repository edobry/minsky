/**
 * Tests for the lenient top-level `configurationSchema` (mt#2161, replaces mt#1612).
 *
 * Validates that unknown top-level keys are STRIPPED (not rejected) and that
 * KNOWN_TOP_LEVEL_KEYS correctly identifies them for the loader's warning.
 * Known keys (including the optional `version` marker) are still accepted
 * and validated.
 */

import { describe, test, expect } from "bun:test";
import { configurationSchema, KNOWN_TOP_LEVEL_KEYS } from "./index";

const UNRECOGNIZED_KEYS = "unrecognized_keys";

describe("configurationSchema — lenient top-level mode (mt#2161, replaces mt#1612)", () => {
  test("strips unknown top-level keys without error", () => {
    const result = configurationSchema.safeParse({ foo: "bar" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("foo" in result.data).toBe(false);
  });

  test("strips a typo of a real top-level key without error", () => {
    const result = configurationSchema.safeParse({
      persistance: { backend: "sqlite" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("persistance" in result.data).toBe(false);
  });

  test("KNOWN_TOP_LEVEL_KEYS detects unknown keys for warning", () => {
    const unknownKeys = ["foo", "persistance"].filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
    expect(unknownKeys).toContain("foo");
    expect(unknownKeys).toContain("persistance");
  });

  test("KNOWN_TOP_LEVEL_KEYS includes all schema keys", () => {
    expect(KNOWN_TOP_LEVEL_KEYS.has("persistence")).toBe(true);
    expect(KNOWN_TOP_LEVEL_KEYS.has("github")).toBe(true);
    expect(KNOWN_TOP_LEVEL_KEYS.has("railway")).toBe(true);
  });

  test("accepts the optional `version` top-level key", () => {
    const result = configurationSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
  });

  test("accepts an empty config object (all top-level keys optional or have defaults)", () => {
    const result = configurationSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("configurationSchema — supabase slot (mt#1633)", () => {
  test("accepts supabase.accessToken as a string", () => {
    const result = configurationSchema.safeParse({
      supabase: { accessToken: "sbp_test123" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts an empty supabase block (accessToken is optional)", () => {
    const result = configurationSchema.safeParse({ supabase: {} });
    expect(result.success).toBe(true);
  });

  test("rejects unknown nested keys under supabase (nested strict)", () => {
    const result = configurationSchema.safeParse({
      supabase: { unknownKey: "x" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const unrecognizedIssues = result.error.issues.filter(
      (issue) => issue.code === UNRECOGNIZED_KEYS
    );
    const allUnrecognizedKeys = unrecognizedIssues.flatMap((issue) =>
      "keys" in issue && Array.isArray(issue.keys) ? issue.keys : []
    );
    expect(allUnrecognizedKeys).toContain("unknownKey");
  });

  test("rejects accessToken typos (e.g., `accesToken`) at the nested level", () => {
    const result = configurationSchema.safeParse({
      supabase: { accesToken: "sbp_test456" },
    });
    expect(result.success).toBe(false);
  });
});
