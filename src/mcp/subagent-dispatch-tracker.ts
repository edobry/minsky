/**
 * Subagent Dispatch Tracker
 *
 * Read-write layer for the `subagent_invocations` table (schema defined in
 * mt#1735). Exposes three public surfaces:
 *
 *   - `recordSubagentInvocation(input)` — insert or upsert one invocation row.
 *   - `getCadence()` — aggregate statistics from the DB (total, byOutcome,
 *     byAgentType, byHourLast24h, lastDispatch).
 *   - `getEscalation()` — apply threshold rules and return an escalation tier.
 *
 * Design (mt#1736):
 *   - DB-only: no in-memory ring buffer, no JSONL file. The Postgres table is
 *     the single source of truth. Aggregations are computed on read via SQL.
 *   - Escalation tiers (first-week calibrated defaults):
 *       "session" — > SESSION_PARTIAL_UNCOMMITTED_THRESHOLD
 *                    `partial-uncommitted-no-handoff` outcomes in the most
 *                    recent parent session (the most recent `parentSessionId`
 *                    value seen in the table).
 *       "daily"   — > DAILY_PARTIAL_UNCOMMITTED_THRESHOLD
 *                    `partial-uncommitted-no-handoff` outcomes in last 24h,
 *                    OR > DAILY_RATE_LIMITED_THRESHOLD `rate-limited` outcomes
 *                    in last 24h.
 *       "none"    — below all thresholds.
 *   - DI pattern: the tracker takes a `PostgresJsDatabase` in its constructor.
 *     Callers (composition root, tests) inject the correct instance. No
 *     tsyringe at this layer — the tracker is instantiated by the MCP server's
 *     composition root where the DB instance is already available.
 *
 * Architectural template: `src/mcp/disconnect-tracker.ts` (mt#1682).
 * Departure from template: DB-only instead of in-memory + JSONL.
 *
 * @see mt#1735 — subagent_invocations schema + migration (foundation)
 * @see mt#1736 — this file
 * @see mt#1737 — SubagentStop hook + workspace classifier
 * @see mt#1738 — debug surface + docs
 * @see mt#1005 — parent epic: Persist subagent execution history
 */

import { and, count, desc, gte, sql, eq, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  subagentInvocationsTable,
  type SubagentInvocationInsert,
  type SubagentInvocationOutcome,
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
} from "../domain/storage/schemas/subagent-invocations-schema";
import { log } from "../utils/logger";
import { getErrorMessage } from "../errors/index";

// ---------------------------------------------------------------------------
// Escalation threshold constants (tunable from a single place)
// ---------------------------------------------------------------------------

/**
 * Session-lifetime threshold for `partial-uncommitted-no-handoff` outcomes.
 * More than this many in the most recent parent session triggers "session"
 * escalation. Calibrated for first-week defaults: 2 failures in one session
 * is noise; 3 is a pattern.
 */
export const SESSION_PARTIAL_UNCOMMITTED_THRESHOLD = 2;

/**
 * 24-hour threshold for `partial-uncommitted-no-handoff` outcomes.
 * More than this many in the last 24h triggers "daily" escalation.
 * Calibrated: 5/day is already load-bearing at first-week dispatch cadence.
 */
export const DAILY_PARTIAL_UNCOMMITTED_THRESHOLD = 5;

/**
 * 24-hour threshold for `rate-limited` outcomes.
 * More than this many in the last 24h triggers "daily" escalation.
 * 3 rate-limit hits/day suggests a structural capacity problem.
 */
export const DAILY_RATE_LIMITED_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input shape for `recordSubagentInvocation`. All fields are taken from
 * `SubagentInvocationInsert` (the Drizzle insert type). Re-exported here so
 * callers only need to import from this module.
 *
 * The only required fields are those declared `.notNull()` in the schema:
 * `taskId`, `agentType`, `outcome`, `startedAt`. Everything else is optional.
 */
export type SubagentInvocationInput = SubagentInvocationInsert;

/**
 * Aggregated cadence statistics returned by `getCadence()`.
 *
 * - `total` — total rows in the table (all-time, not windowed).
 * - `lastDispatch` — ISO-8601 timestamp of the most recent `startedAt`, or
 *   null if the table is empty.
 * - `byOutcome` — count per outcome class (all 6 enum values present,
 *   defaulting to 0 for classes with no rows).
 * - `byAgentType` — count per `agentType` string.
 * - `byHourLast24h` — array of `{ hour: string; count: number }` where `hour`
 *   is an ISO-8601 truncated timestamp (hourly granularity, UTC). Only hours
 *   with at least one row are included.
 */
export interface SubagentDispatchCadence {
  /** Total rows in the table (all-time). */
  total: number;
  /** ISO-8601 timestamp of the most recent startedAt, or null. */
  lastDispatch: string | null;
  /** Count per outcome class. All 6 classes are always present. */
  byOutcome: Record<SubagentInvocationOutcome, number>;
  /** Count per agentType. Only types that appear in the table. */
  byAgentType: Record<string, number>;
  /** Hourly dispatch counts for the last 24 hours. Hours with 0 rows omitted. */
  byHourLast24h: Array<{ hour: string; count: number }>;
}

// ---------------------------------------------------------------------------
// SubagentDispatchTracker
// ---------------------------------------------------------------------------

/**
 * Read-write layer for the `subagent_invocations` table.
 *
 * Instantiate once per composition context (MCP server, test). Inject a
 * `PostgresJsDatabase` instance at construction time.
 *
 * All public methods are async and fail-safe: a DB error causes a log warning
 * and a safe return (empty aggregates, "none" escalation), never a throw. This
 * matches the fail-safe contract of `DisconnectTracker`'s file I/O layer.
 */
export class SubagentDispatchTracker {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Insert a new invocation row, or update an existing one identified by
   * `subagentSessionId`.
   *
   * Upsert semantics:
   *   - When `input.subagentSessionId` is set: look for an existing row with
   *     that value. If found, UPDATE all mutable fields. If not found, INSERT.
   *   - When `input.subagentSessionId` is null/undefined: always INSERT a new row.
   *     The table has no unique constraint on `subagent_session_id` (it is a
   *     non-unique index), so null-keyed rows cannot be de-duplicated at the DB
   *     constraint layer — callers must manage their own deduplication.
   *
   * All fields present in `input` are written. Fields absent from `input`
   * (optional schema columns) are left as their DB defaults (NULL).
   *
   * Errors are swallowed and logged — this matches the fail-safe contract of
   * `DisconnectTracker`'s I/O layer.
   *
   * @param input  The invocation record to persist.
   */
  async recordSubagentInvocation(input: SubagentInvocationInput): Promise<void> {
    try {
      if (input.subagentSessionId != null) {
        // Upsert path: check for an existing row by subagentSessionId.
        const existing = await this.db
          .select({ id: subagentInvocationsTable.id })
          .from(subagentInvocationsTable)
          .where(eq(subagentInvocationsTable.subagentSessionId, input.subagentSessionId))
          .limit(1);

        if (existing.length > 0) {
          // UPDATE the existing row — preserve `id` and `startedAt` (insert-only).
          const { id: _id, ...updateFields } = input;
          await this.db
            .update(subagentInvocationsTable)
            .set(updateFields)
            .where(eq(subagentInvocationsTable.subagentSessionId, input.subagentSessionId));
        } else {
          // INSERT new row.
          await this.db.insert(subagentInvocationsTable).values(input);
        }
      } else {
        // No session key — always INSERT a new row.
        await this.db.insert(subagentInvocationsTable).values(input);
      }
    } catch (err) {
      log.warn("subagent_dispatch_tracker: failed to record invocation", {
        taskId: input.taskId,
        agentType: input.agentType,
        outcome: input.outcome,
        error: getErrorMessage(err),
      });
    }
  }

  /**
   * Aggregate dispatch statistics from the DB.
   *
   * All aggregations are performed in a single round of queries. Returns a
   * zero-filled cadence object when the table is empty or on DB error.
   */
  async getCadence(): Promise<SubagentDispatchCadence> {
    try {
      return await this._queryCadence();
    } catch (err) {
      log.warn("subagent_dispatch_tracker: getCadence failed", {
        error: getErrorMessage(err),
      });
      return emptyCADENCE();
    }
  }

  /**
   * Compute the escalation tier from the current DB state.
   *
   * "daily" fires when:
   *   - more than DAILY_PARTIAL_UNCOMMITTED_THRESHOLD `partial-uncommitted-no-handoff`
   *     outcomes in the last 24h, OR
   *   - more than DAILY_RATE_LIMITED_THRESHOLD `rate-limited` outcomes in last 24h.
   *
   * "session" fires when:
   *   - more than SESSION_PARTIAL_UNCOMMITTED_THRESHOLD `partial-uncommitted-no-handoff`
   *     outcomes in the most recent parent session (identified by the most
   *     recently seen `parentSessionId` value in the table).
   *
   * Returns "none" below both thresholds, or if a DB error occurs.
   */
  async getEscalation(): Promise<"none" | "session" | "daily"> {
    try {
      return await this._queryEscalation();
    } catch (err) {
      log.warn("subagent_dispatch_tracker: getEscalation failed", {
        error: getErrorMessage(err),
      });
      return "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _queryCadence(): Promise<SubagentDispatchCadence> {
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // ── 1. Total count + last dispatch ──────────────────────────────────────
    const [totalRow] = await this.db.select({ total: count() }).from(subagentInvocationsTable);

    const total = totalRow?.total ?? 0;

    const [lastRow] = await this.db
      .select({ startedAt: subagentInvocationsTable.startedAt })
      .from(subagentInvocationsTable)
      .orderBy(desc(subagentInvocationsTable.startedAt))
      .limit(1);

    const lastDispatch = lastRow?.startedAt ? lastRow.startedAt.toISOString() : null;

    // ── 2. byOutcome ─────────────────────────────────────────────────────────
    const outcomeRows = await this.db
      .select({
        outcome: subagentInvocationsTable.outcome,
        cnt: count(),
      })
      .from(subagentInvocationsTable)
      .groupBy(subagentInvocationsTable.outcome);

    const byOutcome: Record<SubagentInvocationOutcome, number> = Object.fromEntries(
      SUBAGENT_INVOCATION_OUTCOME_VALUES.map((v) => [v, 0])
    ) as Record<SubagentInvocationOutcome, number>;

    for (const row of outcomeRows) {
      if (row.outcome != null) {
        byOutcome[row.outcome] = row.cnt;
      }
    }

    // ── 3. byAgentType ───────────────────────────────────────────────────────
    const agentTypeRows = await this.db
      .select({
        agentType: subagentInvocationsTable.agentType,
        cnt: count(),
      })
      .from(subagentInvocationsTable)
      .groupBy(subagentInvocationsTable.agentType);

    const byAgentType: Record<string, number> = {};
    for (const row of agentTypeRows) {
      if (row.agentType != null) {
        byAgentType[row.agentType] = row.cnt;
      }
    }

    // ── 4. byHourLast24h ─────────────────────────────────────────────────────
    // date_trunc('hour', ...) produces PostgreSQL timestamps; we cast to text
    // for a portable return type. The query returns only hours with ≥1 row.
    const hourRows = await this.db
      .select({
        hour: sql<string>`to_char(date_trunc('hour', ${subagentInvocationsTable.startedAt}), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
        cnt: count(),
      })
      .from(subagentInvocationsTable)
      .where(gte(subagentInvocationsTable.startedAt, cutoff24h))
      .groupBy(sql`date_trunc('hour', ${subagentInvocationsTable.startedAt})`)
      .orderBy(sql`date_trunc('hour', ${subagentInvocationsTable.startedAt})`);

    const byHourLast24h = hourRows
      .filter((r) => r.hour != null)
      .map((r) => ({ hour: r.hour, count: r.cnt }));

    return {
      total,
      lastDispatch,
      byOutcome,
      byAgentType,
      byHourLast24h,
    };
  }

  private async _queryEscalation(): Promise<"none" | "session" | "daily"> {
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // ── 1. Daily checks ──────────────────────────────────────────────────────

    // Count partial-uncommitted-no-handoff in last 24h
    const [partialRow] = await this.db
      .select({ cnt: count() })
      .from(subagentInvocationsTable)
      .where(
        and(
          eq(subagentInvocationsTable.outcome, "partial-uncommitted-no-handoff"),
          gte(subagentInvocationsTable.startedAt, cutoff24h)
        )
      );

    const partialCount24h = partialRow?.cnt ?? 0;

    if (partialCount24h > DAILY_PARTIAL_UNCOMMITTED_THRESHOLD) {
      return "daily";
    }

    // Count rate-limited in last 24h
    const [rateLimitedRow] = await this.db
      .select({ cnt: count() })
      .from(subagentInvocationsTable)
      .where(
        and(
          eq(subagentInvocationsTable.outcome, "rate-limited"),
          gte(subagentInvocationsTable.startedAt, cutoff24h)
        )
      );

    const rateLimitedCount24h = rateLimitedRow?.cnt ?? 0;

    if (rateLimitedCount24h > DAILY_RATE_LIMITED_THRESHOLD) {
      return "daily";
    }

    // ── 2. Session check ──────────────────────────────────────────────────────
    // "Current session" = the most recently seen `parentSessionId` in the table.
    // There is no in-memory session marker; we derive it from the DB.
    const [mostRecentRow] = await this.db
      .select({ parentSessionId: subagentInvocationsTable.parentSessionId })
      .from(subagentInvocationsTable)
      .where(isNotNull(subagentInvocationsTable.parentSessionId))
      .orderBy(desc(subagentInvocationsTable.startedAt))
      .limit(1);

    if (mostRecentRow?.parentSessionId != null) {
      const [sessionPartialRow] = await this.db
        .select({ cnt: count() })
        .from(subagentInvocationsTable)
        .where(
          and(
            eq(subagentInvocationsTable.parentSessionId, mostRecentRow.parentSessionId),
            eq(subagentInvocationsTable.outcome, "partial-uncommitted-no-handoff")
          )
        );

      const sessionPartialCount = sessionPartialRow?.cnt ?? 0;

      if (sessionPartialCount > SESSION_PARTIAL_UNCOMMITTED_THRESHOLD) {
        return "session";
      }
    }

    return "none";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a zero-filled cadence object. Used as the error-path fallback in
 * `getCadence()` so callers always get a well-typed value.
 */
function emptyCADENCE(): SubagentDispatchCadence {
  return {
    total: 0,
    lastDispatch: null,
    byOutcome: Object.fromEntries(SUBAGENT_INVOCATION_OUTCOME_VALUES.map((v) => [v, 0])) as Record<
      SubagentInvocationOutcome,
      number
    >,
    byAgentType: {},
    byHourLast24h: [],
  };
}
