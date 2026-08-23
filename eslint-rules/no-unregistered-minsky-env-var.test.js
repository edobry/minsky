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
    // mt#4223: a REGISTERED name under `scripts/` passes. The tree is now
    // scanned (the out-of-scope case that used to sit here moved to `invalid`
    // below, as its mt#4217 note said it would), so a valid case is needed here
    // to show the filter admits the tree rather than merely reporting in it.
    {
      code: "const v = process.env.MINSKY_LOADED_COMMIT;",
      filename: path.join(repoRoot, "scripts", "cli-entry.ts"),
    },
    // Files outside src/, the two hook trees AND scripts/ remain out of scope.
    {
      code: "const v = process.env.MINSKY_OUT_OF_SCOPE_ENTIRELY;",
      filename: path.join(repoRoot, "docs", "example.ts"),
    },
    // mt#4217: a bare `env.MINSKY_FOO` member access on a REGISTERED name passes
    // — the widened matcher keys on registration, not on the access shape.
    {
      code: 'function f(env) { return env.MINSKY_FORCE_PARALLEL === "1"; }',
      filename: srcFile("mcp", "orphan-exit.ts"),
    },
    // mt#4217: `delete env.MINSKY_FOO` is a SCRUB, not a read or a write of a
    // value — it removes an inherited variable before the env object is handed
    // to a child process, so the dot-path parser never sees the name and no
    // registration is implied. Two smoke scripts do exactly this.
    {
      code: "function f(env) { delete env.MINSKY_NEVER_REGISTERED_SCRUB; }",
      filename: srcFile("mcp", "scrub.ts"),
    },
    // PR #3077 R1: the same carve-out on the BRACKET form of a bare `env`.
    {
      code: 'function f(env) { delete env["MINSKY_NEVER_REGISTERED_SCRUB_BRACKET"]; }',
      filename: srcFile("mcp", "scrub.ts"),
    },
    // mt#4217: the widening deliberately does NOT reach a nested `x.env.MINSKY_*`
    // shape. No such site exists in the repo, and matching it would widen the
    // false-positive surface with no evidence to justify it.
    {
      code: "const v = deps.env.MINSKY_NESTED_SHAPE_UNREGISTERED;",
      filename: srcFile("mcp", "nested.ts"),
    },
    // mt#4217: a bare `env` object with a non-MINSKY_ property is untouched.
    {
      code: "function f(env) { return env.HOME; }",
      filename: srcFile("mcp", "paths.ts"),
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
    // mt#4223: the scan-path widening. This is the case that used to sit in
    // `valid` asserting `scripts/` was out of scope — flipped here, which is the
    // fixture proving the filter admits the tree. Its derived path is also the
    // benign shape: `out.of.scope.for.scripts` has an undeclared top-level
    // segment, so the loader would warn and ignore it rather than crash. The
    // rule reports it anyway, because whether a segment is declared is not
    // visible from the var name.
    {
      code: "const v = process.env.MINSKY_OUT_OF_SCOPE_FOR_SCRIPTS;",
      filename: path.join(repoRoot, "scripts", "deploy.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_OUT_OF_SCOPE_FOR_SCRIPTS",
            configPath: "out.of.scope.for.scripts",
          },
        },
      ],
    },
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
    // mt#4217 regression anchor — the shape that was invisible for the rule's
    // whole life. `src/mcp/**` dependency-injects the process environment for
    // testability, so its reads are `env.MINSKY_FOO`, not
    // `process.env.MINSKY_FOO`. The rule scanned those files the entire time and
    // matched nothing in them: 16 vars accumulated unregistered across `src/` and
    // `packages/`, nine of them the memory-ceiling / orphan-exit family.
    {
      code: 'function wire(env) { if (env.MINSKY_BARE_ENV_UNREGISTERED === "1") return; }',
      filename: srcFile("mcp", "orphan-exit.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_BARE_ENV_UNREGISTERED",
            configPath: "bare.env.unregistered",
          },
        },
      ],
    },
    // mt#4217: the bracket form on a bare `env` fires too — the same three
    // static-resolution paths mt#2324 added for `process.env` apply here.
    {
      code: 'function wire(env) { return env["MINSKY_BARE_BRACKET_UNREGISTERED"]; }',
      filename: srcFile("mcp", "bracket.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_BARE_BRACKET_UNREGISTERED",
            configPath: "bare.bracket.unregistered",
          },
        },
      ],
    },
    // PR #3077 R1 regression anchor: `delete process.env.MINSKY_FOO` STILL fires.
    //
    // The `delete` carve-out mt#4217 added is scoped to the bare-`env` path. The
    // first revision of that change placed the check after the shared
    // process-env/bare-env gate, which silently stopped flagging this shape — a
    // behavior change to a path this rule has always covered, invisible to the
    // negative control because no case pinned it. The reviewer caught it; this
    // case is why it cannot recur.
    {
      code: "delete process.env.MINSKY_DELETE_ON_PROCESS_ENV;",
      filename: srcFile("utils", "reset.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_DELETE_ON_PROCESS_ENV",
            configPath: "delete.on.process.env",
          },
        },
      ],
    },
    // PR #3077 R2: the BRACKET form of the same anchor. Worth its own case rather
    // than assumed-covered — the bracket form is precisely the shape whose
    // absence made this task's own measurements wrong twice, so "the dot form is
    // pinned, the bracket form must be too" is the one inference this file should
    // not be making on trust.
    {
      code: 'delete process.env["MINSKY_DELETE_ON_PROCESS_ENV_BRACKET"];',
      filename: srcFile("utils", "reset.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_DELETE_ON_PROCESS_ENV_BRACKET",
            configPath: "delete.on.process.env.bracket",
          },
        },
      ],
    },
    // mt#4217: a WRITE to a bare env object fires — setting a MINSKY_* name on an
    // env destined for a child process is exactly how the child's config loader
    // comes to parse it. Contrast the `delete` case in `valid` above, which
    // removes rather than introduces a name.
    {
      code: 'function spawn(env) { env.MINSKY_BARE_ENV_WRITE = "1"; }',
      filename: srcFile("mcp", "spawn.ts"),
      errors: [
        {
          messageId: "unregistered",
          data: {
            name: "MINSKY_BARE_ENV_WRITE",
            configPath: "bare.env.write",
          },
        },
      ],
    },
  ],
});

console.log("no-unregistered-minsky-env-var: all rule-tester cases pass");
