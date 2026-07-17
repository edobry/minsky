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

import { and, count, desc, gte, sql, eq, isNotNull, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  subagentInvocationsTable,
  type SubagentInvocationInsert,
  type SubagentInvocationOutcome,
  type SubagentInvocationRecord,
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
} from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { EventEmitter } from "@minsky/domain/events/emitter";

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

/**
 * Sentinel `agentType` value used by callers that don't have the real
 * dispatch-time agent type available (e.g. the SubagentStop hook, which only
 * observes the workspace at Stop time — see `.claude/hooks/record-subagent-invocation.ts`).
 * `agent_type` is a NOT NULL column, so callers must supply SOME string; this
 * sentinel marks "no real value known" so the UPDATE path (see
 * `recordSubagentInvocation` below) can avoid clobbering the real value that
 * was written at dispatch time (mt#2653).
 */
export const UNKNOWN_AGENT_TYPE = "unknown";

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
 * - `byModel` — count per `actualModel` string (mt#2796). Rows with a null
 *   `actualModel` (not yet classified at Stop time, or the classifier found
 *   no genuine model id) are excluded rather than bucketed under a sentinel
 *   key, mirroring `byAgentType`'s "only values that appear" contract.
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
  /** Count per actualModel (mt#2796). Rows with a null actualModel are excluded. */
  byModel: Record<string, number>;
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
  /**
   * Process-lifetime singleton. Null until `setInstance(db)` is called.
   * `getInstance()` returns a no-op tracker when no instance has been set —
   * this mirrors `DisconnectTracker.getInstance` which creates one on first
   * call. The no-op path uses an empty fake DB so callers always get a typed
   * value without throwing.
   *
   * Set once from the MCP start-command after the DB connection is resolved
   * (same pattern as memory-enrichment and wake-enrichment middleware).
   */
  private static _instance: SubagentDispatchTracker | null = null;

  /**
   * Return the process-lifetime singleton.
   *
   * If no instance has been set via `setInstance`, returns a no-op tracker
   * whose DB always returns empty result sets. This matches the
   * `DisconnectTracker.getInstance` contract — callers never receive null.
   */
  static getInstance(): SubagentDispatchTracker {
    if (!SubagentDispatchTracker._instance) {
      // No-op tracker: create with a dummy DB that returns empty arrays.
      // This path fires on the CLI path (no Postgres) or if setInstance
      // hasn't been called yet. The fail-safe methods in getCadence/
      // getEscalation catch any DB errors and return safe defaults.
      SubagentDispatchTracker._instance = new SubagentDispatchTracker(createNullDatabase());
    }
    return SubagentDispatchTracker._instance;
  }

  /**
   * Set the process-lifetime singleton to a tracker backed by `db`.
   * Called from the MCP start-command once the DB connection is resolved.
   * Idempotent — subsequent calls replace the instance (useful for tests).
   */
  static setInstance(db: PostgresJsDatabase, eventEmitter?: EventEmitter): SubagentDispatchTracker {
    SubagentDispatchTracker._instance = new SubagentDispatchTracker(db, eventEmitter);
    return SubagentDispatchTracker._instance;
  }

  /**
   * Reset the singleton for tests — creates a fresh instance backed by the
   * provided `db`. Pass the fake DB from test fixtures.
   */
  static resetForTest(db: PostgresJsDatabase): SubagentDispatchTracker {
    SubagentDispatchTracker._instance = new SubagentDispatchTracker(db);
    return SubagentDispatchTracker._instance;
  }

  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly eventEmitter?: EventEmitter
  ) {}

  /**
   * Insert a new invocation row, or update an existing one.
   *
   * Upsert semantics (mt#2831 R1 BLOCKING #1 — deterministic attribution):
   *   - **Strong binding** — when `input.id` is set AND a row with that id exists,
   *     UPDATE that EXACT row. This is the preferred path: a caller that knows the
   *     specific invocation it means (e.g. the SubagentStop hook reading the
   *     current-invocation marker file — see `readCurrentInvocationMarker`,
   *     `packages/domain/src/session/current-invocation-marker.ts`) can never
   *     misattribute an update to the wrong row in a retry chain, regardless of
   *     timing (a LATE Stop event for an OLDER attempt cannot land on a NEWER
   *     attempt's row, or vice versa).
   *   - **Heuristic upsert** — when `input.id` is absent (or doesn't match any row —
   *     e.g. a stale/missing marker), fall back to `input.subagentSessionId`. A
   *     subagentSessionId is no longer guaranteed unique across rows once a dispatch
   *     has been auto-resumed (`recordDispatchRecoveryAttempt` INSERTs a new row
   *     sharing the SAME subagentSessionId as the attempt it resumes — the resume
   *     reuses the existing Minsky session workspace). The target is selected in two
   *     passes: first, the most recent row with `endedAt IS NULL` (an OPEN row — a
   *     Stop-time update should land on whichever attempt is STILL RUNNING); if no
   *     row is open, fall back to the most recent row overall (a replayed/duplicate
   *     Stop event for an already-fully-closed chain). This narrows, but does not
   *     eliminate, the misattribution window the strong-binding path closes — see
   *     `subagent-dispatch-tracker.test.ts`'s "deterministic attribution" describe
   *     block for the specific late-Stop-event scenario this two-pass selection does
   *     and does not handle.
   *   - When neither `input.id` nor `input.subagentSessionId` resolves to an existing
   *     row: always INSERT a new row.
   *
   * All fields present in `input` are written on INSERT. On UPDATE, `id` and
   * `startedAt` are never overwritten (see `buildUpdateFields`).
   *
   * Errors are swallowed and logged — this matches the fail-safe contract of
   * `DisconnectTracker`'s I/O layer.
   *
   * @param input  The invocation record to persist.
   * @returns The persisted row's id, or null on error / total failure to persist.
   */
  async recordSubagentInvocation(input: SubagentInvocationInput): Promise<string | null> {
    // mt#2653 R1: events must carry the PERSISTED agentType, not necessarily
    // `input.agentType` — when the UPDATE path omits the sentinel (see below),
    // the row keeps its EXISTING (dispatch-time) value, which can differ from
    // what this call's `input` carried. Defaults to `input.agentType` for the
    // INSERT paths, where "persisted" and "input" are the same value by
    // construction; reassigned below on the UPDATE path.
    let resolvedAgentType: string = input.agentType;
    let persistedId: string | null = null;
    try {
      let targetRow: { id: string; agentType: string } | undefined;

      // Strong binding: an exact id the caller supplied. Only trust it if the row
      // genuinely exists — a stale/missing marker must fall through to the
      // heuristic path below, not silently no-op.
      if (input.id != null) {
        const byId = await this.db
          .select({
            id: subagentInvocationsTable.id,
            agentType: subagentInvocationsTable.agentType,
          })
          .from(subagentInvocationsTable)
          .where(eq(subagentInvocationsTable.id, input.id))
          .limit(1);
        targetRow = byId[0];
      }

      if (!targetRow && input.subagentSessionId != null) {
        targetRow = await this._selectHeuristicUpsertTarget(input.subagentSessionId);
      }

      if (targetRow) {
        // UPDATE the resolved row by primary key (never by subagentSessionId —
        // see class docstring on why subagentSessionId alone is not a safe target).
        const { updateFields, resolvedAgentType: ra } = this._buildUpdateFields(input, targetRow);
        resolvedAgentType = ra;
        await this.db
          .update(subagentInvocationsTable)
          .set(updateFields)
          .where(eq(subagentInvocationsTable.id, targetRow.id));
        persistedId = targetRow.id;
      } else {
        // INSERT new row.
        const [inserted] = await this.db
          .insert(subagentInvocationsTable)
          .values(input)
          .returning({ id: subagentInvocationsTable.id });
        persistedId = inserted?.id ?? null;
      }

      // Emit subagent.failed event for failure outcomes (mt#2095).
      // Best-effort — EventEmitter.emit() never throws.
      if (
        this.eventEmitter &&
        (input.outcome === "crashed-no-output" ||
          input.outcome === "partial-uncommitted-no-handoff")
      ) {
        await this.eventEmitter.emit({
          eventType: "subagent.failed",
          payload: {
            taskId: input.taskId,
            agentType: resolvedAgentType,
            outcome: input.outcome,
            errorSummary: input.errorSummary,
          },
          relatedTaskId: input.taskId ?? undefined,
          relatedSessionId: input.parentSessionId ?? undefined,
        });
      }

      // Emit subagent.completed event for success outcomes (mt#2487).
      // Co-located with the subagent.failed branch above; the two are
      // mutually exclusive (rate-limited emits neither). Best-effort —
      // EventEmitter.emit() never throws.
      if (
        this.eventEmitter &&
        (input.outcome === "completed-with-pr" ||
          input.outcome === "committed-no-pr" ||
          input.outcome === "partial-committed-handoff-written")
      ) {
        await this.eventEmitter.emit({
          eventType: "subagent.completed",
          payload: {
            taskId: input.taskId,
            agentType: resolvedAgentType,
            outcome: input.outcome,
          },
          relatedTaskId: input.taskId ?? undefined,
          relatedSessionId: input.parentSessionId ?? undefined,
        });
      }

      return persistedId;
    } catch (err) {
      log.warn("subagent_dispatch_tracker: failed to record invocation", {
        taskId: input.taskId,
        agentType: input.agentType,
        outcome: input.outcome,
        error: getErrorMessage(err),
      });
      return null;
    }
  }

  /**
   * Select the UPDATE target for the heuristic (subagentSessionId-keyed) upsert path
   * (mt#2831 R1 BLOCKING #1). Two-pass: prefer the most recent OPEN row
   * (`endedAt IS NULL`) — a Stop-time update should land on whichever attempt in a
   * retry chain is STILL RUNNING — falling back to the most recent row overall when
   * none is open (a replayed/duplicate Stop event for an already-fully-closed chain).
   *
   * This is a real narrowing of the misattribution window `recordSubagentInvocation`'s
   * class docstring describes, but not a full close — see that docstring and the
   * "deterministic attribution" test block for the residual scenario (a late Stop
   * event for an attempt that is ALSO still open, arriving after a newer attempt was
   * inserted and is ALSO still open — both candidates satisfy `endedAt IS NULL`, and
   * without the strong `id` binding this heuristic still picks the more recent one).
   * The strong-binding `id` path is what actually eliminates that residual case.
   */
  private async _selectHeuristicUpsertTarget(
    subagentSessionId: string
  ): Promise<{ id: string; agentType: string } | undefined> {
    const open = await this.db
      .select({
        id: subagentInvocationsTable.id,
        agentType: subagentInvocationsTable.agentType,
      })
      .from(subagentInvocationsTable)
      .where(
        and(
          eq(subagentInvocationsTable.subagentSessionId, subagentSessionId),
          isNull(subagentInvocationsTable.endedAt)
        )
      )
      .orderBy(desc(subagentInvocationsTable.startedAt))
      .limit(1);
    if (open[0]) return open[0];

    const any = await this.db
      .select({
        id: subagentInvocationsTable.id,
        agentType: subagentInvocationsTable.agentType,
      })
      .from(subagentInvocationsTable)
      .where(eq(subagentInvocationsTable.subagentSessionId, subagentSessionId))
      .orderBy(desc(subagentInvocationsTable.startedAt))
      .limit(1);
    return any[0];
  }

  /**
   * Build the UPDATE field set + resolved agentType for an upsert UPDATE, given the
   * already-resolved target row. Shared by both the strong-binding (`id`) and
   * heuristic (`subagentSessionId`) paths in `recordSubagentInvocation` (mt#2831 R1).
   *
   * Never overwrites `id` or `startedAt` (the dispatch-time timestamp `lastDispatch`
   * / `byHourLast24h` depend on for chronology). Preserves the target's existing
   * `agentType` when the caller only has the `UNKNOWN_AGENT_TYPE` sentinel (mt#2653 —
   * the SubagentStop hook has no way to recover the real dispatch-time agentType from
   * the workspace alone, so it sends the sentinel unconditionally; an unconditional
   * `.set({ agentType })` would clobber the real dispatch-time value on every Stop).
   */
  private _buildUpdateFields(
    input: SubagentInvocationInput,
    target: { id: string; agentType: string }
  ): { updateFields: Partial<SubagentInvocationInput>; resolvedAgentType: string } {
    const { id: _id, startedAt: _startedAt, agentType, ...restFields } = input;
    const updateFields: Partial<SubagentInvocationInput> =
      agentType === UNKNOWN_AGENT_TYPE ? restFields : { ...restFields, agentType };
    const resolvedAgentType = agentType === UNKNOWN_AGENT_TYPE ? target.agentType : agentType;
    return { updateFields, resolvedAgentType };
  }

  /**
   * Aggregate dispatch statistics from the DB.
   *
   * All aggregations are performed in a single round of queries. Returns a
   * zero-filled cadence object when the table is empty or on DB error.
   *
   * @param now  Reference "now" for the 24h window cutoff used by
   *   `byHourLast24h`. Defaults to the real wall clock. Callers normally omit
   *   this — it exists as an injectable clock seam so tests can pin
   *   time-window assertions to a fixed reference date instead of the real
   *   wall clock (mt#2654).
   */
  async getCadence(now: Date = new Date()): Promise<SubagentDispatchCadence> {
    try {
      return await this._queryCadence(now);
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
   *
   * @param now  Reference "now" for the 24h window cutoff used by the daily
   *   checks. Defaults to the real wall clock. See `getCadence`'s `now` doc —
   *   same injectable-clock seam (mt#2654).
   */
  async getEscalation(now: Date = new Date()): Promise<"none" | "session" | "daily"> {
    try {
      return await this._queryEscalation(now);
    } catch (err) {
      log.warn("subagent_dispatch_tracker: getEscalation failed", {
        error: getErrorMessage(err),
      });
      return "none";
    }
  }

  /**
   * Return the most recent `subagent_invocations` row for a task (mt#2831), ordered by
   * `startedAt` DESC — the row the dispatch-recovery command needs to decide whether a
   * given task's dispatch is still in flight, and if so, what attempt number it is on.
   *
   * Returns null when the task has no invocation rows or on DB error (fail-safe, matching
   * the tracker's other read methods).
   */
  async getLatestInvocationForTask(taskId: string): Promise<SubagentInvocationRecord | null> {
    try {
      const [row] = await this.db
        .select()
        .from(subagentInvocationsTable)
        .where(eq(subagentInvocationsTable.taskId, taskId))
        .orderBy(desc(subagentInvocationsTable.startedAt))
        .limit(1);
      return row ?? null;
    } catch (err) {
      log.warn("subagent_dispatch_tracker: getLatestInvocationForTask failed", {
        taskId,
        error: getErrorMessage(err),
      });
      return null;
    }
  }

  /**
   * Return every `subagent_invocations` row for a task (mt#2831), the full retry chain
   * (original + any auto-resumed attempts).
   *
   * ORDERING CONTRACT (mt#2831 R1 NB #4 — load-bearing, do not change without updating
   * every consumer below): rows are returned OLDEST -> NEWEST, ordered by `startedAt`
   * ASCENDING. `attemptNumber` increases monotonically with array index (chain[0] is
   * always attempt 1 — the original dispatch; chain[chain.length - 1] is always the
   * MOST RECENT attempt). Consumers rely on this:
   *   - `tasks.dispatch-recover`'s escalation-package builder
   *     (`src/adapters/shared/commands/tasks/dispatch-recover-command.ts`) maps the
   *     array directly into the `attempts` list it returns to the caller, presenting
   *     the chain in chronological (original-first) order without re-sorting.
   *   - Tests pin this order explicitly — see
   *     "getInvocationChainForTask returns rows oldest -> newest (ordering contract)"
   *     in `subagent-dispatch-tracker.test.ts`.
   * If this method's ordering ever needs to change (e.g. to DESC for a new consumer),
   * that consumer must NOT assume the existing ASC contract — add a `direction`
   * parameter rather than flipping the default silently.
   *
   * Returns an empty array on DB error (fail-safe) rather than null, since callers treat
   * this as a list to render, not a single optional record.
   */
  async getInvocationChainForTask(taskId: string): Promise<SubagentInvocationRecord[]> {
    try {
      return await this.db
        .select()
        .from(subagentInvocationsTable)
        .where(eq(subagentInvocationsTable.taskId, taskId))
        .orderBy(subagentInvocationsTable.startedAt);
    } catch (err) {
      log.warn("subagent_dispatch_tracker: getInvocationChainForTask failed", {
        taskId,
        error: getErrorMessage(err),
      });
      return [];
    }
  }

  /**
   * Insert a NEW row for a dispatch-recovery auto-resume attempt (mt#2831). Deliberately a
   * plain INSERT rather than `recordSubagentInvocation`'s upsert — a resumed attempt reuses
   * the SAME Minsky session workspace (and therefore the same `subagentSessionId`) as the
   * attempt it resumes, so upserting on `subagentSessionId` would overwrite the original
   * row's history instead of creating a distinct, linked row. This is the write side of the
   * `resumedFromInvocationId` / `attemptNumber` retry-linkage columns.
   *
   * Returns the new row's id, or null on DB error (fail-safe — the caller still returns the
   * continuation prompt to the orchestrator even if this bookkeeping write fails; the
   * recovery action itself must not be blocked by a telemetry-write failure).
   */
  async recordDispatchRecoveryAttempt(
    input: SubagentInvocationInput & { resumedFromInvocationId: string; attemptNumber: number }
  ): Promise<string | null> {
    try {
      const [row] = await this.db
        .insert(subagentInvocationsTable)
        .values(input)
        .returning({ id: subagentInvocationsTable.id });
      return row?.id ?? null;
    } catch (err) {
      log.warn("subagent_dispatch_tracker: recordDispatchRecoveryAttempt failed", {
        taskId: input.taskId,
        resumedFromInvocationId: input.resumedFromInvocationId,
        attemptNumber: input.attemptNumber,
        error: getErrorMessage(err),
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _queryCadence(now: Date): Promise<SubagentDispatchCadence> {
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

    // ── 3b. byModel (mt#2796) ────────────────────────────────────────────────
    // Excludes rows with a null actualModel (not yet classified, or the
    // classifier found no genuine model id) rather than bucketing them under
    // a sentinel key — mirrors byAgentType's "only values that appear" shape.
    const modelRows = await this.db
      .select({
        model: subagentInvocationsTable.actualModel,
        cnt: count(),
      })
      .from(subagentInvocationsTable)
      .where(isNotNull(subagentInvocationsTable.actualModel))
      .groupBy(subagentInvocationsTable.actualModel);

    const byModel: Record<string, number> = {};
    for (const row of modelRows) {
      if (row.model != null) {
        byModel[row.model] = row.cnt;
      }
    }

    // ── 4. byHourLast24h ─────────────────────────────────────────────────────
    // Enforce UTC explicitly for hour bucketing. `timestamp with time zone` is
    // stored in UTC, but `date_trunc('hour', ts)` operates in the session time
    // zone unless explicitly normalized. Without `AT TIME ZONE 'UTC'` the
    // buckets shift on non-UTC servers and DST boundaries produce incorrect
    // counts. The literal `Z` in the format string only labels output as UTC;
    // we must ALSO ensure the underlying truncation happens in UTC.
    const hourExpr = sql`date_trunc('hour', ${subagentInvocationsTable.startedAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const hourRows = await this.db
      .select({
        hour: sql<string>`to_char(${hourExpr}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
        cnt: count(),
      })
      .from(subagentInvocationsTable)
      .where(gte(subagentInvocationsTable.startedAt, cutoff24h))
      .groupBy(hourExpr)
      .orderBy(hourExpr);

    const byHourLast24h = hourRows
      .filter((r) => r.hour != null)
      .map((r) => ({ hour: r.hour, count: r.cnt }));

    return {
      total,
      lastDispatch,
      byOutcome,
      byAgentType,
      byModel,
      byHourLast24h,
    };
  }

  private async _queryEscalation(now: Date): Promise<"none" | "session" | "daily"> {
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
    byModel: {},
    byHourLast24h: [],
  };
}

/**
 * Create a no-op DB object that satisfies the `PostgresJsDatabase` runtime
 * shape. Returned by `getInstance()` before `setInstance(db)` is called, so
 * `getCadence()` / `getEscalation()` produce zero-filled aggregates on the
 * CLI path or before MCP server startup wiring completes.
 *
 * Implementation: a Proxy that returns itself for any property access (every
 * method returns the same proxy) AND is awaitable via `then()` resolving
 * with `[]`. This makes the proxy resilient to future Drizzle call-chain
 * additions — PR #1062 R1 BLOCKING #1 fix: the prior implementation
 * enumerated `from/where/groupBy/orderBy/limit/select/insert/update/set/values`
 * explicitly, so any new method (e.g., `having`, `offset`, `onConflictDoNothing`)
 * would throw `db.foo is not a function`. The Proxy approach has no allowlist.
 *
 * The tracker's outer try/catch wrappers in `getCadence()` / `getEscalation()`
 * remain the last line of defense; the Proxy is a strictly-additional safety
 * layer that avoids hitting those wrappers on the no-DB path.
 */
function createNullDatabase(): PostgresJsDatabase {
  // We type the proxy via `Record<string | symbol, unknown>` so the
  // get-trap return type aligns. The final cast to PostgresJsDatabase is
  // unavoidable — Drizzle's type is not assignable from a runtime proxy
  // without the library's internal types.
  const proxy: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        // Make the proxy thenable so `await db.select(...)` resolves to `[]`.
        // Drizzle query builders are thenable on the terminal call; the proxy
        // is awaitable at any point in the chain — equivalent semantics for
        // a null DB whose tables are always empty.
        if (prop === "then") {
          return (
            resolve: (v: unknown[]) => unknown,
            _reject: (e: unknown) => unknown
          ): Promise<unknown> => Promise.resolve([]).then(resolve);
        }
        // Symbol.toPrimitive / Symbol.iterator / inspect helpers — return
        // undefined so utilities like `console.log` and `Promise.resolve`
        // handle the proxy as a plain object rather than trying to coerce.
        if (typeof prop === "symbol") {
          return undefined;
        }
        // Every other property access returns a function that returns the
        // proxy itself, so chained calls (select().from().where()...) and
        // mutation calls (insert().values(), update().set().where()) both
        // continue to type-check and eventually await to `[]`.
        return (..._args: unknown[]) => proxy;
      },
    }
  );
  // eslint-disable-next-line custom/no-excessive-as-unknown
  return proxy as unknown as PostgresJsDatabase;
}
