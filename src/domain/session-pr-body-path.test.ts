import { describe, test, expect } from "bun:test";
import { ValidationError } from "../errors/index";

// NOTE: This test file requires refactoring to use dependency injection
// for filesystem operations before it can be safely enabled.
// Current tests use real filesystem operations which violate our testing guidelines.
// See: https://github.com/minsky/issues/262 for consolidation strategy.

describe("Session PR bodyPath file reading functionality", () => {
  test.skip("bodyPath file reading - requires DI refactoring", () => {
    // Test skipped: Filesystem operations need dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test("ValidationError should be constructible", () => {
    // Test that doesn't require filesystem operations
    const error = new ValidationError("Test validation error");
    expect(error.message).toBe("Test validation error");
    expect(error.name).toBe("ValidationError");
  });
});