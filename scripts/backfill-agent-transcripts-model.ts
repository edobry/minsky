#!/usr/bin/env bun
/**
 * mt#3089 backfill: populate `agent_transcripts.model` for historical rows.
 *
 * ## Backfill decision (recorded explicitly per mt#3089's spec)
 *
 * Historical rows are backfilled FROM THE ALREADY-STORED `agent_transcripts
 * .transcript` JSONB column — NOT by re-reading each session's on-disk JSONL
 * file. This is deliberately more robust than a disk-path-based backfill:
 * the ingest path has always retained every "user"/"assistant" line into
 * that column (see `agent-transcript-ingest-service.ts`), so the exact same
 * `message.model` data the fix now extracts at ingest time is ALREADY
 * durably present in the DB for every historical row that ever captured a
 * real assistant turn — no dependency on whether the source JSONL still
 * exists on disk (rotated, cleaned up, or captured on a different machine).
 * `extractModelFromNewLines` (the same pure function the ingest-time fix
 * uses) is reused unchanged against the stored array.
 *
 * A row whose stored transcript never contains a genuine (non-
 * `<synthetic>`) assistant `model` field stays NULL after this backfill —
 * this is CORRECT, not a gap: it means the session crashed/ended before any
 * real assistant turn, or (defensively) a captured line lacked the field
 * entirely. These rows are counted separately below (`skippedNoModel`) so
 * "updated" and "genuinely no model to find" are never conflated.
 *
 * ## Operational safety (mt#3089 R1 review)
 *
 * - **Idempotent, explicitly.** Every batch query is scoped to
 *   `model IS NULL` — an already-backfilled row is never re-selected, so
 *   re-running this script (including after an interrupted prior run) only
 *   ever touches rows still missing a value. No separate "already done"
 *   check is needed; the WHERE clause IS the check.
 * - **Per-row failures never abort the run.** Each row's extract+update is
 *   individually try/caught; a single bad row is counted in `failed` and
 *   the loop continues (unchanged from the original version of this
 *   script).
 * - **Batch-FETCH failures are now ALSO caught** (the actual gap the review
 *   found): a transient error fetching the NEXT page (the exact shape hit
 *   live during this task's own backfill run — a statement timeout on an
 *   early, unbounded attempt) used to propagate to `main()`'s outer
 *   `.catch()`, which printed one error line and exited non-zero with NO
 *   structured summary of the (possibly substantial) progress already made.
 *   Now: the failure is caught, `resumeAfterId` is set to the last
 *   successfully processed row's id, and the SAME structured JSON report
 *   below is still printed before exiting non-zero — so a crashed run is
 *   diagnosable and resumable (`--after-id=<resumeAfterId>`) instead of
 *   just a bare stack trace.
 * - **Extractor observability parity.** Reuses `countAssistantLines`
 *   (mt#3089 R1) to warn — the same way the ingest-time path now does —
 *   when a row's stored transcript has assistant lines but none carried a
 *   genuine model, distinguishing "genuinely no assistant turn ever
 *   captured" (unremarkable, the common `skippedNoModel` case) from
 *   "assistant lines present but extraction found nothing" (a possible
 *   transcript-shape drift worth a human look).
 *
 * Dry-run by default (CLAUDE.md §Operational Safety: Dry-Run First).
 *
 * Usage:
 *   bun scripts/backfill-agent-transcripts-model.ts                    # dry-run (count only)
 *   bun scripts/backfill-agent-transcripts-model.ts --execute          # apply
 *   bun scripts/backfill-agent-transcripts-model.ts --execute --batch-size=50
 *   bun scripts/backfill-agent-transcripts-model.ts --execute --after-id=<uuid>   # resume
 *
 * @see mt#3089 — this task
 * @see packages/domain/src/transcripts/agent-transcript-ingest-service.ts — extractModelFromNewLines, countAssistantLines
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";

/**
 * Deliberately small: each row's `transcript` JSONB can be large (a full
 * conversation), and this task's own live run hit a Postgres statement
 * timeout at batchSize=200 fetching full transcript blobs for 200 rows at
 * once. A small default keeps per-batch payload size — and therefore the
 * risk of hitting that same timeout — low; --batch-size is still available
 * for an operator who wants to trade batch count for per-batch risk.
 */
const DEFAULT_BATCH_SIZE = 20;

interface Args {
  execute: boolean;
  batchSize: number;
  afterId?: string;
}

function parseArgs(argv: string[]): Args {
  const execute = argv.includes("--execute");
  const batchSizeArg = argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchSizeArg
    ? Number(batchSizeArg.slice("--batch-size=".length))
    : DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`--batch-size must be a positive number, got: ${batchSizeArg}`);
  }
  const afterIdArg = argv.find((a) => a.startsWith("--after-id="));
  const afterId = afterIdArg ? afterIdArg.slice("--after-id=".length) : undefined;
  return { execute, batchSize, afterId };
}

/** Mirrors backfill-agent-transcript-turns.ts's bootstrapDb() convention for scripts/. */
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
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

/** Structured final report — printed on every exit path, success or failure. */
interface Report {
  mode: "dry-run" | "execute";
  scanned: number;
  updated: number;
  skippedNoModel: number;
  failed: number;
  /** Set only when a batch-FETCH (not a per-row) failure ended the run early. */
  batchFetchError?: string;
  /** Set alongside batchFetchError — pass as --after-id=<value> to resume. */
  resumeAfterId?: string;
}

function printReport(report: Report): void {
  console.log(JSON.stringify(report));
}

async function main(): Promise<void> {
  const { execute, batchSize, afterId } = parseArgs(process.argv.slice(2));

  const db = await bootstrapDb();
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { extractModelFromNewLines, countAssistantLines } = await import(
    "@minsky/domain/transcripts/agent-transcript-ingest-service"
  );

  const countRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_transcripts WHERE model IS NULL AND transcript IS NOT NULL
  `)) as Array<{ n: number }>;
  const nullModelRows = countRows[0]?.n ?? 0;

  console.log(
    `backfill-agent-transcripts-model ${execute ? "(EXECUTE)" : "(dry-run)"} batchSize=${batchSize}${afterId ? ` --after-id=${afterId}` : ""}`
  );
  console.log(`  candidate rows (model IS NULL, transcript IS NOT NULL): ${nullModelRows}`);
  console.log(
    "  idempotent: every batch is scoped to model IS NULL, so re-running (including after an interrupted prior run) only touches rows still missing a value"
  );

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply)");
    printReport({
      mode: "dry-run",
      scanned: nullModelRows,
      updated: 0,
      skippedNoModel: 0,
      failed: 0,
    });
    process.exit(0);
  }

  let scanned = 0;
  let updated = 0;
  let skippedNoModel = 0;
  let failed = 0;
  // afterId is a raw CLI boundary value (--after-id=<uuid>); brand it once
  // here per the documented Brand<> convention (packages/domain/src/ids.ts)
  // so downstream drizzle comparisons against the branded column type-check.
  let cursor: AgentSessionId | null = afterId ? (afterId as AgentSessionId) : null;

  for (;;) {
    let batch: Array<{ agentSessionId: AgentSessionId; transcript: unknown }>;
    try {
      batch = await db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
        })
        .from(agentTranscriptsTable)
        .where(
          cursor
            ? and(
                isNull(agentTranscriptsTable.model),
                isNotNull(agentTranscriptsTable.transcript),
                gt(agentTranscriptsTable.agentSessionId, cursor)
              )
            : and(isNull(agentTranscriptsTable.model), isNotNull(agentTranscriptsTable.transcript))
        )
        .orderBy(agentTranscriptsTable.agentSessionId)
        .limit(batchSize);
    } catch (err) {
      // mt#3089 R1 review: a batch-FETCH failure (e.g. a transient statement
      // timeout) must not crash out with only a bare stack trace — print the
      // SAME structured report the happy path prints, with a resume cursor,
      // then exit non-zero. Progress already made (updated/skippedNoModel/
      // failed so far) is real and reported, not lost.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  batch fetch failed after cursor=${cursor}: ${message}`);
      printReport({
        mode: "execute",
        scanned,
        updated,
        skippedNoModel,
        failed,
        batchFetchError: message,
        resumeAfterId: cursor ?? undefined,
      });
      process.exit(1);
    }

    if (batch.length === 0) break;

    for (const row of batch) {
      scanned++;
      try {
        const lines = Array.isArray(row.transcript) ? row.transcript : [];
        const typedLines = lines as Parameters<typeof extractModelFromNewLines>[0];
        const model = extractModelFromNewLines(typedLines);
        if (model) {
          await db
            .update(agentTranscriptsTable)
            .set({ model })
            .where(eq(agentTranscriptsTable.agentSessionId, row.agentSessionId));
          updated++;
        } else {
          skippedNoModel++;
          // Parity with the ingest-time observability fix (mt#3089 R1):
          // distinguish "no assistant turn ever captured" (unremarkable)
          // from "assistant lines present but none had a genuine model"
          // (a possible transcript-shape drift worth a human look).
          const assistantLineCount = countAssistantLines(typedLines);
          if (assistantLineCount > 0) {
            console.warn(
              `  no genuine model id found in ${assistantLineCount} assistant line(s) for session ${row.agentSessionId} — possible transcript-shape drift`
            );
          }
        }
      } catch (err) {
        failed++;
        console.error(
          `  error on ${row.agentSessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    cursor = batch[batch.length - 1]?.agentSessionId ?? cursor;
    console.log(
      `  batch: scanned=${scanned} updated=${updated} skippedNoModel=${skippedNoModel} failed=${failed} cursor=${cursor}`
    );
  }

  printReport({ mode: "execute", scanned, updated, skippedNoModel, failed });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    `backfill-agent-transcripts-model failed: ${err instanceof Error ? err.message : String(err)}`
  );
  if (err instanceof Error && err.cause) {
    console.error("cause:", JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause)));
  }
  process.exit(1);
});
