#!/usr/bin/env bun
/**
 * mt#2441 backfill: populate `minsky_session_links` (`cwd_match` class) for
 * transcripts already ingested before the ingest-time writer shipped.
 *
 * The normal ingest pipeline (`AgentTranscriptIngestService.ingestSession`)
 * now writes a `cwd_match` link whenever a transcript's captured `cwd` falls
 * under `<stateDir>/sessions/<id>` (see
 * `packages/domain/src/transcripts/session-link-writer.ts`) — but that write
 * only fires on the NEXT ingest of a given session, gated by the incremental
 * timestamp high-water-mark. An already-ingested, unchanged transcript is a
 * no-op on re-ingest and never re-triggers link detection. This script sweeps
 * every already-ingested `agent_transcripts` row directly (bypassing the HWM
 * gate entirely) and backfills the link for any row whose cwd resolves to a
 * session workspace path.
 *
 * Idempotent: `writeCwdMatchLink` upserts via `ON CONFLICT DO NOTHING` against
 * the table's `(agent_session_id, minsky_session_id)` primary key, so re-runs
 * are safe no-ops for already-linked rows.
 *
 * As of 2026-06-10 (mt#2441 spec), ~29 rows were expected to match the
 * session-cwd pattern across the corpus. Actual yield may be lower per the
 * mt#2749 finding (subagents don't chdir into the session workspace) — that
 * is expected, not a bug in this script or the underlying matcher.
 *
 * Run:
 *   bun scripts/backfill-minsky-session-links.ts
 *
 * Env-gated: requires the standard Minsky Postgres config to be available
 * (the script loads the canonical DB connection via the CLI DI container).
 * Exits with a clear SKIP message (exit 0) if the DB connection cannot be
 * established.
 *
 * @see mt#2441 — this script
 * @see packages/domain/src/transcripts/session-link-writer.ts — detector + writer + backfill logic
 * @see scripts/backfill-memory-associations.ts — sibling script using the same DB-bootstrap pattern
 */

// tsyringe (used by createCliContainer's DI container below) requires this
// polyfill — without it, `bun scripts/backfill-minsky-session-links.ts` (the
// exact invocation this script's own docstring documents) throws "tsyringe
// requires a reflect polyfill" (mt#2768 finding, 2026-07-14).
import "reflect-metadata";
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

  const { backfillCwdMatchLinks } = await import("@minsky/domain/transcripts/session-link-writer");

  const result = await backfillCwdMatchLinks(db);

  console.log("Backfill complete:");
  console.log(`  transcripts scanned:    ${result.transcriptsScanned}`);
  console.log(`  links written:          ${result.linksWritten}`);
  console.log(`  skipped (no cwd match): ${result.linksSkippedNoMatch}`);
  console.log(`  errored:                ${result.linksErrored}`);

  process.exit(result.linksErrored > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Backfill crashed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
