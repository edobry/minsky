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
import { isSqlCapable } from "@minsky/domain/persistence/types";

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
export interface TranscriptCoverageDeps {
  /**
   * Resolve the persistence provider to read through.
   *
   * Injected (mt#3600) so both branches — SQL-capable and not — are reachable
   * from a test without depending on what the DEVELOPER'S MACHINE happens to
   * have configured. Before this seam existed, `sweeps.test.ts` asserted the
   * not-measured path by assuming no provider was reachable; on a configured
   * machine that assumption is false, and the test read the live transcripts
   * table instead (2,540 rows at last observation). It passed alone and failed
   * whenever a sibling test in the same bun process had already initialized the
   * shared singleton — an order-dependent failure that blocked unrelated
   * commits.
   */
  getProvider: () => Promise<unknown>;
}

const defaultDeps: TranscriptCoverageDeps = {
  getProvider: async () => {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const svc = await getSharedPersistenceService();
    return svc.getProvider();
  },
};

export async function getTranscriptCoverage(
  deps: TranscriptCoverageDeps = defaultDeps
): Promise<TranscriptCoverage | null> {
  try {
    const provider = await deps.getProvider();

    if (!isSqlCapable(provider)) {
      return null;
    }

    // The null/typeof checks the old form spelled out are inside the guard (mt#4543),
    // which fails closed on both; the cast goes with the narrowing.
    const sqlProvider = provider;
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
