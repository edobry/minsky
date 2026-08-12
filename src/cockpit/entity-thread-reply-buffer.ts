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
  /** Instant the reply was observed, from the event. The reconcile watermark. */
  firstFailedAt: number;
  attempts: number;
}

/**
 * The minimum an already-stored agent turn has to expose to be reconciled
 * against a buffered reply.
 *
 * Deliberately structural rather than `EntityThreadTurn`: the GET route holds
 * rendered BLOCKS, not turns, and requiring the full turn there would mean a
 * second query for data the route already has in hand.
 */
export interface StoredAgentReply {
  content: string;
  createdAtMs: number;
}

/**
 * Did this buffered reply in fact land?
 *
 * The single definition of that question — the drain and the GET route both
 * call it, so the two cannot answer it differently. That mattered immediately:
 * PR #2913 R1 (BLOCKING) caught the route reporting a reply as pending while
 * the same reply was already rendered in `blocks`, because only the drain knew
 * how to decide it.
 *
 * The timestamp bound is what separates the two candidates. A reply that landed
 * carries a `created_at` at or after the moment it was observed; an identical
 * reply from EARLIER in the thread is minutes or hours behind it, so the
 * tolerance only has to beat clock skew (see {@link CLOCK_SKEW_TOLERANCE_MS}),
 * never resolve a close call. Without the bound, a thread where the agent
 * repeats itself would silently drop the newer reply — reintroducing this
 * task's own bug through the fix for it.
 */
export function isReplyAlreadyStored(reply: PendingReply, stored: StoredAgentReply[]): boolean {
  return stored.some(
    (turn) =>
      turn.content === reply.content &&
      turn.createdAtMs >= reply.firstFailedAt - CLOCK_SKEW_TOLERANCE_MS
  );
}

/**
 * How long a `lost` count is kept after the fact (PR #2913 R1 non-blocking).
 *
 * The counters have to outlive their queue — an operator who was away needs to
 * be told an answer is not coming back — but a long-lived daemon that never
 * forgot them would accumulate one entry per thread that ever aged out.
 *
 * 24h, grounded in the originating incident's own shape: the thread went quiet
 * at 23:38 local and the operator next looked at 12:12 the following day, so a
 * retention that spans "the next time they sit down" is what makes the report
 * useful. Shorter and the notice expires before it is read.
 */
export const LOST_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Agent turns only, projected to the shape {@link isReplyAlreadyStored} reads. */
export function toStoredAgentReplies(turns: EntityThreadTurn[]): StoredAgentReply[] {
  return turns
    .filter((turn) => turn.role === "agent")
    .map((turn) => ({ content: turn.content, createdAtMs: turn.createdAt.getTime() }));
}

/**
 * The same projection from RENDERED BLOCKS, for the GET route.
 *
 * `assistant-text` is the block type an agent turn projects to
 * (`turnToSnapshotBlock`'s `BLOCK_TYPE_BY_ROLE`); a block with no parsable
 * timestamp is dropped rather than defaulted, because a fabricated instant
 * would let {@link isReplyAlreadyStored} suppress a notice on evidence that
 * does not exist.
 */
export function blocksToStoredAgentReplies(
  blocks: ReadonlyArray<{ type?: string; content?: unknown; timestamp?: unknown }>
): StoredAgentReply[] {
  const replies: StoredAgentReply[] = [];
  for (const block of blocks) {
    if (block.type !== "assistant-text") continue;
    if (typeof block.content !== "string" || typeof block.timestamp !== "string") continue;
    const createdAtMs = Date.parse(block.timestamp);
    if (Number.isNaN(createdAtMs)) continue;
    replies.push({ content: block.content, createdAtMs });
  }
  return replies;
}

interface LostRecord {
  count: number;
  lastLostAt: number;
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
  private readonly lost = new Map<string, LostRecord>();

  constructor(private readonly store: EntityThreadTurnStore = PRODUCTION_STORE) {}

  /**
   * Record a reply whose append failed.
   *
   * `observedAt` should be the instant the EVENT arrived, not the instant the
   * append rejected (PR #2913 R1 non-blocking): a slow failure path would
   * otherwise push the watermark later than the reply actually was, which is
   * the direction that makes {@link isReplyAlreadyStored} miss a turn that did
   * land. Defaults to now only for callers with no event to read it from.
   *
   * Returns the thread's report so the caller can name the depth in its log
   * line without a second lookup.
   */
  buffer(localId: string, content: string, observedAt: number = Date.now()): PendingReplyReport {
    const queue = this.pending.get(localId) ?? [];
    queue.push({ content, firstFailedAt: observedAt, attempts: 1 });
    while (queue.length > MAX_PENDING_PER_THREAD) {
      queue.shift();
      this.recordLost(localId, observedAt);
    }
    this.pending.set(localId, queue);
    return this.report(localId, [], observedAt);
  }

  private recordLost(localId: string, now: number): void {
    const existing = this.lost.get(localId);
    this.lost.set(localId, { count: (existing?.count ?? 0) + 1, lastLostAt: now });
  }

  /**
   * Drop every entry past {@link MAX_PENDING_AGE_MS} from the front of a queue,
   * counting each as lost. Returns how many were dropped.
   *
   * Head-first is sufficient because {@link buffer} appends in arrival order,
   * so `firstFailedAt` is non-decreasing along the queue: the first entry still
   * inside its window bounds every entry behind it.
   *
   * Kept separate from the reconcile loop because this is the only aging that
   * may run WITHOUT a successful read, and that distinction is the whole of
   * mt#4066 — a reply the store might still hold is never aged here, only one
   * the store cannot be asked about at all.
   */
  private expireStaleEntries(localId: string, queue: PendingReply[], now: number): number {
    let expired = 0;
    while (queue.length > 0) {
      const head = queue[0];
      if (!head) break;
      if (now - head.firstFailedAt <= MAX_PENDING_AGE_MS) break;
      queue.shift();
      this.recordLost(localId, now);
      expired++;
      log.warn(
        `entity-thread reply buffer: giving up on a reply for ${localId} after ${MAX_PENDING_AGE_MS}ms — it is lost`
      );
    }
    return expired;
  }

  /**
   * What to tell the operator about this thread.
   *
   * `stored` lets a caller that ALREADY holds the thread's agent turns exclude
   * replies that in fact landed. The GET route passes the blocks it just read;
   * without that, a committed-but-unacknowledged append is reported as pending
   * while the very same reply is rendered above the notice — PR #2913 R1
   * (BLOCKING). Non-mutating: the drain owns the queue, so a read cannot
   * reorder or consume it.
   */
  report(
    localId: string,
    stored: StoredAgentReply[] = [],
    now: number = Date.now()
  ): PendingReplyReport {
    const queue = this.pending.get(localId) ?? [];
    const outstanding =
      stored.length > 0 ? queue.filter((reply) => !isReplyAlreadyStored(reply, stored)) : queue;
    const oldest = outstanding[0];
    return {
      pending: outstanding.length,
      lost: this.lostCount(localId, now),
      oldestFailedAt: oldest ? new Date(oldest.firstFailedAt).toISOString() : null,
    };
  }

  /** Lost count, forgetting anything past {@link LOST_RETENTION_MS}. */
  private lostCount(localId: string, now: number): number {
    const record = this.lost.get(localId);
    if (!record) return 0;
    if (now - record.lastLostAt > LOST_RETENTION_MS) {
      this.lost.delete(localId);
      return 0;
    }
    return record.count;
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

      let storedAgentReplies: StoredAgentReply[];
      try {
        storedAgentReplies = toStoredAgentReplies(await this.store.listTurns(db, localId));
      } catch (err) {
        // The store is still unreachable — the condition this buffer exists
        // for, not an error to act on. The queue survives; only its EXPIRED
        // head does not.
        //
        // Aging exclusively on the success path (mt#4066) put the honesty
        // threshold out of reach in precisely the case it was written for. A
        // reply cannot age out until a read succeeds, so for as long as the
        // store is down the panel keeps saying "retrying" — and `retrying` is
        // the one thing that is definitely wrong once the reply is past its
        // window. Observed 2026-08-12 on the mt#4036 originating thread: 24
        // minutes stale, still reported `pending`, `lost: 0`.
        log.debug(
          `entity-thread reply buffer: cannot read ${localId} yet: ${getLoggableErrorSummary(err)}`
        );
        outcome.agedOut += this.expireStaleEntries(localId, queue, now);
        outcome.stillPending += queue.length;
        if (queue.length === 0) this.pending.delete(localId);
        continue;
      }

      while (queue.length > 0) {
        const reply = queue[0];
        if (!reply) break;

        // Reconcile BEFORE aging (mt#4066). A reply already in the table
        // LANDED, however old it is; calling it `lost` would tell the operator
        // to ask again for an answer sitting directly above the notice. Age is
        // the verdict only for a reply the store does not have — which is why
        // the failed-read path above may age, and this path may not until the
        // read has ruled the reply out.
        if (isReplyAlreadyStored(reply, storedAgentReplies)) {
          queue.shift();
          outcome.reconciled++;
          continue;
        }

        if (now - reply.firstFailedAt > MAX_PENDING_AGE_MS) {
          queue.shift();
          this.recordLost(localId, now);
          outcome.agedOut++;
          log.warn(
            `entity-thread reply buffer: giving up on a reply for ${localId} after ${MAX_PENDING_AGE_MS}ms — it is lost`
          );
          continue;
        }

        try {
          const turn = await this.store.appendTurn(db, {
            localId,
            role: "agent",
            content: reply.content,
          });
          queue.shift();
          storedAgentReplies.push({ content: turn.content, createdAtMs: turn.createdAt.getTime() });
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
        } else {
          drainStep++;
        }
        // Report every pass that had work, not only a pass that made progress
        // (mt#4066). The silent `else` above is why 24 minutes of a stranded
        // reply were unattributable: `log.debug` was the drain's only other
        // output and the daemon runs at `info`, so "the drain is wedged on a
        // failing read" and "the drain is not running at all" wrote the same
        // thing — nothing. Bounded by the backoff to at most one line a minute.
        if (outcome.appended || outcome.reconciled || outcome.agedOut || outcome.stillPending) {
          log.info(
            `entity-thread reply buffer: appended ${outcome.appended}, reconciled ${outcome.reconciled}, lost ${outcome.agedOut}, ${outcome.stillPending} still pending`
          );
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
