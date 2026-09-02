/**
 * Tests for peer-message-correlation (mt#4874).
 *
 * The load-bearing cases here are the ones where the correlator must REFUSE to
 * pair: outside the window, and when a body matches more than one send. Both
 * encode measured properties of the production corpus rather than preferences —
 * see the module docblock — so each is paired with a negative control that
 * resolves, proving the refusal is the rule firing and not the fixture failing
 * to line up.
 *
 * Timestamps are fixed literals, never `Date.now()`: the rules under test are
 * about relative offsets, so anchoring to a real clock would make the fixtures
 * mean something different on every run.
 */
import { describe, test, expect } from "bun:test";
import {
  correlatePeerMessages,
  receivedKey,
  sentKey,
  PEER_PAIRING_WINDOW_MS,
  type ReceivedPeerMessage,
  type SentPeerMessage,
} from "./peer-message-correlation";
import type { PeerMessageOrigin } from "./peer-message-origin";

/** 2026-09-01T12:00:00.000Z — an arbitrary fixed anchor, not the wall clock. */
const T0 = Date.parse("2026-09-01T12:00:00.000Z");

const BODY = "please pick up mt#4874 — the reader is committed on task/mt-4874";

function makeSent(overrides: Partial<SentPeerMessage> = {}): SentPeerMessage {
  return {
    agentSessionId: "sender-session",
    turnIndex: 7,
    ordinal: 0,
    recipient: "a2967d2071b06d0fc",
    message: BODY,
    startedAtMs: T0,
    endedAtMs: T0 + 10_000,
    ...overrides,
  };
}

function makeOrigin(overrides: Partial<PeerMessageOrigin> = {}): PeerMessageOrigin {
  return {
    from: "uds:/tmp/cc-socks/16603.sock",
    fromKind: "session",
    peerPid: 16603,
    msgId: "e4f53555-0000-4000-8000-000000000000",
    name: "minsky-64",
    fromMode: "prompting",
    senderTaskId: null,
    hopChain: null,
    body: BODY,
    ...overrides,
  };
}

function makeReceived(overrides: Partial<ReceivedPeerMessage> = {}): ReceivedPeerMessage {
  const { origin, ...rest } = overrides;
  return {
    agentSessionId: "receiver-session",
    lineOrdinal: 412,
    receivedAtMs: T0 + 12_000,
    origin: origin ?? makeOrigin(),
    ...rest,
  };
}

describe("correlatePeerMessages — the window (AT4)", () => {
  test("a delivery inside the window pairs, in both directions (negative control)", () => {
    const sent = makeSent();
    const received = makeReceived();
    const feed = correlatePeerMessages([sent], [received]);

    const sentEntry = feed.entries.find((e) => e.direction === "sent");
    const receivedEntry = feed.entries.find((e) => e.direction === "received");

    expect(sentEntry?.correlation).toEqual({
      state: "paired",
      counterpartKey: receivedKey(received),
    });
    expect(receivedEntry?.correlation).toEqual({
      state: "paired",
      counterpartKey: sentKey(sent),
    });
    expect(feed.counts.paired).toBe(2);
  });

  test("a delivery one millisecond past the window does NOT pair", () => {
    const sent = makeSent();
    const received = makeReceived({
      receivedAtMs: (sent.endedAtMs ?? 0) + PEER_PAIRING_WINDOW_MS + 1,
    });
    const feed = correlatePeerMessages([sent], [received]);

    for (const entry of feed.entries) {
      expect(entry.correlation.state).toBe("unmatched");
    }
    expect(feed.counts.paired).toBe(0);
  });

  test("a delivery at the exact window edge still pairs", () => {
    const sent = makeSent();
    const received = makeReceived({
      receivedAtMs: (sent.endedAtMs ?? 0) + PEER_PAIRING_WINDOW_MS,
    });
    const feed = correlatePeerMessages([sent], [received]);
    expect(feed.counts.paired).toBe(2);
  });

  test("a delivery BEFORE the send's turn began does not pair — a message cannot arrive early", () => {
    const sent = makeSent();
    const received = makeReceived({ receivedAtMs: (sent.startedAtMs ?? 0) - 1 });
    const feed = correlatePeerMessages([sent], [received]);
    expect(feed.counts.paired).toBe(0);
    expect(feed.counts.sentUnmatched).toBe(1);
    expect(feed.counts.receivedUnmatched).toBe(1);
  });

  test("a send carrying only ONE of its two timestamps still correlates via the other", () => {
    // Production carries exactly this row: started_at null, ended_at set.
    const sent = makeSent({ startedAtMs: null, endedAtMs: T0 + 10_000 });
    const received = makeReceived({ receivedAtMs: T0 + 12_000 });
    const feed = correlatePeerMessages([sent], [received]);
    expect(feed.counts.paired).toBe(2);
  });

  test("a delivery with no timestamp is left uncorrelated rather than paired on text alone", () => {
    const feed = correlatePeerMessages([makeSent()], [makeReceived({ receivedAtMs: null })]);
    expect(feed.counts.paired).toBe(0);
    expect(feed.entries.every((e) => e.correlation.state === "unmatched")).toBe(true);
  });
});

describe("correlatePeerMessages — ambiguity is never resolved by guess (SC5)", () => {
  test("two identical sends at the SAME instant leave the delivery ambiguous, not assigned", () => {
    // The measured worst case: one turn fanning the same text to two
    // recipients stamps both blocks identically, so no time bound can separate
    // them. Minimum observed gap between identical sends in production: 0.000s.
    const first = makeSent({ ordinal: 0, recipient: "agent-a" });
    const second = makeSent({ ordinal: 1, recipient: "agent-b" });
    const feed = correlatePeerMessages([first, second], [makeReceived()]);

    const receivedEntry = feed.entries.find((e) => e.direction === "received");
    expect(receivedEntry?.correlation).toEqual({ state: "ambiguous", candidateCount: 2 });

    // Both sends are ambiguous too — neither may be reported as having no
    // delivery record, because a delivery for one of them plainly exists.
    for (const entry of feed.entries.filter((e) => e.direction === "sent")) {
      expect(entry.correlation.state).toBe("ambiguous");
    }
    expect(feed.counts.sentUnmatched).toBe(0);
  });

  test("two deliveries claiming ONE send leave that send ambiguous, not paired", () => {
    const sent = makeSent();
    const feed = correlatePeerMessages(
      [sent],
      [makeReceived({ lineOrdinal: 1 }), makeReceived({ lineOrdinal: 2 })]
    );

    const sentEntry = feed.entries.find((e) => e.direction === "sent");
    expect(sentEntry?.correlation).toEqual({ state: "ambiguous", candidateCount: 2 });
    // Each delivery has a single candidate but cannot own it exclusively.
    for (const entry of feed.entries.filter((e) => e.direction === "received")) {
      expect(entry.correlation.state).toBe("ambiguous");
    }
  });

  test("identical text sent far apart pairs with the near one only", () => {
    const near = makeSent({ turnIndex: 7 });
    const stale = makeSent({
      turnIndex: 1,
      startedAtMs: T0 - 86_400_000,
      endedAtMs: T0 - 86_390_000,
    });
    const feed = correlatePeerMessages([near, stale], [makeReceived()]);

    const receivedEntry = feed.entries.find((e) => e.direction === "received");
    expect(receivedEntry?.correlation).toEqual({ state: "paired", counterpartKey: sentKey(near) });
    // The stale send is reported as having no delivery record — which is what
    // it is. It is not evidence its own message was lost.
    const staleEntry = feed.entries.find((e) => e.key === sentKey(stale));
    expect(staleEntry?.correlation.state).toBe("unmatched");
  });
});

describe("correlatePeerMessages — an unmatched send is not a failure (SC6)", () => {
  test("a send with no delivery record is 'unmatched', and is counted separately", () => {
    const feed = correlatePeerMessages([makeSent()], []);
    expect(feed.counts.sentUnmatched).toBe(1);
    expect(feed.counts.received).toBe(0);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.correlation.state).toBe("unmatched");
  });

  test("a delivery whose sender conversation was never ingested is 'unmatched'", () => {
    const feed = correlatePeerMessages([], [makeReceived()]);
    expect(feed.counts.receivedUnmatched).toBe(1);
    expect(feed.counts.sent).toBe(0);
  });

  test("a send with a null message never pairs, and does not throw", () => {
    const feed = correlatePeerMessages(
      [makeSent({ message: null })],
      [makeReceived({ origin: makeOrigin({ body: null }) })]
    );
    // Two nulls are not a match — that would pair every payload-less record
    // with every other one.
    expect(feed.counts.paired).toBe(0);
    expect(feed.entries).toHaveLength(2);
  });
});

describe("correlatePeerMessages — the feed itself (SC4, SC8)", () => {
  test("entries are newest-first and each carries its direction", () => {
    const older = makeSent({ turnIndex: 1, startedAtMs: T0 - 60_000, endedAtMs: T0 - 50_000 });
    const newer = makeSent({ turnIndex: 2, startedAtMs: T0, endedAtMs: T0 + 10_000 });
    const feed = correlatePeerMessages([older, newer], []);

    expect(feed.entries.map((e) => e.key)).toEqual([sentKey(newer), sentKey(older)]);
    expect(feed.entries.every((e) => e.direction === "sent")).toBe(true);
  });

  test("an undated entry sorts last rather than being dropped", () => {
    const dated = makeSent({ turnIndex: 2 });
    const undated = makeSent({ turnIndex: 9, startedAtMs: null, endedAtMs: null });
    const feed = correlatePeerMessages([dated, undated], []);

    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[1]?.key).toBe(sentKey(undated));
    expect(feed.entries[1]?.at).toBeNull();
  });

  test("fromKind is lifted onto a received entry so session and agent peers can be split", () => {
    const sessionPeer = makeReceived({ lineOrdinal: 1 });
    const agentPeer = makeReceived({
      lineOrdinal: 2,
      origin: makeOrigin({
        from: "implementer",
        fromKind: "agent",
        peerPid: null,
        msgId: null,
        fromMode: null,
        senderTaskId: "mt#4874",
      }),
    });
    const feed = correlatePeerMessages([], [sessionPeer, agentPeer]);

    expect(feed.entries.find((e) => e.key === receivedKey(sessionPeer))?.fromKind).toBe("session");
    expect(feed.entries.find((e) => e.key === receivedKey(agentPeer))?.fromKind).toBe("agent");
    // A sent entry has no envelope to read a kind off, and says so rather than
    // defaulting to one of the two.
    expect(correlatePeerMessages([makeSent()], []).entries[0]?.fromKind).toBeNull();
  });
});
