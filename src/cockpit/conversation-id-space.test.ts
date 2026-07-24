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

describe("looksLikeConversationId (mt#3131 D3/D5)", () => {
  test("accepts a standard UUID (the Claude Code session-id shape)", () => {
    expect(looksLikeConversationId("a9c1a09b-d7c8-4d95-bc49-70cfa922f0d7")).toBe(true);
  });

  test("accepts a UUID with uppercase hex digits", () => {
    expect(looksLikeConversationId("A9C1A09B-D7C8-4D95-BC49-70CFA922F0D7")).toBe(true);
  });

  // The two mt#3131 D3/D5 repro ids — both must be rejected.
  test("rejects the subagent-id repro case (agent-<hex>, wrong shape entirely)", () => {
    expect(looksLikeConversationId("agent-a2a1e886c52ade5b9")).toBe(false);
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
