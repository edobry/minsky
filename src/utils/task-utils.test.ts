// This file's tests were for the old normalizeTaskId function in src/utils/task-utils.ts,
// which has been removed and replaced by a more comprehensive version in src/domain/tasks/utils.ts.
// The new utility has its own tests in src/domain/tasks/utils.test.ts.
// This test file is now obsolete.
/*
Original content commented out:
import { describe, expect, test } from "bun:test";
import { normalizeTaskId } from "./task-utils.js";

describe("normalizeTaskId", () => {
  test("should add # if missing", () => {
    expect(normalizeTaskId("123")).toBe("#123");
  });

  test("should not add # if present", () => {
    expect(normalizeTaskId("#123")).toBe("#123");
  });

  test("should return empty string if empty", () => {
    expect(normalizeTaskId("")).toBe("");
  });
});
*/
