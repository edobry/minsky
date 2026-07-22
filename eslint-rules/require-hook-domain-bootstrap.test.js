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
  ],
});
