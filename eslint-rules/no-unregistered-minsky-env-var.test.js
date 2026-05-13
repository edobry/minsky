/**
 * @fileoverview Tests for no-unregistered-minsky-env-var ESLint rule (mt#1788).
 *
 * The rule reads the canonical allowlists by parsing the source text of
 * `src/domain/configuration/sources/environment.ts` at rule-load time. The
 * tests below assume that file's allowlists contain at least the entries
 * that exist on main when this PR landed (e.g., `MINSKY_LOG_MODE` in
 * `environmentMappings`, `MINSKY_FORCE_PARALLEL` in `HOOK_ONLY_ENV_VARS`).
 * If those constants get renamed/retired, these tests need updating in the
 * same PR per `/plan-task` gate criterion (h).
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-unregistered-minsky-env-var.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import path from "node:path";

const repoRoot = process.cwd();

function srcFile(...parts) {
  return path.join(repoRoot, "src", ...parts);
}

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tsTester.run("no-unregistered-minsky-env-var", rule, {
  valid: [
    // Registered in environmentMappings (config-mapped).
    {
      code: 'const m = process.env.MINSKY_LOG_MODE ?? "auto";',
      filename: srcFile("utils", "logger.ts"),
    },
    // Registered in HOOK_ONLY_ENV_VARS.
    {
      code: 'if (process.env.MINSKY_FORCE_PARALLEL === "1") {}',
      filename: srcFile("utils", "guard.ts"),
    },
    // Already-swept entry (mt#1788 sweep added MINSKY_NON_INTERACTIVE).
    {
      code: 'const ni = process.env.MINSKY_NON_INTERACTIVE === "1";',
      filename: srcFile("utils", "interactive.ts"),
    },
    // Non-MINSKY_ env vars are not the rule's concern (no dot-path conflict).
    {
      code: "const home = process.env.HOME;",
      filename: srcFile("utils", "paths.ts"),
    },
    {
      code: 'const ci = process.env.CI === "true";',
      filename: srcFile("utils", "env.ts"),
    },
    // Files outside src/ are out of scope (config files at root, etc.).
    {
      code: "const x = process.env.MINSKY_TOTALLY_BOGUS_NAME;",
      filename: path.join(repoRoot, "drizzle.pg.config.ts"),
    },
    // The registration file itself is allowed to read any process.env.MINSKY_*
    // — its reads are loader machinery.
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_NAME;",
      filename: srcFile("domain", "configuration", "sources", "environment.ts"),
    },
    // Computed access (process.env["MINSKY_X"]) is intentionally not flagged
    // — the bracket form is rare and dynamically computed; the originating
    // incidents all involved bare-identifier access.
    {
      code: 'const v = process.env["MINSKY_TOTALLY_BOGUS_NAME"];',
      filename: srcFile("utils", "dynamic.ts"),
    },
    // PR #1089 R1 BLOCKING #5: only .ts files in src/ are linted; .js files
    // (rare in src/ but possible for transitional/generated content) are out
    // of scope per spec.
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_NAME;",
      filename: srcFile("legacy", "loader.js"),
    },
  ],
  invalid: [
    // Unregistered MINSKY_* read in a regular src/ file.
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_NEW_VAR;",
      filename: srcFile("utils", "new-feature.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_TOTALLY_BOGUS_NEW_VAR",
            configPath: "totally.bogus.new.var",
          },
        },
      ],
    },
    // Assignment side (LHS) is also caught — process.env writes need the
    // var registered too because subsequent reads in the same process see
    // the value the loader rejects.
    {
      code: 'process.env.MINSKY_NEWLY_INTRODUCED = "1";',
      filename: srcFile("cli.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_NEWLY_INTRODUCED",
            configPath: "newly.introduced",
          },
        },
      ],
    },
    // Multiple unregistered names in one file all fire.
    {
      code: `
        const a = process.env.MINSKY_FOO_ONE;
        const b = process.env.MINSKY_FOO_TWO;
      `,
      filename: srcFile("multi.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: { name: "MINSKY_FOO_ONE", configPath: "foo.one" },
        },
        {
          messageId: "unregistered",
          data: { name: "MINSKY_FOO_TWO", configPath: "foo.two" },
        },
      ],
    },
    // Tests under src/ ARE in scope — tests should also use registered names.
    {
      code: 'process.env.MINSKY_TEST_ONLY_NEW = "x";',
      filename: srcFile("utils", "interactive.test.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_TEST_ONLY_NEW",
            configPath: "test.only.new",
          },
        },
      ],
    },
  ],
});

console.log("no-unregistered-minsky-env-var: all rule-tester cases pass");
