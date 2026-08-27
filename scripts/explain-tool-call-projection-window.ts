#!/usr/bin/env bun
/**
 * mt#3329 AT3: EXPLAIN-checked window query.
 *
 * Proves the trailing-time-window scan the EngProd miner (mt#3330) and
 * mt#1120's supervision analysis both need — "an ordered tool-name stream
 * per session over a trailing time window (e.g. 14 days, all sessions)" —
 * touches ONLY `agent_tool_call_projection` and its own indexes, never the
 * raw `agent_transcript_turns.tool_calls` jsonb column (whose megabyte-scale
 * Write/Edit payloads are exactly what this projection table exists to
 * avoid scanning).
 *
 * Must be run AFTER migration 0078 has applied (the table must exist) —
 * this task's migration ships in the same PR but applies to prod via the
 * normal auto-migrate flow at merge, not from this script. Re-run once the
 * backfill (`scripts/backfill-agent-tool-call-projection.ts --execute`) has
 * populated a representative row count — an empty/near-empty table produces
 * a degenerate plan (trivial Seq Scan over ~0 rows) that doesn't exercise
 * the index the way a populated corpus does.
 *
 * Usage:
 *   bun scripts/explain-tool-call-projection-window.ts [--days=14]
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

async function bootstrapDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) {
    throw new Error("This script requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("This script requires an initialized Postgres database connection.");
  }
  return connection;
}

function parseDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--days="));
  const days = arg ? Number(arg.slice("--days=".length)) : 14;
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    throw new Error(`--days must be a positive integer, got: ${arg}`);
  }
  return days;
}

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const db = await bootstrapDb();

  const intervalLiteral = `${days} days`;

  // The exact window query the EngProd miner (mt#3330) / mt#1120 need: an
  // ordered tool-name stream per session, filtered to a trailing window,
  // across ALL sessions (not scoped to one) — the shape AT3 specifies.
  const plan = (await db.execute(sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT agent_session_id, turn_index, ordinal, tool_name, server, timestamp
    FROM agent_tool_call_projection
    WHERE timestamp >= now() - ${intervalLiteral}::interval
    ORDER BY agent_session_id, turn_index, ordinal
  `)) as Array<Record<string, unknown>>;

  console.log(`EXPLAIN (ANALYZE, BUFFERS) — trailing ${days}-day window, all sessions:\n`);
  for (const row of plan) {
    const line = Object.values(row)[0];
    console.log(typeof line === "string" ? line : JSON.stringify(line));
  }

  const planText = plan.map((r) => String(Object.values(r)[0])).join("\n");
  const touchesTurnsTable = /agent_transcript_turns/.test(planText);
  console.log(
    `\nTouches agent_transcript_turns: ${touchesTurnsTable ? "YES (FAIL — investigate)" : "no (expected)"}`
  );

  process.exit(touchesTurnsTable ? 1 : 0);
}

main().catch((err) => {
  console.error(`explain-tool-call-projection-window failed: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
