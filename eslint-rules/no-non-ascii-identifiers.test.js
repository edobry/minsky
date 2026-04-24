/**
 * @fileoverview Tests for no-non-ascii-identifiers ESLint rule
 *
 * Verifies that the rule flags non-ASCII characters in identifier names
 * while leaving string literals and comments untouched.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-non-ascii-identifiers.js";
import { RuleTester } from "eslint";

// Message ID constant — avoids no-magic-string-duplication warnings
const NON_ASCII_MSG = "nonAsciiIdentifier";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-non-ascii-identifiers", rule, {
  valid: [
    // ASCII-only identifiers are fine
    "const greeting = 1;",
    "let counter = 0;",
    "function greet() {}",
    "class MyClass {}",
    "const obj = { key: 'value' };",
    "const obj = { myMethod() {} };",

    // Non-ASCII in string literals is explicitly allowed
    "const greeting = 'café';",
    'const city = "Zürich";',
    "const msg = `résumé`;",

    // Non-ASCII in comments is allowed
    "// This is a café comment\nconst x = 1;",
    "/* naïve approach */\nconst y = 2;",

    // Template literals with non-ASCII content
    "const s = `Hello, Ëlise!`;",

    // Import from non-ASCII path string — the path is a Literal, not an Identifier
    'import something from "some-module";',

    // Regular ASCII destructuring
    "const { name, age } = person;",
    "const [first, second] = arr;",

    // Arrow functions with ASCII params
    "const fn = (x, y) => x + y;",

    // ASCII catch clause
    "try {} catch (err) {}",
  ],

  invalid: [
    // Non-ASCII variable name
    {
      code: "const café = 1;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII function name
    {
      code: "function résumé() {}",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "résumé" } }],
    },

    // Non-ASCII class name
    {
      code: "class Ëlise {}",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "Ëlise" } }],
    },

    // Non-ASCII object method name
    {
      code: "const obj = { grüßen() {} };",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "grüßen" } }],
    },

    // Non-ASCII object property key (shorthand)
    {
      code: "const naïf = 1; const obj = { naïf };",
      errors: [
        { messageId: NON_ASCII_MSG, data: { name: "naïf" } },
        { messageId: NON_ASCII_MSG, data: { name: "naïf" } },
      ],
    },

    // Non-ASCII arrow function parameter
    {
      code: "const fn = (café) => café;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII destructuring binding
    {
      code: "const { café } = obj;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII let declaration
    {
      code: "let naïve = true;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "naïve" } }],
    },

    // Non-ASCII import local binding
    {
      code: 'import { café } from "some-module";',
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII default import
    {
      code: 'import résumé from "some-module";',
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "résumé" } }],
    },

    // Multiple non-ASCII identifiers in same file
    {
      code: "const café = 1; const résumé = 2;",
      errors: [
        { messageId: NON_ASCII_MSG, data: { name: "café" } },
        { messageId: NON_ASCII_MSG, data: { name: "résumé" } },
      ],
    },

    // Non-ASCII function parameter (plain identifier)
    {
      code: "function greet(ñombre) {}",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "ñombre" } }],
    },

    // Non-ASCII catch clause binding
    {
      code: "try {} catch (errëur) {}",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "errëur" } }],
    },
  ],
});
