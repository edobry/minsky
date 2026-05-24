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
import { log } from "../../utils/logger";

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
export class DrizzleEventEmitter implements EventEmitter {
  constructor(private readonly db: PostgresJsDatabase) {}

  async emit(event: SystemEventInput): Promise<void> {
    try {
      await this.db.insert(systemEventsTable).values({
        eventType: event.eventType,
        payload: event.payload,
        actor: event.actor ?? null,
        relatedTaskId: event.relatedTaskId ?? null,
        relatedSessionId: event.relatedSessionId ?? null,
      });
    } catch (err: unknown) {
      // Best-effort: log the failure but never propagate it.
      // A dead DB should not prevent asks from being created, PRs from being
      // reviewed, or subagents from being dispatched.
      log.warn("EventEmitter: failed to emit system event (best-effort, swallowed)", {
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
export class NoopEventEmitter implements EventEmitter {
  /** All events that have been emitted (for test assertions). */
  readonly emitted: SystemEventInput[] = [];

  async emit(event: SystemEventInput): Promise<void> {
    this.emitted.push(event);
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
 */
export function createEventEmitter(db: PostgresJsDatabase): EventEmitter {
  return new DrizzleEventEmitter(db);
}
