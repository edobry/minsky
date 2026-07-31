/**
 * Transcript legibility-coverage snapshot (mt#3441).
 *
 * `title` and `summary` are the human-legible layer of the transcript index —
 * what lets an operator answer "which conversation was the one about X". Both
 * are produced by sweepers, and a sweeper can be perfectly ALIVE while producing
 * nothing: `SummaryPipeline` had no automatic caller at all and sat at 11 of
 * 2,108 rows (0.5%) for months without any surface saying so.
 *
 * `/api/sweeps` already answers "is the sweeper running?". This answers "is it
 * actually producing?" — the same failure class one layer down, which is why the
 * two belong in one read rather than in separate places.
 */
import { log } from "@minsky/shared/logger";

/** Populated-field counts for `agent_transcripts`, plus derived percentages. */
export interface TranscriptCoverage {
  total: number;
  withTitle: number;
  withSummary: number;
  /** Percentage populated, 2dp. Derived here so every reader agrees on the math. */
  titlePct: number;
  summaryPct: number;
}

/**
 * Read coverage counts in ONE aggregate query.
 *
 * Returns null — never throws — when persistence is not SQL-capable or the query
 * fails, matching the degradation posture of the sweepers this reports on. A
 * null coverage block reads as "not measured", which is honestly different from
 * "measured as zero"; collapsing those two is the exact ambiguity that let the
 * 0.5% sit unnoticed.
 */
export async function getTranscriptCoverage(): Promise<TranscriptCoverage | null> {
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    if (
      !("getDatabaseConnection" in provider) ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      return null;
    }

    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<
        import("drizzle-orm/postgres-js").PostgresJsDatabase | null
      >;
    };
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return null;

    const { sql } = await import("drizzle-orm");
    const { agentTranscriptsTable } = await import(
      "@minsky/domain/storage/schemas/agent-transcripts-schema"
    );

    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        withTitle: sql<number>`count(${agentTranscriptsTable.title})::int`,
        withSummary: sql<number>`count(${agentTranscriptsTable.summary})::int`,
      })
      .from(agentTranscriptsTable);

    if (!row) return null;

    return {
      total: row.total,
      withTitle: row.withTitle,
      withSummary: row.withSummary,
      titlePct: pct(row.withTitle, row.total),
      summaryPct: pct(row.withSummary, row.total),
    };
  } catch (err) {
    // Logged, not swallowed: a coverage surface that silently returns null is
    // the same "looks fine, reports nothing" shape this task exists to remove.
    log.debug("cockpit: transcript coverage unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Percentage to 2dp; 0 when there is nothing to divide by. */
function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 10000) / 100;
}
