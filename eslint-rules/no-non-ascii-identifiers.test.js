/**
 * @fileoverview Tests for no-non-ascii-identifiers ESLint rule
 *
 * Verifies that the rule flags non-ASCII characters in identifier names
 * while leaving string literals and comments untouched.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-non-ascii-identifiers.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

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

    // Non-ASCII array destructuring element
    {
      code: "const [café] = arr;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII export-as specifier (exported name)
    {
      code: "const foo = 1; export { foo as café };",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII class field (PropertyDefinition)
    {
      code: "class C { café = 1; }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },
  ],
});

// ---------------------------------------------------------------------------
// TypeScript-specific tests (require @typescript-eslint/parser)
// ---------------------------------------------------------------------------

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tsTester.run("no-non-ascii-identifiers (TypeScript)", rule, {
  valid: [
    // ASCII type alias
    "type MyType = string;",
    // ASCII interface
    "interface MyInterface {}",
    // ASCII enum
    "enum Direction { Up, Down }",
    // ASCII generic
    "function identity<T>(x: T): T { return x; }",
    // ASCII TSPropertySignature
    "interface I { name: string; }",
    // ASCII TSMethodSignature
    "interface I { greet(): void; }",
  ],

  invalid: [
    // Non-ASCII type alias name
    {
      code: "type café = string;",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII interface name
    {
      code: "interface Résumé {}",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "Résumé" } }],
    },

    // Non-ASCII enum name
    {
      code: "enum Ënum { A }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "Ënum" } }],
    },

    // Non-ASCII enum member
    {
      code: "enum E { café }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII generic type parameter
    {
      code: "function identity<Ñ>(x: Ñ): Ñ { return x; }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "Ñ" } }],
    },

    // Non-ASCII TSPropertySignature key
    {
      code: "interface I { café: string; }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "café" } }],
    },

    // Non-ASCII TSMethodSignature key
    {
      code: "interface I { grüßen(): void; }",
      errors: [{ messageId: NON_ASCII_MSG, data: { name: "grüßen" } }],
    },
  ],
});
