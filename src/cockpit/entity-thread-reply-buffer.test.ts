/**
 * mt#4036 — the pending agent-reply buffer.
 *
 * The acceptance tests these cover, by the spec's own numbering:
 *   AT1 — the recorder's `onEvent` does not throw when the store rejects
 *         (covered in ./entity-thread-launch.test.ts, which owns the recorder)
 *   AT2 — reject-then-succeed lands the turn EXACTLY ONCE, no duplicate
 *   AT3 — the panel renders a distinguishable dropped-reply state
 *         (covered in ./web/widgets/EntityThreadPanel.test.tsx)
 *   AT4 — a rejected write logs the cause and NOT the full reply body
 *         (covered in ./entity-thread-launch.test.ts)
 *
 * `FakeStore` below is handed to the buffer's constructor as its
 * `EntityThreadTurnStore`. Nothing is patched: the buffer takes its store as a
 * dependency precisely so a failing store can be handed to it, which is also
 * the only way to exercise the committed-then-unacknowledged append that makes
 * a blind retry unsafe.
 */

import { describe, expect, test } from "bun:test";
import {
  EntityThreadReplyBuffer,
  MAX_PENDING_AGE_MS,
  MAX_PENDING_PER_THREAD,
  CLOCK_SKEW_TOLERANCE_MS,
  DRAIN_BACKOFF_MS,
  schedulePendingDrain,
  shouldReportPendingReplies,
  stopPendingDrain,
  blocksToStoredAgentReplies,
  LOST_RETENTION_MS,
} from "./entity-thread-reply-buffer";

const LOCAL_ID = "entity-thread:ask:a902cba7-fd37-464a-842f-96fe38fe8bcc";
/** A second thread, for the cases that turn on threads being independent. */
const OTHER_LOCAL_ID = "entity-thread:task:mt%234036";
/** The postgres-js code the 2026-08-11 outage actually produced. */
const OUTAGE_ERROR = "CONNECTION_CLOSED";

interface StoredTurn {
  id: string;
  localId: string;
  seq: number;
  role: "operator" | "agent";
  content: string;
  createdAt: Date;
}

/**
 * A store whose reachability can be toggled, mirroring the outage this exists
 * for: `listEntityThreadTurns` and `appendEntityThreadTurn` both fail while it
 * is down, and both recover together.
 */
class FakeStore {
  turns: StoredTurn[] = [];
  reachable = true;
  appendCalls = 0;
  /** Simulates a post-send failure: the row commits, the ack is lost. */
  commitThenFail = false;
  now = 1_000_000;

  list = async (_db: unknown, localId: string): Promise<StoredTurn[]> => {
    if (!this.reachable) throw new Error(OUTAGE_ERROR);
    return this.turns.filter((t) => t.localId === localId);
  };

  append = async (
    _db: unknown,
    input: { localId: string; role: "operator" | "agent"; content: string }
  ): Promise<StoredTurn> => {
    this.appendCalls++;
    const seq = this.turns.filter((t) => t.localId === input.localId).length + 1;
    const turn: StoredTurn = {
      id: `${input.localId}#${seq}`,
      localId: input.localId,
      seq,
      role: input.role,
      content: input.content,
      createdAt: new Date(this.now),
    };
    if (this.commitThenFail) {
      // The row lands, then the acknowledgement fails — the exact ambiguity
      // that makes a blind retry unsafe.
      this.turns.push(turn);
      throw new Error(OUTAGE_ERROR);
    }
    if (!this.reachable) throw new Error(OUTAGE_ERROR);
    this.turns.push(turn);
    return turn;
  };
}

function bufferOver(store: FakeStore): EntityThreadReplyBuffer {
  return new EntityThreadReplyBuffer({
    listTurns: store.list as never,
    appendTurn: store.append as never,
  });
}

describe("EntityThreadReplyBuffer.buffer", () => {
  test("reports the depth and the oldest failure instant", () => {
    const buffer = new EntityThreadReplyBuffer();
    const first = buffer.buffer(LOCAL_ID, "Both filed.", 1_000);
    expect(first.pending).toBe(1);
    expect(first.lost).toBe(0);
    expect(first.oldestFailedAt).toBe(new Date(1_000).toISOString());

    const second = buffer.buffer(LOCAL_ID, "You're right.", 2_000);
    expect(second.pending).toBe(2);
    // The OLDEST, not the newest — the operator's question is "how long has
    // this been stuck", not "when did the last one fail".
    expect(second.oldestFailedAt).toBe(new Date(1_000).toISOString());
  });

  test("keeps threads separate", () => {
    const buffer = new EntityThreadReplyBuffer();
    buffer.buffer(LOCAL_ID, "a", 1_000);
    buffer.buffer(OTHER_LOCAL_ID, "b", 1_000);
    expect(buffer.report(LOCAL_ID).pending).toBe(1);
    expect(buffer.totalPending()).toBe(2);
  });

  test("drops the OLDEST past the per-thread cap and counts it lost", () => {
    const buffer = new EntityThreadReplyBuffer();
    for (let i = 0; i < MAX_PENDING_PER_THREAD + 3; i++) {
      buffer.buffer(LOCAL_ID, `reply ${i}`, 1_000 + i);
    }
    // `now` is passed explicitly: `lost` counters expire after
    // LOST_RETENTION_MS, so a default real-clock read against these synthetic
    // timestamps would report the losses as already forgotten.
    const report = buffer.report(LOCAL_ID, [], 1_000 + MAX_PENDING_PER_THREAD);
    expect(report.pending).toBe(MAX_PENDING_PER_THREAD);
    expect(report.lost).toBe(3);
  });

  test("a thread with nothing buffered reports silence, not zeroes to render", () => {
    const buffer = new EntityThreadReplyBuffer();
    const report = buffer.report(LOCAL_ID);
    expect(report.pending).toBe(0);
    expect(report.lost).toBe(0);
    expect(report.oldestFailedAt).toBeNull();
  });
});

/**
 * PR #2913 R1 (BLOCKING) — the GET route reported a reply as pending while the
 * same reply was already rendered in `blocks`, because only the drain knew how
 * to decide "did this land?". The predicate is now shared; these pin both
 * callers to it.
 */
describe("report reconciled against already-stored replies (PR #2913 R1)", () => {
  const AT = 1_000_000;

  test("a reply already present in the thread is not reported as pending", () => {
    const buffer = new EntityThreadReplyBuffer();
    buffer.buffer(LOCAL_ID, "Both filed.", AT);

    // The commit landed; only the acknowledgement was lost. Reporting this as
    // pending renders the reply AND a notice saying it could not be saved.
    const stored = [{ content: "Both filed.", createdAtMs: AT + 5 }];
    expect(buffer.report(LOCAL_ID, stored, AT).pending).toBe(0);
    // Unreconciled, it is still pending — the queue was not mutated by the read.
    expect(buffer.report(LOCAL_ID, [], AT).pending).toBe(1);
  });

  test("an identical reply from BEFORE the failure does not suppress the notice", () => {
    const buffer = new EntityThreadReplyBuffer();
    buffer.buffer(LOCAL_ID, "Checking.", AT);
    const stored = [{ content: "Checking.", createdAtMs: AT - CLOCK_SKEW_TOLERANCE_MS - 60_000 }];
    expect(buffer.report(LOCAL_ID, stored, AT).pending).toBe(1);
  });

  test("blocksToStoredAgentReplies takes agent blocks and drops unusable ones", () => {
    const replies = blocksToStoredAgentReplies([
      { type: "assistant-text", content: "kept", timestamp: "2026-08-11T03:29:35Z" },
      { type: "user-prompt", content: "the operator's turn", timestamp: "2026-08-11T03:25:47Z" },
      { type: "assistant-text", content: "no timestamp" },
      { type: "assistant-text", content: "bad timestamp", timestamp: "not a date" },
    ]);
    // A block with no parsable instant is DROPPED, not defaulted: a fabricated
    // timestamp would suppress a notice on evidence that does not exist.
    expect(replies).toEqual([{ content: "kept", createdAtMs: Date.parse("2026-08-11T03:29:35Z") }]);
  });
});

/** PR #2913 R1 (non-blocking) — `lost` counters must not accumulate forever. */
describe("lost-counter retention", () => {
  test("a loss is reported while it is still worth telling the operator about", () => {
    const buffer = new EntityThreadReplyBuffer();
    for (let i = 0; i < MAX_PENDING_PER_THREAD + 1; i++) {
      buffer.buffer(LOCAL_ID, `reply ${i}`, 1_000);
    }
    expect(buffer.report(LOCAL_ID, [], 1_000 + LOST_RETENTION_MS - 1).lost).toBe(1);
  });

  test("and is forgotten past the retention window", () => {
    const buffer = new EntityThreadReplyBuffer();
    for (let i = 0; i < MAX_PENDING_PER_THREAD + 1; i++) {
      buffer.buffer(LOCAL_ID, `reply ${i}`, 1_000);
    }
    expect(buffer.report(LOCAL_ID, [], 1_000 + LOST_RETENTION_MS + 1).lost).toBe(0);
  });
});

describe("shouldReportPendingReplies", () => {
  test("a clean thread reports NOTHING rather than a reassuring zero", () => {
    // Follows `originSeeded`'s discipline (PR #2493 R1): absent means "no
    // claim". A daemon predating this field must not be read as asserting a
    // clean state it never checked.
    expect(shouldReportPendingReplies({ pending: 0, lost: 0, oldestFailedAt: null })).toBe(false);
  });

  test("reports while anything is pending", () => {
    expect(shouldReportPendingReplies({ pending: 1, lost: 0, oldestFailedAt: "x" })).toBe(true);
  });

  test("keeps reporting after everything pending is gone but replies were lost", () => {
    // The queue drains to empty when replies age out, and the operator still
    // needs to know an answer is not coming back.
    expect(shouldReportPendingReplies({ pending: 0, lost: 2, oldestFailedAt: null })).toBe(true);
  });
});

describe("EntityThreadReplyBuffer.drain", () => {
  test("AT2: a reply buffered during an outage lands exactly once on recovery", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "Both filed.", store.now);

    // Still down: nothing lands, nothing is lost.
    let outcome = await buffer.drain({} as never, store.now);
    expect(outcome.appended).toBe(0);
    expect(outcome.stillPending).toBe(1);
    expect(store.turns).toHaveLength(0);

    store.reachable = true;
    outcome = await buffer.drain({} as never, store.now);
    expect(outcome.appended).toBe(1);
    expect(outcome.stillPending).toBe(0);
    expect(store.turns.map((t) => t.content)).toEqual(["Both filed."]);

    // A second drain must not re-append. This is the duplicate half of AT2.
    outcome = await buffer.drain({} as never, store.now);
    expect(outcome.appended).toBe(0);
    expect(store.turns).toHaveLength(1);
  });

  test("a committed-but-unacknowledged append is reconciled, not duplicated", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    // The insert commits and the ack is lost — indistinguishable, from the
    // caller's side, from an insert that never ran. Blindly retrying here is
    // what would produce a visible duplicate turn.
    store.commitThenFail = true;
    try {
      await store.append({}, { localId: LOCAL_ID, role: "agent", content: "Both filed." });
    } catch {
      buffer.buffer(LOCAL_ID, "Both filed.", store.now);
    }
    store.commitThenFail = false;

    const outcome = await buffer.drain({} as never, store.now);
    expect(outcome.reconciled).toBe(1);
    expect(outcome.appended).toBe(0);
    expect(store.turns).toHaveLength(1);
  });

  test("an identical turn from BEFORE the failure is not mistaken for the buffered one", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    // The agent said the same thing an hour earlier. Reconciling against it
    // would silently drop the new reply — the bug this task exists to fix,
    // reintroduced by an over-eager dedup.
    store.now = 1_000_000;
    await store.append({}, { localId: LOCAL_ID, role: "agent", content: "Checking." });

    const failedAt = store.now + CLOCK_SKEW_TOLERANCE_MS + 60_000;
    buffer.buffer(LOCAL_ID, "Checking.", failedAt);
    store.now = failedAt;

    const outcome = await buffer.drain({} as never, failedAt);
    expect(outcome.appended).toBe(1);
    expect(outcome.reconciled).toBe(0);
    expect(store.turns).toHaveLength(2);
  });

  test("replies land in arrival order, and one failure holds the rest of that thread", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "first", store.now);
    buffer.buffer(LOCAL_ID, "second", store.now + 1);
    buffer.buffer(LOCAL_ID, "third", store.now + 2);

    store.reachable = true;
    await buffer.drain({} as never, store.now + 10);
    expect(store.turns.map((t) => t.content)).toEqual(["first", "second", "third"]);
  });

  test("gives up past the age bound and counts the reply lost", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "Both filed.", store.now);

    const wayLater = store.now + MAX_PENDING_AGE_MS + 1;
    store.reachable = true;
    const outcome = await buffer.drain({} as never, wayLater);

    expect(outcome.agedOut).toBe(1);
    expect(outcome.appended).toBe(0);
    expect(store.turns).toHaveLength(0);
    // Still reported — a lost reply the operator is never told about is the
    // original defect wearing a different hat.
    expect(buffer.report(LOCAL_ID, [], wayLater).lost).toBe(1);
  });

  test("a thread whose store read fails does not stall the others", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);
    const otherId = OTHER_LOCAL_ID;

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "a", store.now);
    buffer.buffer(otherId, "b", store.now);

    store.reachable = true;
    const outcome = await buffer.drain({} as never, store.now);
    expect(outcome.appended).toBe(2);
    expect(buffer.totalPending()).toBe(0);
  });
});

/**
 * mt#4066 — aging must not depend on the store being readable.
 *
 * The 2026-08-12 recurrence, on this file's own LOCAL_ID: a reply failed to
 * persist at 21:01:32Z and was still reported `pending, lost: 0` at 21:25Z —
 * 24 minutes, 9 past MAX_PENDING_AGE_MS. Every mt#4036 test passed throughout,
 * because each one lets the store recover before asserting on the age bound
 * (see "gives up past the age bound" above, which sets `reachable = true`
 * first). The store STAYING down was the untested case, and it is the case the
 * buffer exists for.
 */
describe("aging under an unreachable store (mt#4066)", () => {
  test("SC1: a reply past its window is lost even though no read ever succeeded", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "Punting ask#8004 costs you nothing here", store.now);

    const wayLater = store.now + MAX_PENDING_AGE_MS + 1;
    // Deliberately still unreachable — the outage outlasts the window, which
    // is exactly the 2026-08-12 shape.
    const outcome = await buffer.drain({} as never, wayLater);

    expect(outcome.agedOut).toBe(1);
    expect(outcome.stillPending).toBe(0);
    const report = buffer.report(LOCAL_ID, [], wayLater);
    expect(report.pending).toBe(0);
    expect(report.lost).toBe(1);
    // The whole point: the operator is now told to ask again instead of being
    // told to keep waiting.
    expect(shouldReportPendingReplies(report)).toBe(true);
  });

  test("SC4: inside the window, a failed read still loses nothing", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    buffer.buffer(LOCAL_ID, "Both filed.", store.now);

    const stillFresh = store.now + MAX_PENDING_AGE_MS - 1;
    const outcome = await buffer.drain({} as never, stillFresh);

    expect(outcome.agedOut).toBe(0);
    expect(outcome.stillPending).toBe(1);
    expect(store.appendCalls).toBe(0);
    expect(buffer.report(LOCAL_ID, [], stillFresh).lost).toBe(0);
  });

  test("SC4: a reply that LANDED is reconciled, never reported lost, however stale", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    // The commit landed; only the ack was lost — and then nothing drained for
    // longer than the age window. Aging this would tell the operator to ask
    // again for an answer rendered directly above the notice.
    store.commitThenFail = true;
    try {
      await store.append({}, { localId: LOCAL_ID, role: "agent", content: "Both filed." });
    } catch {
      buffer.buffer(LOCAL_ID, "Both filed.", store.now);
    }
    store.commitThenFail = false;

    const wayLater = store.now + MAX_PENDING_AGE_MS + 1;
    const outcome = await buffer.drain({} as never, wayLater);

    expect(outcome.reconciled).toBe(1);
    expect(outcome.agedOut).toBe(0);
    expect(buffer.report(LOCAL_ID, [], wayLater).lost).toBe(0);
    expect(store.turns).toHaveLength(1);
  });

  test("SC5: one thread's unreadable store does not hold another thread's pass", async () => {
    const store = new FakeStore();
    const otherId = OTHER_LOCAL_ID;
    const buffer = new EntityThreadReplyBuffer({
      listTurns: (async (db: unknown, localId: string) => {
        if (localId === LOCAL_ID) throw new Error(OUTAGE_ERROR);
        return store.list(db, localId);
      }) as never,
      appendTurn: store.append as never,
    });

    const wayLater = store.now + MAX_PENDING_AGE_MS + 1;
    buffer.buffer(LOCAL_ID, "unreadable thread", store.now);
    // Deliberately still INSIDE its window: an equally-stale reply would age
    // out on its own merits and prove nothing about cross-thread isolation.
    buffer.buffer(otherId, "healthy thread", wayLater - 1_000);

    const outcome = await buffer.drain({} as never, wayLater);

    // The unreadable thread ages out; the healthy one still lands in the SAME
    // pass rather than waiting behind it.
    expect(outcome.agedOut).toBe(1);
    expect(store.turns.map((t) => t.content)).toEqual(["healthy thread"]);
    expect(buffer.totalPending()).toBe(0);
  });
});

/**
 * mt#4066 — the drain has to actually run.
 *
 * `schedulePendingDrain` is armed only by a failed append and re-armed only by
 * its own `.finally`, so "the chain is wedged" and "the chain is not running"
 * are indistinguishable from outside. This exercises the real timer rather
 * than asserting on the module's internal handle: what matters is that arming
 * it drains the queue, not which variable holds the timeout.
 */
describe("drain scheduling (mt#4066)", () => {
  test("SC2: arming the chain drains a queued reply once the store recovers", async () => {
    const store = new FakeStore();
    const buffer = bufferOver(store);

    store.reachable = false;
    // Real clock: the scheduled pass reads `Date.now()` for its age check.
    buffer.buffer(LOCAL_ID, "Both filed.", Date.now());
    store.reachable = true;

    stopPendingDrain();
    schedulePendingDrain({} as never, buffer);
    // Idempotent — a second arm must not stack a second chain.
    schedulePendingDrain({} as never, buffer);

    await new Promise((resolve) => setTimeout(resolve, (DRAIN_BACKOFF_MS[0] ?? 2_000) + 750));

    expect(store.turns.map((t) => t.content)).toEqual(["Both filed."]);
    expect(buffer.totalPending()).toBe(0);
    stopPendingDrain();
  });
});
