/**
 * Tests for the strict top-level `configurationSchema` (mt#1612).
 *
 * Validates that unknown top-level keys are rejected with a Zod
 * `unrecognized_keys` issue rather than being silently stripped or
 * passed through, and that legitimate top-level keys (including the
 * optional `version` marker) are accepted.
 */

import { describe, test, expect } from "bun:test";
import { configurationSchema } from "./index";

const UNRECOGNIZED_KEYS = "unrecognized_keys";

describe("configurationSchema — strict top-level mode (mt#1612)", () => {
  test("rejects unknown top-level keys with unrecognized_keys", () => {
    const result = configurationSchema.safeParse({ foo: "bar" });

    expect(result.success).toBe(false);
    if (result.success) return;

    const unrecognizedIssues = result.error.issues.filter(
      (issue) => issue.code === UNRECOGNIZED_KEYS
    );
    expect(unrecognizedIssues.length).toBeGreaterThan(0);

    const allUnrecognizedKeys = unrecognizedIssues.flatMap((issue) =>
      "keys" in issue && Array.isArray(issue.keys) ? issue.keys : []
    );
    expect(allUnrecognizedKeys).toContain("foo");
  });

  test("rejects a typo of a real top-level key (`persistance` vs `persistence`)", () => {
    const result = configurationSchema.safeParse({
      persistance: { backend: "sqlite" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const unrecognizedIssues = result.error.issues.filter(
      (issue) => issue.code === UNRECOGNIZED_KEYS
    );
    const allUnrecognizedKeys = unrecognizedIssues.flatMap((issue) =>
      "keys" in issue && Array.isArray(issue.keys) ? issue.keys : []
    );
    expect(allUnrecognizedKeys).toContain("persistance");
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
