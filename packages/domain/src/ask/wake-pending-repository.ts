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

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";

import { wakePendingTable } from "../storage/schemas/wake-pending-schema";
import type { WakePendingRecord, WakePendingInsert } from "../storage/schemas/wake-pending-schema";
import type { WakeSignalPayload } from "./wake-on-respond";
import { getLoggableErrorSummary } from "../errors/index";

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
/**
 * Decides which of the claimed payloads the caller can actually DELIVER (mt#4517).
 *
 * Returns the subset it will render. Anything omitted is RELEASED back to pending
 * rather than left marked, so a payload the caller could not carry is delivered on a
 * later call instead of being silently consumed.
 *
 * Pure and synchronous by contract: it runs between the claim and the release, and
 * anything slow there widens the window described on {@link DrizzleWakePendingRepository}.
 * The caller owns the policy (a character budget, a per-kind cap); the repository owns
 * only the claim/release mechanics.
 */
export type DeliverableFilter = (claimed: WakeSignalPayload[]) => WakeSignalPayload[];

/**
 * Truncate an oversized `reviewBody` to {@link MAX_WAKE_BODY_CHARS} (mt#4517 SC5).
 *
 * Returns the payload unchanged when it already fits, so the common path allocates
 * nothing. The ellipsis is appended OUTSIDE the budget deliberately — a reader needs to
 * know the body was cut, and one character cannot be the difference that displaces a
 * block.
 */
export function capReviewBody(payload: WakeSignalPayload): WakeSignalPayload {
  if (payload.reviewBody.length <= MAX_WAKE_BODY_CHARS) return payload;
  return { ...payload, reviewBody: `${payload.reviewBody.slice(0, MAX_WAKE_BODY_CHARS)}…` };
}

/**
 * Longest `reviewBody` a wake row may carry (mt#4517 SC5).
 *
 * Enforced at INSERT — the single chokepoint every producer passes through — rather
 * than in each producer. `MAX_WAKE_ANSWER_CHARS` (`asks-answered-wake.ts`) caps the
 * `ask.answered` path at its source and still should; this is the backstop that also
 * covers `ask.review` and `pr.watch`, whose bodies are a GitHub review body and a
 * match description and had no write-side bound at all. Same value as the answered
 * cap, so one oversized body cannot displace a whole block under any kind.
 */
export const MAX_WAKE_BODY_CHARS = 600;

export interface WakePendingRepository {
  insert(payload: WakeSignalPayload): Promise<void>;
  /**
   * Claim this session's undelivered wakes.
   *
   * With `selectDeliverable`, only the payloads it returns stay marked; the rest are
   * released back to pending (mt#4517). Without it, every claimed row stays marked —
   * the pre-mt#4517 behaviour, kept as the default so callers that consume everything
   * they claim need no filter.
   */
  drainBySession(
    parentSessionId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]>;
  /**
   * Consumer side, conversation grain (mt#4476). Same atomic semantics as
   * `drainBySession`, keyed on the ADR-006 caller identity the MCP server resolves
   * on every tool call. This is the path an ordinary answered ask travels — it has
   * no workspace session to key on.
   */
  drainByAgent(
    agentId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]>;
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

/**
 * Claim/release semantics (mt#4517).
 *
 * A drain CLAIMS with a single `UPDATE … RETURNING`, so concurrent drains still
 * serialize on the row lock and each row is claimed exactly once — mt#4476's
 * no-double-delivery property is unchanged. What mt#4517 adds is the second half: rows
 * the caller cannot deliver are RELEASED (`drained_at` back to NULL) instead of staying
 * marked, so an undeliverable payload is retried rather than silently consumed.
 *
 * **Why two statements rather than one transaction.** Wrapping claim+release in a
 * transaction would close the window below, and was not taken: `client.begin` goes
 * through the mt#4473 pooler guard, which replays a recorded builder chain and shipped
 * hours before this change. Two plain statements need nothing from the guard beyond what
 * every other query here already uses. The cost is a window between claim and release in
 * which a process death strands the rejected rows marked — the SAME failure this task
 * fixes, but narrowed from "every over-budget payload, every time" to "only if the
 * process dies inside a few milliseconds". A concurrent drain in that window sees the
 * rows as claimed and skips them, so the window costs a delay, never a double delivery.
 * If the guard later grows verified transaction support, this collapses to one atomic
 * block with no interface change.
 */
export class DrizzleWakePendingRepository implements WakePendingRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(payload: WakeSignalPayload): Promise<void> {
    assertAddressable(payload);
    const capped = capReviewBody(payload);
    const row: WakePendingInsert = {
      parentSessionId: capped.parentSessionId ?? null,
      agentId: capped.agentId ?? null,
      askId: capped.askId,
      payloadJson: capped,
    };
    await this.db.insert(wakePendingTable).values(row);
  }

  /**
   * Release rows the caller could not deliver, so they are claimable again.
   *
   * Best-effort by design: a release failure leaves the rows marked, which is exactly
   * the pre-mt#4517 behaviour — bad, but not worse than the baseline, and never a reason
   * to fail the drain and lose the payloads the caller CAN deliver. Logged rather than
   * swallowed so a persistent failure is visible.
   */
  private async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.db
        .update(wakePendingTable)
        .set({ drainedAt: null, drainedForTool: null })
        .where(inArray(wakePendingTable.id, ids));
    } catch (err: unknown) {
      log.error("wake_pending: failed to release undeliverable rows; they remain marked", {
        count: ids.length,
        error: getLoggableErrorSummary(err),
      });
    }
  }

  async drainBySession(
    parentSessionId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]> {
    // Atomic CLAIM: a single UPDATE ... RETURNING that flips drained_at on every
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
    return this.settleClaim(rows, selectDeliverable);
  }

  async drainByAgent(
    agentId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]> {
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
    return this.settleClaim(rows, selectDeliverable);
  }

  /**
   * Second half of the claim (mt#4517): keep what the caller will deliver, release the rest.
   *
   * Identity is by ROW ID, not by payload equality — two wakes for the same ask carry
   * identical payloads, and matching on content would release the wrong row.
   */
  private async settleClaim(
    rows: WakePendingRecord[],
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]> {
    if (rows.length === 0) return [];

    const payloads = rows.map(rowToPayload);
    if (!selectDeliverable) return payloads;

    const deliverable = new Set(selectDeliverable(payloads));
    const releasedIds: string[] = [];
    const kept: WakeSignalPayload[] = [];
    for (const [index, payload] of payloads.entries()) {
      if (deliverable.has(payload)) {
        kept.push(payload);
      } else {
        const row = rows[index];
        if (row) releasedIds.push(row.id);
      }
    }

    await this.release(releasedIds);
    return kept;
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
    const capped = capReviewBody(payload);
    this.rows.push({
      id: `fake-${this.rows.length + 1}`,
      parentSessionId: capped.parentSessionId ?? null,
      agentId: capped.agentId ?? null,
      askId: capped.askId,
      payload: capped,
      emittedAt: new Date(),
      drainedAt: null,
      drainedForTool: null,
    });
  }

  async drainBySession(
    parentSessionId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]> {
    return this.drainWhere(
      (row) => row.parentSessionId === parentSessionId,
      drainedForTool,
      selectDeliverable
    );
  }

  async drainByAgent(
    agentId: string,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): Promise<WakeSignalPayload[]> {
    return this.drainWhere((row) => row.agentId === agentId, drainedForTool, selectDeliverable);
  }

  /**
   * Mirrors the Drizzle claim/release (mt#4517): mark everything matching, then put back
   * whatever the filter did not select. The fake must reproduce this or a unit test can
   * pass against semantics production does not have.
   */
  private drainWhere(
    matches: (row: (typeof this.rows)[number]) => boolean,
    drainedForTool: string,
    selectDeliverable?: DeliverableFilter
  ): WakeSignalPayload[] {
    const claimed: Array<(typeof this.rows)[number]> = [];
    for (const row of this.rows) {
      if (row.drainedAt === null && matches(row)) {
        row.drainedAt = new Date();
        row.drainedForTool = drainedForTool;
        claimed.push(row);
      }
    }
    if (claimed.length === 0) return [];

    const payloads = claimed.map((row) => row.payload);
    if (!selectDeliverable) return payloads;

    const deliverable = new Set(selectDeliverable(payloads));
    const kept: WakeSignalPayload[] = [];
    for (const row of claimed) {
      if (deliverable.has(row.payload)) {
        kept.push(row.payload);
      } else {
        row.drainedAt = null;
        row.drainedForTool = null;
      }
    }
    return kept;
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
