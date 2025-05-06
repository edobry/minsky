import { describe, expect, it } from "bun:test";
import { normalizeTaskId } from "./task-utils";

describe("normalizeTaskId", () => {
  it("should add # prefix to task ID without it", () => {
    expect(normalizeTaskId("001")).toBe("#001");
    expect(normalizeTaskId("123")).toBe("#123");
  });

  it("should not modify task ID that already has # prefix", () => {
    expect(normalizeTaskId("#001")).toBe("#001");
    expect(normalizeTaskId("#123")).toBe("#123");
  });

  it("should handle empty/undefined values", () => {
    expect(normalizeTaskId("")).toBe("");
    expect(normalizeTaskId(undefined as unknown as string)).toBe(undefined);
  });
}); 
