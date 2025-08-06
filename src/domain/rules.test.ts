import { describe, test, expect } from "bun:test";
import { RuleService } from "./rules";

// NOTE: This test file requires refactoring RuleService to use dependency injection
// for filesystem operations before it can be safely enabled.
// Current tests use real filesystem operations which violate our testing guidelines.
// See: https://github.com/minsky/issues/262 for consolidation strategy.

describe("RuleService", () => {
  test.skip("listRules - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test.skip("findRuleById - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection  
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test.skip("validateRule - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test.skip("createRule - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test.skip("updateRule - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });

  test.skip("searchRules - requires DI refactoring", () => {
    // Test skipped: RuleService needs filesystem dependency injection
    // to avoid real filesystem operations in tests
    expect(true).toBe(true);
  });
});