#!/usr/bin/env bun
/**
 * mt#2756 backfill: populate `minsky_session_links` (`subagent_spawn` class)
 * for `agent_spawns` rows already extracted before the extraction-time writer
 * shipped.
 *
 * `AgentSpawnsPipeline` (mt#1327, `agent-spawns-pipeline.ts`) now writes a
 * `subagent_spawn` link inline whenever it resolves a spawn's
 * `childAgentSessionId` AND the parent's dispatch prompt embeds a Minsky
 * workspace session directory (see
 * `packages/domain/src/transcripts/spawn-link-writer.ts`) — but that write
 * only fires on a FUTURE `transcripts.spawns-extract` run. Rows already
 * present in `agent_spawns` from before this wiring shipped never re-trigger
 * link detection on their own. This script sweeps every already-extracted
 * `agent_spawns` row directly and backfills the link for any row whose
 * parent prompt resolves to a session workspace path.
 *
 * Idempotent: `writeSpawnLink` upserts via `ON CONFLICT DO NOTHING` against
 * `minsky_session_links`'s `(agent_session_id, minsky_session_id)` primary
 * key, so re-runs are safe no-ops for already-linked rows.
 *
 * Run:
 *   bun scripts/backfill-subagent-spawn-links.ts
 *
 * Env-gated: requires the standard Minsky Postgres config to be available
 * (the script loads the canonical DB connection via the CLI DI container).
 * Exits with a clear SKIP message (exit 0) if the DB connection cannot be
 * established.
 *
 * @see mt#2756 — this script
 * @see packages/domain/src/transcripts/spawn-link-writer.ts — detector + writer + backfill logic
 * @see scripts/backfill-minsky-session-links.ts — sibling script for the mt#2441 `cwd_match` class
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

async function getDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  return connection as PostgresJsDatabase;
}

async function main(): Promise<void> {
  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error(
      "SKIP: failed to initialize DB connection — Postgres not available in this environment."
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(0);
  }

  const { backfillSpawnLinks } = await import("@minsky/domain/transcripts/spawn-link-writer");

  const result = await backfillSpawnLinks(db);

  console.log("Backfill complete:");
  console.log(`  agent_spawns rows scanned: ${result.spawnsScanned}`);
  console.log(`  links written:             ${result.linksWritten}`);
  console.log(`  skipped (no prompt match): ${result.linksSkippedNoMatch}`);
  console.log(`  errored:                   ${result.linksErrored}`);

  process.exit(result.linksErrored > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Backfill crashed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
