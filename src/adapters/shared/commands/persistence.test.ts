/**
 * Tests for the `persistence.migrate` command's dry-run/execute precedence.
 *
 * mt#3191: the `--dry-run`/`-n` flag was destructured into an unused
 * `_dryRun` binding and never read — preview-vs-apply was controlled solely
 * by `--execute`, so `persistence migrate --dry-run --execute` silently
 * APPLIED a schema migration against Postgres despite the operator
 * explicitly asking for a preview. This violates CLAUDE.md's
 * `§Operational Safety: Dry-Run First` invariant.
 *
 * Fix direction chosen (per the task spec's (a)/(b) choice): HONOR the flag.
 * `--dry-run` now forces preview and takes precedence over `--execute` via a
 * single exported, unit-testable seam (`resolveMigratePreviewMode` in
 * `./persistence.ts`) shared by both the schema-only migration path and the
 * backend-migration path inside the command handler — so the precedence is
 * explicit in code, not incidental to evaluation order in two places.
 *
 * Three layers of coverage, from most to least isolated:
 *
 * 1. `resolveMigratePreviewMode` unit tests — the pure precedence function
 *    both command code paths call (`persistence.ts` lines ~133, ~169, and
 *    ~293).
 * 2. Handler-level tests for the `!to` schema-only branch (the default,
 *    no-`--to` invocation) — exercises the REAL `persistence.migrate`
 *    command handler end to end, stubbing only the migration runner via the
 *    `registerPersistenceCommands(container?, registry?, overrides?)`
 *    optional-parameter seam (mirrors the `listReviewsImpl` DI pattern in
 *    `asks-github-client.ts`, required by the project's
 *    `custom/no-global-module-mocks` ESLint rule — `mock.module()` is
 *    banned because it persists across test files with no per-file unmock;
 *    see `observability.test.ts`'s documented rationale for the same
 *    tradeoff). This closes the gap a resolver-only test leaves: nothing
 *    would catch a future regression where the handler stops calling
 *    `resolveMigratePreviewMode` at all.
 * 3. A handler-level test for the `to=postgres` (backend-migration) branch's
 *    PREVIEW side — using a `FakeSessionProvider` (`@minsky/domain/session`)
 *    and `initializeConfiguration`/`CustomConfigFactory` to supply a fake
 *    Postgres connection string, proving `--dry-run --execute` and the
 *    no-flag default both return `{ preview: true }` without any real I/O
 *    (preview mode returns before any DB connection is attempted).
 *
 * Known gap (not closed here): the `to=postgres` branch's APPLY side
 * (`dryRun: false, execute: true`) is NOT handler-tested. Tracing the code
 * past the preview early-return (`persistence.ts` ~line 293 `if
 * (isPreviewMode) { ...return...}`), the next dependency is
 * `PersistenceProviderFactory.create(...)` -> `targetProvider
 * .getDatabaseConnection()` -> `targetDb.transaction(...)` (the
 * clear-then-bulk-insert write) — a live Postgres connection with no
 * existing injectable seam in this file. Two considered options: (a) supply
 * a deliberately-unreachable connection string and assert a fast connection
 * failure — rejected as non-deterministic (whether the underlying
 * postgres.js/drizzle client connects eagerly or lazily, and how fast a
 * refused/unroutable connection fails, isn't guaranteed, risking a flaky or
 * hanging test); (b) add a second override seam
 * (`createTargetProvider`) alongside `runSchemaMigrations` — rejected
 * because it would touch the exact write-path code region a reviewer round
 * on this PR already (incorrectly) flagged as modified by this change
 * (see the PR body's rebuttal); adding a real diff there while
 * simultaneously rebutting that false claim was judged worse than the
 * coverage gap. The precedence LOGIC for this branch is still fully proven
 * two ways: `resolveMigratePreviewMode`'s exhaustive unit tests (including
 * the `execute: true, dryRun: false` -> `false` apply case), and the fact
 * that `isPreviewMode` gates the entire write block behind a single,
 * unconditional `if` with nothing else in between (verified by direct code
 * reading, cited above) — so the only unverified link is that single `if`
 * statement's wiring, not the precedence computation itself.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveMigratePreviewMode,
  registerPersistenceCommands,
  type PersistenceCommandOverrides,
} from "./persistence";
import { createSharedCommandRegistry, type SharedCommandRegistry } from "../command-registry";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import { initializeConfiguration, CustomConfigFactory } from "@minsky/domain/configuration/index";
import type { AppContainerInterface, ServiceKey } from "@minsky/domain/composition/types";

describe("resolveMigratePreviewMode (persistence.migrate dry-run/execute precedence, mt#3191)", () => {
  test("--dry-run --execute previews — does NOT apply (dry-run wins)", () => {
    expect(resolveMigratePreviewMode({ execute: true, dryRun: true })).toBe(true);
  });

  test("no flags: default still previews", () => {
    expect(resolveMigratePreviewMode({})).toBe(true);
    expect(resolveMigratePreviewMode({ execute: undefined, dryRun: undefined })).toBe(true);
  });

  test("--execute alone applies (no dry-run requested)", () => {
    expect(resolveMigratePreviewMode({ execute: true, dryRun: false })).toBe(false);
    expect(resolveMigratePreviewMode({ execute: true })).toBe(false);
  });

  test("--dry-run alone previews (redundant with default, but consistent)", () => {
    expect(resolveMigratePreviewMode({ execute: false, dryRun: true })).toBe(true);
    expect(resolveMigratePreviewMode({ dryRun: true })).toBe(true);
  });

  test("neither flag set previews (matches CLAUDE.md dry-run-by-default)", () => {
    expect(resolveMigratePreviewMode({ execute: false, dryRun: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler-level: schema-only branch (no `--to`) — the default invocation.
// ---------------------------------------------------------------------------

function getMigrateCommand(
  overrides?: PersistenceCommandOverrides,
  container?: AppContainerInterface
) {
  const registry: SharedCommandRegistry = createSharedCommandRegistry();
  registerPersistenceCommands(container, registry, overrides);
  const command = registry.getCommand("persistence.migrate");
  if (!command) throw new Error("persistence.migrate not registered");
  return command;
}

describe("persistence.migrate handler — schema-only branch (no --to)", () => {
  test("--dry-run --execute calls the migration runner with dryRun:true (previews, does not apply)", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const command = getMigrateCommand({
      runSchemaMigrations: async (options) => {
        calls.push(options ?? {});
        return { success: true, backend: "postgres", dryRun: true } as never;
      },
    });

    await command.execute({ execute: true, dryRun: true }, {});

    expect(calls).toEqual([{ dryRun: true }]);
  });

  test("--execute alone calls the migration runner with dryRun:false (applies)", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const command = getMigrateCommand({
      runSchemaMigrations: async (options) => {
        calls.push(options ?? {});
        return { success: true, applied: true, backend: "postgres" } as never;
      },
    });

    await command.execute({ execute: true }, {});

    expect(calls).toEqual([{ dryRun: false }]);
  });

  test("no flags (default) calls the migration runner with dryRun:true (previews)", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const command = getMigrateCommand({
      runSchemaMigrations: async (options) => {
        calls.push(options ?? {});
        return { success: true, backend: "postgres", dryRun: true } as never;
      },
    });

    await command.execute({}, {});

    expect(calls).toEqual([{ dryRun: true }]);
  });
});

// ---------------------------------------------------------------------------
// Handler-level: backend-migration branch (`--to postgres`) — preview side.
// ---------------------------------------------------------------------------

/** Minimal fake AppContainerInterface exposing a FakeSessionProvider. */
function makeFakeContainer(sessionProvider: FakeSessionProvider): AppContainerInterface {
  return {
    register: () => ({}) as AppContainerInterface,
    set: () => ({}) as AppContainerInterface,
    get: ((key: ServiceKey) => {
      if (key === "sessionProvider") return sessionProvider;
      throw new Error(`Service '${key}' not stubbed in test container`);
    }) as AppContainerInterface["get"],
    has: ((key: ServiceKey) => key === "sessionProvider") as AppContainerInterface["has"],
    initialize: async () => {},
    close: async () => {},
  };
}

describe("persistence.migrate handler — backend-migration branch (--to postgres), preview side", () => {
  afterEach(async () => {
    // Restore an unconfigured state so this file doesn't leak a configured
    // persistence backend into other tests running in the same process
    // (mirrors deployment-default-service.test.ts's pattern).
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, { overrides: {}, skipValidation: true });
  });

  async function configureFakePostgres(): Promise<void> {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: {
        persistence: {
          backend: "postgres",
          postgres: { connectionString: "postgresql://fake:fake@127.0.0.1:1/fake" },
        },
      },
      skipValidation: true,
    });
  }

  test("--dry-run --execute returns a preview result — no write attempted", async () => {
    await configureFakePostgres();
    const container = makeFakeContainer(new FakeSessionProvider());
    const command = getMigrateCommand(undefined, container);

    const result = (await command.execute(
      { to: "postgres", execute: true, dryRun: true, backup: false },
      {}
    )) as { preview?: boolean; targetBackend?: string };

    expect(result.preview).toBe(true);
    expect(result.targetBackend).toBe("postgres");
  });

  test("no flags (default) returns a preview result", async () => {
    await configureFakePostgres();
    const container = makeFakeContainer(new FakeSessionProvider());
    const command = getMigrateCommand(undefined, container);

    const result = (await command.execute({ to: "postgres", backup: false }, {})) as {
      preview?: boolean;
    };

    expect(result.preview).toBe(true);
  });
});
