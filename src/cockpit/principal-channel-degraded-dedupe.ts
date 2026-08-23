/**
 * Per-process fallback dedupe for the principal channel (mt#4252).
 *
 * ## Why this exists
 *
 * The channel's real dedupe is durable: `createInboundEventRecorder` looks the
 * message's idempotency token up in the append-only event log and answers
 * `"duplicate"` for a replay. That check lives in Postgres — so when Postgres
 * is unreachable, the check is unreachable too, and the poller's fail-open
 * ("proceed unaudited rather than go silent") had no way to tell a replay from
 * a new message. Composed with a cursor read that also fails open, every
 * unconfirmed message was re-executed once per backoff cycle: real `claude -p`
 * turns, real replies, for as long as the outage lasted.
 *
 * This module is the answer to the narrow question the durable check can no
 * longer answer during an outage: **has THIS process already acted on this
 * token?** It is deliberately not a second source of truth. It holds no
 * authority when the DB is up, it is consulted only on the failure path, and a
 * restart empties it — at which point Telegram's own confirm-by-offset
 * semantics and the durable log take over again.
 *
 * ## Why it also owns the health substate
 *
 * mem#862's rule: an instrument must sit at the boundary that fails. A counter
 * placed inside the operation it means to watch can only report failures that
 * happen after that operation is reached. This object is the one thing in the
 * system that is TOLD, per message, whether the durable write landed — so it is
 * where "polling normally" vs "polling without durable dedupe" can be answered
 * without anything else having to remember to report it.
 *
 * {@link DegradedDedupeSnapshot.mode} is DERIVED by comparing the last durable
 * write against the last fallback, never latched. mt#4183 made the channel's
 * `running`/`stalled` states a projection for exactly this reason — a latch is
 * what went stale there — so the substate self-corrects on the next successful
 * write and there is nothing to clear.
 *
 * @see docs/architecture/adr-035-failed-initializer-must-not-be-memoized-as-a-value.md
 *   — rule 2 (degradation is the consumer's decision, not a substitution made on
 *   its behalf) and rule 3 ("configured but failing" must stay distinguishable
 *   from "fine"), which this module applies one layer up from the initializers
 *   the ADR scoped itself to.
 */

/** Which dedupe the channel is currently relying on. */
export type DedupeMode = "durable" | "degraded";

/**
 * How many fallback tokens to retain.
 *
 * Sized to cover an outage, not a process lifetime. Telegram retains an
 * unconfirmed update for 24h, and entries are added ONLY on the failure path —
 * a healthy channel never puts anything in here at all — so this bounds a
 * pathological case rather than steady state. Evicting the oldest is safe in
 * the direction that matters: the worst outcome is one extra replay of a
 * message from very early in a very long outage, which is the behaviour without
 * this module at all.
 */
const MAX_RETAINED_TOKENS = 1_000;

/** What the health surface reports about the channel's dedupe (criterion 4). */
export interface DegradedDedupeSnapshot {
  /**
   * `"durable"` when the last audit write this process attempted LANDED;
   * `"degraded"` when it failed and the fallback below was consulted instead.
   *
   * Read this as a statement about the last observed write, dated by
   * {@link since} — not as a live probe. Nothing here polls the database; the
   * channel only learns the DB's state by trying to write to it, so a quiet
   * channel keeps reporting whatever it last observed. That is the honest
   * reading, and `since` is what keeps it from being mistaken for a fresh one.
   */
  mode: DedupeMode;
  /**
   * ISO stamp of the write that set {@link mode}, or of process start when no
   * write has been attempted yet.
   */
  since: string;
  /**
   * Messages this process acted on WITHOUT a durable audit row.
   *
   * A rising count during an outage is the blast radius made countable — the
   * spec's frequency premise is unmeasured, and this is what measures it.
   * Monotonic for the process's lifetime; it is a total, not a gauge, so it
   * deliberately does NOT reset when the DB recovers.
   */
  unrecordedCount: number;
}

export interface DegradedDedupe {
  /**
   * Decide whether a message whose durable audit write FAILED should be acted
   * on. Call only on that path — a landed write is {@link noteDurableWrite}'s
   * business.
   *
   * `"duplicate"` means this process already acted on the token, so the message
   * is a replay Telegram re-served and must not be run again. `"recorded"`
   * means it is new: the caller proceeds, and the token is retained so the next
   * cycle's replay of it answers `"duplicate"`.
   */
  admitUnrecorded(token: string): "recorded" | "duplicate";
  /** The durable write landed. The durable dedupe is authoritative again. */
  noteDurableWrite(): void;
  snapshot(): DegradedDedupeSnapshot;
}

/**
 * Build a fallback dedupe.
 *
 * `now` is injectable so a test can drive the mode/`since` projection without
 * sleeping; production omits it.
 */
export function createDegradedDedupe(deps: { now?: () => number } = {}): DegradedDedupe {
  const now = deps.now ?? ((): number => Date.now());

  // Insertion-ordered, which is what makes the FIFO eviction below one line:
  // JS `Set` iterates in insertion order, so the first key is always the oldest.
  const seen = new Set<string>();
  let unrecordedCount = 0;
  const startedAtMs = now();

  // "Which happened last" is ordered by a monotonic counter, NOT by the clock.
  // Two events in the same millisecond are ordinary in a busy cycle (and
  // routine in a test), and a wall-clock comparison cannot separate them — it
  // has to break the tie arbitrarily, which means the mode is decided by
  // whichever way that guess fell rather than by what actually happened. A
  // counter cannot tie, and cannot run backwards if the system clock does.
  let sequence = 0;
  let lastDurableWrite: { seq: number; atMs: number } | undefined;
  let lastFallback: { seq: number; atMs: number } | undefined;

  return {
    admitUnrecorded(token: string): "recorded" | "duplicate" {
      lastFallback = { seq: ++sequence, atMs: now() };
      if (seen.has(token)) return "duplicate";

      seen.add(token);
      unrecordedCount += 1;
      if (seen.size > MAX_RETAINED_TOKENS) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      return "recorded";
    },

    noteDurableWrite(): void {
      lastDurableWrite = { seq: ++sequence, atMs: now() };
    },

    snapshot(): DegradedDedupeSnapshot {
      // Whichever happened LAST is the current mode. Neither having happened is
      // a healthy start, not a degraded one: no write has failed yet.
      const degraded =
        lastFallback !== undefined &&
        (lastDurableWrite === undefined || lastFallback.seq > lastDurableWrite.seq);
      const sinceMs = degraded
        ? (lastFallback?.atMs ?? startedAtMs)
        : (lastDurableWrite?.atMs ?? startedAtMs);
      return {
        mode: degraded ? "degraded" : "durable",
        since: new Date(sinceMs).toISOString(),
        unrecordedCount,
      };
    },
  };
}
