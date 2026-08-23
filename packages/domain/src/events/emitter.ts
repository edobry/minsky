/**
 * EventEmitter service — thin write helper for the system_events table.
 *
 * Provides best-effort event emission: failures are logged but never
 * propagated to the caller, so EventEmitter failure never prevents the
 * primary action (e.g., an ask.created emission failure does not prevent
 * the Ask from being created).
 *
 * Two implementations:
 *   - `DrizzleEventEmitter`  — production Postgres INSERT via Drizzle ORM
 *   - `NoopEventEmitter`     — hermetic no-op for tests that don't care about events
 *
 * @see mt#2092 — Event log Phase 1a
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { systemEventsTable } from "../storage/schemas/system-events-schema";
import type { SystemEventInput } from "../storage/schemas/system-events-schema";
import { log } from "@minsky/shared/logger";

// Re-export for convenience so callers only need to import from emitter.ts
export type { SystemEventInput };

// ---------------------------------------------------------------------------
// EventEmitter interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for system event emission.
 *
 * All callsites depend on this interface, not on the Drizzle implementation,
 * so tests can inject a fake or a spy.
 *
 * Best-effort contract: `emit` MUST NOT throw. Implementations catch all
 * errors internally. Callers do not wrap emit() in try/catch.
 */
export interface EventEmitter {
  /**
   * Emit a system event.
   *
   * Best-effort: always resolves (never rejects). Failures are logged
   * to the application logger but not propagated.
   */
  emit(event: SystemEventInput): Promise<void>;
}

/**
 * `EventEmitter` extended with a persistence-signaling `tryEmit` (mt#2568
 * PR #2284 R2). `emit()` ALWAYS resolves regardless of whether the
 * underlying write succeeded — that is its documented best-effort contract,
 * not a bug — so a caller that needs to know whether the row was actually
 * persisted (to gate its own retry/dedup state, e.g.
 * `EmbeddingsHealthTracker`'s `emittedForCurrentDegradation` latch) MUST use
 * `tryEmit`, not `emit`. Matches the existing pattern already used by
 * `emit-best-effort.ts` and `bulk-edit-command.ts`.
 */
export interface EventEmitterWithTryEmit extends EventEmitter {
  /**
   * Emit a system event with a persistence signal: resolves `true` when the
   * row was actually written, `false` when the write failed. Never rejects
   * — same best-effort contract as `emit`.
   */
  tryEmit(event: SystemEventInput): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Failure description (mt#4131)
// ---------------------------------------------------------------------------

/** A single structured warn entry, described independent of WHERE it's emitted. */
export interface EmitFailureLogEntry {
  message: string;
  context: Record<string, unknown>;
}

/**
 * Pure decision core: build the warn entry for a failed `system_events` insert.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose `message` is
 * only `Failed query: <sql>` + `params: <params>` — the driver's own error is on
 * `.cause`. postgres.js populates `code` there: a connection token such as
 * `CONNECTION_ENDED` when the pool has gone away, or a SQLSTATE plus `detail` /
 * `constraint_name` when the server actually rejected the row. So logging
 * `message` alone reports THAT a write failed and never WHY, which is how 865
 * dropped `mcp.disconnect` events stayed undiagnosable from the log.
 *
 * The cause keys are omitted rather than set to `undefined` when there is no
 * cause — a plain `Error` is the common case here, and four empty keys on every
 * such line is noise.
 */
export function describeEmitFailure(
  err: unknown,
  eventType: SystemEventInput["eventType"]
): EmitFailureLogEntry {
  const context: Record<string, unknown> = {
    eventType,
    error: err instanceof Error ? err.message : String(err),
  };

  const cause: unknown = err instanceof Error ? err.cause : undefined;
  if (cause) {
    context.causeMessage = cause instanceof Error ? cause.message : String(cause);
    const fields = cause as { code?: unknown; detail?: unknown; constraint_name?: unknown };
    if (typeof fields.code === "string") context.causeCode = fields.code;
    if (typeof fields.detail === "string") context.causeDetail = fields.detail;
    if (typeof fields.constraint_name === "string")
      context.causeConstraint = fields.constraint_name;
  }

  return {
    message: "EventEmitter: failed to emit system event (best-effort, swallowed)",
    context,
  };
}

/** Injectable warn sink, mirroring `LogPostgresNoticeDeps` (mt#3628). */
export interface EventEmitterLogDeps {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultEventEmitterLogDeps: EventEmitterLogDeps = { warn: log.warn };

// ---------------------------------------------------------------------------
// DrizzleEventEmitter — Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Production EventEmitter backed by Postgres via Drizzle ORM.
 *
 * Inserts a row into `system_events` with best-effort semantics:
 * any DB error is caught, logged, and swallowed — never re-thrown.
 * This ensures EventEmitter failure is non-fatal for the calling domain action.
 */
export class DrizzleEventEmitter implements EventEmitterWithTryEmit {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly logDeps: EventEmitterLogDeps = defaultEventEmitterLogDeps
  ) {}

  /**
   * Emit with a persistence signal: resolves `true` when the row was actually
   * written, `false` when the insert failed (error logged and swallowed —
   * same never-throws contract as `emit`). Callers holding their own
   * dedup/retry state (e.g. the deploy.smoke sweep's once-per-commit flag)
   * gate state advancement on this; fire-and-forget callers use `emit()`.
   *
   * Note the postgres.js connection is lazy — a down DB typically surfaces
   * HERE (at first insert), not at connection-handle acquisition, which is
   * why the signal must come from the insert itself.
   */
  async tryEmit(event: SystemEventInput): Promise<boolean> {
    try {
      await this.db.insert(systemEventsTable).values({
        eventType: event.eventType,
        payload: event.payload,
        actor: event.actor ?? null,
        relatedTaskId: event.relatedTaskId ?? null,
        relatedSessionId: event.relatedSessionId ?? null,
      });
      return true;
    } catch (err: unknown) {
      // Best-effort: log the failure but never propagate it.
      // A dead DB should not prevent asks from being created, PRs from being
      // reviewed, or subagents from being dispatched.
      const entry = describeEmitFailure(err, event.eventType);
      this.logDeps.warn(entry.message, entry.context);
      return false;
    }
  }

  async emit(event: SystemEventInput): Promise<void> {
    await this.tryEmit(event);
  }
}

// ---------------------------------------------------------------------------
// NoopEventEmitter — hermetic no-op for tests
// ---------------------------------------------------------------------------

/**
 * No-op EventEmitter for use in tests that don't care about event emission.
 *
 * Captures emitted events in `emitted` so tests that DO care can assert
 * on them without needing a real DB.
 */
export class NoopEventEmitter implements EventEmitterWithTryEmit {
  /** All events that have been emitted (for test assertions). */
  readonly emitted: SystemEventInput[] = [];

  async emit(event: SystemEventInput): Promise<void> {
    await this.tryEmit(event);
  }

  /**
   * Always "succeeds" — pushing to an in-memory array cannot fail
   * (mt#2568 PR #2284 R2: implements `EventEmitterWithTryEmit` so tests can
   * inject this in place of `DrizzleEventEmitter` for retry-on-failure
   * callers).
   */
  async tryEmit(event: SystemEventInput): Promise<boolean> {
    this.emitted.push(event);
    return true;
  }

  /** Clear captured events (useful in beforeEach). */
  clear(): void {
    this.emitted.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a production `DrizzleEventEmitter` from a Drizzle DB connection.
 *
 * Return type widened to `EventEmitterWithTryEmit` (mt#2568 PR #2284 R2) so
 * retry-gating callers (e.g. `EmbeddingsHealthTracker`) can use `tryEmit`
 * without needing a separate `DrizzleEventEmitter`-specific factory —
 * `DrizzleEventEmitter` already implements the wider interface, so this is
 * purely additive for existing `EventEmitter`-typed consumers.
 */
export function createEventEmitter(db: PostgresJsDatabase): EventEmitterWithTryEmit {
  return new DrizzleEventEmitter(db);
}
