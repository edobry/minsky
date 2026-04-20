/**
 * @fileoverview Tests for no-real-fs-in-tests ESLint rule
 * Verifies that the rule reports fs imports in test files and provides
 * suggestions (not auto-fixes) for replacing them.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-real-fs-in-tests.js";
import { RuleTester } from "eslint";

const TEST_FILENAME = "src/domain/example.test.ts";
const SUGGESTION_DESC = "Comment out import (requires manual fix of call sites)";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

ruleTester.run("no-real-fs-in-tests", rule, {
  valid: [
    // Non-test files should be ignored (RuleTester uses filename option)
    {
      code: 'import { readFile } from "fs/promises";',
      filename: "src/domain/workspace.ts",
    },
    // Test file without fs imports is fine
    {
      code: 'import { describe, test } from "bun:test";',
      filename: "src/domain/workspace.test.ts",
    },
  ],

  invalid: [
    // fs/promises import in test file — should report with suggestion, NOT auto-fix
    {
      code: 'import { readFile } from "fs/promises";',
      filename: TEST_FILENAME,
      errors: [
        {
          messageId: "fsImport",
          suggestions: [
            {
              desc: SUGGESTION_DESC,
              output:
                '// Use dependency injection — pass mock fs via function/constructor parameters\n// import { readFile } from "fs/promises";',
            },
          ],
        },
      ],
    },
    // fs import in test file
    {
      code: 'import * as fs from "fs";',
      filename: TEST_FILENAME,
      errors: [
        {
          messageId: "fsImport",
          suggestions: [
            {
              desc: SUGGESTION_DESC,
              output:
                '// Use dependency injection — pass mock fs via function/constructor parameters\n// import * as fs from "fs";',
            },
          ],
        },
      ],
    },
    // node:fs/promises import in test file
    {
      code: 'import { writeFile } from "node:fs/promises";',
      filename: TEST_FILENAME,
      errors: [
        {
          messageId: "fsImport",
          suggestions: [
            {
              desc: SUGGESTION_DESC,
              output:
                '// Use dependency injection — pass mock fs via function/constructor parameters\n// import { writeFile } from "node:fs/promises";',
            },
          ],
        },
      ],
    },
  ],
});
