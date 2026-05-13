/**
 * @fileoverview ESLint rule to catch new `process.env.MINSKY_*` reads in src/
 * that are not registered in either `environmentMappings` (config-mapped) or
 * `HOOK_ONLY_ENV_VARS` (hook-only). Closes the ADD-side gap of the
 * env-var-namespace-conflict class (mt#1610, mt#1624, mt#1785).
 *
 * The Minsky env-var-to-config dot-path parser at
 * `src/domain/configuration/sources/environment.ts` auto-converts every
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
import { dirname, resolve } from "node:path";

const REGISTRATION_FILE = "src/domain/configuration/sources/environment.ts";

/**
 * Build the set of registered MINSKY_* env-var names from both allowlists by
 * parsing the source text at rule-load time. Avoids importing the .ts file
 * directly (ESLint runs under Node which can't load TypeScript without a
 * loader).
 *
 * Patterns matched (anchored to the canonical structure of environment.ts):
 *   environmentMappings: `  MINSKY_FOO_BAR: "..."` (object key with colon)
 *   HOOK_ONLY_ENV_VARS:  `  "MINSKY_FOO_BAR",` (Set member as string literal)
 *
 * Both allowlists live in the same file. If the structure changes, this
 * extractor will quietly under-report and the rule will start false-positive
 * flagging registered names — which is conservative-loud (preferable to
 * silent under-flagging).
 */
function buildRegisteredSet() {
  // The rule file is at `eslint-rules/no-unregistered-minsky-env-var.js`;
  // resolve the env source relative to the project root (one level up).
  const ruleDir = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(ruleDir, "..", REGISTRATION_FILE);
  const text = readFileSync(sourcePath, "utf8");

  const registered = new Set();

  // environmentMappings keys: `  MINSKY_NAME: "..."` (bare-identifier key).
  // The dot-path parser only fires for MINSKY_-prefixed names.
  const mappingKeyRe = /^\s*(MINSKY_[A-Z0-9_]+)\s*:/gm;
  for (const m of text.matchAll(mappingKeyRe)) {
    registered.add(m[1]);
  }

  // HOOK_ONLY_ENV_VARS Set members: `  "MINSKY_NAME",` (string literal in
  // a Set constructor's array). Single OR double quotes.
  const setMemberRe = /^\s*["'](MINSKY_[A-Z0-9_]+)["']\s*,/gm;
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
      unregistered: `process.env.{{name}} is not registered. Add it to either \`environmentMappings\` (config-mapped) or \`HOOK_ONLY_ENV_VARS\` (hook-only) at ${REGISTRATION_FILE}, or rename it to NOT start with MINSKY_ to bypass the dot-path parser. Without registration the env-var-to-config parser auto-maps {{name}} to \`{{configPath}}\` which the strict schema rejects, crashing the container at boot. See mt#1788.`,
    },
  },

  create(context) {
    const filename = context.getFilename();

    // Scope per spec: lint src/**/*.ts only. Root-level config files like
    // drizzle.pg.config.ts have their own lifecycle (drizzle-kit migrate,
    // not the MCP boot path) and don't conflict with the env-var-to-config
    // parser at runtime.
    if (!filename.includes("/src/")) {
      return {};
    }

    // Don't lint the registration file itself — its `process.env.X` reads
    // are the loader machinery that consumes the allowlists.
    if (filename.endsWith(REGISTRATION_FILE)) {
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
        // Mirrors src/domain/configuration/sources/environment.ts logic:
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
