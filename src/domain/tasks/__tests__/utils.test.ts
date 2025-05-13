import { describe, expect, test } from "bun:test";
import { normalizeTaskId } from "../utils";

describe("normalizeTaskId", () => {
  test("should add # prefix to task ID without it and handle valid IDs", () => {
    expect(normalizeTaskId("001")).toBe("#001");
    expect(normalizeTaskId("123")).toBe("#123");
    expect(normalizeTaskId("abc")).toBeNull();
  });

  test("should ensure a single # prefix for task IDs that already have it", () => {
    expect(normalizeTaskId("#001")).toBe("#001");
    expect(normalizeTaskId("##123")).toBe("#123");
    expect(normalizeTaskId("###abc")).toBeNull();
  });

  test("should return null for empty, undefined, null, or whitespace-only inputs", () => {
    expect(normalizeTaskId("")).toBeNull();
    expect(normalizeTaskId(undefined as any)).toBeNull();
    expect(normalizeTaskId(null as any)).toBeNull();
    expect(normalizeTaskId("   ")).toBeNull();
  });

  test("should return null if the ID is only a # or multiple #s", () => {
    expect(normalizeTaskId("#")).toBeNull();
    expect(normalizeTaskId("##")).toBeNull();
    expect(normalizeTaskId("###")).toBeNull();
  });
});
