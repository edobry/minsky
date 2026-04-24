/**
 * @fileoverview Tests for no-skipped-tests ESLint rule
 *
 * Verifies that the rule flags describe.skip(), it.skip(), test.skip(),
 * test.todo(), it.todo(), and describe.todo() in test files, while leaving
 * non-test files and regular active tests untouched.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-skipped-tests.js";
import { RuleTester } from "eslint";

const TEST_FILENAME = "src/domain/example.test.ts";
const SPEC_FILENAME = "src/domain/example.spec.ts";
const NON_TEST_FILENAME = "src/domain/example.ts";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

ruleTester.run("no-skipped-tests", rule, {
  valid: [
    // Non-test files are ignored entirely
    {
      code: "describe.skip('ignored in non-test file', () => {});",
      filename: NON_TEST_FILENAME,
    },

    // Active describe/it/test — no .skip or .todo
    {
      code: "describe('suite', () => { it('test', () => {}); });",
      filename: TEST_FILENAME,
    },
    {
      code: "test('passing', () => {});",
      filename: TEST_FILENAME,
    },
    {
      code: "it('passing', () => {});",
      filename: TEST_FILENAME,
    },

    // .skip/.todo on objects that are NOT describe/it/test
    {
      code: "myRunner.skip('not a test object');",
      filename: TEST_FILENAME,
    },
    {
      code: "myRunner.todo('not a test object');",
      filename: TEST_FILENAME,
    },

    // Standalone skip/todo identifiers (not member expressions)
    {
      code: "const skip = () => {}; skip();",
      filename: TEST_FILENAME,
    },
    {
      code: "const todo = () => {}; todo('not flagged');",
      filename: TEST_FILENAME,
    },

    // .spec.ts files are also test files, but active tests are fine
    {
      code: "describe('spec suite', () => { test('spec test', () => {}); });",
      filename: SPEC_FILENAME,
    },
  ],

  invalid: [
    // describe.skip in .test.ts file
    {
      code: "describe.skip('skipped suite', () => {});",
      filename: TEST_FILENAME,
      errors: [{ messageId: "skippedTest", data: { object: "describe" } }],
    },

    // it.skip in .test.ts file
    {
      code: "it.skip('skipped test', () => {});",
      filename: TEST_FILENAME,
      errors: [{ messageId: "skippedTest", data: { object: "it" } }],
    },

    // test.skip in .test.ts file
    {
      code: "test.skip('skipped test', () => {});",
      filename: TEST_FILENAME,
      errors: [{ messageId: "skippedTest", data: { object: "test" } }],
    },

    // test.todo in .test.ts file
    {
      code: "test.todo('unimplemented');",
      filename: TEST_FILENAME,
      errors: [{ messageId: "todoTest", data: { object: "test" } }],
    },

    // it.todo in .test.ts file
    {
      code: "it.todo('unimplemented');",
      filename: TEST_FILENAME,
      errors: [{ messageId: "todoTest", data: { object: "it" } }],
    },

    // describe.todo in .test.ts file
    {
      code: "describe.todo('unimplemented suite');",
      filename: TEST_FILENAME,
      errors: [{ messageId: "todoTest", data: { object: "describe" } }],
    },

    // describe.skip in .spec.ts file
    {
      code: "describe.skip('skipped suite', () => {});",
      filename: SPEC_FILENAME,
      errors: [{ messageId: "skippedTest", data: { object: "describe" } }],
    },

    // test.todo in .spec.ts file
    {
      code: "test.todo('unimplemented');",
      filename: SPEC_FILENAME,
      errors: [{ messageId: "todoTest", data: { object: "test" } }],
    },

    // Multiple violations in one file
    {
      code: "describe.skip('s1', () => {}); test.todo('t1');",
      filename: TEST_FILENAME,
      errors: [
        { messageId: "skippedTest", data: { object: "describe" } },
        { messageId: "todoTest", data: { object: "test" } },
      ],
    },
  ],
});
