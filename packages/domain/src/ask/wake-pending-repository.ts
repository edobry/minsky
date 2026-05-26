/**
 * WakePendingRepository — interface + Drizzle/Postgres impl + in-memory fake.
 *
 * The producer side (`PersistentWakeSignalSink` in `wake-on-respond.ts`) writes one
 * row per `quality.review` Ask `responded` transition. The consumer side
 * (`enrichWakeResponse` in `src/mcp/middleware/wake-enrichment.ts`) drains undelivered
 * rows for the calling session at every allowlisted MCP tool call.
 *
 * The interface deliberately exposes only what the producer + consumer need; broader
 * CRUD (list-by-ask, list-historical, etc.) is intentionally absent until a use case
 * surfaces.
 *
 * Reference: mt#1519 §5 (catalog), mt#1661 (this v0).
 */

import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { wakePendingTable } from "../storage/schemas/wake-pending-schema";
import type { WakePendingRecord, WakePendingInsert } from "../storage/schemas/wake-pending-schema";
import type { WakeSignalPayload } from "./wake-on-respond";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Operations the bridge needs against the `wake_pending` table.
 *
 * - `insert` — producer side; called by `PersistentWakeSignalSink.emit()`.
 * - `drainBySession` — consumer side; atomically marks undelivered rows as drained
 *   and returns their payloads. Idempotent: a second call with the same session
 *   returns an empty array.
 */
export interface WakePendingRepository {
  insert(payload: WakeSignalPayload): Promise<void>;
  drainBySession(parentSessionId: string, drainedForTool: string): Promise<WakeSignalPayload[]>;
}

// ---------------------------------------------------------------------------
// Drizzle/Postgres implementation
// ---------------------------------------------------------------------------

export class DrizzleWakePendingRepository implements WakePendingRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(payload: WakeSignalPayload): Promise<void> {
    const row: WakePendingInsert = {
      parentSessionId: payload.parentSessionId,
      askId: payload.askId,
      payloadJson: payload,
    };
    await this.db.insert(wakePendingTable).values(row);
  }

  async drainBySession(
    parentSessionId: string,
    drainedForTool: string
  ): Promise<WakeSignalPayload[]> {
    // Atomic drain: a single UPDATE ... RETURNING that flips drained_at on every
    // currently-undelivered row for this session. Concurrent calls are serialized
    // by the row-level lock the UPDATE acquires; whichever transaction wins gets
    // the rows, the other gets an empty result. No double-delivery.
    const rows = await this.db
      .update(wakePendingTable)
      .set({
        drainedAt: new Date(),
        drainedForTool,
      })
      .where(
        and(
          eq(wakePendingTable.parentSessionId, parentSessionId),
          isNull(wakePendingTable.drainedAt)
        )
      )
      .returning();
    return rows.map(rowToPayload);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake (test seam)
// ---------------------------------------------------------------------------

/**
 * In-memory implementation for unit + integration tests. Behavior matches the
 * Drizzle implementation: `drainBySession` is atomic (no double-delivery on
 * concurrent calls).
 */
export class FakeWakePendingRepository implements WakePendingRepository {
  private readonly rows: Array<{
    id: string;
    parentSessionId: string;
    askId: string;
    payload: WakeSignalPayload;
    emittedAt: Date;
    drainedAt: Date | null;
    drainedForTool: string | null;
  }> = [];

  async insert(payload: WakeSignalPayload): Promise<void> {
    this.rows.push({
      id: `fake-${this.rows.length + 1}`,
      parentSessionId: payload.parentSessionId,
      askId: payload.askId,
      payload,
      emittedAt: new Date(),
      drainedAt: null,
      drainedForTool: null,
    });
  }

  async drainBySession(
    parentSessionId: string,
    drainedForTool: string
  ): Promise<WakeSignalPayload[]> {
    const drained: WakeSignalPayload[] = [];
    for (const row of this.rows) {
      if (row.drainedAt === null && row.parentSessionId === parentSessionId) {
        row.drainedAt = new Date();
        row.drainedForTool = drainedForTool;
        drained.push(row.payload);
      }
    }
    return drained;
  }

  /** Test helper — return all rows including drained ones. */
  listAll(): ReadonlyArray<{
    parentSessionId: string;
    askId: string;
    payload: WakeSignalPayload;
    drainedAt: Date | null;
    drainedForTool: string | null;
  }> {
    return this.rows.map((r) => ({
      parentSessionId: r.parentSessionId,
      askId: r.askId,
      payload: r.payload,
      drainedAt: r.drainedAt,
      drainedForTool: r.drainedForTool,
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPayload(row: WakePendingRecord): WakeSignalPayload {
  // The schema's `.$type<WakeSignalPayload>()` annotation gives us a typed
  // payload directly — no cast needed. Producer side only ever inserts
  // well-formed payloads, so the type matches at runtime.
  return row.payloadJson;
}
