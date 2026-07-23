#!/usr/bin/env bun
/**
 * CI-invocable entrypoint for the reviewer service's migration runner.
 *
 * mt#3117 — gives the reviewer a release-phase deploy gate: this script is
 * invoked by `.github/workflows/deploy-reviewer.yml`, connected as the
 * DDL-capable `postgres` role (sourced from the `MINSKY_PERSISTENCE_POSTGRES_URL`
 * CI secret), and run BEFORE the new image is pushed to GHCR / takes
 * traffic. A non-zero exit here fails the deploy job — no image is pushed,
 * and the previously-deployed reviewer keeps serving.
 *
 * Today `applyMigrations()` is reachable only from inside
 * `services/reviewer/src/server.ts`'s `if (import.meta.main)` boot block.
 * That boot-time call is left UNCHANGED by this task (removal is mt#3030's
 * job, after this workflow has survived a real deploy) — dual application
 * is safe because the drizzle ledger (`__drizzle_migrations_reviewer`) is
 * idempotent and high-water-mark based. This script is a separate,
 * standalone entrypoint so migration can additionally be gated in CI,
 * ahead of the image push, WITHOUT requiring the DDL credential to live in
 * the reviewer's runtime Railway environment (see the task spec's
 * "Authoritative-source check" for why Railway's `preDeployCommand` was
 * rejected: it inherits the service's runtime env).
 *
 * This script lives OUTSIDE `services/reviewer/src/` on purpose: it imports
 * from `../src/db/client` and `../src/db/migrate`, which is fine — those
 * two modules are documented "Sealed: no imports from src/", a constraint
 * on what THEY import, not on what imports them. Do not move this script
 * (or its logic) into `src/db/` — that would either violate the seal or
 * require relaxing it.
 *
 * Usage: bun run services/reviewer/scripts/migrate.ts
 * Exit code: 0 on success, 1 on any failure (missing connection string,
 * migration error, or post-migration self-check failure).
 */

import { createDb } from "../src/db/client";
import { applyMigrations } from "../src/db/migrate";

/**
 * Resolve the Postgres connection string from env, mirroring
 * `services/reviewer/src/db/client.ts`'s `resolveConnectionString()`
 * resolution order. Checked explicitly (rather than letting `createDb()`
 * silently fall through to its localhost dev default) so a missing CI
 * secret fails fast with a clear message instead of a cryptic
 * connection-refused error partway through migration.
 */
function resolveConnectionStringForCi(): string | undefined {
  return (
    process.env.MINSKY_PERSISTENCE_POSTGRES_URL ||
    process.env.MINSKY_SESSIONDB_POSTGRES_URL ||
    process.env.MINSKY_POSTGRES_URL ||
    undefined
  );
}

async function main(): Promise<number> {
  const connectionString = resolveConnectionStringForCi();
  if (!connectionString) {
    console.error(
      "[reviewer migrate] No Postgres connection string found in env. Set " +
        "MINSKY_PERSISTENCE_POSTGRES_URL (preferred) to the DDL-capable `postgres` " +
        "role connection string before invoking this script. Refusing to fall back " +
        "to a default — this script is meant to run only against an explicitly " +
        "configured target (CI: the MINSKY_PERSISTENCE_POSTGRES_URL repo secret)."
    );
    return 1;
  }

  console.log(
    "[reviewer migrate] Applying reviewer migrations (services/reviewer/migrations/pg)..."
  );

  const db = createDb();
  try {
    await applyMigrations(db);
    console.log("[reviewer migrate] Migrations applied and post-migration self-check passed.");
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reviewer migrate] FAILED: ${message}`);
    return 1;
  } finally {
    // Best-effort pool shutdown so the process doesn't hang on an open
    // connection. Wrapped in a real try/catch rather than a trailing
    // `.catch()`: if `$client` is absent (drizzle version skew) or `end()`
    // throws SYNCHRONOUSLY, a promise-level `.catch()` never runs and the
    // throw escapes from `finally` — which in JS discards the value the
    // `try`/`catch` above already computed, reporting a spurious failure
    // for a migration that actually succeeded (or vice versa). Closing the
    // pool is never itself a migration outcome, so it must not affect the
    // exit code.
    try {
      await db.$client?.end({ timeout: 5 });
    } catch {
      /* ignore — pool-close failure is not a migration failure */
    }
  }
}

const exitCode = await main();
process.exit(exitCode);
