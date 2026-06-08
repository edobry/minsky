/**
 * @fileoverview ESLint rule to catch new `process.env.MINSKY_*` reads in src/
 * that are not registered in either `environmentMappings` (config-mapped) or
 * `HOOK_ONLY_ENV_VARS` (hook-only). Closes the ADD-side gap of the
 * env-var-namespace-conflict class (mt#1610, mt#1624, mt#1785).
 *
 * The Minsky env-var-to-config dot-path parser at
 * `packages/domain/src/configuration/sources/environment.ts` auto-converts every
 * `MINSKY_FOO_BAR` env var seen at boot into a `foo.bar` config-path write.
 * Any path the strict config schema doesn't know about throws a validation
 * error at root level (`Unrecognized key: "foo"`), failing the config loader
 * and crashing the container at boot. This rule prevents new `MINSKY_*`
 * reads from being added without explicit registration in one of the two
 * allowlists.
 *
 * The two valid registration paths:
 *   1. `environmentMappings` — the env var routes to a config path. Add the
 *      key + the dotted config path. The config schema must accept the path.
 *   2. `HOOK_ONLY_ENV_VARS` — the env var is process/hook-only and does NOT
 *      feed config. The dot-path parser will skip it.
 *
 * Tracking task: mt#1788. See bridge memory id
 * `0b361d17-cc83-41dc-a485-0002d7e41e94`.
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
 *   HOOK_ONLY_ENV_VARS:
 *     `  "MINSKY_FOO_BAR",` (Set member as string literal, with trailing comma)
 *     `  "MINSKY_FOO_BAR", // comment` (trailing inline comment, currently
 *       used by every entry in this file)
 *     `  "MINSKY_FOO_BAR"` (last entry, no trailing comma)
 *     Single OR double quotes for any of the above.
 *
 * On read failure (file missing, permission error, etc.) the function returns
 * an empty Set with a console warning — fail-soft so a misconfigured rule
 * doesn't break ESLint entirely.
 */
function buildRegisteredSet() {
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
        `Rule will flag every process.env.MINSKY_* read until the file is readable.`
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
        "Require every `process.env.MINSKY_*` read in src/ to be registered " +
        "in `environmentMappings` or `HOOK_ONLY_ENV_VARS` to prevent " +
        "env-var-namespace conflicts with the config-loader's dot-path parser " +
        "(mt#1610, mt#1624, mt#1785).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      unregistered: `process.env.{{name}} is not registered. Add it to either \`environmentMappings\` (config-mapped) or \`HOOK_ONLY_ENV_VARS\` (hook-only) at ${REGISTRATION_FILE_POSIX}, or rename it to NOT start with MINSKY_ to bypass the dot-path parser. Without registration the env-var-to-config parser auto-maps {{name}} to \`{{configPath}}\` which the strict schema rejects, crashing the container at boot. See mt#1788.`,
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
    //   override instructions would hit a hard CLI crash because the env var
    //   wasn't registered in HOOK_ONLY_ENV_VARS.
    //   See mt#1994 spec and `feedback_new_minsky_env_var_must_be_registered`.
    //
    // - .minsky/hooks/**/*.ts: mt#2304 extension. After moving hook sources to
    //   .minsky/hooks/ (canonical source location), the compiled .claude/hooks/
    //   outputs carry the same env var reads but authors write to .minsky/hooks/.
    //   Scanning the source location catches new hook-only env vars at authoring
    //   time before compile, matching the intent of mt#1994.
    const srcSegment = `${pathSep}src${pathSep}`;
    const claudeHooksSegment = `${pathSep}.claude${pathSep}hooks${pathSep}`;
    const minskyHooksSegment = `${pathSep}.minsky${pathSep}hooks${pathSep}`;
    const isTsFile = normalized.endsWith(".ts");
    const inSrc = normalized.includes(srcSegment);
    const inClaudeHooks = normalized.includes(claudeHooksSegment);
    const inMinskyHooks = normalized.includes(minskyHooksSegment);
    if (!isTsFile || (!inSrc && !inClaudeHooks && !inMinskyHooks)) {
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
        if (
          !obj ||
          obj.type !== "MemberExpression" ||
          obj.object.type !== "Identifier" ||
          obj.object.name !== "process" ||
          obj.property.type !== "Identifier" ||
          obj.property.name !== "env"
        ) {
          return;
        }
        const prop = node.property;
        // Skip computed access like process.env["MINSKY_FOO"] for now —
        // the bracket form is rare and dynamically computed; we'd need
        // string-literal narrowing. Bare-identifier access is the dominant
        // pattern and what the originating incidents involved.
        if (node.computed || prop.type !== "Identifier") return;

        const name = prop.name;
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
