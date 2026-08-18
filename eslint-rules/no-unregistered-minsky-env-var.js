/**
 * @fileoverview ESLint rule to catch new `process.env.MINSKY_*` reads in src/
 * that are not registered in either `environmentMappings` (config-mapped) or
 * `HOOK_ONLY_ENV_VAR_CATEGORIES` (hook-only). Closes the ADD-side gap of the
 * env-var-namespace-conflict class (mt#1610, mt#1624, mt#1785).
 *
 * The Minsky env-var-to-config dot-path parser at
 * `packages/domain/src/configuration/sources/environment.ts` auto-converts every
 * `MINSKY_FOO_BAR` env var seen at boot into a `foo.bar` config-path write.
 * What an unregistered var COSTS depends on the derived path's top-level
 * segment, and the two cases differ sharply (measured mt#4223):
 *
 *   - UNDECLARED segment (`MINSKY_CDP_URL` -> `cdp.url`): the loader emits
 *     `Unrecognized top-level config key: cdp. These keys will be ignored.`
 *     and continues. Verified on the CLI entrypoint.
 *   - DECLARED segment: the value reaches a live config path. `MINSKY_GITHUB_TOKEN`
 *     derived `github.token` and was silently a third alias for the GitHub token
 *     beside the explicit GITHUB_TOKEN / GH_TOKEN mappings until mt#4223
 *     registered it. An unknown key inside a nested `z.strictObject` DOES still
 *     fail validation and take the loader down (mt#2452, `reviewer.app`).
 *
 * The hard boot crash this rule was filed against (mt#1785 `auto.migrate`,
 * mt#1994 `ack`) is REAL history, not a hypothetical — both were observed. The
 * top-level case has since softened to warn-and-ignore; the nested-strict case
 * has not. So the rule is not merely crash-prevention: it is what keeps a name
 * from silently acquiring a config meaning nobody declared. This rule prevents
 * new `MINSKY_*` reads from being added without explicit registration in one of
 * the two allowlists.
 *
 * The two valid registration paths:
 *   1. `environmentMappings` — the env var routes to a config path. Add the
 *      key + the dotted config path. The config schema must accept the path.
 *   2. `HOOK_ONLY_ENV_VAR_CATEGORIES` — the env var is process/hook-only and
 *      does NOT feed config. The dot-path parser will skip it. Add one line,
 *      `MINSKY_FOO_BAR: "<category>",`, choosing `operator-override` (a guard,
 *      gate or detector consults it as its OWN override), `test-fixture`, or
 *      `tunable`. `HOOK_ONLY_ENV_VARS` is DERIVED from that record's keys
 *      (mt#3882) and is not an edit target; `operator-override` additionally
 *      obliges an entry in `.minsky/hooks/known-override-env-vars.ts`, which
 *      `known-override-env-vars.test.ts` enforces by name.
 *
 * Tracking task: mt#1788. See bridge memory id
 * `0b361d17-cc83-41dc-a485-0002d7e41e94` — whose own "add the var to the
 * `HOOK_ONLY_ENV_VARS` set" recipe predates mt#3882; this header is the
 * current one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep as pathSep, normalize as pathNormalize } from "node:path";

const REGISTRATION_FILE_POSIX = "packages/domain/src/configuration/sources/environment.ts";
// OS-specific form for cross-platform endsWith() checks (PR #1089 R1 BLOCKING #1).
const REGISTRATION_FILE_NATIVE = REGISTRATION_FILE_POSIX.split("/").join(pathSep);

/**
 * Build the set of registered MINSKY_* env-var names from both allowlists by
 * parsing the source text at rule-load time. Avoids importing the .ts file
 * directly (ESLint runs under Node which can't load TypeScript without a
 * loader).
 *
 * Patterns matched (covers the canonical structure of environment.ts AND
 * tolerates Prettier reformat / quoted keys / inline comments / trailing-
 * comma omission per PR #1089 R1 BLOCKING #2 + #3):
 *   environmentMappings:
 *     `  MINSKY_FOO_BAR: "..."` (bare identifier key)
 *     `  "MINSKY_FOO_BAR": "..."` (quoted key — needed when name contains
 *       characters that aren't valid identifiers, OR when style mandates
 *       quoting)
 *   HOOK_ONLY_ENV_VAR_CATEGORIES (mt#3882 — a record keyed by var name;
 *   `HOOK_ONLY_ENV_VARS` is now derived from its keys):
 *     `  MINSKY_FOO_BAR: "operator-override",` — matched by mappingKeyRe,
 *       the SAME pattern that matches an environmentMappings key. The record
 *       shape is required for exactly this reason; see that constant's
 *       docblock in environment.ts.
 *   HOOK_ONLY_ENV_VARS (the pre-mt#3882 `new Set([...])` literal — kept
 *   because nothing guarantees no other Set-shaped allowlist appears here):
 *     `  "MINSKY_FOO_BAR",` (Set member as string literal, with trailing comma)
 *     `  "MINSKY_FOO_BAR", // comment` (trailing inline comment)
 *     `  "MINSKY_FOO_BAR"` (last entry, no trailing comma)
 *     Single OR double quotes for any of the above.
 *
 * Exported so `.minsky/hooks/known-override-env-vars.test.ts` can assert the
 * REAL extractor still resolves every registry entry (mt#3882 AT5). A copy of
 * these regexes in the test would be one more hand-maintained mirror, which is
 * the defect that task exists to retire.
 *
 * On read failure (file missing, permission error, etc.) the function returns
 * an empty Set with a console warning — fail-soft so a misconfigured rule
 * doesn't break ESLint entirely.
 */
export function buildRegisteredSet() {
  const registered = new Set();
  let text;
  try {
    // The rule file is at `eslint-rules/no-unregistered-minsky-env-var.js`;
    // resolve the env source relative to the project root (one level up).
    const ruleDir = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(ruleDir, "..", REGISTRATION_FILE_POSIX);
    text = readFileSync(sourcePath, "utf8");
  } catch (e) {
    // PR #1089 R1: guard the I/O so a missing/unreadable file doesn't crash
    // the entire ESLint run. Empty registry means the rule will conservatively
    // flag every MINSKY_* read — loud failure mode, easy to diagnose.
    console.warn(
      `[no-unregistered-minsky-env-var] could not read ${REGISTRATION_FILE_POSIX}: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        `Rule will flag every MINSKY_* env-var access until the file is readable.`
    );
    return registered;
  }

  // environmentMappings keys: bare or quoted identifier followed by colon.
  // The leading anchor allows for indentation; the optional quote wrapper
  // handles `"MINSKY_X": ...` shape (PR #1089 R1 BLOCKING #2).
  const mappingKeyRe = /^[ \t]*["']?(MINSKY_[A-Z0-9_]+)["']?[ \t]*:/gm;
  for (const m of text.matchAll(mappingKeyRe)) {
    registered.add(m[1]);
  }

  // HOOK_ONLY_ENV_VARS Set members: quoted string literal, trailing
  // comma OR end-of-input-relative-to-array. Lookahead allows `,`, end-of-
  // line (last entry without trailing comma), or comment markers.
  // (PR #1089 R1 BLOCKING #3.)
  const setMemberRe = /^[ \t]*["'](MINSKY_[A-Z0-9_]+)["'][ \t]*(?=,|\r?$|\/\/|\/\*)/gm;
  for (const m of text.matchAll(setMemberRe)) {
    registered.add(m[1]);
  }

  return registered;
}

const REGISTERED = buildRegisteredSet();

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every `MINSKY_*` env-var access in src/ and the hook trees to " +
        "be registered in `environmentMappings` or `HOOK_ONLY_ENV_VAR_CATEGORIES` " +
        "to prevent env-var-namespace conflicts with the config-loader's dot-path " +
        "parser (mt#1610, mt#1624, mt#1785). Matches accesses on `process.env` " +
        "AND on a bare object named `env` (the dependency-injected style in " +
        "src/mcp/**, mt#4217), in all statically-resolvable forms (mt#2324): " +
        'bare-identifier (env.MINSKY_FOO), string-literal bracket (env["MINSKY_FOO"]), ' +
        "and non-interpolated template-literal bracket (env[`MINSKY_FOO`]). " +
        "Dynamic computed access (variable key, interpolated template literal) " +
        "is not statically resolvable and is skipped, as is `delete env.MINSKY_FOO` " +
        "on a bare env (a scrub, not an introduction — `delete process.env.MINSKY_FOO` " +
        "still reports). Scans src/, .claude/hooks/, .minsky/hooks/ and scripts/ " +
        "(mt#4223); the services/* tree is excluded (independent deploy packages " +
        "with their own config loaders).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      unregistered: `{{name}} is not registered. Add it to either \`environmentMappings\` (config-mapped) or \`HOOK_ONLY_ENV_VAR_CATEGORIES\` (hook-only — one entry per line as \`{{name}}: "operator-override" | "test-fixture" | "tunable",\`; \`HOOK_ONLY_ENV_VARS\` is DERIVED from its keys and must not be edited directly) at ${REGISTRATION_FILE_POSIX}, or rename it to NOT start with MINSKY_ to bypass the dot-path parser. Without registration the env-var-to-config parser auto-maps {{name}} to \`{{configPath}}\` — if that path's top-level segment is DECLARED in the config schema the value silently becomes live config (mt#4223: MINSKY_GITHUB_TOKEN -> github.token), and an unknown key inside a strict object fails the loader outright (mt#2452). See mt#1788, mt#3882, mt#4217, mt#4223.`,
    },
  },

  create(context) {
    const filename = context.getFilename();
    // Normalize to native separators so includes()/endsWith() match on
    // Windows (PR #1089 R1 BLOCKING #1). Path.normalize collapses `..`
    // and rewrites separators to `path.sep`.
    const normalized = pathNormalize(filename);

    // Scope per spec: lint src/**/*.ts, .claude/hooks/**/*.ts, AND
    // .minsky/hooks/**/*.ts.
    //
    // - src/**/*.ts: original mt#1788 coverage. Root-level config files like
    //   drizzle.pg.config.ts have their own lifecycle (drizzle-kit migrate,
    //   not the MCP boot path) and don't conflict with the env-var-to-config
    //   parser at runtime. Both the path-segment match and the .ts extension
    //   are required (PR #1089 R1 BLOCKING #5 — without the extension check
    //   the rule was also firing on .js files under src/).
    //
    // - .claude/hooks/**/*.ts: mt#1994 extension. Hook-only override env vars
    //   (e.g., MINSKY_ACK_OOB_MERGE, MINSKY_FORCE_EDIT_GENERATED) have their
    //   only read site in hook files. Without scanning this directory, the rule
    //   missed the hook-only-override slice — operators following the documented
    //   override instructions hit a hard CLI crash (`Unrecognized key: "ack"`)
    //   because the env var wasn't registered in HOOK_ONLY_ENV_VARS. That crash
    //   was observed at the time; the top-level case has since softened to
    //   warn-and-ignore (see the module docblock's declared-vs-undeclared split,
    //   mt#4223), so a re-run today would warn rather than crash.
    //   See mt#1994 spec and `feedback_new_minsky_env_var_must_be_registered`.
    //
    // - .minsky/hooks/**/*.ts: mt#2304 extension. After moving hook sources to
    //   .minsky/hooks/ (canonical source location), the compiled .claude/hooks/
    //   outputs carry the same env var reads but authors write to .minsky/hooks/.
    //   Scanning the source location catches new hook-only env vars at authoring
    //   time before compile, matching the intent of mt#1994.
    //
    // - scripts/**/*.ts IS scanned as of mt#4223. This tree participates in the
    //   boot path the rule guards — `scripts/cli-entry.ts` SETS
    //   MINSKY_LOADED_COMMIT / MINSKY_RUN_MODE / MINSKY_PACKAGE_ROOT on the CLI's
    //   own environment before importing the bundle, and those three are
    //   registered for exactly that reason. mt#4217 shipped the matcher widening
    //   below plus the 16 dispositions it forced in src/ + packages/, and
    //   deferred this tree so 34 per-var classifications did not land in one
    //   review; mt#4223 closed it with the remaining 18.
    //
    //   What scanning `scripts/` actually buys is narrower than the boot-crash
    //   framing suggests, and worth stating so the next reader does not
    //   over-claim it (measured mt#4223): an unregistered var's consequence
    //   depends on whether its derived top-level segment is DECLARED in
    //   `configurationSchema`. `MINSKY_CDP_URL` derives `cdp.url` — undeclared,
    //   and the loader warns `Unrecognized top-level config key` and ignores it.
    //   `MINSKY_GITHUB_TOKEN` derives `github.token` — DECLARED and live, so it
    //   silently became a third alias for the GitHub token beside the explicit
    //   `GITHUB_TOKEN` / `GH_TOKEN` mappings. The declared-segment case is the
    //   one with teeth, and it is not visible from the var name alone, which is
    //   why the whole tree is scanned rather than a curated subset.
    //   (Bound: "warns and ignores" is verified on the CLI entrypoint; mt#2452
    //   shows an unknown key inside a nested z.strictObject DOES fail validation.)
    //
    //   This scope is per-RULE and deliberately does NOT match how other rules
    //   treat `scripts/` (PR #3094 R1). `eslint.config.js` turns `no-console` /
    //   `no-magic-numbers` OFF for `scripts/**` and exempts the tree from
    //   `no-raw-console`, because a CLI script SHOULD print to stdout — that is
    //   a statement about console usage, and carries no implication about env
    //   vars. This rule is ON here for an unrelated reason: the dot-path parser
    //   reads the process environment regardless of which tree the read site
    //   lives in, so the tree a var is read from has no bearing on whether its
    //   name acquires a config meaning. Two rules disagreeing about one
    //   directory is the scoping mechanism working, not a policy conflict.
    //
    //   Coverage is nonetheless the footgun this repo has hit twice
    //   (`require-hook-domain-bootstrap` mt#3178, `require-guard-outcome-in-fire-log`
    //   mt#3920): a tree present in the rule but not in `eslint.config.js`'s
    //   `files` glob is SILENTLY unenforced, and reports zero — indistinguishable
    //   from a clean tree. Verified empirically rather than by reading the config:
    //   a `process.env.MINSKY_DEFINITELY_NOT_REGISTERED` read added to
    //   `scripts/smoke-setup-db.ts` IS reported by a real `bunx eslint` run, and
    //   the tree is clean once removed.
    const srcSegment = `${pathSep}src${pathSep}`;
    const claudeHooksSegment = `${pathSep}.claude${pathSep}hooks${pathSep}`;
    const minskyHooksSegment = `${pathSep}.minsky${pathSep}hooks${pathSep}`;
    const servicesSegment = `${pathSep}services${pathSep}`;
    const scriptsSegment = `${pathSep}scripts${pathSep}`;
    const isTsFile = normalized.endsWith(".ts");
    const inSrc = normalized.includes(srcSegment);
    const inClaudeHooks = normalized.includes(claudeHooksSegment);
    const inMinskyHooks = normalized.includes(minskyHooksSegment);
    // services/*/** are independent deploy packages (reviewer, site) with their
    // OWN config loaders — requireEnv() / direct process.env reads, NOT the
    // main env-var-to-config dot-path parser. The MCP-boot-crash class this rule
    // guards does not apply to them, so a bracket-form read such as
    // services/reviewer/src/config.ts's `process.env["MINSKY_MCP_URL"]` must NOT
    // be forced into the MAIN allowlist (which would mislead readers into
    // thinking it is a main-config key). Exclude the services tree (mt#2324).
    // This matches the existing root-config exclusion rationale above — files
    // with their own lifecycle separate from the MCP boot path.
    const inServices = normalized.includes(servicesSegment);
    const inScripts = normalized.includes(scriptsSegment);
    // mt#2304: scan .minsky/hooks/ (canonical hook source) in addition to
    // src/ and .claude/hooks/, so new hook-only env vars are caught at authoring
    // time. mt#2324: but never the services/ tree (own config loaders).
    if (!isTsFile || (!inSrc && !inClaudeHooks && !inMinskyHooks && !inScripts) || inServices) {
      return {};
    }

    // Don't lint the registration file itself — its `process.env.X` reads
    // are the loader machinery that consumes the allowlists.
    if (normalized.endsWith(REGISTRATION_FILE_NATIVE)) {
      return {};
    }

    return {
      // Match: process.env.MINSKY_FOO_BAR (MemberExpression where
      // .object is process.env and .property is an Identifier starting
      // with MINSKY_).
      MemberExpression(node) {
        const obj = node.object;
        if (!obj) return;

        // `process.env.MINSKY_FOO` — the original mt#1788 shape.
        const isProcessEnv =
          obj.type === "MemberExpression" &&
          obj.object.type === "Identifier" &&
          obj.object.name === "process" &&
          obj.property.type === "Identifier" &&
          obj.property.name === "env";

        // `env.MINSKY_FOO` — a bare member access on a parameter or local named
        // `env` (mt#4217). This is the dominant style in `src/mcp/**`, where the
        // process environment is dependency-injected for testability, and it was
        // invisible to this rule for as long as the rule existed: 10 vars
        // accumulated unregistered, nine of them the memory-ceiling /
        // orphan-exit family, in a tree the rule was already scanning.
        //
        // Keyed on the OBJECT's identifier name plus the `MINSKY_` property
        // prefix rather than on any type information — an object named `env`
        // carrying a `MINSKY_`-prefixed key is a process-environment map in
        // every occurrence measured in this repo. Deliberately does NOT reach
        // `someObj.env.MINSKY_FOO`; no such site exists today, and matching a
        // nested shape would widen the false-positive surface without evidence.
        const isBareEnv = obj.type === "Identifier" && obj.name === "env";

        if (!isProcessEnv && !isBareEnv) return;

        // `delete env.MINSKY_FOO` is neither a read nor a write of a VALUE: it
        // scrubs an inherited variable out of an env object before that object
        // is handed to a child process, so the dot-path parser never sees the
        // name and no registration is implied. Two smoke scripts do exactly
        // this with MINSKY_PERSISTENCE_POSTGRES_CONNECTIONSTRING, which is why
        // that name is absent from the registrations this rule change forced.
        //
        // Scoped to the BARE-`env` path on purpose (PR #3077 R1). Applying it to
        // `process.env` too — which is what the first revision did, by placing
        // this check after the shared gate — would have silently stopped flagging
        // `delete process.env.MINSKY_FOO`, a shape this rule has always reported.
        // That is a behavior change to the pre-existing path with no evidence
        // behind it: the only `delete` sites measured in this repo are on an env
        // object destined for a CHILD process, and deleting from the CURRENT
        // process's own `process.env` is a different act this task never studied.
        // Preserving prior behavior is the conservative default; widening it, if
        // ever wanted, belongs in a change that measures those sites.
        if (
          isBareEnv &&
          node.parent &&
          node.parent.type === "UnaryExpression" &&
          node.parent.operator === "delete"
        ) {
          return;
        }

        const prop = node.property;
        // Resolve the env-var NAME from the property node (mt#2324). All
        // STATICALLY-resolvable forms are covered:
        //   - bare-identifier access      process.env.MINSKY_FOO    → prop.name
        //   - string-literal bracket      process.env["MINSKY_FOO"] → prop.value
        //     (both single- and double-quoted literals)
        //   - non-interpolated template   process.env[`MINSKY_FOO`] → the cooked
        //     literal bracket               quasi (zero expressions)
        // Genuinely DYNAMIC computed access — process.env[someVar],
        // process.env[`MINSKY_${x}`] (interpolated template literal) — cannot be
        // resolved statically and is intentionally skipped.
        let name;
        if (!node.computed && prop.type === "Identifier") {
          name = prop.name;
        } else if (node.computed && prop.type === "Literal" && typeof prop.value === "string") {
          name = prop.value;
        } else if (
          node.computed &&
          prop.type === "TemplateLiteral" &&
          prop.expressions.length === 0 &&
          prop.quasis.length === 1
        ) {
          const cooked = prop.quasis[0].value.cooked;
          if (typeof cooked !== "string") return;
          name = cooked;
        } else {
          return;
        }
        if (!name.startsWith("MINSKY_")) return;
        if (REGISTERED.has(name)) return;

        // Compute the dot-path the loader would auto-map this to, so the
        // operator can see the exact key the config schema would reject.
        // Mirrors packages/domain/src/configuration/sources/environment.ts logic:
        // `MINSKY_FOO_BAR_BAZ` → `foo.bar.baz`.
        const configPath = name
          .replace(/^MINSKY_/, "")
          .toLowerCase()
          .split("_")
          .join(".");

        context.report({
          node: prop,
          messageId: "unregistered",
          data: { name, configPath },
        });
      },
    };
  },
};
