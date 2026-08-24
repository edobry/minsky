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
  /**
   * Consumer side, conversation grain (mt#4476). Same atomic semantics as
   * `drainBySession`, keyed on the ADR-006 caller identity the MCP server resolves
   * on every tool call. This is the path an ordinary answered ask travels — it has
   * no workspace session to key on.
   */
  drainByAgent(agentId: string, drainedForTool: string): Promise<WakeSignalPayload[]>;
}

/**
 * Thrown by `insert` when a payload names neither addressing key.
 *
 * A row with both keys NULL matches no drain query, so it would sit undelivered
 * forever while every surface reported success — the silent-failure shape mem#704
 * names. Failing at the write is the only place it is still visible.
 */
export class UnaddressableWakeError extends Error {
  constructor(askId: string) {
    super(
      `wake_pending: refusing to insert an unaddressable row for ask ${askId} — ` +
        `neither parentSessionId nor agentId is set, so no drain could ever match it.`
    );
    this.name = "UnaddressableWakeError";
  }
}

// ---------------------------------------------------------------------------
// Drizzle/Postgres implementation
// ---------------------------------------------------------------------------

export class DrizzleWakePendingRepository implements WakePendingRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(payload: WakeSignalPayload): Promise<void> {
    assertAddressable(payload);
    const row: WakePendingInsert = {
      parentSessionId: payload.parentSessionId ?? null,
      agentId: payload.agentId ?? null,
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

  async drainByAgent(agentId: string, drainedForTool: string): Promise<WakeSignalPayload[]> {
    // Same atomic UPDATE ... RETURNING as drainBySession, on the conversation-grain
    // key. Kept as a separate statement rather than an OR over both columns: the two
    // keys have separate partial indexes, and an OR would force the planner to choose
    // one or fall back to a scan.
    const rows = await this.db
      .update(wakePendingTable)
      .set({
        drainedAt: new Date(),
        drainedForTool,
      })
      .where(and(eq(wakePendingTable.agentId, agentId), isNull(wakePendingTable.drainedAt)))
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
    parentSessionId: string | null;
    agentId: string | null;
    askId: string;
    payload: WakeSignalPayload;
    emittedAt: Date;
    drainedAt: Date | null;
    drainedForTool: string | null;
  }> = [];

  async insert(payload: WakeSignalPayload): Promise<void> {
    assertAddressable(payload);
    this.rows.push({
      id: `fake-${this.rows.length + 1}`,
      parentSessionId: payload.parentSessionId ?? null,
      agentId: payload.agentId ?? null,
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
    return this.drainWhere((row) => row.parentSessionId === parentSessionId, drainedForTool);
  }

  async drainByAgent(agentId: string, drainedForTool: string): Promise<WakeSignalPayload[]> {
    return this.drainWhere((row) => row.agentId === agentId, drainedForTool);
  }

  private drainWhere(
    matches: (row: (typeof this.rows)[number]) => boolean,
    drainedForTool: string
  ): WakeSignalPayload[] {
    const drained: WakeSignalPayload[] = [];
    for (const row of this.rows) {
      if (row.drainedAt === null && matches(row)) {
        row.drainedAt = new Date();
        row.drainedForTool = drainedForTool;
        drained.push(row.payload);
      }
    }
    return drained;
  }

  /** Test helper — return all rows including drained ones. */
  listAll(): ReadonlyArray<{
    parentSessionId: string | null;
    agentId: string | null;
    askId: string;
    payload: WakeSignalPayload;
    drainedAt: Date | null;
    drainedForTool: string | null;
  }> {
    return this.rows.map((r) => ({
      parentSessionId: r.parentSessionId,
      agentId: r.agentId,
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

/**
 * Both implementations refuse an unaddressable payload, so a test using the fake
 * cannot pass on a payload the real repository would silently strand (mt#4476).
 */
function assertAddressable(payload: WakeSignalPayload): void {
  if (!payload.parentSessionId && !payload.agentId) {
    throw new UnaddressableWakeError(payload.askId);
  }
}

function rowToPayload(row: WakePendingRecord): WakeSignalPayload {
  // The schema's `.$type<WakeSignalPayload>()` annotation gives us a typed
  // payload directly — no cast needed. Producer side only ever inserts
  // well-formed payloads, so the type matches at runtime.
  return row.payloadJson;
}
