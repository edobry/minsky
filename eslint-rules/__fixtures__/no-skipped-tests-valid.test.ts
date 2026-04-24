/**
 * Fixture: Examples of valid test patterns that ESLint should NOT flag
 * This is NOT a real test file — it's test data for the no-skipped-tests ESLint rule.
 */

import { describe, it, test, expect } from "bun:test";

// ✅ GOOD: Regular describe/it/test — no .skip or .todo
describe("active suite", () => {
  it("passing test", () => {
    expect(1 + 1).toBe(2);
  });

  test("another passing test", () => {
    expect("hello").toBe("hello");
  });
});

// ✅ GOOD: Nested describes without skip/todo
describe("outer", () => {
  describe("inner", () => {
    it("nested test", () => {
      expect(true).toBe(true);
    });
  });
});

// ✅ GOOD: Functions named skip/todo in non-test-object context
const skip = () => {};
const todo = () => {};
skip();
todo();

// ✅ GOOD: object.skip/todo where object is NOT describe/it/test
const myRunner = { skip: () => {}, todo: () => {} };
myRunner.skip();
myRunner.todo();
