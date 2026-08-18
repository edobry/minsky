/**
 * The principal channel under a persistence outage (mt#4252).
 *
 * These are the task's four acceptance tests, and they are deliberately
 * INTEGRATION-shaped rather than four unit tests: the defect was not in any one
 * of the four mechanisms it ran through. Each — the cursor read failing open,
 * an absent offset meaning "everything unconfirmed", Telegram re-serving,
 * and the dedupe failing open — is individually correct and was individually
 * justified in a docblock. Only composed do they form a cycle, so only composed
 * can a test show the cycle is gone.
 *
 * So the real `runPollCycle`, the real `createEventLogCursor`, the real
 * `createDegradedDedupe` and the real `getPrincipalChannelStatus` projection
 * are wired together here. What is stubbed is exactly the outage: the database
 * (reader and recorder both fail) and Telegram (a fetch that re-serves).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { runPollCycle, type ChannelActuator, type PollCycleDeps } from "./principal-channel-poller";
import {
  createEventLogCursor,
  getPrincipalChannelStatus,
  resetPrincipalChannelStatus,
  _setPrincipalChannelDedupeForTest,
  _setPrincipalChannelStatusForTest,
} from "./principal-channel-launch";
import { createDegradedDedupe } from "./principal-channel-degraded-dedupe";
import { auditLivenessAssertions } from "./health-liveness-invariant";
// The REAL key builder, not a string spelled the same way here: the fallback
// dedupe is only correct if it keys on exactly what the durable dedupe keys on,
// so a test that hard-coded the format could go on passing after the two drifted.
import { inboundEventToken } from "@minsky/domain/notify/principal-inbound";
import type { FetchFn } from "@minsky/domain/notify/telegram-transport";

const TOKEN = "tok";
const CHAT = "167346572";

afterEach(() => {
  resetPrincipalChannelStatus();
});

/** One Telegram update carrying `text`, in the wire shape `getUpdates` returns. */
function update(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: CHAT, type: "private" },
      from: { id: 777 },
      text,
    },
  };
}

interface OutageHarness {
  deps: PollCycleDeps;
  /** Every `converse` the actuator was asked to run — the blast radius, counted. */
  actuatorCalls: string[];
  /** Every reply actually sent to Telegram. */
  sentTexts: string[];
  /** The `offset` each poll asked for; `null` when the request carried none. */
  offsetsRequested: Array<number | null>;
  /** Swap what `getUpdates` serves on the next cycle. */
  serve(updates: unknown[]): void;
  /** Let the database answer again, from `highestUpdateId`. */
  recoverDb(highestUpdateId: number | undefined): void;
  dedupe: ReturnType<typeof createDegradedDedupe>;
}

/**
 * A poller wired to a DOWN database.
 *
 * Both halves fail exactly as production does: `createHighestUpdateIdReader`
 * swallows its error and answers `undefined`, and `createInboundEventRecorder`
 * THROWS (it throws on a null handle too, which is the likelier outage path).
 */
function outageHarness(initial: unknown[]): OutageHarness {
  const actuatorCalls: string[] = [];
  const sentTexts: string[] = [];
  const offsetsRequested: Array<number | null> = [];
  let served = initial;
  let dbUp = false;
  let durableHighest: number | undefined;

  const actuator: ChannelActuator = {
    converse: async (text) => {
      actuatorCalls.push(text);
      return `answered: ${text}`;
    },
    interrupt: async () => "stopped",
    reset: async () => "fresh conversation",
    answerAsk: async () => "ask answered",
  };

  // The real reader's failure shape: an error becomes `undefined`, never a throw.
  const readHighestUpdateId = async (): Promise<number | undefined> =>
    dbUp ? durableHighest : undefined;

  const recordAdvance = async (updateId: number): Promise<void> => {
    if (!dbUp) throw new Error("persistence unavailable");
    durableHighest = updateId;
  };

  const fetchFn: FetchFn = async (url, init) => {
    const target = String(url);
    if (target.includes("/getUpdates")) {
      const parsed = init?.body ? (JSON.parse(String(init.body)) as { offset?: number }) : {};
      const requestedOffset = parsed.offset;
      offsetsRequested.push(requestedOffset ?? null);
      // Telegram's actual semantics: an update is confirmed only once a poll
      // asks for an offset ABOVE its update_id, so anything below the requested
      // offset is gone and everything at or above it comes back.
      const visible =
        requestedOffset === undefined
          ? served
          : served.filter((u) => (u as { update_id: number }).update_id >= requestedOffset);
      return new Response(JSON.stringify({ ok: true, result: visible }));
    }
    if (target.includes("/sendMessage")) {
      const parsed = JSON.parse(String(init?.body)) as { text: string };
      sentTexts.push(parsed.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  };

  const dedupe = createDegradedDedupe();

  const deps: PollCycleDeps = {
    token: TOKEN,
    chatId: CHAT,
    auth: { allowedChatId: CHAT },
    actuator,
    cursor: createEventLogCursor(readHighestUpdateId, recordAdvance),
    recordEvent: async () => {
      if (!dbUp) throw new Error("persistence unavailable");
      return "recorded";
    },
    degradedDedupe: dedupe,
    fetchFn,
  };

  return {
    deps,
    actuatorCalls,
    sentTexts,
    offsetsRequested,
    serve: (updates) => {
      served = updates;
    },
    recoverDb: (highestUpdateId) => {
      dbUp = true;
      durableHighest = highestUpdateId;
    },
    dedupe,
  };
}

/**
 * Run one cycle the way `startPrincipalChannelPoller`'s loop does.
 *
 * The loop CATCHES a thrown cycle and turns it into an error outcome, then
 * backs off and runs again — which matters here, because during an outage
 * `cursor.write` throws out of every cycle. A test that let the throw escape
 * would stop after cycle one and never observe the replay it is looking for.
 */
async function runCycleLikeThePoller(deps: PollCycleDeps): Promise<void> {
  try {
    await runPollCycle(deps);
  } catch {
    // intentional-swallow: mirrors the poller loop's own catch, which converts a
    // thrown cycle into an error outcome and backs off rather than exiting.
  }
}

describe("mt#4252 — the channel under a persistence outage", () => {
  test("AT1: a message is handled at most once across repeated cycles while the DB is down", async () => {
    const h = outageHarness([update(101, "deploy the thing")]);

    for (let i = 0; i < 3; i++) await runCycleLikeThePoller(h.deps);

    // The heart of it: three cycles, one agent turn, one reply. Before this
    // change these were 3 and 3 — three real `claude -p` turns against a
    // message the principal had already been answered.
    expect(h.actuatorCalls).toEqual(["deploy the thing"]);
    expect(h.sentTexts).toEqual(["answered: deploy the thing"]);

    // And the cause is visibly gone: only the FIRST poll went out offset-less.
    // Every later one asked past the update, which is what stops Telegram
    // re-serving it in the first place.
    expect(h.offsetsRequested[0]).toBeNull();
    expect(h.offsetsRequested.slice(1)).toEqual([102, 102]);
  });

  test("AT2: a NEW message still gets answered while the DB is down", async () => {
    const h = outageHarness([update(101, "first")]);

    await runCycleLikeThePoller(h.deps);
    await runCycleLikeThePoller(h.deps);
    h.serve([update(101, "first"), update(102, "second")]);
    await runCycleLikeThePoller(h.deps);

    // The whole point of the two fail-opens is that the channel must not go
    // silent because Postgres blinked. Suppressing replays must not suppress
    // traffic — if this ever fails, the fix has become the bug it replaced.
    expect(h.actuatorCalls).toEqual(["first", "second"]);
  });

  test("AT3: a recovered read returning a LOWER id does not re-open the window", async () => {
    const h = outageHarness([update(101, "first")]);

    await runCycleLikeThePoller(h.deps);
    expect(h.actuatorCalls).toEqual(["first"]);

    // The DB comes back, but its highest recorded id is BEHIND what this
    // process already served — the rows for 101 never landed, because that is
    // what the outage was. A cursor that simply trusted the durable read would
    // rewind here and re-run the message.
    h.recoverDb(99);
    await runCycleLikeThePoller(h.deps);
    await runCycleLikeThePoller(h.deps);

    expect(h.actuatorCalls).toEqual(["first"]);
    expect(h.offsetsRequested.slice(1)).toEqual([102, 102]);
  });

  test("AT4: health reports the degraded substate, and returns to normal after a durable write", async () => {
    const h = outageHarness([update(101, "first")]);
    _setPrincipalChannelStatusForTest({
      state: "running",
      chatId: CHAT,
      since: new Date(1700000000000).toISOString(),
      lastProgressAt: null,
    });
    _setPrincipalChannelDedupeForTest(h.dedupe);

    // Before any write is attempted, nothing has failed — a fresh channel is
    // not degraded.
    const atStart = getPrincipalChannelStatus();
    expect(atStart.state).toBe("running");
    expect(atStart.state === "running" ? atStart.dedupe?.mode : undefined).toBe("durable");

    await runCycleLikeThePoller(h.deps);

    const degraded = getPrincipalChannelStatus();
    expect(degraded.state === "running" ? degraded.dedupe?.mode : undefined).toBe("degraded");
    // The count is the blast radius made countable: one message acted on with
    // no durable audit row behind it.
    expect(degraded.state === "running" ? degraded.dedupe?.unrecordedCount : undefined).toBe(1);

    h.recoverDb(101);
    h.serve([update(102, "second")]);
    await runCycleLikeThePoller(h.deps);

    const recovered = getPrincipalChannelStatus();
    expect(recovered.state === "running" ? recovered.dedupe?.mode : undefined).toBe("durable");
    // A TOTAL, not a gauge — it deliberately does not reset, so the outage
    // stays visible after it ends.
    expect(recovered.state === "running" ? recovered.dedupe?.unrecordedCount : undefined).toBe(1);
  });

  test("AT4 (cont.): the degraded payload still satisfies the liveness invariant", async () => {
    // Criterion 4 names `health-liveness-invariant.ts` as a check the new shape
    // has to pass, so this RUNS it against the real projected status rather
    // than against a hand-written fixture — a fixture would only prove the
    // fixture is well-formed.
    const h = outageHarness([update(101, "first")]);
    _setPrincipalChannelStatusForTest({
      state: "running",
      chatId: CHAT,
      since: new Date(1700000000000).toISOString(),
      lastProgressAt: new Date(1700000001000).toISOString(),
    });
    _setPrincipalChannelDedupeForTest(h.dedupe);
    await runCycleLikeThePoller(h.deps);

    const projected = getPrincipalChannelStatus();
    expect(projected.state === "running" ? projected.dedupe?.mode : undefined).toBe("degraded");

    const audit = auditLivenessAssertions({
      principalChannel: projected as unknown as Record<string, unknown>,
    });

    expect(audit.undated).toEqual([]);
    // Asserted so the check above cannot pass VACUOUSLY: an invariant that
    // found no assertion to test would also report zero undated ones, which is
    // the failure mode `dated` exists to expose.
    expect(audit.dated.map((entry) => entry.field)).toContain("principalChannel");
  });
});

describe("mt#4252 — the fallback dedupe on its own", () => {
  test("admits a token once and calls every later sighting a duplicate", () => {
    const dedupe = createDegradedDedupe();
    expect(dedupe.admitUnrecorded(inboundEventToken(1))).toBe("recorded");
    expect(dedupe.admitUnrecorded(inboundEventToken(1))).toBe("duplicate");
    expect(dedupe.admitUnrecorded(inboundEventToken(2))).toBe("recorded");
    expect(dedupe.snapshot().unrecordedCount).toBe(2);
  });

  test("mode follows whichever happened last, so it self-corrects with nothing to clear", () => {
    let clock = 1_000;
    const dedupe = createDegradedDedupe({ now: () => clock });

    expect(dedupe.snapshot().mode).toBe("durable");

    clock = 2_000;
    dedupe.admitUnrecorded(inboundEventToken(1));
    expect(dedupe.snapshot()).toMatchObject({
      mode: "degraded",
      since: new Date(2_000).toISOString(),
    });

    clock = 3_000;
    dedupe.noteDurableWrite();
    expect(dedupe.snapshot()).toMatchObject({
      mode: "durable",
      since: new Date(3_000).toISOString(),
    });

    // Back to degraded on the next failure — no latch, no reset call.
    clock = 4_000;
    dedupe.admitUnrecorded(inboundEventToken(2));
    expect(dedupe.snapshot().mode).toBe("degraded");
  });

  test("retains a bounded number of tokens, evicting the oldest first", () => {
    const dedupe = createDegradedDedupe();
    // One past the 1,000 cap, so exactly the oldest token should be evicted.
    for (let i = 0; i <= 1_000; i++) dedupe.admitUnrecorded(inboundEventToken(i));

    // Evicted, so it is admitted again rather than recognised.
    expect(dedupe.admitUnrecorded(inboundEventToken(0))).toBe("recorded");
    // Still retained.
    expect(dedupe.admitUnrecorded(inboundEventToken(1_000))).toBe("duplicate");
  });
});
