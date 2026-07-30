#!/usr/bin/env bun
/**
 * mt#3329 one-time backfill: populate `agent_tool_call_projection` from the
 * existing `agent_transcript_turns` corpus (~2,000 conversations at task
 * authoring time). Every conversation ingested BEFORE this task's projection
 * writer existed has turns with non-null `tool_calls` but zero rows in
 * `agent_tool_call_projection` — this script closes that gap for the
 * historical corpus. New conversations get projection rows automatically at
 * ingest time (see `AgentTranscriptIngestService` step 4e).
 *
 * Dry-run by default (CLAUDE.md §Operational Safety: Dry-Run First): reports
 * the number of PROJECTION ROWS that would be written (not just the turn
 * count — a turn with a parallel tool-call batch yields multiple rows), by
 * summing `jsonb_array_length(tool_calls)` over turns with no existing
 * projection row for that (session, turn).
 *
 * Robustness (mt#3360): the pending-count query guards `jsonb_array_length`
 * with a `jsonb_typeof(tool_calls) = 'array'` filter — some Apr-2026-ingested
 * rows store `tool_calls` as a jsonb STRING (double-encoded JSON), and
 * `jsonb_array_length` THROWS on a scalar, killing the whole query with no
 * useful error message (verified live 2026-07-30: the failure surfaced as
 * `Failed query: ...\nparams: ` with an EMPTY message — the real Postgres
 * error, "cannot get array length of a scalar", was sitting unprinted in
 * `err.cause`; see the top-level `.catch()` fix below). A separate,
 * `skippedNonArray` count reports how many non-null, non-array rows exist so
 * the operator can see the repair (`scripts/repair-double-encoded-tool-calls.ts`)
 * is the fix, not a script bug.
 *
 * Batched/bounded/resumable (mirrors `scripts/backfill-agent-transcript-turns.ts`
 * / mt#2457's precedent): drives `projectToolCallsForAllTranscripts`'s
 * keyset-paginated session-id batching instead of an unbounded full-corpus
 * scan. Progress is logged per batch; --after-id resumes an interrupted run.
 *
 * Idempotent: `ToolCallProjectionPipeline` upserts on
 * (agent_session_id, turn_index, ordinal); re-running (including a resumed
 * partial run) never duplicates rows.
 *
 * Sampled reconciliation (task spec AT2): after --execute (or standalone via
 * --verify-sample-only), --verify-sample=N (default 20; 0 disables) samples
 * N sessions that have projection rows, independently re-derives the
 * expected tool_use stream from `agent_transcript_turns.tool_calls` (using
 * the SAME pure helpers the pipeline uses — parseToolName /
 * computeArgFingerprint — so this proves the STORED rows are actually
 * correct, not merely that the code agrees with itself in one process run),
 * and reports any mismatch.
 *
 * Usage:
 *   bun scripts/backfill-agent-tool-call-projection.ts                        # dry-run (count only)
 *   bun scripts/backfill-agent-tool-call-projection.ts --execute              # apply, batched
 *   bun scripts/backfill-agent-tool-call-projection.ts --execute --batch-size=50
 *   bun scripts/backfill-agent-tool-call-projection.ts --execute --after-id=<uuid>   # resume
 *   bun scripts/backfill-agent-tool-call-projection.ts --verify-sample-only         # reconciliation only, no writes
 *   bun scripts/backfill-agent-tool-call-projection.ts --execute --verify-sample=50
 *
 * @see mt#3329 — this task; spec §Scope (backfill script, dry-run first), AT2
 * @see packages/domain/src/transcripts/tool-call-projection-pipeline.ts
 * @see scripts/backfill-agent-transcript-turns.ts — mt#2457 precedent this mirrors
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import type { ProjectAllToolCallsResult } from "@minsky/domain/transcripts/tool-call-projection-pipeline";

/** Default page size — mirrors tool-call-projection-pipeline.ts's default. */
const DEFAULT_BATCH_SIZE = 100;
/** Default sample size for post-execute reconciliation (task spec AT2). */
const DEFAULT_VERIFY_SAMPLE = 20;

interface Args {
  execute: boolean;
  afterId?: string;
  batchSize?: number;
  verifySample: number;
  verifySampleOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const execute = argv.includes("--execute");
  const verifySampleOnly = argv.includes("--verify-sample-only");
  const afterIdArg = argv.find((a) => a.startsWith("--after-id="));
  const afterId = afterIdArg ? afterIdArg.slice("--after-id=".length) : undefined;
  const batchSizeArg = argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchSizeArg ? Number(batchSizeArg.slice("--batch-size=".length)) : undefined;
  if (batchSize !== undefined && (!Number.isFinite(batchSize) || batchSize <= 0)) {
    throw new Error(`--batch-size must be a positive number, got: ${batchSizeArg}`);
  }
  const verifySampleArg = argv.find((a) => a.startsWith("--verify-sample="));
  const verifySample = verifySampleArg
    ? Number(verifySampleArg.slice("--verify-sample=".length))
    : DEFAULT_VERIFY_SAMPLE;
  if (!Number.isFinite(verifySample) || verifySample < 0) {
    throw new Error(`--verify-sample must be a non-negative number, got: ${verifySampleArg}`);
  }
  return { execute, afterId, batchSize, verifySample, verifySampleOnly };
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

  // Duck-typed guard (mirrors scripts/backfill-agent-transcript-turns.ts's PR
  // #2110 R1 fix) — not `instanceof PersistenceProvider`, which can
  // false-negative across a dual-package hazard.
  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

/**
 * Dry-run headline number: PROJECTION ROWS (not turns) that --execute would
 * write.
 *
 * Compares each turn's expected block count (`jsonb_array_length(tool_calls)`)
 * against its ACTUAL projected row count (a LEFT JOIN aggregate, not an
 * existence check) — a turn counts as pending whenever those two numbers
 * differ, which covers BOTH the zero-projected case (a turn ingested before
 * this task's writer existed) AND the partially-projected case (e.g. an
 * earlier interrupted backfill run left some, but not all, of a turn's
 * tool_use blocks written). An earlier version of this query used
 * `NOT EXISTS (... projection row for this turn ...)`, which only detects the
 * zero-projected case — a partially-projected turn already has at least one
 * row, so `NOT EXISTS` is false for it and the deficit silently disappears
 * from the count. `pending_rows` reports the actual DEFICIT (expected minus
 * actual), not the full per-turn block count, so it matches the number of
 * rows `--execute` will actually need to write/repair.
 */
export interface PendingProjectionCounts {
  pendingTurns: number;
  pendingRows: number;
  /**
   * Turns with a non-null `tool_calls` that is NOT a jsonb array (mt#3360) —
   * excluded from `pendingTurns`/`pendingRows` (they can't be measured via
   * `jsonb_array_length`, which throws on a scalar) and reported separately
   * so the count isn't silently short.
   */
  skippedNonArray: number;
}

export async function countPendingProjectionRows(
  db: PostgresJsDatabase
): Promise<PendingProjectionCounts> {
  const rows = (await db.execute(sql`
    SELECT
      count(*)::int AS pending_turns,
      COALESCE(sum(jsonb_array_length(t.tool_calls) - COALESCE(p.projected_count, 0)), 0)::int AS pending_rows
    FROM agent_transcript_turns t
    LEFT JOIN (
      SELECT agent_session_id, turn_index, count(*)::int AS projected_count
      FROM agent_tool_call_projection
      GROUP BY agent_session_id, turn_index
    ) p ON p.agent_session_id = t.agent_session_id AND p.turn_index = t.turn_index
    WHERE t.tool_calls IS NOT NULL
      AND jsonb_typeof(t.tool_calls) = 'array'
      AND jsonb_array_length(t.tool_calls) > COALESCE(p.projected_count, 0)
  `)) as Array<Record<string, unknown>>;
  const pendingTurns = Number(rows?.[0]?.pending_turns ?? 0);
  const pendingRows = Number(rows?.[0]?.pending_rows ?? 0);

  const skippedRows = (await db.execute(sql`
    SELECT count(*)::int AS skipped_non_array
    FROM agent_transcript_turns
    WHERE tool_calls IS NOT NULL
      AND jsonb_typeof(tool_calls) <> 'array'
  `)) as Array<Record<string, unknown>>;
  const skippedNonArray = Number(skippedRows?.[0]?.skipped_non_array ?? 0);

  return { pendingTurns, pendingRows, skippedNonArray };
}

interface ReconciliationResult {
  sessionsSampled: number;
  sessionsMatched: number;
  sessionsMismatched: number;
  mismatchDetails: string[];
}

/**
 * Sampled reconciliation (task spec AT2): pick `sampleSize` sessions that
 * have at least one projection row, independently re-derive the expected
 * tool_use stream directly from `agent_transcript_turns.tool_calls` (using
 * the SAME pure helpers the pipeline uses), and compare against the STORED
 * `agent_tool_call_projection` rows for that session.
 */
async function runSampleReconciliation(
  db: PostgresJsDatabase,
  sampleSize: number
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    sessionsSampled: 0,
    sessionsMatched: 0,
    sessionsMismatched: 0,
    mismatchDetails: [],
  };
  if (sampleSize <= 0) return result;

  const { parseToolName, computeArgFingerprint } = await import(
    "@minsky/domain/transcripts/tool-call-projection-fields"
  );

  const sampledSessions = (await db.execute(sql`
    SELECT DISTINCT agent_session_id
    FROM agent_tool_call_projection
    ORDER BY random()
    LIMIT ${sampleSize}
  `)) as Array<{ agent_session_id: string }>;

  result.sessionsSampled = sampledSessions.length;

  for (const { agent_session_id: sessionId } of sampledSessions) {
    const turnRows = (await db.execute(sql`
      SELECT turn_index, tool_calls
      FROM agent_transcript_turns
      WHERE agent_session_id = ${sessionId} AND tool_calls IS NOT NULL
      ORDER BY turn_index ASC
    `)) as Array<{ turn_index: number; tool_calls: unknown }>;

    interface ExpectedRow {
      turnIndex: number;
      ordinal: number;
      toolName: string;
      server: string | null;
      argFingerprint: string;
    }
    const expected: ExpectedRow[] = [];
    for (const row of turnRows) {
      const blocks = row.tool_calls;
      if (!Array.isArray(blocks)) continue;
      blocks.forEach((block: Record<string, unknown>, ordinal: number) => {
        if (!block || typeof block.name !== "string" || block.name.length === 0) return;
        const { server, name } = parseToolName(block.name);
        expected.push({
          turnIndex: row.turn_index,
          ordinal,
          toolName: name,
          server,
          argFingerprint: computeArgFingerprint(block.input),
        });
      });
    }

    const actualRows = (await db.execute(sql`
      SELECT turn_index, ordinal, tool_name, server, arg_fingerprint
      FROM agent_tool_call_projection
      WHERE agent_session_id = ${sessionId}
      ORDER BY turn_index ASC, ordinal ASC
    `)) as Array<{
      turn_index: number;
      ordinal: number;
      tool_name: string;
      server: string | null;
      arg_fingerprint: string;
    }>;

    let mismatch: string | null = null;
    if (actualRows.length !== expected.length) {
      mismatch = `row count mismatch: expected ${expected.length}, got ${actualRows.length}`;
    } else {
      for (let i = 0; i < expected.length; i++) {
        const exp = expected[i];
        const act = actualRows[i];
        if (
          !exp ||
          !act ||
          exp.turnIndex !== act.turn_index ||
          exp.ordinal !== act.ordinal ||
          exp.toolName !== act.tool_name ||
          (exp.server ?? null) !== (act.server ?? null) ||
          exp.argFingerprint !== act.arg_fingerprint
        ) {
          mismatch = `divergence at index ${i}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`;
          break;
        }
      }
    }

    if (mismatch) {
      result.sessionsMismatched++;
      result.mismatchDetails.push(`${sessionId}: ${mismatch}`);
    } else {
      result.sessionsMatched++;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const { execute, afterId, batchSize, verifySample, verifySampleOnly } = parseArgs(
    process.argv.slice(2)
  );

  const db = await bootstrapDb();

  if (verifySampleOnly) {
    console.log(`backfill-agent-tool-call-projection (VERIFY-SAMPLE-ONLY, n=${verifySample})`);
    const reconciliation = await runSampleReconciliation(db, verifySample);
    console.log(JSON.stringify({ mode: "verify-sample-only", ...reconciliation }));
    process.exit(reconciliation.sessionsMismatched > 0 ? 1 : 0);
  }

  const before = await countPendingProjectionRows(db);
  console.log(
    `backfill-agent-tool-call-projection ${execute ? "(EXECUTE)" : "(dry-run)"}${
      afterId ? ` --after-id=${afterId}` : ""
    }`
  );
  console.log(`  pending turns (no projection yet):  ${before.pendingTurns}`);
  console.log(`  pending projection rows to write:   ${before.pendingRows}`);
  console.log(`  skipped (non-array tool_calls):     ${before.skippedNonArray}`);

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply the batched backfill)");
    console.log(
      JSON.stringify({
        mode: "dry-run",
        pendingTurns: before.pendingTurns,
        pendingRows: before.pendingRows,
        skippedNonArray: before.skippedNonArray,
      })
    );
    process.exit(0);
  }

  console.log(
    `  running batched projection sweep (batchSize=${batchSize ?? DEFAULT_BATCH_SIZE})...`
  );

  const { projectToolCallsForAllTranscripts } = await import(
    "@minsky/domain/transcripts/tool-call-projection-pipeline"
  );

  let batchCount = 0;
  const result: ProjectAllToolCallsResult = await projectToolCallsForAllTranscripts(db, {
    batchSize,
    afterId,
    onBatchComplete: (partial, lastId) => {
      batchCount++;
      console.log(
        `    batch ${batchCount}: sessionsScanned=${partial.sessionsScanned} ` +
          `sessionsProcessed=${partial.sessionsProcessed} sessionsErrored=${partial.sessionsErrored} ` +
          `turnsScanned=${partial.turnsScanned} toolCallsProjected=${partial.toolCallsProjected} ` +
          `skippedNonArray=${partial.skippedNonArray} lastId=${lastId}`
      );
    },
  });

  console.log("  backfill complete:", JSON.stringify(result));

  const after = await countPendingProjectionRows(db);
  console.log(`  pending projection rows (after):    ${after.pendingRows}`);
  console.log(`  skipped (non-array tool_calls, after): ${after.skippedNonArray}`);

  let reconciliation: ReconciliationResult | undefined;
  if (verifySample > 0) {
    console.log(`  running sampled reconciliation (n=${verifySample})...`);
    reconciliation = await runSampleReconciliation(db, verifySample);
    console.log(
      `  reconciliation: sampled=${reconciliation.sessionsSampled} ` +
        `matched=${reconciliation.sessionsMatched} mismatched=${reconciliation.sessionsMismatched}`
    );
    if (reconciliation.mismatchDetails.length > 0) {
      console.warn("  MISMATCHES:", JSON.stringify(reconciliation.mismatchDetails));
    }
  }

  console.log(
    JSON.stringify({
      mode: "execute",
      pendingRowsBefore: before.pendingRows,
      pendingRowsAfter: after.pendingRows,
      skippedNonArrayBefore: before.skippedNonArray,
      skippedNonArrayAfter: after.skippedNonArray,
      ...result,
      reconciliation,
    })
  );

  const failed = result.sessionsErrored > 0 || (reconciliation?.sessionsMismatched ?? 0) > 0;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  // mt#3360: drizzle-orm's postgres-js driver wraps a failed query in a
  // `DrizzleQueryError` whose OWN `.message` is just "Failed query: <sql>\n
  // params: <params>" — the underlying Postgres error (e.g. "cannot get
  // array length of a scalar") lives on `.cause`, and printing only
  // `err.message` (as this catch previously did) surfaced the query text
  // with an effectively empty error, costing real diagnosis time. Print
  // both.
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  const causeMessage =
    cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;
  console.error(
    `backfill-agent-tool-call-projection failed: ${message}${
      causeMessage ? `\n  caused by: ${causeMessage}` : ""
    }`
  );
  process.exit(1);
});
