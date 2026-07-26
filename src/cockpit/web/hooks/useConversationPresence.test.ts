/**
 * Tests for the presence read's four documented outcomes (mt#3261).
 *
 * This is the honest-degradation contract: the route deliberately distinguishes
 * "we looked and there is no telemetry" (200 `UNKNOWN`) from "we could not
 * look" (503) from "you passed the wrong kind of id" (422) from "that id cannot
 * exist" (404). Collapsing any of them into `UNKNOWN` reintroduces the
 * falsely-confident-derived-field class mt#3130 exists to remove, so each gets
 * its own assertion here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchConversationPresence,
  type ConversationPresencePayload,
} from "./useConversationPresence";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  }) as unknown as typeof fetch;
  return calls;
}

/** Stub that returns a non-JSON body, exercising the unparseable-error path. */
function stubFetchRaw(status: number, text: string): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(text, { status }))) as unknown as typeof fetch;
}

const OK_BODY: ConversationPresencePayload = {
  presence: "LIVE",
  needsInputReason: null,
  needsInputTool: null,
  toolName: "Bash",
  toolElapsedMs: 571,
  quietForMs: 12,
  isQuiet: false,
  basis: "activity-fresh",
  conversationId: "c-1",
  ask: null,
};

describe("fetchConversationPresence", () => {
  test("200 returns the payload and stamps when it was read", async () => {
    stubFetch(200, OK_BODY);
    const before = Date.now();
    const state = await fetchConversationPresence("c-1");
    expect(state.kind).toBe("presence");
    if (state.kind !== "presence") throw new Error("expected a presence outcome");
    expect(state.payload.presence).toBe("LIVE");
    expect(state.payload.toolName).toBe("Bash");
    // The stamp is what lets the elapsed readout advance honestly between polls.
    expect(state.fetchedAtMs).toBeGreaterThanOrEqual(before);
  });

  test("200 with UNKNOWN is a real answer, not an error", async () => {
    stubFetch(200, { ...OK_BODY, presence: "UNKNOWN", toolName: null, basis: "no-row" });
    const state = await fetchConversationPresence("c-1");
    expect(state.kind).toBe("presence");
    if (state.kind !== "presence") throw new Error("expected a presence outcome");
    expect(state.payload.presence).toBe("UNKNOWN");
  });

  test("503 is store-unavailable — NOT collapsed into UNKNOWN", async () => {
    stubFetch(503, {
      error: { code: "store_unavailable", message: "Presence store is unavailable." },
    });
    const state = await fetchConversationPresence("c-1");
    expect(state.kind).toBe("store-unavailable");
  });

  test("422 is wrong-id-space and carries the route's own message", async () => {
    stubFetch(422, { error: { code: "wrong_id_space", message: "That is a workspace id." } });
    const state = await fetchConversationPresence("ws-1");
    expect(state.kind).toBe("wrong-id-space");
    if (state.kind !== "wrong-id-space") throw new Error("expected wrong-id-space");
    expect(state.message).toBe("That is a workspace id.");
  });

  test("404 is invalid-id and carries the route's own message", async () => {
    stubFetch(404, { error: { code: "invalid_id", message: '"nope" is not a valid id.' } });
    const state = await fetchConversationPresence("nope");
    expect(state.kind).toBe("invalid-id");
    if (state.kind !== "invalid-id") throw new Error("expected invalid-id");
    expect(state.message).toBe('"nope" is not a valid id.');
  });

  test("an undocumented failure throws rather than inventing a fifth honest-looking state", async () => {
    stubFetch(500, { error: { code: "internal", message: "boom" } });
    await expect(fetchConversationPresence("c-1")).rejects.toThrow("boom");
  });

  test("a non-JSON error body still throws, with a status-derived message", async () => {
    stubFetchRaw(502, "<html>bad gateway</html>");
    await expect(fetchConversationPresence("c-1")).rejects.toThrow("502");
  });

  test("the conversation id is percent-encoded into the path", async () => {
    const calls = stubFetch(200, OK_BODY);
    await fetchConversationPresence("a/b c");
    expect(calls[0]).toBe("/api/conversation/a%2Fb%20c/presence");
  });
});
