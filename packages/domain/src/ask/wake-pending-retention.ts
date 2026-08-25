/**
 * `wake_pending` retention sweep (mt#4537).
 *
 * Nothing deleted from this table until this module existed, so rows accumulated
 * forever — drained and undrained alike. The interesting part is WHICH rows are safe
 * to delete, because the two states have opposite hazards and the obvious policy
 * ("delete old delivered rows") bounds almost nothing.
 *
 * ## Measured, 2026-08-25 (prod)
 *
 * 12 rows total: **1 drained, 11 undrained**. Of the 11, nine address a workspace
 * session that no longer exists and one names an ask that no longer exists. So a
 * drained-only policy would have deleted a single row and left the backlog untouched.
 * The population splits by DELIVERABILITY, not by drain state.
 *
 * ## Covers
 *
 * - **Delivered rows past the retention window.** A drained row has done its job; it
 *   is kept only as long as the one consumer that reads it can still ask about it
 *   (below).
 * - **Undrained rows whose ADDRESSEE no longer exists** — a session-keyed row whose
 *   `parent_session_id` matches no `sessions` row, or any row whose `ask_id` matches no
 *   `asks` row. Neither can ever be delivered: the session-keyed drain resolves its key
 *   through the session record, and a wake for a deleted ask has nothing to announce.
 *
 * ## Does NOT cover
 *
 * - **Undrained rows with a live addressee, at any age.** These are undelivered wakes,
 *   and deleting one is precisely the loss mt#4517 just closed. Age is not evidence of
 *   undeliverability — an ask answered while its agent was idle is exactly the case the
 *   table exists for.
 * - **Undrained rows whose ask is CLOSED.** Considered and deliberately excluded: an
 *   ask reaching `closed` does not mean the agent that filed it ever saw the answer, so
 *   deleting on that signal would drop the delivery for the reader who most needs it.
 *   It would have caught four more of the twelve measured rows; that is not worth the
 *   class of loss it admits.
 * - **Agent-keyed undrained rows whose CONVERSATION is gone.** There is no registry of
 *   live conversations to check against, so undeliverability is not decidable here. If
 *   one ever exists, this is the predicate to extend.
 * - **Table bloat from a future high-arrival-rate producer.** At ~1 row/day the window
 *   below is generous. A producer that changes the arrival rate by orders of magnitude
 *   should revisit it rather than assume it still holds.
 *
 * ## Why 14 days, and why it is not a round number
 *
 * A drained row is not inert: it is the ONLY thing suppressing the prompt-seam
 * announcement for an ask the tool seam already delivered. `selectSettledAsks`
 * (`.minsky/hooks/inject-ask-responses.ts`) checks its own local watermark first and
 * `wakeDeliveredAt` second, and on the `wakeDeliveredAt` path it deliberately does NOT
 * record a watermark of its own — so deleting the row while the ask is still tracked
 * re-announces an answer the agent already received.
 *
 * The bound therefore comes from that consumer's declared maximum, not from this
 * table's arrival cadence (12 rows in 11 days grounds nothing).
 * `ask-conversation-map.ts` declares `ENTRY_MAX_AGE_MS` = 7 days. That ceiling is
 * NOMINAL rather than enforced: `pruneEntries` runs only from `recordAskConversation`
 * — the write path — while `readAskConversationMap` / `askIdsForConversation` apply no
 * age filter at all, so a machine that stops filing asks keeps entries past 7 days
 * indefinitely. 14 days is that ceiling doubled, which is the margin for the gap
 * between the declared window and the enforced one. If the read path ever filters by
 * age (mt#4541 SC4), this can drop to 7 days plus a small margin.
 *
 * Measured against `drained_at`, not `emitted_at`: delivery is always at or after the
 * ask's attribution, so the later timestamp is the conservative one.
 *
 * ## Why undeliverable rows have no age floor
 *
 * A grace period would be a number with nothing behind it. A `sessions` row is only
 * ever absent because session cleanup removed it — it is never absent-then-present, so
 * there is no window in which a live addressee looks dead. The producer writes
 * `parent_session_id` from an ask that already carried it, which required the session
 * to exist.
 *
 * ## Invocation path
 *
 * `startWakePendingRetentionSweeper` (`src/cockpit/sweepers.ts`) registers this on the
 * cockpit daemon's sweep registry, started from `src/commands/cockpit/start-command.ts`.
 * It reports a real {@link SweepTickResult} rather than a blanket success, per mt#4412.
 *
 * @see mt#4537 — this task
 * @see mt#4517 — the claim/release split that makes `drained_at` mean "rendered"
 * @see mt#4541 — the delivery-model gap split out of this task
 */

import { and, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { wakePendingTable } from "../storage/schemas/wake-pending-schema";
import { postgresSessions } from "../storage/schemas/session-schema";
import { asksTable } from "../storage/schemas/ask-schema";

/**
 * How long a DELIVERED row is kept. See the module docblock for the derivation — this
 * is the attribution window's declared ceiling doubled, not a round number.
 */
export const WAKE_PENDING_DELIVERED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** What one sweep pass removed, split by the predicate that removed it. */
export interface WakePendingRetentionResult {
  /** Delivered rows older than the retention window. */
  deletedDelivered: number;
  /** Undelivered rows whose addressee no longer exists. */
  deletedUndeliverable: number;
}

/** Options accepted by {@link runWakePendingRetentionSweep}. */
export interface WakePendingRetentionOptions {
  /** Injected clock. Defaults to now; tests pass a fixed instant. */
  now?: Date;
  /** Override the delivered-row window. Defaults to {@link WAKE_PENDING_DELIVERED_RETENTION_MS}. */
  retentionMs?: number;
}

/**
 * Run one retention pass. Two statements, deliberately not one:
 *
 * The predicates are disjoint by construction (`drained_at IS NOT NULL` vs `IS NULL`),
 * so a single `OR`'d DELETE would return one total and lose the split. The two counts
 * answer different questions — a rising `deletedUndeliverable` means wakes are being
 * addressed to sessions that die before draining, which is a delivery problem, not
 * hygiene — and collapsing them would hide exactly the signal worth watching.
 *
 * Throws on a failed statement rather than swallowing: the caller is a sweep tick that
 * owns the fail-open policy and has to report `ok: false`, which it cannot do if the
 * failure is hidden here.
 */
export async function runWakePendingRetentionSweep(
  db: PostgresJsDatabase,
  options: WakePendingRetentionOptions = {}
): Promise<WakePendingRetentionResult> {
  const now = options.now ?? new Date();
  const retentionMs = options.retentionMs ?? WAKE_PENDING_DELIVERED_RETENTION_MS;
  const cutoff = new Date(now.getTime() - retentionMs);

  const delivered = await db
    .delete(wakePendingTable)
    .where(and(isNotNull(wakePendingTable.drainedAt), lt(wakePendingTable.drainedAt, cutoff)))
    .returning({ id: wakePendingTable.id });

  // `${asksTable.id}::text`, not a cast of `ask_id` to uuid. `wake_pending.ask_id` is
  // plain unconstrained text by design (ADR-029 records it as the sole such ref to an
  // ask id), so it may hold a value that is not a uuid at all — one such row exists in
  // production. Casting THAT side would raise `invalid input syntax for type uuid` and
  // take the whole sweep down; casting the uuid side to text cannot fail. Same
  // direction as the cockpit's own subquery in `ask-state-cache.ts`.
  const undeliverable = await db
    .delete(wakePendingTable)
    .where(
      and(
        isNull(wakePendingTable.drainedAt),
        or(
          and(
            isNotNull(wakePendingTable.parentSessionId),
            notExists(
              db
                .select({ present: sql`1` })
                .from(postgresSessions)
                .where(sql`${postgresSessions.sessionId} = ${wakePendingTable.parentSessionId}`)
            )
          ),
          notExists(
            db
              .select({ present: sql`1` })
              .from(asksTable)
              .where(sql`${asksTable.id}::text = ${wakePendingTable.askId}`)
          )
        )
      )
    )
    .returning({ id: wakePendingTable.id });

  return {
    deletedDelivered: delivered.length,
    deletedUndeliverable: undeliverable.length,
  };
}
