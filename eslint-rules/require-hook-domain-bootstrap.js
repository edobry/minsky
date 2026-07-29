/**
 * @fileoverview Require the shared domain bootstrap in any hook that reaches
 * the persistence layer (mt#3046, the structural fix for the mt#3019 class).
 *
 * A hook process is its OWN entry point. It inherits nothing from `cli.ts` or
 * the MCP server boot, and two things are mandatory before ANY domain import
 * that leads to the persistence factory:
 *
 *   1. `reflect-metadata` — domain classes reached through the factory are
 *      `@injectable()`, so the IMPORT of `packages/domain/src/persistence/factory`
 *      throws `tsyringe requires a reflect polyfill`.
 *   2. Domain configuration — `PersistenceService.initialize()` throws
 *      "Configuration not initialized" without it.
 *
 * Both live in `.minsky/hooks/domain-bootstrap.ts`'s `ensureHookDomainBootstrap()`.
 *
 * WHY A LINT RULE AND NOT A RUNTIME SMOKE TEST (mt#3046 planning, 2026-07-22).
 * The original proposal was to spawn each hook and assert no bootstrap-class
 * message on stderr. Measuring the tree falsified that design:
 *
 *   - All 81 hook module graphs import cleanly in a bare Bun process — the
 *     failure is NOT at module load, so a static-import probe finds nothing.
 *   - The failure lives behind a DYNAMIC import inside a function that only
 *     runs on the production path, and it is SWALLOWED. The second live
 *     instance found (`post-merge-unasked-direction-scan.ts`'s `loadTranscript`)
 *     wraps it in `catch { return null }` and emits nothing at all. A stderr
 *     assertion reports PASS on a hook that is 100% dead.
 *
 * The invariant is checkable statically — "a hook that references the
 * persistence layer must also import the bootstrap" — and unlike a runtime
 * probe it cannot be defeated by a swallowed error, needs no live database,
 * and fires at authoring time instead of after merge.
 *
 * Coverage model (mirrors `no-entity-id-param-drift`, mt#2780): the
 * `eslint.config.js` block enumerates the covered glob — config, not
 * path-parsing, is the scoping mechanism. The path check below is
 * defense-in-depth for direct/RuleTester invocations.
 *
 * Conservatism: only files under a declared ENTRY-POINT ROOT are considered
 * (`.minsky/hooks/` and `scripts/` — see `ENTRY_POINT_ROOTS_POSIX`); `.test.ts`
 * siblings are exempt (a test is not an entry point and legitimately
 * names these symbols in assertions), and `domain-bootstrap` itself is exempt
 * because it IS the bootstrap.
 *
 * Precedents: `custom/no-unregistered-minsky-env-var` (mt#1788),
 * `custom/no-entity-id-param-drift` (mt#2780).
 */

import { sep as pathSep } from "node:path";

/**
 * Entry-point roots subject to the invariant (mt#3046 hooks; mt#3178 scripts).
 *
 * This list must stay in sync with the `files` glob of the
 * `require-hook-domain-bootstrap` block in `eslint.config.js`. Config is the
 * scoping mechanism; this is the defense-in-depth companion for direct and
 * RuleTester invocations, so a root present in the config glob but ABSENT here
 * silently disables the rule for that tree — which is exactly the defect
 * mt#3178 hit: widening the config glob alone was a no-op because this guard
 * still rejected every `scripts/**` file.
 */
const ENTRY_POINT_ROOTS_POSIX = [".minsky/hooks", "scripts"];

/**
 * Symbols whose presence means this file reaches the persistence layer.
 * `resolvePersistenceProvider` is the hook-facing convenience helper;
 * `PersistenceService` is the class underneath it; `getDatabaseConnection` is
 * the capability every DB-touching caller invokes on the resolved provider.
 */
const PERSISTENCE_SYMBOLS = new Set([
  "resolvePersistenceProvider",
  "PersistenceService",
  "getDatabaseConnection",
]);

/**
 * Module specifiers that lead to the persistence layer. Matched as a suffix so
 * both the static `../../packages/domain/src/persistence/factory` form and any
 * future alias land the same way.
 */
const PERSISTENCE_MODULE_SUFFIXES = ["persistence/factory", "persistence/service"];

/**
 * The bootstrap module, matched as a specifier suffix (`./domain-bootstrap`).
 *
 * Note there is deliberately no companion SYMBOL constant: satisfaction is
 * determined by the IMPORT alone, never by a reference to
 * `ensureHookDomainBootstrap` — see the Identifier handler for why.
 */
const BOOTSTRAP_MODULE_SUFFIX = "domain-bootstrap";

/**
 * The bare tsyringe reflect polyfill (mt#3178).
 *
 * `.minsky/hooks/**` and `scripts/**` satisfy this invariant DIFFERENTLY, and
 * the asymmetry is deliberate:
 *
 *  - A **hook** must import `ensureHookDomainBootstrap`, which does BOTH halves
 *    (reflect polyfill + domain configuration init). A hook that imported only
 *    the polyfill would still resolve a null provider — the mt#3019 failure —
 *    so the polyfill alone must NOT satisfy the invariant there.
 *  - A **script** conventionally does the two halves inline: a static
 *    `import "reflect-metadata"` followed by `initializeConfiguration` /
 *    `setupConfiguration` / `createCliContainer`. Measured 2026-07-28: 29 of
 *    the 31 `scripts/**` files this rule flags already do exactly that, and are
 *    correctly bootstrapped. Requiring them to import a helper out of the
 *    `.minsky/hooks/` tree would be pure churn in an odd dependency direction.
 *
 * Accepting the polyfill for scripts still catches the incident that motivated
 * the widening: mt#3176's `verify-conversation-run-state.ts` had NO
 * `reflect-metadata` import and died on the polyfill before its first DB
 * assertion.
 *
 * STATIC imports only — see the ImportDeclaration handler. A dynamic
 * `await import("reflect-metadata")` does not reliably precede the domain
 * imports it must precede, so it does not satisfy the invariant.
 */
const REFLECT_POLYFILL_SPECIFIER = "reflect-metadata";

/** Entry-point roots whose convention accepts a bare static reflect polyfill. */
const REFLECT_POLYFILL_ROOTS_POSIX = ["scripts"];

function toPosix(filename) {
  return filename.split(pathSep).join("/");
}

/** Does this file's entry-point root accept a bare static reflect polyfill? */
function rootAcceptsReflectPolyfill(filename) {
  const normalized = toPosix(filename);
  return REFLECT_POLYFILL_ROOTS_POSIX.some((root) => normalized.includes(`${root}/`));
}

/** Is this file an entry-point source file subject to the invariant? */
function isCoveredEntryPointFile(filename) {
  const normalized = toPosix(filename);
  if (!ENTRY_POINT_ROOTS_POSIX.some((root) => normalized.includes(`${root}/`))) return false;
  // A test is not an entry point; it may name these symbols in assertions.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  // The bootstrap module itself cannot import itself.
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base.replace(/\.[cm]?[jt]sx?$/, "") === BOOTSTRAP_MODULE_SUFFIX) return false;
  return true;
}

/** String value of an import source / dynamic-import argument, or null. */
function sourceValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  // A template literal with no substitutions is still a static specifier.
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function isPersistenceSpecifier(value) {
  return value != null && PERSISTENCE_MODULE_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function isBootstrapSpecifier(value) {
  if (value == null) return false;
  const withoutExt = value.replace(/\.[cm]?[jt]sx?$/, "");
  return withoutExt.endsWith(BOOTSTRAP_MODULE_SUFFIX);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require ensureHookDomainBootstrap in any entry-point file (.minsky/hooks, scripts) that reaches the persistence layer (mt#3046; the mt#3019 dead-DB-path class)",
    },
    schema: [],
    messages: {
      missingBootstrap:
        "This entry point reaches the persistence layer ({{trigger}}) without importing `ensureHookDomainBootstrap` from './domain-bootstrap'. A hook or script is its own entry point: without the bootstrap the domain import throws (tsyringe reflect polyfill) or the provider resolves to null (configuration not initialized), and the failure is typically swallowed — the entry point silently does nothing. See mt#3019 (hook) and mt#3176 (script).",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isCoveredEntryPointFile(filename)) return {};

    const acceptsReflectPolyfill = rootAcceptsReflectPolyfill(filename);

    let hasBootstrapImport = false;
    /** First node that proves this file reaches persistence, plus what proved it. */
    let trigger = null;

    function noteTrigger(node, description) {
      if (!trigger) trigger = { node, description };
    }

    return {
      ImportDeclaration(node) {
        const value = sourceValue(node.source);
        if (isBootstrapSpecifier(value)) {
          // Only an IMPORT satisfies the invariant. Requiring the specifier
          // too would reject `import "./domain-bootstrap"` for its polyfill
          // side effect, which is a legitimate (if unusual) way to satisfy
          // layer 1.
          hasBootstrapImport = true;
          return;
        }
        // Per-root alternative (mt#3178): a script's static reflect polyfill.
        // Deliberately NOT mirrored in ImportExpression — a dynamic polyfill
        // import does not reliably precede the domain imports it must precede.
        if (acceptsReflectPolyfill && value === REFLECT_POLYFILL_SPECIFIER) {
          hasBootstrapImport = true;
          return;
        }
        if (isPersistenceSpecifier(value)) {
          noteTrigger(node, `static import of '${value}'`);
        }
      },

      // `await import("../../packages/domain/src/persistence/factory")` — the
      // form the real defect took in both known instances.
      ImportExpression(node) {
        const value = sourceValue(node.source);
        if (isBootstrapSpecifier(value)) {
          hasBootstrapImport = true;
          return;
        }
        if (isPersistenceSpecifier(value)) {
          noteTrigger(node, `dynamic import of '${value}'`);
        }
      },

      // Catches a persistence symbol reached by any other route (a re-export,
      // a destructure off an already-imported namespace, a bare call).
      //
      // Deliberately does NOT treat a bare `ensureHookDomainBootstrap`
      // identifier as satisfying the invariant. Only an import does — see the
      // ImportDeclaration/ImportExpression handlers. The negative control
      // caught this: with an identifier-based check, DELETING the import while
      // leaving the call site behind still passed, which is precisely the
      // regression the rule exists to catch (a call to a symbol that is no
      // longer in scope is a different, louder failure — but the missing
      // POLYFILL it also removes is the silent one).
      Identifier(node) {
        if (PERSISTENCE_SYMBOLS.has(node.name)) {
          noteTrigger(node, `reference to '${node.name}'`);
        }
      },

      "Program:exit"(programNode) {
        if (!trigger || hasBootstrapImport) return;
        // One report per file: the invariant is a file-level property, and
        // flagging every reference would bury it.
        context.report({
          node: trigger.node ?? programNode,
          messageId: "missingBootstrap",
          data: { trigger: trigger.description },
        });
      },
    };
  },
};
