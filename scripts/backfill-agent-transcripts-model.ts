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
 * entirely. These rows are counted separately below so "backfilled" and
 * "genuinely no model to find" are never conflated.
 *
 * Dry-run by default (CLAUDE.md §Operational Safety: Dry-Run First). This is
 * an UPDATE-only backfill over rows already scoped to `model IS NULL` — it
 * can never regress an already-populated value, and it is idempotent
 * (re-running only re-derives the same value for rows still NULL).
 *
 * Usage:
 *   bun scripts/backfill-agent-transcripts-model.ts              # dry-run (count only)
 *   bun scripts/backfill-agent-transcripts-model.ts --execute     # apply
 *   bun scripts/backfill-agent-transcripts-model.ts --execute --batch-size=200
 *
 * @see mt#3089 — this task
 * @see packages/domain/src/transcripts/agent-transcript-ingest-service.ts — extractModelFromNewLines
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

const DEFAULT_BATCH_SIZE = 200;

interface Args {
  execute: boolean;
  batchSize: number;
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
  return { execute, batchSize };
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

  const hasSqlCapability =
    !!persistence && !!(persistence as { capabilities?: { sql?: boolean } }).capabilities?.sql;
  const hasGetDatabaseConnection =
    !!persistence &&
    typeof (persistence as { getDatabaseConnection?: unknown }).getDatabaseConnection ===
      "function";
  if (!hasSqlCapability || !hasGetDatabaseConnection) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await (
    persistence as { getDatabaseConnection: () => Promise<PostgresJsDatabase | null> }
  ).getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

async function main(): Promise<void> {
  const { execute, batchSize } = parseArgs(process.argv.slice(2));

  const db = await bootstrapDb();
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { extractModelFromNewLines } = await import(
    "@minsky/domain/transcripts/agent-transcript-ingest-service"
  );

  const countRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_transcripts WHERE model IS NULL AND transcript IS NOT NULL
  `)) as Array<{ n: number }>;
  const nullModelRows = countRows[0]?.n ?? 0;

  console.log(
    `backfill-agent-transcripts-model ${execute ? "(EXECUTE)" : "(dry-run)"} batchSize=${batchSize}`
  );
  console.log(`  candidate rows (model IS NULL, transcript IS NOT NULL): ${nullModelRows}`);

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply)");
    console.log(JSON.stringify({ mode: "dry-run", candidateRows: nullModelRows }));
    process.exit(0);
  }

  let scanned = 0;
  let backfilled = 0;
  let noModelFound = 0;
  let errored = 0;
  let cursor: string | null = null;

  for (;;) {
    const batch: Array<{ agentSessionId: string; transcript: unknown }> = await db
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

    if (batch.length === 0) break;

    for (const row of batch) {
      scanned++;
      try {
        const lines = Array.isArray(row.transcript) ? row.transcript : [];
        const model = extractModelFromNewLines(
          lines as Parameters<typeof extractModelFromNewLines>[0]
        );
        if (model) {
          await db
            .update(agentTranscriptsTable)
            .set({ model })
            .where(eq(agentTranscriptsTable.agentSessionId, row.agentSessionId));
          backfilled++;
        } else {
          noModelFound++;
        }
      } catch (err) {
        errored++;
        console.error(
          `  error on ${row.agentSessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    cursor = batch[batch.length - 1]?.agentSessionId ?? cursor;
    console.log(
      `  batch: scanned=${scanned} backfilled=${backfilled} noModelFound=${noModelFound} errored=${errored} cursor=${cursor}`
    );
  }

  console.log(JSON.stringify({ mode: "execute", scanned, backfilled, noModelFound, errored }));
  process.exit(errored > 0 ? 1 : 0);
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
