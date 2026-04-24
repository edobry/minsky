/**
 * Fixture: Examples of skipped/todo test patterns that ESLint SHOULD flag
 * This is NOT a real test file — it's test data for the no-skipped-tests ESLint rule.
 */

import { describe, it, test } from "bun:test";

// ❌ SHOULD BE DETECTED: describe.skip
describe.skip("skipped suite", () => {
  it("does something", () => {});
});

// ❌ SHOULD BE DETECTED: it.skip
describe("active suite", () => {
  it.skip("skipped test", () => {});
});

// ❌ SHOULD BE DETECTED: test.skip
test.skip("another skipped test", () => {});

// ❌ SHOULD BE DETECTED: test.todo
test.todo("unimplemented test");

// ❌ SHOULD BE DETECTED: it.todo
it.todo("another unimplemented test");

// ❌ SHOULD BE DETECTED: describe.todo
describe.todo("unimplemented suite");
