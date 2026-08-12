/**
 * Pending agent-reply buffer for entity threads (mt#4036).
 *
 * ## What this exists to stop
 *
 * `createEntityThreadReplyRecorder` writes each agent reply to
 * `entity_thread_turns` as it streams. That write can fail, and until mt#4036
 * a failure was logged and dropped. The panel renders the thread FROM that
 * table, so a dropped reply is not a gap in a history — it is the ANSWER, and
 * its absence is indistinguishable from an agent that never replied.
 *
 * Observed 2026-08-11 on `entity-thread:ask:a902cba7-…`: the daemon's pool went
 * unreachable at 03:28:45Z, and the four replies the agent produced over the
 * next three minutes all failed to persist — including the substantive answer
 * to the operator's instruction. The operator saw silence, asked "Well?", and
 * that reply was dropped too. The agent was working the entire time.
 *
 * ## Why this is not `withPgPoolRetry`
 *
 * The obvious fix — wrap the append in the existing retry helper — does not
 * work here, for two independent reasons, and both are worth stating because
 * the helper LOOKS like the right tool:
 *
 * 1. **It would not fire.** `withPgPoolRetry` gates on
 *    `isPgRetryableConnectionError`, whose first act is to reject any error
 *    carrying a `query` own-property. Drizzle wraps the driver error and its
 *    message IS the query text, which is exactly the shape the 2026-08-11
 *    failures had. `isDatabaseUnavailableError`'s own docblock names this trap:
 *    a caller using the retry predicate for a different question "would pass its
 *    own unit tests" while doing nothing.
 * 2. **Loosening the gate would be unsafe.** That guard is not incidental. A
 *    post-send failure may have COMMITTED the insert already, and
 *    `appendEntityThreadTurn` is not idempotent — it allocates `seq` as
 *    `MAX(seq) + 1`, so a blind re-run of a committed append produces a visible
 *    duplicate turn rather than a no-op.
 *
 * So this module does not retry the same statement. It buffers the reply and
 * RECONCILES on drain: read the thread's turns back, and only append the ones
 * that are genuinely absent. That makes the recovery safe under exactly the
 * post-send ambiguity the retry helper refuses to guess about.
 *
 * ## What it deliberately does not do
 *
 * Nothing here is durable across a daemon restart. A buffered reply lives in
 * this process's memory, and a restart loses it — which is the second half of
 * the same 2026-08-11 incident, owned by mt#4037. Making the buffer survive a
 * restart is that task's problem, not this one's; conflating them would put a
 * write-ahead log in front of a table whose whole purpose is to be the record.
 *
 * @see mt#4036 — this module
 * @see mt#4037 — the daemon-restart half of the same incident
 * @see ./entity-thread-launch.ts — the recorder that fills this buffer
 * @see ../../packages/domain/src/persistence/postgres-retry.ts — the helper this deliberately does not use
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  appendEntityThreadTurn,
  listEntityThreadTurns,
  type EntityThreadTurn,
} from "@minsky/domain/transcripts/entity-thread-store";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";

/**
 * How long a reply stays worth retrying before it is counted as lost.
 *
 * Grounded in the originating outage rather than a round number (per
 * `decision-defaults.mdc §Thresholds`): the daemon's pool went unreachable at
 * 03:28:45Z and the process was replaced at 03:38:46Z, so it served a broken
 * pool for **9m11s** without recovering on its own. 15 minutes sits above that
 * observed window with headroom, and below the point where a reply is stale
 * enough that surfacing it as lost is more honest than landing it.
 */
export const MAX_PENDING_AGE_MS = 15 * 60 * 1000;

/**
 * Backoff schedule between drain passes, in milliseconds.
 *
 * Also incident-shaped. The pool recycle in the originating outage completed
 * 15s after the first unreachable probe (03:28:45Z → 03:29:00Z), so the first
 * two steps cover a recycle-shaped blip cheaply; the later steps carry the long
 * tail without hammering a pool that is genuinely down. The final value repeats
 * until {@link MAX_PENDING_AGE_MS} ages the entries out.
 */
export const DRAIN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/**
 * Per-thread cap on buffered replies.
 *
 * A bound on memory, not a policy: the originating outage buffered 4 replies in
 * 3 minutes, so 100 is roughly two orders of magnitude of headroom. On overflow
 * the OLDEST is dropped and counted as lost — the newest replies are the ones
 * the operator is waiting on.
 */
export const MAX_PENDING_PER_THREAD = 100;

/**
 * Tolerance when deciding whether an existing turn is the buffered one.
 *
 * The daemon's clock stamps `firstFailedAt`; Postgres's clock stamps
 * `created_at`. This only has to beat skew between the two, not resolve a close
 * call: the alternative it must exclude is a turn with identical text from
 * EARLIER in the thread, which is minutes or hours away, never seconds.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export interface PendingReply {
  content: string;
  /** Daemon-clock instant of the first failed append. The reconcile watermark. */
  firstFailedAt: number;
  attempts: number;
}

/**
 * What the GET route reports about a thread's unpersisted replies.
 *
 * `lost` is separate from `pending` because they are different statements to
 * the operator: `pending` says "wait", `lost` says "this is not coming back".
 */
export interface PendingReplyReport {
  pending: number;
  lost: number;
  /** ISO timestamp of the oldest still-pending reply, or null when none. */
  oldestFailedAt: string | null;
}

export interface DrainOutcome {
  appended: number;
  /** Already present in the table — the failed insert had in fact committed. */
  reconciled: number;
  agedOut: number;
  stillPending: number;
}

/**
 * The two store operations the drain needs.
 *
 * Injected rather than imported-and-called so the drain's behaviour under a
 * failing store is observable by handing it a failing store — the alternative
 * is patching module imports, which `testing-standards.mdc §Testable Design`
 * names as design feedback rather than a test technique. It is also the only
 * way to exercise the committed-then-unacknowledged append, which no real
 * Postgres will produce on demand.
 */
export interface EntityThreadTurnStore {
  listTurns(db: PostgresJsDatabase, localId: string): Promise<EntityThreadTurn[]>;
  appendTurn(
    db: PostgresJsDatabase,
    input: { localId: string; role: "operator" | "agent"; content: string }
  ): Promise<EntityThreadTurn>;
}

const PRODUCTION_STORE: EntityThreadTurnStore = {
  listTurns: listEntityThreadTurns,
  appendTurn: appendEntityThreadTurn,
};

/**
 * Replies that failed to persist, keyed by thread.
 *
 * A class rather than module-level maps so a test can hold its own instance
 * instead of reaching into shared state between cases. Production uses the
 * single {@link pendingReplyBuffer} below, which is the same lifetime as the
 * daemon that owns the recorder.
 */
export class EntityThreadReplyBuffer {
  private readonly pending = new Map<string, PendingReply[]>();
  private readonly lost = new Map<string, number>();

  constructor(private readonly store: EntityThreadTurnStore = PRODUCTION_STORE) {}

  /**
   * Record a reply whose append failed.
   *
   * Returns the thread's report so the caller can name the depth in its log
   * line without a second lookup.
   */
  buffer(localId: string, content: string, now: number = Date.now()): PendingReplyReport {
    const queue = this.pending.get(localId) ?? [];
    queue.push({ content, firstFailedAt: now, attempts: 1 });
    while (queue.length > MAX_PENDING_PER_THREAD) {
      queue.shift();
      this.lost.set(localId, (this.lost.get(localId) ?? 0) + 1);
    }
    this.pending.set(localId, queue);
    return this.report(localId);
  }

  report(localId: string): PendingReplyReport {
    const queue = this.pending.get(localId) ?? [];
    const oldest = queue[0];
    return {
      pending: queue.length,
      lost: this.lost.get(localId) ?? 0,
      oldestFailedAt: oldest ? new Date(oldest.firstFailedAt).toISOString() : null,
    };
  }

  /** Threads with at least one pending reply. Drives the drain loop's exit. */
  threadsWithPending(): string[] {
    return [...this.pending.entries()].filter(([, q]) => q.length > 0).map(([id]) => id);
  }

  totalPending(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }

  /**
   * One drain pass over every thread with pending replies.
   *
   * Per thread: read the stored turns once, then walk the queue in arrival
   * order. A reply whose text already appears as an agent turn stamped at or
   * after its `firstFailedAt` is treated as landed — that is the post-send case
   * where the insert committed and only the acknowledgement was lost, and
   * re-appending it would duplicate a visible turn.
   *
   * A failed append STOPS that thread's queue for this pass rather than
   * skipping ahead, so replies cannot land out of order relative to each other.
   * Other threads continue: one wedged thread must not hold the rest.
   */
  async drain(db: PostgresJsDatabase, now: number = Date.now()): Promise<DrainOutcome> {
    const outcome: DrainOutcome = { appended: 0, reconciled: 0, agedOut: 0, stillPending: 0 };

    for (const localId of this.threadsWithPending()) {
      const queue = this.pending.get(localId);
      if (!queue) continue;

      let stored;
      try {
        stored = await this.store.listTurns(db, localId);
      } catch (err) {
        // The store is still unreachable. Leave the queue intact — this is the
        // condition the buffer exists for, not an error to act on.
        log.debug(
          `entity-thread reply buffer: cannot read ${localId} yet: ${getLoggableErrorSummary(err)}`
        );
        outcome.stillPending += queue.length;
        continue;
      }

      while (queue.length > 0) {
        const reply = queue[0];
        if (!reply) break;

        if (now - reply.firstFailedAt > MAX_PENDING_AGE_MS) {
          queue.shift();
          this.lost.set(localId, (this.lost.get(localId) ?? 0) + 1);
          outcome.agedOut++;
          log.warn(
            `entity-thread reply buffer: giving up on a reply for ${localId} after ${MAX_PENDING_AGE_MS}ms — it is lost`
          );
          continue;
        }

        const alreadyStored = stored.some(
          (turn) =>
            turn.role === "agent" &&
            turn.content === reply.content &&
            turn.createdAt.getTime() >= reply.firstFailedAt - CLOCK_SKEW_TOLERANCE_MS
        );
        if (alreadyStored) {
          queue.shift();
          outcome.reconciled++;
          continue;
        }

        try {
          const turn = await this.store.appendTurn(db, {
            localId,
            role: "agent",
            content: reply.content,
          });
          queue.shift();
          stored.push(turn);
          outcome.appended++;
        } catch (err) {
          reply.attempts++;
          log.debug(
            `entity-thread reply buffer: append still failing for ${localId} (attempt ${reply.attempts}): ${getLoggableErrorSummary(err)}`
          );
          break;
        }
      }

      outcome.stillPending += queue.length;
      if (queue.length === 0) this.pending.delete(localId);
    }

    return outcome;
  }

  /** Test seam — drops every queue and counter. */
  reset(): void {
    this.pending.clear();
    this.lost.clear();
  }
}

/** The daemon's buffer. Shared by the recorder and the GET route. */
export const pendingReplyBuffer = new EntityThreadReplyBuffer();

/**
 * Should the GET route carry a `pendingReplies` field at all?
 *
 * Extracted so the omit-vs-report decision is directly testable rather than
 * inlined in a response spread, and because the DEFAULT here is the
 * load-bearing part: a thread with nothing outstanding reports NOTHING, not a
 * reassuring `{pending: 0, lost: 0}`. That follows `originSeeded`'s discipline
 * (PR #2493 R1) — absent means "no claim", and a daemon predating the field
 * must not be read as asserting a clean state it never checked.
 */
export function shouldReportPendingReplies(report: PendingReplyReport): boolean {
  return report.pending > 0 || report.lost > 0;
}

// ---------------------------------------------------------------------------
// Drain scheduling
// ---------------------------------------------------------------------------

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainStep = 0;

function nextBackoffMs(step: number): number {
  const last = DRAIN_BACKOFF_MS[DRAIN_BACKOFF_MS.length - 1] ?? 60_000;
  return DRAIN_BACKOFF_MS[Math.min(step, DRAIN_BACKOFF_MS.length - 1)] ?? last;
}

/**
 * Ensure a drain pass is scheduled.
 *
 * Idempotent: called on every failed append, but only ever holds one timer. The
 * chain reschedules itself while anything is still pending and stops when the
 * buffer empties, so an idle daemon runs no timer at all.
 *
 * A drain that makes progress resets the backoff — the store recovering is the
 * signal that the long waits are no longer warranted.
 */
export function schedulePendingDrain(
  db: PostgresJsDatabase,
  buffer: EntityThreadReplyBuffer = pendingReplyBuffer
): void {
  if (drainTimer !== null) return;
  if (buffer.totalPending() === 0) return;

  const delay = nextBackoffMs(drainStep);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void buffer
      .drain(db)
      .then((outcome) => {
        if (outcome.appended > 0 || outcome.reconciled > 0) {
          drainStep = 0;
          log.info(
            `entity-thread reply buffer: recovered ${outcome.appended} reply(ies), reconciled ${outcome.reconciled}, ${outcome.stillPending} still pending`
          );
        } else {
          drainStep++;
        }
      })
      .catch((err) => {
        // The drain's own failure must never escape into the daemon — the same
        // constraint the recorder operates under.
        drainStep++;
        log.warn(`entity-thread reply buffer: drain pass failed: ${getLoggableErrorSummary(err)}`);
      })
      .finally(() => {
        schedulePendingDrain(db, buffer);
      });
  }, delay);
  // A pending drain must not hold the process open at shutdown.
  drainTimer.unref?.();
}

/** Test seam — cancels any scheduled drain and resets the backoff. */
export function stopPendingDrain(): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainStep = 0;
}
