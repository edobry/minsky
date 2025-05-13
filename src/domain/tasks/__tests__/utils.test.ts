import { describe, expect, test } from "bun:test";
import { normalizeTaskId } from "../utils";

describe("normalizeTaskId", () => {
  test("should add # prefix to task ID without it and handle valid IDs", () => {
    expect(normalizeTaskId("001")).toBe("#001");
    expect(normalizeTaskId("123")).toBe("#123");
    expect(normalizeTaskId("abc")).toBe("#abc");
  });

  test("should ensure a single # prefix for task IDs that already have it", () => {
    expect(normalizeTaskId("#001")).toBe("#001");
    expect(normalizeTaskId("##123")).toBe("#123");
    expect(normalizeTaskId("###abc")).toBe("#abc");
  });

  test("should return null for empty, undefined, null, or whitespace-only inputs", () => {
    expect(normalizeTaskId("")).toBe(null);
    expect(normalizeTaskId(undefined)).toBe(null);
    expect(normalizeTaskId(null)).toBe(null);
    expect(normalizeTaskId("   ")).toBe(null);
  });

  test("should return null if the ID is only a # or multiple #s", () => {
    expect(normalizeTaskId("#")).toBe(null);
    expect(normalizeTaskId("##")).toBe(null);
    expect(normalizeTaskId("###")).toBe(null);
  });
});
