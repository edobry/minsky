/**
 * Tests for the peer-message projection (mt#4874).
 *
 * Every fixture is a REAL `origin` object read off `~/.claude/projects/**` on
 * 2026-09-01 — key-for-key, with only the `body` text elided. The object is an
 * undocumented harness internal (Claude Code's messaging docs describe the
 * channel as "Plain text only" and document no envelope), so an invented fixture
 * would test our belief about the harness rather than the harness.
 *
 * The three shapes below are not a selection — they are the COMPLETE set, found
 * by enumerating field combinations across every peer line in the corpus:
 *
 *   4x  agent sender, `senderTaskId` only
 *   2x  uds sender, + verifiedPeerPid + msg_id + fromMode + hopChain
 *   5x  uds sender, + verifiedPeerPid + msg_id + fromMode
 *
 * The spec originally asked for a fourth — a `uds:` sender LACKING pid/msg_id —
 * and no such line exists; the shape that lacks them is the agent one. Recorded
 * on mt#4874 rather than quietly satisfied with a made-up fixture.
 */

import { describe, expect, test } from "bun:test";

import { readPeerMessageOrigin } from "./peer-message-origin";

/** Shape 2 (2 of 11): a cross-session message that was relayed, so it carries `hopChain`. */
const relayedSessionLine = {
  type: "user",
  isMeta: true,
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-socks/17354.sock",
    verifiedPeerPid: 17354,
    msg_id: "338c6858-9845-4a67-903e-9ee1fee01a99",
    name: "mt#4289 — Classify synthetic user-role lines at turn extraction …",
    hopChain: ["5b4c8e983f3f9306d442fcc3"],
    fromMode: "prompting",
    body: "Delivery test, plus a real correction you should have…",
  },
};

/** Shape 3 (5 of 11): the common cross-session case — same, without a relay. */
const directSessionLine = {
  type: "user",
  isMeta: true,
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-socks/16603.sock",
    verifiedPeerPid: 16603,
    msg_id: "e4f53555-ac7b-4b5c-8765-5077e3e88ebe",
    name: "minsky-64",
    fromMode: "prompting",
    body: "All three findings verified independently…",
  },
};

/**
 * Shape 1 (4 of 11): a teammate INSIDE one session. `origin.kind` is `peer` here
 * too, which is exactly why `from` has to be the discriminator — and note this
 * is the shape carrying none of the socket-side fields.
 */
const inSessionAgentLine = {
  type: "user",
  isMeta: true,
  origin: {
    kind: "peer",
    from: "implementer",
    senderTaskId: "ac0c810eaead4ce11",
    name: "implementer",
    body: "PR #3110 (mt#4264) is APPROVED by minsky-reviewer[bot]…",
  },
};

describe("readPeerMessageOrigin — the three real shapes", () => {
  test("a relayed cross-session message keeps its hop chain", () => {
    const result = readPeerMessageOrigin(relayedSessionLine);
    expect(result).not.toBeNull();
    expect(result?.fromKind).toBe("session");
    expect(result?.peerPid).toBe(17354);
    expect(result?.msgId).toBe("338c6858-9845-4a67-903e-9ee1fee01a99");
    expect(result?.hopChain).toEqual(["5b4c8e983f3f9306d442fcc3"]);
    expect(result?.senderTaskId).toBeNull();
  });

  test("a direct cross-session message has no hop chain", () => {
    const result = readPeerMessageOrigin(directSessionLine);
    expect(result?.fromKind).toBe("session");
    expect(result?.peerPid).toBe(16603);
    expect(result?.fromMode).toBe("prompting");
    expect(result?.hopChain).toBeNull();
  });

  test("an in-session agent message is NOT classified as a session peer", () => {
    // The whole point of `fromKind`. `origin.kind` is "peer" for this line too,
    // so a consumer that skipped this split would present a subagent's message
    // as if it arrived from another of the operator's terminals.
    const result = readPeerMessageOrigin(inSessionAgentLine);
    expect(result?.fromKind).toBe("agent");
    expect(result?.from).toBe("implementer");
    expect(result?.senderTaskId).toBe("ac0c810eaead4ce11");
    // Fail-open, per shape: none of the socket-side fields exist on this line,
    // and their absence must not make it unreadable.
    expect(result?.peerPid).toBeNull();
    expect(result?.msgId).toBeNull();
    expect(result?.fromMode).toBeNull();
    expect(result?.body).not.toBeNull();
  });
});

describe("readPeerMessageOrigin — null means NOT a peer message, and nothing else", () => {
  test.each([
    ["no origin at all", { type: "user", message: { role: "user", content: "hi" } }],
    ["a non-peer kind", { type: "user", origin: { kind: "coordinator" } }],
    ["origin is a string", { type: "user", origin: "peer" }],
    ["origin is empty", { type: "user", origin: {} }],
    ["peer kind with no from", { type: "user", origin: { kind: "peer", name: "x" } }],
    ["peer kind with a blank from", { type: "user", origin: { kind: "peer", from: "   " } }],
  ])("%s → null", (_label, line) => {
    expect(readPeerMessageOrigin(line)).toBeNull();
  });

  test.each([[null], [undefined], ["a string"], [42]])(
    "a non-object input (%p) does not throw",
    (input) => {
      expect(readPeerMessageOrigin(input)).toBeNull();
    }
  );
});

describe("readPeerMessageOrigin — fail-open on individual fields", () => {
  test("a peer line carrying only from and kind still reads", () => {
    // The posture the module argues for: a missing optional field degrades that
    // field, never the message. An un-correlatable message must stay VISIBLE.
    const result = readPeerMessageOrigin({ origin: { kind: "peer", from: "uds:/tmp/x.sock" } });
    expect(result).toEqual({
      from: "uds:/tmp/x.sock",
      fromKind: "session",
      peerPid: null,
      msgId: null,
      name: null,
      fromMode: null,
      senderTaskId: null,
      hopChain: null,
      body: null,
    });
  });

  test.each([["17354"], [Number.NaN], [{}], [null]])(
    "a non-finite verifiedPeerPid (%p) degrades to null rather than poisoning a lookup",
    (pid) => {
      // NaN is the one that matters: it is typeof "number", so an unguarded read
      // would carry it into the time-bounded pid→session resolution, where every
      // comparison is false and the message silently reports as uncorrelated.
      const result = readPeerMessageOrigin({
        origin: { kind: "peer", from: "uds:/tmp/x.sock", verifiedPeerPid: pid },
      });
      expect(result?.peerPid).toBeNull();
    }
  );

  test("a hopChain with non-string members keeps the usable hops", () => {
    const result = readPeerMessageOrigin({
      origin: { kind: "peer", from: "uds:/tmp/x.sock", hopChain: ["a", 7, "", null, "b"] },
    });
    expect(result?.hopChain).toEqual(["a", "b"]);
  });

  test("a hopChain that is not an array, or has no usable members, is null", () => {
    const notArray = readPeerMessageOrigin({
      origin: { kind: "peer", from: "uds:/tmp/x.sock", hopChain: "a,b" },
    });
    expect(notArray?.hopChain).toBeNull();

    const noneUsable = readPeerMessageOrigin({
      origin: { kind: "peer", from: "uds:/tmp/x.sock", hopChain: [1, 2] },
    });
    expect(noneUsable?.hopChain).toBeNull();
  });
});
