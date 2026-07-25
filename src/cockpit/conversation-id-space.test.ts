/**
 * Tests for the conversation id-space fail-loud classifier (mt#2525 / mt#2420)
 * and the mt#3131 (D3/D5) id-shape + bounded-timeout helpers.
 */
import { describe, test, expect } from "bun:test";
import {
  classifySnapshotMiss,
  looksLikeConversationId,
  withBoundedTimeout,
  WRONG_ID_SPACE_MESSAGE,
} from "./conversation-id-space";

describe("classifySnapshotMiss (mt#2525)", () => {
  test("a known WORKSPACE id → wrong_id_space (the mt#2420 mistake)", async () => {
    const result = await classifySnapshotMiss("task359", async () => true);
    expect(result).toBe("wrong_id_space");
  });

  test("an id unknown to the workspace substrate → not_found", async () => {
    const result = await classifySnapshotMiss("some-conversation-uuid", async () => false);
    expect(result).toBe("not_found");
  });

  test("a probe that throws falls open to not_found (never crashes the request)", async () => {
    const result = await classifySnapshotMiss("any-id", async () => {
      throw new Error("provider unavailable");
    });
    expect(result).toBe("not_found");
  });

  test("the requested id is the value passed to the workspace probe", async () => {
    let seen: string | undefined;
    await classifySnapshotMiss("workspace-xyz", async (id) => {
      seen = id;
      return false;
    });
    expect(seen).toBe("workspace-xyz");
  });

  test("the user-safe message names both id-spaces descriptively (no premature rename)", () => {
    expect(WRONG_ID_SPACE_MESSAGE).toContain("workspace session id");
    expect(WRONG_ID_SPACE_MESSAGE).toContain("harness conversation id");
  });

  // mt#3131 (D3): a probe that never resolves must not hang classification —
  // it falls open to not_found once the (injectable, for test speed) bound
  // expires, exactly like a thrown probe error above.
  test("a probe that never resolves falls open to not_found once the bound expires", async () => {
    const result = await classifySnapshotMiss(
      "any-id",
      () => new Promise(() => {}), // never resolves
      20 // short bound — this test would otherwise wait the real 5s default
    );
    expect(result).toBe("not_found");
  });
});

describe("looksLikeConversationId (mt#3131 D3/D5, widened mt#3225)", () => {
  test("accepts a standard UUID (the Claude Code session-id shape)", () => {
    expect(looksLikeConversationId("a9c1a09b-d7c8-4d95-bc49-70cfa922f0d7")).toBe(true);
  });

  test("accepts a UUID with uppercase hex digits", () => {
    expect(looksLikeConversationId("A9C1A09B-D7C8-4D95-BC49-70CFA922F0D7")).toBe(true);
  });

  // mt#3225 AT1: the operator-reported live repro id — a real, ingested
  // subagent transcript that the picker served but the events endpoint
  // rejected before this task.
  test("accepts an agent-prefixed subagent-transcript id (the mt#3225 live repro)", () => {
    expect(looksLikeConversationId("agent-ae944bce40bdc1dd6")).toBe(true);
  });

  // mt#3225: the ORIGINAL mt#3131 repro id turns out to be the exact same
  // 17-hex-char shape as the live mt#3225 repro above — it was rejected at
  // mt#3131 not because the SHAPE was invalid, but because at the time no
  // ingest path wrote a transcript keyed by this shape. mt#3109 changed
  // that (see the doc comment above `AGENT_PREFIXED_RE` in
  // conversation-id-space.ts for the full trail), so this id is now
  // correctly admissible — the inverse of what the mt#3131-era test here
  // asserted.
  test('accepts the former mt#3131 "reject" repro id (same shape, premise changed under mt#3109)', () => {
    expect(looksLikeConversationId("agent-a2a1e886c52ade5b9")).toBe(true);
  });

  test("rejects an agent-prefixed id with the wrong hex width (16 chars, one short)", () => {
    expect(looksLikeConversationId("agent-a2a1e886c52ade5b")).toBe(false);
  });

  test("rejects an agent-prefixed id with the wrong hex width (18 chars, one long)", () => {
    expect(looksLikeConversationId("agent-a2a1e886c52ade5b99")).toBe(false);
  });

  test("rejects an agent-prefixed id with a non-hex character", () => {
    expect(looksLikeConversationId("agent-g2a1e886c52ade5b9")).toBe(false);
  });

  // The diagnostic-row repro (mt#3225 Context: `probe-mt3120-diagnostic`,
  // one of the 45/4/1 picker breakdown) and the mt#3131 malformed-id repro
  // — neither matches either admissible shape and both must stay rejected.
  test("rejects the diagnostic-row repro case (probe-mt3120-diagnostic)", () => {
    expect(looksLikeConversationId("probe-mt3120-diagnostic")).toBe(false);
  });

  test("rejects the malformed-id repro case (8 hex chars, no hyphens)", () => {
    expect(looksLikeConversationId("958f3805")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(looksLikeConversationId("")).toBe(false);
  });

  test("rejects a workspace session id used on the wrong route (still a UUID — this check does not replace wrong_id_space classification)", () => {
    // A workspace id CAN be UUID-shaped too — looksLikeConversationId only
    // filters out ids that could NEVER be a conversation id; distinguishing
    // "valid-shaped but wrong id space" is classifySnapshotMiss's job, not
    // this cheap shape check's.
    expect(looksLikeConversationId("11111111-2222-3333-4444-555555555555")).toBe(true);
  });
});

describe("withBoundedTimeout (mt#3131 D3)", () => {
  test("resolves with the promise's value when it settles before the bound", async () => {
    const result = await withBoundedTimeout(Promise.resolve("ok"), 1_000);
    expect(result).toBe("ok");
  });

  test("propagates a rejection from the wrapped promise (not a timeout)", async () => {
    await expect(withBoundedTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow(
      "boom"
    );
  });

  test("rejects with a TimeoutError once the bound expires", async () => {
    await expect(withBoundedTimeout(new Promise(() => {}), 20)).rejects.toThrow(/Timed out/);
  });
});
