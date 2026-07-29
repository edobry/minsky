/**
 * @fileoverview Tests for custom/require-hook-domain-bootstrap (mt#3046).
 *
 * The rule flags a `.minsky/hooks` file that reaches the persistence layer
 * without importing the shared bootstrap. The dynamic-import case is the one
 * that matters most: both real instances (mt#3019's `record-subagent-invocation`
 * and the second one this task found, `post-merge-unasked-direction-scan`)
 * reached persistence through `await import(...)` inside a function, where the
 * throw is swallowed and nothing reaches stderr.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./require-hook-domain-bootstrap.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

const hookFile = ".minsky/hooks/some-hook.ts";
const hookTestFile = ".minsky/hooks/some-hook.test.ts";
const bootstrapFile = ".minsky/hooks/domain-bootstrap.ts";
const outsideFile = "src/domain/tasks/unrelated.ts";
// mt#3178 widened coverage to the `scripts/**` entry-point tree.
const scriptFile = "scripts/some-backfill.ts";
const scriptTestFile = "scripts/some-backfill.test.ts";

const MSG = "missingBootstrap";

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("require-hook-domain-bootstrap", rule, {
  valid: [
    // A bootstrapped hook — the mt#3019 shape after the fix.
    {
      filename: hookFile,
      code: `
        import { ensureHookDomainBootstrap } from "./domain-bootstrap";
        async function run() {
          const bootstrap = await ensureHookDomainBootstrap();
          if (!bootstrap.ok) return;
          const { resolvePersistenceProvider } = await import(
            "../../packages/domain/src/persistence/factory"
          );
          const provider = await resolvePersistenceProvider();
          return provider;
        }
      `,
    },
    // Bootstrapped via a static persistence import too.
    {
      filename: hookFile,
      code: `
        import { ensureHookDomainBootstrap } from "./domain-bootstrap";
        import { resolvePersistenceProvider } from "../../packages/domain/src/persistence/factory";
        export { ensureHookDomainBootstrap, resolvePersistenceProvider };
      `,
    },
    // A hook that never touches persistence — the common case (77 of 81).
    {
      filename: hookFile,
      code: `
        import { readInput } from "./types";
        import { deploySurfaceFor } from "../../packages/domain/src/deployment/deploy-surface";
        const input = await readInput();
        export default deploySurfaceFor(input);
      `,
    },
    // The bootstrap module itself cannot import itself.
    {
      filename: bootstrapFile,
      code: `
        import "reflect-metadata";
        export async function ensureHookDomainBootstrap() {
          const { PersistenceService } = await import("../../packages/domain/src/persistence/service");
          return PersistenceService;
        }
      `,
    },
    // A test file is not an entry point; it may name the symbols freely.
    {
      filename: hookTestFile,
      code: `
        import { resolvePersistenceProvider } from "../../packages/domain/src/persistence/factory";
        test("provider", async () => { await resolvePersistenceProvider(); });
      `,
    },
    // Outside .minsky/hooks the invariant does not apply — the CLI and the MCP
    // server bootstrap the domain layer at their own entry points.
    {
      filename: outsideFile,
      code: `
        import { resolvePersistenceProvider } from "./persistence/factory";
        export const p = resolvePersistenceProvider();
      `,
    },
    // mt#3178: a script satisfies the invariant with a STATIC reflect polyfill.
    // This is the idiom 29 of the 31 flagged scripts already used.
    {
      filename: scriptFile,
      code: `
        import "reflect-metadata";
        import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
        export const p = resolvePersistenceProvider();
      `,
    },
    // mt#3178: the hook idiom also satisfies a script — the two are alternatives,
    // not mutually exclusive.
    {
      filename: scriptFile,
      code: `
        import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
        import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
        export async function run() {
          await ensureHookDomainBootstrap();
          return resolvePersistenceProvider();
        }
      `,
    },
    // A test is not an entry point — the exemption carries over to scripts.
    {
      filename: scriptTestFile,
      code: `
        import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
        export const p = resolvePersistenceProvider();
      `,
    },
  ],

  invalid: [
    // The shape that actually shipped twice: dynamic import inside a function,
    // error swallowed, nothing on stderr.
    {
      filename: hookFile,
      code: `
        async function loadTranscript(sessionId) {
          try {
            const { resolvePersistenceProvider } = await import(
              "../../packages/domain/src/persistence/factory"
            );
            const provider = await resolvePersistenceProvider();
            if (!provider) return null;
            return provider;
          } catch {
            return null;
          }
        }
      `,
      errors: [{ messageId: MSG }],
    },
    // Static import, no bootstrap.
    {
      filename: hookFile,
      code: `
        import { resolvePersistenceProvider } from "../../packages/domain/src/persistence/factory";
        export const provider = await resolvePersistenceProvider();
      `,
      errors: [{ messageId: MSG }],
    },
    // Reached via PersistenceService directly rather than the helper.
    {
      filename: hookFile,
      code: `
        const { PersistenceService } = await import("../../packages/domain/src/persistence/service");
        const service = new PersistenceService();
        await service.initialize();
      `,
      errors: [{ messageId: MSG }],
    },
    // Exactly one report per file even with several persistence references —
    // the invariant is a file-level property.
    {
      filename: hookFile,
      code: `
        import { resolvePersistenceProvider } from "../../packages/domain/src/persistence/factory";
        import { PersistenceService } from "../../packages/domain/src/persistence/service";
        async function a() {
          const p = await resolvePersistenceProvider();
          return p.getDatabaseConnection();
        }
        async function b() {
          const p = await resolvePersistenceProvider();
          return p.getDatabaseConnection();
        }
        export { a, b, PersistenceService };
      `,
      errors: [{ messageId: MSG }],
    },
    // Importing the bootstrap MODULE is what counts — a same-named local
    // binding from somewhere else must not satisfy the rule by accident.
    {
      filename: hookFile,
      code: `
        import { somethingElse } from "./types";
        const { getDatabaseConnection } = somethingElse;
        export const db = await getDatabaseConnection();
      `,
      errors: [{ messageId: MSG }],
    },
    // --- Aliasing / namespace shapes (PR #2184 R1 BLOCKING #2) ---
    //
    // The review predicted these evade a name-based Identifier walker. They do
    // not, for two reasons worth pinning so a future refactor cannot quietly
    // break them:
    //   - a RENAMED named import still carries an `imported` Identifier with
    //     the ORIGINAL name (`{ imported: resolvePersistenceProvider, local: r }`),
    //     and the module specifier matches independently;
    //   - a destructuring RENAME still carries the original name as the
    //     Property KEY (`{ getDatabaseConnection: g }`), which ESLint visits.
    // These were verified against the rule before being written down.
    {
      filename: hookFile,
      code: `
        import { resolvePersistenceProvider as r } from "../../packages/domain/src/persistence/factory";
        export const x = await r();
      `,
      errors: [{ messageId: MSG }],
    },
    {
      filename: hookFile,
      code: `
        import * as p from "../../packages/domain/src/persistence/factory";
        const { getDatabaseConnection: g } = p;
        export const x = await g();
      `,
      errors: [{ messageId: MSG }],
    },
    {
      filename: hookFile,
      code: `
        import { getDatabaseConnection as gdc } from "../../packages/domain/src/persistence/service";
        export const x = await gdc();
      `,
      errors: [{ messageId: MSG }],
    },
    // The hardest of the four: the object being destructured did NOT come from
    // a persistence-module specifier, so the module-suffix check cannot help —
    // only the Property-key identifier catches it.
    {
      filename: hookFile,
      code: `
        import { thing } from "./types";
        const { getDatabaseConnection: g } = thing;
        export const x = await g();
      `,
      errors: [{ messageId: MSG }],
    },
    // REGRESSION (found by this task's own negative control): an earlier draft
    // treated ANY identifier named `ensureHookDomainBootstrap` as satisfying
    // the invariant. Deleting the import while leaving the call site behind
    // therefore passed — the exact edit the negative control performs. Only an
    // import counts.
    {
      filename: hookFile,
      code: `
        // bootstrap import removed; call site left behind
        async function run() {
          const bootstrap = await ensureHookDomainBootstrap();
          if (!bootstrap.ok) return;
          const { resolvePersistenceProvider } = await import(
            "../../packages/domain/src/persistence/factory"
          );
          return resolvePersistenceProvider();
        }
        export { run };
      `,
      errors: [{ messageId: MSG }],
    },
    // mt#3178 SC#5: a scripts/** file reaching persistence with NO bootstrap
    // is flagged. Before mt#3178 this passed silently — the rule's own path
    // guard rejected every scripts/** file regardless of the config glob.
    {
      filename: scriptFile,
      code: `
        import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
        export const p = resolvePersistenceProvider();
      `,
      errors: [{ messageId: MSG }],
    },
    // mt#3178 SC#3: the negative control carries over to scripts — a bare
    // identifier is not an import, so deleting the import while leaving the
    // call site behind must still fail.
    {
      filename: scriptFile,
      code: `
        export async function run() {
          await ensureHookDomainBootstrap();
          return resolvePersistenceProvider();
        }
      `,
      errors: [{ messageId: MSG }],
    },
    // mt#3178 asymmetry: the reflect polyfill alone does NOT satisfy a HOOK.
    // `ensureHookDomainBootstrap` does polyfill AND configuration init; a hook
    // with only the polyfill still resolves a null provider — the mt#3019
    // failure. Accepting it here would silently weaken the original rule.
    {
      filename: hookFile,
      code: `
        import "reflect-metadata";
        import { resolvePersistenceProvider } from "./persistence/factory";
        export const p = resolvePersistenceProvider();
      `,
      errors: [{ messageId: MSG }],
    },
    // mt#3178: only a STATIC polyfill import counts. A dynamic one does not
    // reliably precede the domain imports it must precede.
    {
      filename: scriptFile,
      code: `
        export async function run() {
          await import("reflect-metadata");
          const { resolvePersistenceProvider } = await import("@minsky/domain/persistence/factory");
          return resolvePersistenceProvider();
        }
      `,
      errors: [{ messageId: MSG }],
    },
  ],
});
