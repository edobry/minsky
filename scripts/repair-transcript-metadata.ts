#!/usr/bin/env bun
/**
 * mt#3342 repair: restore `started_at` / `harness` on transcript rows whose
 * FIRST-EVER write was an ingest-failure stub.
 *
 * ## What went wrong
 *
 * `recordIngestFailure` creates a placeholder row with `harness: 'unknown'` and
 * no `started_at`. Those four metadata columns used to be INSERT-ONLY on the
 * ingest upsert (absent from its `onConflictDoUpdate` SET clause), so a
 * conversation whose first write was a failure kept the placeholders forever —
 * every later successful ingest merged its transcript in but could not repair
 * the metadata. mt#3278's self-healing reset then cleared the failure columns,
 * so nothing on the row recorded why it looked like that.
 *
 * The ingest-side fix (same PR) makes those columns fill-if-null, which stops
 * NEW rows from getting stuck. It does NOT fix rows already stuck: their
 * `started_at` stays NULL because an incremental ingest's own `extractStartedAt`
 * only sees lines since the high-water-mark, and `harness` stays `'unknown'`
 * only until the next successful ingest (the NULLIF makes that self-heal). This
 * script closes the `started_at` gap directly.
 *
 * ## Where the repaired value comes from
 *
 * From the row's OWN stored `transcript` JSONB — the minimum `timestamp` across
 * its entries — NOT from re-reading the source JSONL on disk. Same decision, and
 * for the same reason, as `backfill-agent-transcripts-model.ts`: the ingest path
 * has always retained every captured line in that column, so the data is already
 * durably in the DB with no dependency on whether the JSONL still exists.
 * Extraction happens IN SQL (`jsonb_array_elements`) rather than by pulling
 * blobs into the process — these rows are live conversations whose transcripts
 * are large, and the sibling model-backfill hit a statement timeout doing that.
 *
 * `harness` is set to `claude_code` for repaired rows. That is not a guess:
 * `'unknown'` has exactly ONE producer in the repo (`UNKNOWN_HARNESS`, in
 * `recordIngestFailure`), and BOTH ingest sources that write real rows
 * (`SingleFileTranscriptSource`, `ClaudeCodeTranscriptSource`) declare
 * `HARNESS = "claude_code"`. A row carrying the placeholder AND a non-empty
 * transcript was therefore ingested by one of those two. Rows with no transcript
 * are left alone — there is no evidence for them either way.
 *
 * ## Operational safety (CLAUDE.md §Operational Safety: Dry-Run First)
 *
 * - Dry-run by default; `--execute` required to write.
 * - Idempotent: every statement is scoped to `started_at IS NULL`, so a
 *   re-run (including after an interrupted one) only touches rows still broken.
 * - A row whose transcript yields no parseable timestamp is counted separately
 *   (`skippedNoTimestamp`) and left untouched — "repaired" and "nothing to
 *   recover from" are never conflated.
 * - `--verify-upsert` exercises the ingest-side fill-if-null SQL against the
 *   LIVE database on a scratch row and deletes it afterward. That branch is the
 *   only way to prove the COALESCE/NULLIF semantics actually work — a mocked DB
 *   records the SQL string without evaluating it.
 *
 * Usage:
 *   bun scripts/repair-transcript-metadata.ts                    # dry-run (default)
 *   bun scripts/repair-transcript-metadata.ts --execute --limit=1  # bounded first run
 *   bun scripts/repair-transcript-metadata.ts --execute          # apply to all recoverable rows
 *   bun scripts/repair-transcript-metadata.ts --verify-upsert    # live probe of the ingest fix
 *
 * @see mt#3342 — this task
 * @see packages/domain/src/transcripts/agent-transcript-ingest-service.ts — the ingest-side fix
 * @see scripts/backfill-agent-transcripts-model.ts — the sibling this mirrors
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

const UNKNOWN_HARNESS = "unknown";
const REAL_HARNESS = "claude_code";

/**
 * `db.execute(sql\`\`)` is untyped by construction — the raw escape hatch returns
 * driver rows with no schema to infer from. One narrowing helper keeps that
 * unavoidable assertion in a single named place instead of a double-cast at
 * every call site (`custom/no-excessive-as-unknown` flags the latter, and it is
 * right to: seven scattered casts hide which shape any given query returns).
 */
function rows<T>(result: unknown): T[] {
  return result as T[];
}

interface Args {
  execute: boolean;
  verifyUpsert: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got: ${limitArg}`);
  }
  return {
    execute: argv.includes("--execute"),
    verifyUpsert: argv.includes("--verify-upsert"),
    limit,
  };
}

/** Mirrors backfill-agent-transcripts-model.ts's bootstrapDb() convention for scripts/. */
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
    throw new Error("This repair requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("This repair requires an initialized Postgres database connection.");
  }
  return connection;
}

/**
 * Earliest entry timestamp per broken row, computed in SQL.
 *
 * `jsonb_typeof` guard: `transcript` is an array for every row the ingest path
 * wrote, but a defensive check costs nothing and a non-array would make
 * `jsonb_array_elements` raise, aborting the whole scan.
 *
 * The optional `limit` bounds the set IN SQL rather than by passing a JS array
 * of ids into an `= ANY(...)` predicate. That was the first implementation and
 * it FAILED against real Postgres — Drizzle's raw `sql` template inlines a JS
 * array as a single scalar param, so the driver reported
 * `malformed array literal: "agent-a19d37fd9d564fa88"`. Caught only because the
 * destructive branch was exercised on one row (mt#2776); the dry-run never runs
 * this statement and was perfectly green.
 */
function recoverableCte(limit?: number) {
  const bound = limit != null ? sql` ORDER BY recovered_started_at DESC LIMIT ${limit}` : sql``;
  return sql`
  SELECT t.agent_session_id,
         MIN((e ->> 'timestamp')::timestamptz) AS recovered_started_at
  FROM agent_transcripts t
  CROSS JOIN LATERAL jsonb_array_elements(t.transcript) AS e
  WHERE t.started_at IS NULL
    AND t.transcript IS NOT NULL
    AND jsonb_typeof(t.transcript) = 'array'
    AND (e ->> 'timestamp') IS NOT NULL
  GROUP BY t.agent_session_id${bound}
`;
}

interface Report {
  mode: "dry-run" | "execute";
  limit: number | null;
  brokenTotal: number;
  recoverable: number;
  skippedNoTimestamp: number;
  harnessPlaceholders: number;
  updated: number;
  remainingBroken: number;
  sample: { agentSessionId: string; recoveredStartedAt: string }[];
}

async function runRepair(
  db: PostgresJsDatabase,
  execute: boolean,
  limit?: number
): Promise<Report> {
  const brokenRows = await db.execute(
    sql`SELECT count(*)::int AS n,
               count(*) FILTER (WHERE harness = ${UNKNOWN_HARNESS})::int AS placeholders
        FROM agent_transcripts WHERE started_at IS NULL`
  );
  const brokenCounts = rows<{ n: number; placeholders: number }>(brokenRows)[0];
  const brokenTotal = Number(brokenCounts?.n ?? 0);
  const harnessPlaceholders = Number(brokenCounts?.placeholders ?? 0);

  const recoverableRows = rows<{ agent_session_id: string; recovered_started_at: string }>(
    await db.execute(
      sql`WITH recoverable AS (${recoverableCte()})
        SELECT agent_session_id, recovered_started_at FROM recoverable
        ORDER BY recovered_started_at DESC`
    )
  );

  const recoverable = recoverableRows.length;
  const sample = recoverableRows.slice(0, 5).map((r) => ({
    agentSessionId: r.agent_session_id,
    recoveredStartedAt: String(r.recovered_started_at),
  }));

  let updated = 0;
  if (execute && recoverable > 0) {
    // `--limit` bounds the blast radius so the destructive branch can be
    // exercised on a single row first (mt#2776: running only the dry-run never
    // executes this statement, so a failure here would ship unseen — and one
    // did, see recoverableCte's note). The bound is applied inside the CTE, and
    // its ordering matches the dry-run's sample, so a bounded run repairs the
    // rows the operator just previewed rather than an arbitrary subset.
    const result = rows<{ agent_session_id: string }>(
      await db.execute(
        sql`WITH recoverable AS (${recoverableCte(limit)})
          UPDATE agent_transcripts t
          SET started_at = r.recovered_started_at,
              harness = CASE WHEN t.harness = ${UNKNOWN_HARNESS} THEN ${REAL_HARNESS} ELSE t.harness END
          FROM recoverable r
          WHERE t.agent_session_id = r.agent_session_id
            AND t.started_at IS NULL
          RETURNING t.agent_session_id`
      )
    );
    updated = result.length;
  }

  const afterRows = await db.execute(
    sql`SELECT count(*)::int AS n FROM agent_transcripts WHERE started_at IS NULL`
  );
  const remainingBroken = Number(rows<{ n: number }>(afterRows)[0]?.n ?? 0);

  return {
    mode: execute ? "execute" : "dry-run",
    limit: limit ?? null,
    brokenTotal,
    recoverable,
    skippedNoTimestamp: brokenTotal - recoverable,
    harnessPlaceholders,
    updated,
    remainingBroken,
    sample,
  };
}

/**
 * Live probe of the INGEST-SIDE fix (mt#3342), on a scratch row that this
 * function creates and deletes.
 *
 * Reproduces the exact shape that produced the bug: a failure-stub row
 * (`harness='unknown'`, no `started_at`) followed by an upsert carrying real
 * values. Pre-fix the second write left both placeholders in place; post-fix
 * the COALESCE/NULLIF group fills them. This is the only check that evaluates
 * the raw SQL against a real Postgres — the semantics of `NULLIF` and
 * `EXCLUDED` cannot be exercised by a mocked db.
 */
async function verifyUpsertFillIfNull(db: PostgresJsDatabase): Promise<boolean> {
  const scratchId = `mt3342-verify-${Date.now()}-${process.pid}`;
  // ISO strings with an explicit ::timestamptz cast, NOT JS Dates: the raw
  // `db.execute(sql\`\`)` path passes params straight through to postgres.js,
  // which only serializes strings/Buffers and throws ERR_INVALID_ARG_TYPE on a
  // Date. (Drizzle's typed query builder converts Dates for you; this escape
  // hatch does not.)
  const realStartIso = "2020-01-02T03:04:05.000Z";
  const realStartMs = Date.parse(realStartIso);
  try {
    // 1. The failure stub: placeholder harness, no started_at.
    await db.execute(
      sql`INSERT INTO agent_transcripts (agent_session_id, harness, ingest_failure_count)
          VALUES (${scratchId}, ${UNKNOWN_HARNESS}, 1)`
    );

    // 2. A later successful ingest carrying real metadata, using the SAME
    //    fill-if-null SET clause the ingest service now issues.
    await db.execute(
      sql`INSERT INTO agent_transcripts (agent_session_id, harness, started_at, cwd)
          VALUES (${scratchId}, ${REAL_HARNESS}, ${realStartIso}::timestamptz, '/tmp/mt3342')
          ON CONFLICT (agent_session_id) DO UPDATE SET
            harness = COALESCE(NULLIF(agent_transcripts.harness, ${UNKNOWN_HARNESS}), EXCLUDED.harness),
            started_at = COALESCE(agent_transcripts.started_at, EXCLUDED.started_at),
            cwd = COALESCE(agent_transcripts.cwd, EXCLUDED.cwd)`
    );

    const queried = rows<{ harness: string; started_at: Date | string | null; cwd: string | null }>(
      await db.execute(
        sql`SELECT harness, started_at, cwd FROM agent_transcripts WHERE agent_session_id = ${scratchId}`
      )
    );
    const row = queried[0];

    const harnessOk = row?.harness === REAL_HARNESS;
    const startedOk = row?.started_at != null && new Date(row.started_at).getTime() === realStartMs;
    const cwdOk = row?.cwd === "/tmp/mt3342";

    // 3. Negative control: a SECOND upsert carrying a LATER start time must NOT
    //    regress the stored value. This is the half that makes it fill-if-null
    //    rather than overwrite-always, and an implementation that used a bare
    //    overwrite would pass every check above while failing this one.
    const laterStartIso = "2021-06-07T08:09:10.000Z";
    await db.execute(
      sql`INSERT INTO agent_transcripts (agent_session_id, harness, started_at)
          VALUES (${scratchId}, ${REAL_HARNESS}, ${laterStartIso}::timestamptz)
          ON CONFLICT (agent_session_id) DO UPDATE SET
            started_at = COALESCE(agent_transcripts.started_at, EXCLUDED.started_at)`
    );
    const afterProbeRows = rows<{ started_at: Date | string | null }>(
      await db.execute(
        sql`SELECT started_at FROM agent_transcripts WHERE agent_session_id = ${scratchId}`
      )
    );
    const noRegression =
      afterProbeRows[0]?.started_at != null &&
      new Date(afterProbeRows[0].started_at).getTime() === realStartMs;

    console.log(
      JSON.stringify(
        {
          check: "upsert-fill-if-null",
          scratchId,
          harnessRepaired: harnessOk,
          startedAtRepaired: startedOk,
          cwdRepaired: cwdOk,
          laterValueDidNotRegressStoredValue: noRegression,
          pass: harnessOk && startedOk && cwdOk && noRegression,
        },
        null,
        2
      )
    );
    return harnessOk && startedOk && cwdOk && noRegression;
  } finally {
    await db.execute(sql`DELETE FROM agent_transcripts WHERE agent_session_id = ${scratchId}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await bootstrapDb();

  if (args.verifyUpsert) {
    const ok = await verifyUpsertFillIfNull(db);
    process.exit(ok ? 0 : 1);
  }

  const report = await runRepair(db, args.execute, args.limit);
  console.log(JSON.stringify(report, null, 2));
  if (!args.execute) {
    console.log("\nDry-run only. Re-run with --execute to apply.");
  }
}

main().catch((err: unknown) => {
  console.error("repair-transcript-metadata failed:", err);
  process.exit(1);
});
