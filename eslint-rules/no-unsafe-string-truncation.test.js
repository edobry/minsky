/**
 * @fileoverview Tests for no-unsafe-string-truncation ESLint rule
 *
 * Verifies that the rule:
 *   - Flags .slice(0, N) / .substring(0, N) / .substr(0, N) on plausible string receivers
 *   - Flags .slice(-N) on plausible string receivers
 *   - Does NOT flag safeTruncate() calls
 *   - Does NOT flag array slices (non-string receivers)
 *   - Does NOT flag eslint-disabled lines (tested via allowlist option)
 *   - Respects the allowlist option
 *
 * @see mt#1615
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-unsafe-string-truncation.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

// Message ID constants — avoids no-magic-string-duplication warnings
const MSG_HEAD = "unsafeHeadTruncation";
const MSG_TAIL = "unsafeTailTruncation";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

ruleTester.run("no-unsafe-string-truncation", rule, {
  valid: [
    // safeTruncate is always safe (no raw .slice on string)
    "safeTruncate(content, 300, 'head');",
    "safeTruncate(str, 5000, 'head');",
    "safeTruncate(text, 1000, 'tail');",

    // Array slices — receiver is not plausibly a string
    "items.slice(0, 5);",
    "results.slice(0, limit);",
    "entries.slice(0, 10);",
    "arr.slice(-100);",
    "records.slice(0, 3);",

    // Non-zero first arg on a string — not head-truncation pattern
    "str.slice(1);",
    "text.slice(2, 10);",

    // Variable in the allowlist (known ASCII, e.g., SHA)
    {
      code: "sha.slice(0, 8);",
      options: [{ allowlist: ["sha"] }],
    },
    {
      code: "commitHash.slice(0, 7);",
      options: [{ allowlist: ["commitHash"] }],
    },

    // Non-string method: .slice on a number method result (not plausibly string)
    "Math.max(a, b).toString().slice(0, 5);",

    // Date/time slices with known-ASCII content — not in plausibly-string heuristic
    "new Date().toISOString().slice(0, 10);",
    "new Date().toTimeString().slice(0, 5);",
  ],

  invalid: [
    // Head truncation on content (string-hint name)
    {
      code: "content.slice(0, 300);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },

    // Head truncation on text (string-hint name)
    {
      code: "text.slice(0, 1000);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },

    // Head truncation using .substring()
    {
      code: "content.substring(0, 4997);",
      errors: [{ messageId: MSG_HEAD, data: { method: "substring" } }],
    },

    // Head truncation using .substr()
    {
      code: "message.substr(0, 200);",
      errors: [{ messageId: MSG_HEAD, data: { method: "substr" } }],
    },

    // Head truncation on body (reviewer body)
    {
      code: "body.slice(0, 100);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },

    // Head truncation on str (explicit string hint)
    {
      code: "str.slice(0, 50);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },

    // Head truncation after .trim() — chain is plausibly string
    {
      code: "text.trim().slice(0, 200);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },

    // Tail truncation on string-hinted variable
    {
      code: "output.slice(-800);",
      errors: [{ messageId: MSG_TAIL, data: { method: "slice" } }],
    },

    // MCP boundary context — an adapter module that crosses MCP boundary
    {
      code: "description.slice(0, 100);",
      filename: "src/adapters/mcp/some-adapter.ts",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },
  ],
});

// TypeScript tests
tsTester.run("no-unsafe-string-truncation (TypeScript)", rule, {
  valid: [
    // safeTruncate always allowed
    "const result = safeTruncate(content, 300, 'head');",

    // Array indexed types — heuristic doesn't flag non-string-named vars
    "const items: string[] = []; items.slice(0, 5);",
  ],

  invalid: [
    // TypeScript with string-typed hint
    {
      code: "const truncated = content.slice(0, 300);",
      errors: [{ messageId: MSG_HEAD, data: { method: "slice" } }],
    },
    {
      code: "const preview = body.substring(0, 100);",
      errors: [{ messageId: MSG_HEAD, data: { method: "substring" } }],
    },
  ],
});
