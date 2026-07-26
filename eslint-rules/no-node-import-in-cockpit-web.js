/**
 * @fileoverview Flag VALUE imports of Node-only modules from `src/cockpit/web/**` (mt#3239).
 *
 * Originating incident: mt#3215 (PR #2315) added
 * `import { isAutomatedClosureResponder } from "@minsky/domain/ask/close-as-resolved"` to
 * `AskPage.tsx`. That domain module imports `@minsky/shared/logger`, whose top-level code reads
 * `process.env.*` — a Node global with no browser equivalent. The browser-bundled cockpit page
 * crashed with `Can't find variable: process` on load. Nothing caught this pre-merge: the file
 * typechecks (types don't know or care whether `process` exists at runtime), lints clean (no
 * existing rule inspects import *targets* for Node-only reach), and its own component test
 * passed (it runs under Bun, where `process` is defined) — only a human loading the page in an
 * actual browser found it.
 *
 * This rule closes the DIRECT half of that gap: it flags any VALUE (non-type) import in a
 * cockpit web file whose source specifier is one of `bannedExact` or starts with one of
 * `bannedPrefixes` + "/". `import type` declarations and inline `import { type X }` specifiers
 * are always allowed — those are erased at build time and carry no runtime module-graph cost, so
 * banning them would produce false positives against the many existing (and legitimate)
 * `import type { X } from "@minsky/domain/..."` usages already in `src/cockpit/web/**`.
 *
 * Coverage — stated honestly, not implied: this rule only catches a DIRECT banned import. It
 * does NOT walk the transitive import graph. A cockpit web file that imports a
 * `@minsky/domain/*` (or other non-banned) module which ITSELF transitively imports
 * `@minsky/shared/logger` two or more hops away is NOT caught. The mt#3239 fix moved the specific
 * predicate this incident needed (`isAutomatedClosureResponder`) into a browser-safe module
 * (`@minsky/shared/ask-closure`) precisely so cockpit code has a safe import to reach for instead
 * of routing through `@minsky/domain` at all; this rule is the mechanical backstop that fails the
 * build the next time someone reaches for the Node path directly, not a guarantee against every
 * possible transitive reintroduction.
 *
 * Reference: mt#3239 (this rule), mt#3215 (the behavioral fix whose delivery this repairs),
 * `packages/shared/src/ask-approval.ts` (mt#3203, the browser-safe-module precedent).
 *
 * ## `allowedExact` — why a broad `@minsky/domain` prefix ban needs an escape hatch
 *
 * `src/cockpit/web/**` has several PRE-EXISTING, already-working VALUE imports of specific
 * `@minsky/domain/*` submodules (e.g. `@minsky/domain/ask/state-machine`'s `isTerminal`,
 * `@minsky/domain/transcripts/event-schema`'s `EVENT_REALMS`) that were spot-checked at mt#3239
 * authoring time and confirmed to have zero Node dependencies one hop deep. Banning
 * `@minsky/domain` as a whole prefix (the honest, defense-in-depth default — ANY domain submodule
 * could grow a Node import later, exactly like `close-as-resolved.ts` did) would otherwise flag
 * this already-safe, already-shipped code as a lint error with no code change involved — a false
 * positive that would have blocked THIS very fix from landing cleanly. `allowedExact` is a
 * narrow, explicit, reviewed list of exact specifiers exempted from the `bannedPrefixes` match
 * (never from `bannedExact` — `@minsky/shared/logger` itself can never be allowlisted). Adding an
 * entry here is a decision, not a lint tweak: verify the target module (and, ideally, its direct
 * imports) has no Node dependency before adding it, the same spot-check this rule's own authoring
 * did. An allowlisted module that LATER grows a Node import is not caught by this rule — that
 * gap is real and is part of the transitive-coverage limitation stated above, not a contradiction
 * of it.
 */

/** True when an import/specifier is TypeScript type-only (erased at build time). */
function isTypeOnly(node) {
  return node && node.importKind === "type";
}

/** True when `spec` matches one of the exact-banned or prefix-banned specifiers, and is not
 * exempted via `allowedExact`. `bannedExact` always wins over `allowedExact` — an exact-banned
 * specifier (e.g. the logger itself) can never be exempted through the allowlist. */
function isBannedSpecifier(spec, bannedExact, bannedPrefixes, allowedExact) {
  if (bannedExact.includes(spec)) return true;
  if (allowedExact.includes(spec)) return false;
  return bannedPrefixes.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow VALUE imports of Node-only modules (@minsky/domain, @minsky/shared/logger) from cockpit web files",
      category: "Possible Errors",
      recommended: false,
      url: "https://github.com/edobry/minsky/blob/main/eslint-rules/no-node-import-in-cockpit-web.js",
    },
    schema: [
      {
        type: "object",
        properties: {
          bannedExact: {
            type: "array",
            items: { type: "string" },
            description: "Import specifiers banned by exact match (e.g. '@minsky/shared/logger').",
          },
          bannedPrefixes: {
            type: "array",
            items: { type: "string" },
            description:
              "Import specifier prefixes banned as themselves or with a '/' subpath (e.g. '@minsky/domain').",
          },
          allowedExact: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact specifiers exempted from a bannedPrefixes match (never from bannedExact). Use for spot-checked, already-Node-free submodules under a banned prefix.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bannedNodeImport:
        "'{{spec}}' is a Node-only module (or reaches one transitively) and cannot be evaluated in the browser-bundled cockpit — see mt#3239. Use a browser-safe module instead (e.g. packages/shared/src/ask-approval.ts, packages/shared/src/ask-closure.ts). If you only need TYPES, use `import type` — it is erased at build time and not flagged by this rule.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const bannedExact = Array.isArray(options.bannedExact) ? options.bannedExact : [];
    const bannedPrefixes = Array.isArray(options.bannedPrefixes) ? options.bannedPrefixes : [];
    const allowedExact = Array.isArray(options.allowedExact) ? options.allowedExact : [];

    if (bannedExact.length === 0 && bannedPrefixes.length === 0) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (!node.source || typeof node.source.value !== "string") return;
        const spec = node.source.value;
        if (!isBannedSpecifier(spec, bannedExact, bannedPrefixes, allowedExact)) return;

        // Whole-declaration type import (`import type { X } from "..."` or
        // `import type X from "..."`) is fully erased — never flagged.
        if (isTypeOnly(node)) return;

        // Side-effect-only import (`import "@minsky/domain/..."`) has no
        // specifiers to check for type-only-ness — it always runs the module.
        if (node.specifiers.length === 0) {
          context.report({ node, messageId: "bannedNodeImport", data: { spec } });
          return;
        }

        // Named/default/namespace specifiers: flag only if at least one is a
        // VALUE binding. `import { type Foo, bar } from "..."` is flagged
        // (because of `bar`); `import { type Foo, type Baz } from "..."` is not.
        const hasValueSpecifier = node.specifiers.some((specifier) => !isTypeOnly(specifier));
        if (hasValueSpecifier) {
          context.report({ node, messageId: "bannedNodeImport", data: { spec } });
        }
      },
      ImportExpression(node) {
        // Dynamic imports — only string-literal specifiers are checkable
        // statically. No type-only concept applies to `import()` expressions.
        if (
          node.source &&
          node.source.type === "Literal" &&
          typeof node.source.value === "string"
        ) {
          const spec = node.source.value;
          if (isBannedSpecifier(spec, bannedExact, bannedPrefixes, allowedExact)) {
            context.report({ node, messageId: "bannedNodeImport", data: { spec } });
          }
        }
      },
    };
  },
};
