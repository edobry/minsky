#!/usr/bin/env bun
/**
 * Helper script for drizzle-kit configuration
 * Loads database credentials from Minsky configuration system and outputs as JSON
 * Used to work around drizzle-kit's lack of top-level await support
 *
 * ## Gated (mt#4017)
 *
 * This script's stdout IS a live credential — the resolved Postgres connection
 * string, password included — printed unconditionally by design so its sole
 * sanctioned caller, `drizzle.pg.config.ts`, can `JSON.parse` it (drizzle-kit
 * 0.31.2 has no top-level-await support, so the config can't `await` this
 * in-process; see that file's own comment for the forward note on when this
 * subprocess pattern goes away).
 *
 * Running this directly — e.g. an agent trying to answer "is the DB
 * configured?" by invoking it from a shell — prints that credential into a
 * persisted, ingested transcript. That happened twice: 2026-08-01 (mem#808,
 * a different script whose redaction silently matched nothing) and
 * 2026-08-11 (ask#8065, this exact script, second exposure of the same
 * Supabase pooler password in 11 days).
 *
 * The gate below refuses to print anything unless `GATE_ENV_VAR` is set —
 * an explicit signal `drizzle.pg.config.ts` sets on ITS subprocess's
 * environment, not a TTY check (an agent's subprocess call has no TTY either
 * way, so a TTY check would not distinguish the sanctioned caller from a
 * direct agent invocation). `.minsky/hooks/block-secret-file-read.ts` adds a
 * second, independent layer: it denies a direct invocation of this script at
 * the PreToolUse level, before the process even starts, so the two layers
 * cover different failure points (this script's own gate covers any
 * caller that isn't `drizzle.pg.config.ts`; the guard covers an agent
 * routing the invocation through Bash/`session_exec`).
 */

// tsyringe (transitively imported via configuration/backend-detection) requires
// reflect-metadata to be loaded at the entry point.
import "reflect-metadata";
import { loadConfiguration } from "@minsky/domain/configuration/loader";

/**
 * Env var `drizzle.pg.config.ts` sets on this script's subprocess environment
 * to signal "you are being invoked from the sanctioned caller." Registered in
 * `HOOK_ONLY_ENV_VARS` (`packages/domain/src/configuration/sources/environment.ts`)
 * since this script calls `loadConfiguration()` itself, which would otherwise
 * auto-map an unrecognized `MINSKY_*` var into a config dot-path and crash
 * under strict-mode validation.
 */
const GATE_ENV_VAR = "MINSKY_DRIZZLE_LOADER_GATE";

function refuseUngatedInvocation(): never {
  console.error(
    [
      "Refusing to run: this script's stdout is the live database connection",
      "string, credential included. It is meant to run ONLY as a subprocess of",
      "drizzle.pg.config.ts, which sets the gate signal itself before invoking it.",
      "",
      "Running it directly — including via an agent's Bash/session_exec tool —",
      "prints a live credential into a persisted, ingested transcript (mt#4017,",
      "ask#8065: this happened, twice, to the same credential).",
      "",
      "To check whether the DB is configured WITHOUT printing the credential, use:",
      "  bun run src/cli.ts persistence check      # or the persistence_check MCP tool",
      "",
      `Override (sanctioned caller only): set ${GATE_ENV_VAR}=1.`,
    ].join("\n")
  );
  process.exit(1);
}

async function main() {
  if (process.env[GATE_ENV_VAR] !== "1") {
    refuseUngatedInvocation();
  }

  try {
    const configResult = await loadConfiguration();
    const config = configResult.config;

    // Extract database configuration
    const dbConfig = {
      postgres: {
        connectionString: config.persistence?.postgres?.connectionString || null,
      },
      sqlite: {
        // PersistenceConfig's current type is postgres-only (sqlite support
        // predates the Postgres-only migration); read defensively in case a
        // legacy config still carries this field, matching prior behavior.
        path:
          (config.persistence as { sqlite?: { dbPath?: string } } | undefined)?.sqlite?.dbPath ||
          null,
      },
      backend: config.persistence?.backend || "sqlite",
    };

    // Output as JSON for consumption by drizzle config
    console.log(JSON.stringify(dbConfig, null, 2));
  } catch (error) {
    console.error("Failed to load Minsky configuration:", error);
    process.exit(1);
  }
}

main();
