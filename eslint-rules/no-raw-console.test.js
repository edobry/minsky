/**
 * @fileoverview Tests for no-raw-console ESLint rule (mt#1960).
 *
 * Verifies AST detection of `console.*` calls, the `allowedPatterns` opt-out,
 * and the conditional `--fix` that only rewrites when `log` is bound.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-raw-console.js";
import { RuleTester } from "eslint";

const RAW_CONSOLE = "rawConsole";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-raw-console", rule, {
  valid: [
    // No console at all
    "const x = 1; const y = 2;",

    // Logger usage (not console)
    'import { log } from "./logger";\nlog.info("hello");',
    'import { log } from "./logger";\nlog.error("bad", { ctx: 1 });',

    // `console` as a non-call reference
    "const c = console; const ref = c;",

    // Computed access does not match (out of scope; rule targets the static
    // `console.<id>(...)` shape)
    'const m = "log"; console[m]("hi");',

    // Allowed pattern via option
    {
      code: 'console.error("Failed to import test monitoring data");',
      options: [
        {
          allowedPatterns: ['console.error("Failed to import test monitoring data"'],
        },
      ],
    },
    {
      code: 'console.log("🔇 Global test setup");',
      options: [{ allowedPatterns: ['"🔇 Global test setup"'] }],
    },

    // Console method NOT in the recognized set is ignored
    "console.profile();",
  ],

  invalid: [
    // Plain console.log without `log` in scope — reports, no autofix
    {
      code: 'console.log("hello");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    {
      code: 'console.warn("watch out");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    {
      code: 'console.error("oops");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    {
      code: 'console.debug("trace");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    {
      code: 'console.info("info");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },

    // `log` import in scope → autofix rewrites console.log → log.info
    {
      code: 'import { log } from "./logger";\nconsole.log("hello");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import { log } from "./logger";\nlog.info("hello");',
    },
    // console.error → log.error when log is in scope
    {
      code: 'import { log } from "./logger";\nconsole.error("oops");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import { log } from "./logger";\nlog.error("oops");',
    },
    // console.warn → log.warn
    {
      code: 'import { log } from "./logger";\nconsole.warn("hm");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import { log } from "./logger";\nlog.warn("hm");',
    },
    // console.debug → log.debug
    {
      code: 'import { log } from "./logger";\nconsole.debug("trace");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import { log } from "./logger";\nlog.debug("trace");',
    },

    // Default import of `log` also satisfies binding check
    {
      code: 'import log from "./logger";\nconsole.log("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import log from "./logger";\nlog.info("hi");',
    },

    // Namespace import bringing in `log`
    {
      code: 'import * as log from "./logger";\nconsole.log("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: 'import * as log from "./logger";\nlog.info("hi");',
    },

    // Method without log-equivalent (e.g., console.table) — reports but no fix
    // even when `log` is in scope.
    {
      code: 'import { log } from "./logger";\nconsole.table([1, 2, 3]);',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    {
      code: 'import { log } from "./logger";\nconsole.trace("here");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },

    // Multiple violations in one file all flagged
    {
      code: 'console.log("a"); console.warn("b"); console.error("c");',
      errors: [{ messageId: RAW_CONSOLE }, { messageId: RAW_CONSOLE }, { messageId: RAW_CONSOLE }],
      output: null,
    },

    // Allowed pattern: pattern does not match this string → still flagged
    {
      code: 'console.error("a different message");',
      options: [{ allowedPatterns: ["Failed to import test monitoring data"] }],
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },

    // Optional-chaining cases: reported but NOT autofixed (mt#1960 reviewer feedback).
    // The naive callee replacement would drop `?.` and change short-circuit semantics.

    // Optional member access (`console?.log("x")`) — reported, no autofix
    {
      code: 'console?.log("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    // Optional member access + `log` in scope — still no autofix (safety > convenience)
    {
      code: 'import { log } from "./logger";\nconsole?.log("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    // Optional call (`console.log?.("x")`) — reported, no autofix
    {
      code: 'console.log?.("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
    // Optional call + `log` in scope — still no autofix
    {
      code: 'import { log } from "./logger";\nconsole.log?.("hi");',
      errors: [{ messageId: RAW_CONSOLE }],
      output: null,
    },
  ],
});
