/**
 * @fileoverview Tests for the no-spy-patching ESLint rule (mt#3565).
 *
 * Verifies the rule flags any direct spyOn(...) call in a test file (the ban), and separately
 * flags a spyOn(...) result held in a variable with no paired .mockRestore()/restoreAllMocks()
 * (the companion restore-protocol check) — while leaving non-test files, unrelated calls, and
 * properly restored spies untouched.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-spy-patching.js";
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

ruleTester.run("no-spy-patching", rule, {
  valid: [
    // Non-test files are ignored entirely, even if they call something named spyOn
    {
      code: "spyOn(someModule, 'fn');",
      filename: NON_TEST_FILENAME,
    },

    // No spyOn at all — ordinary injected-fake test
    {
      code: `
        test("uses an injected fake", () => {
          const fake = { fn: () => "value" };
          const result = decide(fake);
          expect(result).toBe("value");
        });
      `,
      filename: TEST_FILENAME,
    },

    // "spyOn" as a property name / non-call reference is not flagged
    {
      code: "const helpers = { spyOn: null }; helpers.spyOn;",
      filename: TEST_FILENAME,
    },
  ],

  invalid: [
    // Bare spyOn(...) call with no assignment — banned, no restore check applies (nothing to
    // restore-check without a holder variable)
    {
      code: `spyOn(someModule, "fn");`,
      filename: TEST_FILENAME,
      errors: [{ messageId: "spyOnBanned" }],
    },

    // spyOn(...) assigned to a variable, never restored — banned AND flagged for missing restore
    {
      code: `
        describe("suite", () => {
          const spy = spyOn(someModule, "fn");
          test("case", () => {
            spy();
          });
        });
      `,
      filename: TEST_FILENAME,
      errors: [{ messageId: "spyOnBanned" }, { messageId: "spyOnUnrestored" }],
    },

    // spyOn(...) assigned and restored via .mockRestore() — still banned, but the restore
    // check does not additionally fire
    {
      code: `
        describe("suite", () => {
          const spy = spyOn(someModule, "fn");
          afterEach(() => {
            spy.mockRestore();
          });
        });
      `,
      filename: TEST_FILENAME,
      errors: [{ messageId: "spyOnBanned" }],
    },

    // spyOn(...) assigned, discharged via restoreAllMocks() elsewhere in the file
    {
      code: `
        describe("suite", () => {
          const spy = spyOn(someModule, "fn");
          afterEach(() => {
            restoreAllMocks();
          });
        });
      `,
      filename: TEST_FILENAME,
      errors: [{ messageId: "spyOnBanned" }],
    },

    // .spec.ts files are also test files
    {
      code: `spyOn(someModule, "fn");`,
      filename: SPEC_FILENAME,
      errors: [{ messageId: "spyOnBanned" }],
    },
  ],
});
