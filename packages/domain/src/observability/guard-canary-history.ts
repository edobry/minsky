/**
 * Guard canary history — repository + pure "broken since" derivation (mt#4007).
 *
 * Write side: append one row per EVALUATED canary outcome (never for a guard
 * with no declared canary — see the schema's doc comment for why absence,
 * not a stored "missing" state, is the never-verified signal).
 *
 * Read side: derive, per guard, one of three states from its history:
 *   - `never-verified` — zero rows for this guard.
 *   - `passing`        — the most recent row passed; carries `lastVerifiedAt`.
 *   - `broken`         — the most recent row failed; carries `brokenSinceAt`
 *                        (the earliest timestamp of the CURRENT contiguous
 *                        failure run, not the first failure ever seen) and
 *                        `lastCheckedAt` (the most recent failing run).
 *
 * The derivation itself (`deriveGuardCanaryStatus`) is a pure function over
 * an ordered row list — no DB, no I/O — so its three-state logic (and the
 * contiguous-run boundary in particular) is unit-testable without a live
 * Postgres connection, mirroring `canary-runner.ts`'s own
 * `evaluateCanaryOutcome` pure/impure split.
 *
 * @see mt#4007 — this module
 * @see packages/domain/src/storage/schemas/guard-canary-runs-schema.ts — the table
 * @see packages/domain/src/presence/repository.ts — the repository shape this mirrors
 * @see scripts/run-guard-canaries.ts — the writer
 */

import { desc, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { guardCanaryRunsTable } from "../storage/schemas/guard-canary-runs-schema";
import type { GuardCanaryRunRecord } from "../storage/schemas/guard-canary-runs-schema";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One evaluated canary outcome to record, for one guard, as part of one run. */
export interface GuardCanaryOutcomeInput {
  guardName: string;
  source: "registry" | "standalone";
  expects: string;
  passed: boolean;
  failureDetail?: string | null;
}

/** A minimal ordered-history row — the only shape `deriveGuardCanaryStatus` needs. */
export interface GuardCanaryHistoryRow {
  passed: boolean;
  ranAt: Date;
}

export type GuardCanaryStatus =
  | { state: "never-verified" }
  | { state: "passing"; lastVerifiedAt: string }
  | { state: "broken"; brokenSinceAt: string; lastCheckedAt: string };

// ---------------------------------------------------------------------------
// Pure derivation (no I/O — see module doc comment)
// ---------------------------------------------------------------------------

/**
 * Derive a guard's current canary status from its history, ordered
 * MOST-RECENT-FIRST (`rows[0]` is the latest run).
 *
 * "Broken since" is the earliest timestamp of the CURRENT contiguous failure
 * run — walking backward from the latest row while every row keeps failing —
 * NOT the first failure ever seen in the guard's whole history. A PASS
 * anywhere in the walk closes the contiguous run at the row just after it;
 * running out of rows (every recorded run failed) makes the oldest row the
 * boundary.
 */
export function deriveGuardCanaryStatus(rows: GuardCanaryHistoryRow[]): GuardCanaryStatus {
  if (rows.length === 0) return { state: "never-verified" };

  const latest = rows[0];
  if (!latest) return { state: "never-verified" };

  if (latest.passed) {
    return { state: "passing", lastVerifiedAt: latest.ranAt.toISOString() };
  }

  // Walk backward (rows are most-recent-first) while the run keeps failing.
  let brokenSince = latest;
  for (const row of rows) {
    if (!row.passed) {
      brokenSince = row;
    } else {
      break;
    }
  }

  return {
    state: "broken",
    brokenSinceAt: brokenSince.ranAt.toISOString(),
    lastCheckedAt: latest.ranAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

function toHistoryRow(row: GuardCanaryRunRecord): GuardCanaryHistoryRow {
  return { passed: row.passed, ranAt: row.ranAt };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for guard-canary-history persistence. Consumers depend on
 * this interface, not the concrete Drizzle implementation, so tests can
 * inject a fake.
 */
export interface GuardCanaryHistoryRepository {
  /**
   * Record every EVALUATED outcome from one canary pass. All rows share
   * `runId` and `ranAt` — the corpus baseline for that run is the resulting
   * set of `guardName` values. A no-op on an empty `outcomes` array (no
   * INSERT issued).
   */
  recordRun(runId: string, ranAt: Date, outcomes: GuardCanaryOutcomeInput[]): Promise<void>;

  /**
   * Batch status read for a set of guard names — ONE query, not N+1
   * (`efficient-database-queries.mdc`). Guards absent from the result map
   * carry `{ state: "never-verified" }` implicitly (the caller should treat
   * a missing map key the same as an explicit never-verified entry); this
   * method only returns entries for guards that have at least one row.
   */
  getGuardStatuses(guardNames: string[]): Promise<Map<string, GuardCanaryStatus>>;

  /** Convenience single-guard read, built on {@link getGuardStatuses}. */
  getGuardStatus(guardName: string): Promise<GuardCanaryStatus>;
}

// ---------------------------------------------------------------------------
// Drizzle / Postgres implementation
// ---------------------------------------------------------------------------

export class DrizzleGuardCanaryHistoryRepository implements GuardCanaryHistoryRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async recordRun(runId: string, ranAt: Date, outcomes: GuardCanaryOutcomeInput[]): Promise<void> {
    if (outcomes.length === 0) return;

    await this.db.insert(guardCanaryRunsTable).values(
      outcomes.map((outcome) => ({
        runId,
        guardName: outcome.guardName,
        source: outcome.source,
        expects: outcome.expects,
        passed: outcome.passed,
        failureDetail: outcome.failureDetail ?? null,
        ranAt,
      }))
    );
  }

  async getGuardStatuses(guardNames: string[]): Promise<Map<string, GuardCanaryStatus>> {
    const result = new Map<string, GuardCanaryStatus>();
    if (guardNames.length === 0) return result;

    // ONE query for every requested guard, ordered so each guard's rows are
    // already most-recent-first once grouped — avoids an N+1 per-guard query
    // (efficient-database-queries.mdc).
    const rows = await this.db
      .select()
      .from(guardCanaryRunsTable)
      .where(inArray(guardCanaryRunsTable.guardName, guardNames))
      .orderBy(desc(guardCanaryRunsTable.ranAt));

    const byGuard = new Map<string, GuardCanaryHistoryRow[]>();
    for (const row of rows) {
      const list = byGuard.get(row.guardName) ?? [];
      list.push(toHistoryRow(row));
      byGuard.set(row.guardName, list);
    }

    for (const [guardName, history] of byGuard) {
      result.set(guardName, deriveGuardCanaryStatus(history));
    }

    return result;
  }

  async getGuardStatus(guardName: string): Promise<GuardCanaryStatus> {
    const statuses = await this.getGuardStatuses([guardName]);
    return statuses.get(guardName) ?? { state: "never-verified" };
  }
}

// ---------------------------------------------------------------------------
// Helper: build a repository from a raw DB connection (mirrors
// buildPresenceClaimRepository / buildAskRepository — mt#2567 convention)
// ---------------------------------------------------------------------------

/**
 * Build a DrizzleGuardCanaryHistoryRepository from a raw database connection.
 * Returns null if db is absent; constructs unconditionally otherwise.
 */
export function buildGuardCanaryHistoryRepository(
  db: unknown
): DrizzleGuardCanaryHistoryRepository | null {
  if (!db) return null;
  return new DrizzleGuardCanaryHistoryRepository(db as PostgresJsDatabase);
}

/**
 * Re-exported so a caller doesn't need to reach into the schema module
 * directly for the table symbol (e.g. a future targeted single-guard query).
 */
export { guardCanaryRunsTable };
