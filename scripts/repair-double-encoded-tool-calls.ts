#!/usr/bin/env bun
/**
 * mt#3360: one-time repair of double-encoded `tool_calls` rows in
 * `agent_transcript_turns` — an Apr 2026 ingest artifact (pre-mt#2381 write
 * path; see `packages/domain/src/transcripts/turn-writer.ts`'s comment on
 * the historical bug). 1,948 rows across 6 sessions (2026-04-19..27) store
 * `tool_calls` as a jsonb STRING — double-encoded JSON of an otherwise-valid
 * `tool_use` array — instead of a jsonb array, which breaks any consumer
 * that assumes array shape (`jsonb_array_length` throws; `Array.isArray`
 * checks silently skip).
 *
 * Dry-run by default (CLAUDE.md §Operational Safety: Dry-Run First; bulk
 * shared-state mutations require a task wrapper — this task, mt#3360, is
 * that wrapper). Reports the `jsonb_typeof` distribution before the repair,
 * the exact rows where `jsonb_typeof(tool_calls) = 'string'`, and previews
 * the guarded one-unwrap: `tool_calls = (tool_calls #>> '{}')::jsonb`.
 *
 * Guard design: rather than expressing the guard as a single SQL WHERE
 * clause (`jsonb_typeof((tool_calls #>> '{}')::jsonb) = 'array'`), which
 * would evaluate the `::jsonb` cast against EVERY string-typed row as part
 * of one statement — a single row whose string content is not syntactically
 * valid JSON would abort the WHOLE UPDATE, not just that row — this script
 * classifies candidacy in TypeScript first (`JSON.parse`, which can never
 * abort a SQL transaction) and then targets the UPDATE at exactly the
 * verified-safe (session_id, turn_index) pairs via a VALUES-list join. This
 * still applies the identical unwrap expression the spec specifies
 * (`tool_calls = (tool_calls #>> '{}')::jsonb`) and is semantically
 * equivalent to the SQL-level guard for every row that passes it — it is
 * simply evaluated in a place that can degrade to "leave this row alone and
 * report it as residue" instead of "abort the entire batch."
 *
 * Any row whose unwrapped string does NOT parse to a JSON array (invalid
 * JSON syntax, or valid JSON that isn't an array) is left untouched and
 * reported as residue — never included in the UPDATE.
 *
 * Usage:
 *   bun scripts/repair-double-encoded-tool-calls.ts              # dry-run (report only)
 *   bun scripts/repair-double-encoded-tool-calls.ts --execute    # apply the guarded unwrap
 *
 * @see mt#3360 — this task
 * @see mt#3329 / scripts/backfill-agent-tool-call-projection.ts — the backfill this unblocks
 * @see packages/domain/src/transcripts/turn-writer.ts — the (already-fixed) write site
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

/** Rows per UPDATE statement when applying the repair (mirrors the repo's chunking convention, e.g. turn-writer.ts). */
const CHUNK_SIZE = 500;

interface Args {
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  return { execute: argv.includes("--execute") };
}

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
    throw new Error("Repair requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Repair requires an initialized Postgres database connection.");
  }
  return connection;
}

export interface TypeofCount {
  typ: string;
  n: number;
}

/** `jsonb_typeof` distribution over all non-null `tool_calls` rows. */
export async function getTypeofDistribution(db: PostgresJsDatabase): Promise<TypeofCount[]> {
  const rows = (await db.execute(sql`
    SELECT jsonb_typeof(tool_calls) AS typ, count(*)::int AS n
    FROM agent_transcript_turns
    WHERE tool_calls IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `)) as Array<{ typ: string; n: number }>;
  return rows;
}

export interface StringTypedRow {
  agentSessionId: string;
  turnIndex: number;
  toolCalls: unknown;
}

/** All rows where `jsonb_typeof(tool_calls) = 'string'` (the double-encoded shape). */
async function fetchStringTypedRows(db: PostgresJsDatabase): Promise<StringTypedRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      agent_session_id AS "agentSessionId",
      turn_index AS "turnIndex",
      tool_calls AS "toolCalls"
    FROM agent_transcript_turns
    WHERE jsonb_typeof(tool_calls) = 'string'
    ORDER BY agent_session_id, turn_index
  `)) as Array<{ agentSessionId: string; turnIndex: number; toolCalls: unknown }>;
  return rows;
}

export interface ClassifiedRow {
  agentSessionId: string;
  turnIndex: number;
  outcome: "candidate" | "residue";
  reason?: string;
}

/**
 * Pure function — testable without a DB. Classifies each string-typed
 * `tool_calls` row: does its unwrapped text (`JSON.parse`, the same JSON
 * grammar Postgres's `::jsonb` cast validates against) parse to a JSON
 * array? Candidates are safe to repair; residue is left untouched and
 * reported with a reason.
 */
export function classifyStringRows(rows: StringTypedRow[]): ClassifiedRow[] {
  return rows.map((row) => {
    const { agentSessionId, turnIndex } = row;
    const raw = row.toolCalls;
    if (typeof raw !== "string") {
      // Defensive: fetchStringTypedRows already filters on
      // jsonb_typeof = 'string', so the driver should always hand back a JS
      // string here. Treat anything else as residue rather than throwing.
      return {
        agentSessionId,
        turnIndex,
        outcome: "residue",
        reason: `expected a string value at read time, got ${typeof raw}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        agentSessionId,
        turnIndex,
        outcome: "residue",
        reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!Array.isArray(parsed)) {
      const kind = parsed === null ? "null" : typeof parsed;
      return {
        agentSessionId,
        turnIndex,
        outcome: "residue",
        reason: `unwraps to ${kind}, not an array`,
      };
    }
    return { agentSessionId, turnIndex, outcome: "candidate" };
  });
}

/**
 * Applies the guarded one-unwrap UPDATE to exactly the given candidate
 * (session_id, turn_index) pairs, chunked. The `jsonb_typeof(tool_calls) =
 * 'string'` re-check in the WHERE clause is defense-in-depth against a race
 * (a row changing shape between the SELECT and this UPDATE) — since
 * `candidates` were already verified in TS to parse cleanly to an array, the
 * `(tool_calls #>> '{}')::jsonb` cast here can never throw for real.
 */
async function applyRepair(
  db: PostgresJsDatabase,
  candidates: ClassifiedRow[]
): Promise<{ updated: number }> {
  let updated = 0;
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    // `agent_transcript_turns.agent_session_id` is `text`, not `uuid`
    // (packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts;
    // migration 0027_agent_transcripts.sql declares it `text`) — but cast
    // explicitly anyway so the VALUES list's column type is never left to
    // driver-dependent parameter-type inference.
    const valuesSql = sql.join(
      chunk.map((c) => sql`(${c.agentSessionId}::text, ${c.turnIndex}::int)`),
      sql`, `
    );

    // `db.execute`'s result (postgres.js's `RowList`) already carries a
    // `.count` field for the affected-row count — no cast needed.
    const result = await db.execute(sql`
      UPDATE agent_transcript_turns AS t
      SET tool_calls = (t.tool_calls #>> '{}')::jsonb
      FROM (VALUES ${valuesSql}) AS v(session_id, turn_index)
      WHERE t.agent_session_id = v.session_id
        AND t.turn_index = v.turn_index
        AND jsonb_typeof(t.tool_calls) = 'string'
        AND jsonb_typeof((t.tool_calls #>> '{}')::jsonb) = 'array'
    `);

    updated += result.count ?? chunk.length;
  }
  return { updated };
}

async function main(): Promise<void> {
  const { execute } = parseArgs(process.argv.slice(2));
  const db = await bootstrapDb();

  console.log(`repair-double-encoded-tool-calls ${execute ? "(EXECUTE)" : "(dry-run)"}`);

  const before = await getTypeofDistribution(db);
  console.log("  jsonb_typeof distribution (before):", JSON.stringify(before));

  const stringRows = await fetchStringTypedRows(db);
  const classified = classifyStringRows(stringRows);
  const candidates = classified.filter((c) => c.outcome === "candidate");
  const residue = classified.filter((c) => c.outcome === "residue");

  console.log(`  string-typed rows found:        ${stringRows.length}`);
  console.log(`  candidates (unwrap -> array):   ${candidates.length}`);
  console.log(`  residue (left untouched):       ${residue.length}`);
  if (residue.length > 0) {
    console.log("  RESIDUE:", JSON.stringify(residue.slice(0, 20)));
  }

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply the guarded repair)");
    console.log(
      JSON.stringify({
        mode: "dry-run",
        before,
        stringRowCount: stringRows.length,
        candidateCount: candidates.length,
        residueCount: residue.length,
        residue: residue.slice(0, 50),
      })
    );
    process.exit(residue.length > 0 ? 2 : 0);
  }

  console.log(`  applying guarded unwrap UPDATE to ${candidates.length} candidate row(s)...`);
  const { updated } = await applyRepair(db, candidates);
  console.log(`  updated ${updated} row(s)`);

  const after = await getTypeofDistribution(db);
  console.log("  jsonb_typeof distribution (after):", JSON.stringify(after));

  console.log(
    JSON.stringify({
      mode: "execute",
      before,
      after,
      stringRowCount: stringRows.length,
      candidateCount: candidates.length,
      residueCount: residue.length,
      updated,
      residue: residue.slice(0, 50),
    })
  );

  // Non-zero exit when residue remains, so the caller notices even though
  // the repair itself succeeded — distinct from exit 1 (hard failure).
  process.exit(residue.length > 0 ? 2 : 0);
}

// Guard the entry point (mirrors backfill-ask-short-ids.ts's precedent) —
// without this, importing this module's testable exports (classifyStringRows,
// getTypeofDistribution — from this script's own test file) would also kick
// off main()'s real DB bootstrap + process.exit() as a side effect of the
// import.
if (import.meta.main) {
  main().catch((err) => {
    // Print both the wrapper's message and the underlying Postgres error on
    // `.cause` (drizzle-orm's DrizzleQueryError swallows the real error into
    // `.cause`, matching the same bug fixed in
    // scripts/backfill-agent-tool-call-projection.ts).
    const message = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: unknown } | undefined)?.cause;
    const causeMessage =
      cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;
    console.error(
      `repair-double-encoded-tool-calls failed: ${message}${
        causeMessage ? `\n  caused by: ${causeMessage}` : ""
      }`
    );
    process.exit(1);
  });
}
