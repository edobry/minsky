#!/usr/bin/env bun
/**
 * mt#2457 backfill: reconcile `agent_transcript_turns` for the historical
 * `agent_transcripts` rows (mostly the 2026-04-27 → 2026-06-08 window; ~651
 * measured 2026-07-20) that were ingested before extraction-on-capture
 * existed (pre-ADR-019/mt#2381) and therefore never got their turns
 * materialized. Both search tools (`transcripts_search-text` FTS,
 * `transcripts_search` semantic) are blind to any session with zero turn
 * rows, regardless of how much raw transcript content it holds.
 *
 * Dry-run by default (CLAUDE.md §Operational Safety: Dry-Run First): counts
 * how many `agent_transcripts` rows currently have a non-null `transcript`
 * but zero rows in `agent_transcript_turns` (the task spec's Acceptance
 * Test 1 query) and compares that count to the ~651 baseline measured
 * 2026-07-20. If the count diverges beyond ~2x from that baseline, this
 * script STOPS instead of proceeding to --execute — per
 * `operational-safety-dry-run-first.mdc §Dry-run scope-match check`, a
 * magnitude beyond what was approved is a stop signal, not something the
 * heuristic should quietly absorb.
 *
 * Batched/bounded/resumable (mt#2457 perf constraint): drives
 * `extractTurnsForAllTranscripts`'s keyset-paginated batching
 * (packages/domain/src/transcripts/turn-writer.ts) instead of the prior
 * unbatched full-corpus load, which did not complete in 280s locally
 * against ~1,584 large-JSONB rows. Progress is logged per batch; --after-id
 * resumes a run that was interrupted partway through.
 *
 * Usage:
 *   bun scripts/backfill-agent-transcript-turns.ts                       # dry-run (count only)
 *   bun scripts/backfill-agent-transcript-turns.ts --execute             # apply, batched
 *   bun scripts/backfill-agent-transcript-turns.ts --execute --batch-size=50
 *   bun scripts/backfill-agent-transcript-turns.ts --execute --after-id=<uuid>   # resume
 *
 * Idempotent: `extractTurnsForAllTranscripts` upserts turn rows
 * (embedding-preserving); re-running (including after a resumed partial run)
 * never duplicates rows or clobbers an already-filled embedding.
 *
 * @see mt#2457 — this task; spec §Success Criteria 2, §Scope perf constraint
 * @see packages/domain/src/transcripts/turn-writer.ts — extractTurnsForAllTranscripts
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import type { ExtractAllTurnsResult } from "@minsky/domain/transcripts/turn-writer";

/** Baseline zero-turn-row count measured 2026-07-20 (task spec §Summary). */
const EXPECTED_BASELINE = 651;
/** Scope-match divergence factor (operational-safety-dry-run-first.mdc). */
const DIVERGENCE_FACTOR = 2;
/** Default page size for the reconciliation sweep (mirrors turn-writer.ts's default). */
const DEFAULT_BATCH_SIZE = 100;

interface Args {
  execute: boolean;
  afterId?: string;
  batchSize?: number;
}

function parseArgs(argv: string[]): Args {
  const execute = argv.includes("--execute");
  const afterIdArg = argv.find((a) => a.startsWith("--after-id="));
  const afterId = afterIdArg ? afterIdArg.slice("--after-id=".length) : undefined;
  const batchSizeArg = argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchSizeArg ? Number(batchSizeArg.slice("--batch-size=".length)) : undefined;
  if (batchSize !== undefined && (!Number.isFinite(batchSize) || batchSize <= 0)) {
    throw new Error(`--batch-size must be a positive number, got: ${batchSizeArg}`);
  }
  return { execute, afterId, batchSize };
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

  // Duck-typed guard (mt#2457 R1 review; mirrors scripts/backfill-session-short-ids.ts /
  // scripts/backfill-memory-short-ids.ts / scripts/backfill-ask-short-ids.ts's PR #2110 R1
  // fix), not `instanceof PersistenceProvider`: an `instanceof` check against a class
  // pulled in via a dynamic `import()` can false-negative when the resolved object was
  // constructed from a DIFFERENT instance of the same module (dual-package hazard) — the
  // check then silently rejects a perfectly valid provider. Check for the actual
  // capability/method this script needs instead.
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

/** Acceptance Test 1's exact query: non-null-transcript rows with zero extracted turns. */
async function countZeroTurnRows(db: PostgresJsDatabase): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM agent_transcripts a
    WHERE a.transcript IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_transcript_turns t WHERE t.agent_session_id = a.agent_session_id
      )
  `)) as Array<Record<string, unknown>>;
  const n = rows?.[0]?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

async function main(): Promise<void> {
  const { execute, afterId, batchSize } = parseArgs(process.argv.slice(2));

  const db = await bootstrapDb();

  const before = await countZeroTurnRows(db);
  console.log(
    `backfill-agent-transcript-turns ${execute ? "(EXECUTE)" : "(dry-run)"}${
      afterId ? ` --after-id=${afterId}` : ""
    }`
  );
  console.log(`  zero-turn non-null-transcript rows (current): ${before}`);
  console.log(`  expected baseline (measured 2026-07-20):      ~${EXPECTED_BASELINE}`);

  // Scope-match check (operational-safety-dry-run-first.mdc §Dry-run scope-match
  // check): a magnitude beyond ~2x what was approved is a STOP, not something
  // to quietly proceed past. A before-count of 0 is not a divergence — it just
  // means a prior run already reconciled the corpus (idempotent no-op ahead).
  const ratio = before / EXPECTED_BASELINE;
  if (before > 0 && (ratio > DIVERGENCE_FACTOR || ratio < 1 / DIVERGENCE_FACTOR)) {
    console.error(
      [
        `STOP: current zero-turn count (${before}) diverges beyond ~${DIVERGENCE_FACTOR}x`,
        `from the approved baseline (~${EXPECTED_BASELINE}); re-confirm scope with the`,
        `operator before running --execute (operational-safety-dry-run-first.mdc scope-match gate).`,
      ].join(" ")
    );
    process.exit(1);
  }

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply the batched reconciliation)");
    console.log(
      JSON.stringify({ mode: "dry-run", zeroTurnRowsBefore: before, baseline: EXPECTED_BASELINE })
    );
    process.exit(0);
  }

  console.log(
    `  running batched extraction reconciliation (batchSize=${batchSize ?? DEFAULT_BATCH_SIZE})...`
  );

  const { extractTurnsForAllTranscripts } = await import("@minsky/domain/transcripts/turn-writer");

  let batchCount = 0;
  const result: ExtractAllTurnsResult = await extractTurnsForAllTranscripts(db, {
    batchSize,
    afterId,
    onBatchComplete: (partial, lastId) => {
      batchCount++;
      console.log(
        `    batch ${batchCount}: scanned=${partial.transcriptsScanned} ` +
          `processed=${partial.transcriptsProcessed} skipped=${partial.transcriptsSkipped} ` +
          `nonEmptyYieldedZero=${partial.nonEmptyYieldedZero} errored=${partial.transcriptsErrored} ` +
          `turnsWritten=${partial.turnsWritten} lastId=${lastId}`
      );
    },
  });

  console.log("  reconciliation complete:", JSON.stringify(result));

  if (result.nonEmptyYieldedZero > 0) {
    console.warn(
      `  WARNING: ${result.nonEmptyYieldedZero} non-empty transcript(s) yielded zero turns during ` +
        `this run — an extraction failure, not a genuinely-empty skip. Investigate before assuming ` +
        `the corpus is fully reconciled (see turn-writer.ts's writeTurnsForTranscript WARN logs).`
    );
  }

  const after = await countZeroTurnRows(db);
  console.log(`  zero-turn non-null-transcript rows (after):   ${after}`);

  console.log(
    JSON.stringify({
      mode: "execute",
      zeroTurnRowsBefore: before,
      zeroTurnRowsAfter: after,
      ...result,
    })
  );

  process.exit(result.transcriptsErrored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    `backfill-agent-transcript-turns failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
