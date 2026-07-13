/**
 * @fileoverview Tests for no-unregistered-minsky-env-var ESLint rule (mt#1788).
 *
 * The rule reads the canonical allowlists by parsing the source text of
 * `packages/domain/src/configuration/sources/environment.ts` at rule-load time. The
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

function claudeHookFile(...parts) {
  return path.join(repoRoot, ".claude", "hooks", ...parts);
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
    // — its reads are loader machinery. (Path is the post-monorepo location
    // `packages/domain/src/...`, matching REGISTRATION_FILE_POSIX in the rule;
    // the pre-monorepo `src/domain/...` path no longer matches the exemption.)
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_NAME;",
      filename: path.join(
        repoRoot,
        "packages",
        "domain",
        "src",
        "configuration",
        "sources",
        "environment.ts"
      ),
    },
    // mt#2324: dynamically-computed access via a VARIABLE key cannot be
    // resolved statically, so it is still NOT flagged.
    {
      code: "const key = makeKey(); const v = process.env[key];",
      filename: srcFile("utils", "dynamic.ts"),
    },
    // mt#2324: template-literal computed access (with interpolation) is also
    // not statically resolvable → not flagged.
    {
      code: "const v = process.env[`MINSKY_${suffix}`];",
      filename: srcFile("utils", "dynamic.ts"),
    },
    // mt#2324: a REGISTERED env var read via the static-literal BRACKET form
    // passes — registration is what matters, not the access syntax.
    {
      code: 'if (process.env["MINSKY_FORCE_PARALLEL"] === "1") {}',
      filename: srcFile("utils", "guard.ts"),
    },
    // mt#2324: a REGISTERED env var read via a non-interpolated TEMPLATE-LITERAL
    // bracket also passes (statically resolvable, but registered).
    {
      code: "if (process.env[`MINSKY_FORCE_PARALLEL`] === `1`) {}",
      filename: srcFile("utils", "guard.ts"),
    },
    // PR #1089 R1 BLOCKING #5: only .ts files in src/ are linted; .js files
    // (rare in src/ but possible for transitional/generated content) are out
    // of scope per spec.
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_NAME;",
      filename: srcFile("legacy", "loader.js"),
    },
    // mt#1994: .claude/hooks/**/*.ts is in scope. Registered env vars pass.
    {
      code: 'if (process.env.MINSKY_ACK_OOB_MERGE === "1") {}',
      filename: claudeHookFile("block-out-of-band-merge.ts"),
    },
    {
      code: 'const skip = process.env.MINSKY_SKIP_SKILL_STALENESS === "1";',
      filename: claudeHookFile("skill-staleness-detector.ts"),
    },
    // mt#1994: .js files in .claude/hooks/ are out of scope (consistent with
    // the src/ extension-gate — only .ts files are linted).
    {
      code: "const v = process.env.MINSKY_TOTALLY_BOGUS_HOOK_NAME;",
      filename: claudeHookFile("legacy-hook.js"),
    },
    // mt#1994: files outside both src/ AND .claude/hooks/ remain out of scope.
    // (e.g., scripts/, services/, .github/workflows/ — those have their own
    // boot lifecycles separate from the MCP config loader.)
    {
      code: "const v = process.env.MINSKY_OUT_OF_SCOPE_FOR_SCRIPTS;",
      filename: path.join(repoRoot, "scripts", "deploy.ts"),
    },
    // mt#2324: services/*/src/** are independent deploy packages (reviewer,
    // site) with their OWN config loaders (requireEnv / direct reads, no
    // dot-path parser). Even though the path contains `/src/`, the services
    // tree is excluded — an unregistered bracket read there is NOT flagged.
    {
      code: 'const v = process.env["MINSKY_MCP_URL"];',
      filename: path.join(repoRoot, "services", "reviewer", "src", "config.ts"),
    },
    {
      code: "const v = process.env.MINSKY_REVIEWER_SERVICE_ONLY_VAR;",
      filename: path.join(repoRoot, "services", "site", "src", "logger.ts"),
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
    // mt#2324: unregistered static-literal BRACKET access fires (double-quote).
    {
      code: 'const v = process.env["MINSKY_BRACKET_UNREGISTERED"];',
      filename: srcFile("utils", "bracket.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_BRACKET_UNREGISTERED",
            configPath: "bracket.unregistered",
          },
        },
      ],
    },
    // mt#2324: single-quoted literal bracket access fires too.
    {
      code: "const v = process.env['MINSKY_BRACKET_SINGLE'];",
      filename: srcFile("utils", "bracket.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_BRACKET_SINGLE",
            configPath: "bracket.single",
          },
        },
      ],
    },
    // mt#2324: unregistered NON-INTERPOLATED template-literal bracket fires —
    // it is statically resolvable, analogous to a string literal.
    {
      code: "const v = process.env[`MINSKY_TEMPLATE_UNREGISTERED`];",
      filename: srcFile("utils", "bracket.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_TEMPLATE_UNREGISTERED",
            configPath: "template.unregistered",
          },
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
    // mt#1994: unregistered env var read in a .claude/hooks/ file fires. This
    // is the regression-anchor case — without this rule extension, a future
    // hook author could introduce a `process.env.MINSKY_NEW_OVERRIDE` read in
    // a hook file and the operator following the override-set instructions
    // would hit a CLI boot crash because the env-var-to-config dot-path parser
    // doesn't know to skip it.
    {
      code: 'if (process.env.MINSKY_NEWLY_INTRODUCED_HOOK_VAR === "1") {}',
      filename: claudeHookFile("new-hook-with-override.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_NEWLY_INTRODUCED_HOOK_VAR",
            configPath: "newly.introduced.hook.var",
          },
        },
      ],
    },
  ],
});

console.log("no-unregistered-minsky-env-var: all rule-tester cases pass");
