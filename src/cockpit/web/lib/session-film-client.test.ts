/**
 * Tests for session-film-client.ts (mt#3184; mt#3262 content/resolve additions).
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  SessionFilmError,
  fetchSessionFilmContent,
  fetchSessionFilmEvents,
  resolveEventContent,
  sessionFilmRetry,
} from "./session-film-client";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";

/** The reachable server-refusal code both fetchers surface (see ADR-040 — the
 *  422 `unscrubbed` refusal these tests used to exercise no longer exists). */
const NOT_FOUND_CODE = "session_not_found";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("fetchSessionFilmEvents", () => {
  test("returns the parsed events + ingestedAt on success", async () => {
    mockFetch(200, { events: [{ verb: "read" }], ingestedAt: "2026-07-20T00:00:00.000Z" });
    const result = await fetchSessionFilmEvents("abc");
    expect(result.events).toHaveLength(1);
    expect(result.ingestedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  test("throws SessionFilmError carrying status + code on a server refusal", async () => {
    mockFetch(404, { error: { code: NOT_FOUND_CODE, message: "No transcript found" } });
    await expect(fetchSessionFilmEvents("abc")).rejects.toThrow(SessionFilmError);
    try {
      await fetchSessionFilmEvents("abc");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionFilmError);
      expect((err as SessionFilmError).status).toBe(404);
      expect((err as SessionFilmError).code).toBe(NOT_FOUND_CODE);
    }
  });

  // This used to assert the `verifiedRescrubbed` param, which went away with
  // the gate (mt#3268 / ADR-040). What still matters is that the fetch
  // carries the conversation id and nothing else.
  test("requests the events endpoint with conversationId as the only param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ events: [], ingestedAt: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSessionFilmEvents("abc");
    expect(capturedUrl).toContain("/api/cockpit/session-film/events");
    expect(new URL(capturedUrl, "http://localhost").searchParams.get("conversationId")).toBe("abc");
    expect(capturedUrl).not.toContain("verifiedRescrubbed");
  });
});

describe("fetchSessionFilmContent (mt#3262)", () => {
  test("returns the parsed blocks + ingestedAt on success", async () => {
    mockFetch(200, {
      blocks: [{ id: "b0", turnIndex: 0 }],
      ingestedAt: "2026-07-20T00:00:00.000Z",
    });
    const result = await fetchSessionFilmContent("abc");
    expect(result.blocks).toHaveLength(1);
    expect(result.ingestedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  test("throws SessionFilmError carrying status + code on a server refusal", async () => {
    mockFetch(404, { error: { code: NOT_FOUND_CODE, message: "No transcript found" } });
    await expect(fetchSessionFilmContent("abc")).rejects.toThrow(SessionFilmError);
    try {
      await fetchSessionFilmContent("abc");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionFilmError);
      expect((err as SessionFilmError).status).toBe(404);
      expect((err as SessionFilmError).code).toBe(NOT_FOUND_CODE);
    }
  });

  // See the events counterpart above — same removal, same reason (ADR-040).
  test("requests the content endpoint with conversationId as the only param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ blocks: [], ingestedAt: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSessionFilmContent("abc");
    expect(capturedUrl).toContain("/api/cockpit/session-film/content");
    expect(new URL(capturedUrl, "http://localhost").searchParams.get("conversationId")).toBe("abc");
    expect(capturedUrl).not.toContain("verifiedRescrubbed");
  });
});

describe("resolveEventContent (mt#3262 SC 2)", () => {
  const AGENT_ID = "agent-1";

  function assistantBlock(turnIndex: number, content: unknown[]): SessionContextSnapshotBlock {
    return {
      id: `${AGENT_ID}:turn:${turnIndex}`,
      type: "assistant-text",
      source: "observed",
      content: { role: "assistant", content },
      timestamp: "2026-07-28T10:00:00.000Z",
      turnIndex,
      rawJsonlType: "assistant",
    };
  }

  function userBlock(turnIndex: number, content: unknown): SessionContextSnapshotBlock {
    return {
      id: `${AGENT_ID}:turn:${turnIndex}`,
      type: "user-prompt",
      source: "observed",
      content: { role: "user", content },
      timestamp: "2026-07-28T10:00:00.000Z",
      turnIndex,
      rawJsonlType: "user",
    };
  }

  function fakeEvent(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
    return {
      schemaVersion: "v0",
      tStart: "2026-07-28T10:00:00.000Z",
      actor: { kind: "agent", agentSessionId: AGENT_ID },
      verb: "think",
      target: { realm: "agents", id: `agents:${AGENT_ID}` },
      outcome: "ok",
      weight: 0,
      adapterVersion: "test",
      ...overrides,
    };
  }

  test("resolves a think event to the turn's thinking element", () => {
    const blocks = [
      assistantBlock(1, [
        { type: "thinking", thinking: "reasoning text" },
        { type: "text", text: "hello" },
      ]),
    ];
    const event = fakeEvent({ verb: "think", sourceRef: { turnIndex: 1 } });
    expect(resolveEventContent(blocks, event)).toEqual({
      kind: "thinking",
      thinking: "reasoning text",
    });
  });

  test("resolves a speak event to the turn's text element", () => {
    const blocks = [
      assistantBlock(1, [
        { type: "thinking", thinking: "reasoning text" },
        { type: "text", text: "hello" },
      ]),
    ];
    const event = fakeEvent({ verb: "speak", sourceRef: { turnIndex: 1 } });
    expect(resolveEventContent(blocks, event)).toEqual({ kind: "text", text: "hello" });
  });

  test("resolves an ask event to the user turn's text element", () => {
    const blocks = [userBlock(0, "please do X")];
    const event = fakeEvent({
      verb: "ask",
      actor: { kind: "principal" },
      sourceRef: { turnIndex: 0 },
    });
    expect(resolveEventContent(blocks, event)).toEqual({ kind: "text", text: "please do X" });
  });

  test("resolves a tool-call event to its call+paired result via toolUseId", () => {
    const blocks = [
      assistantBlock(1, [
        { type: "tool_use", id: "call-a", name: "session_read_file", input: { path: "a.ts" } },
      ]),
      userBlock(2, [
        { type: "tool_result", tool_use_id: "call-a", content: "contents of a", is_error: false },
      ]),
    ];
    const event = fakeEvent({
      verb: "read",
      target: { realm: "repo", id: "file:workspace:a.ts" },
      sourceRef: { turnIndex: 1, toolUseId: "call-a" },
    });
    const resolved = resolveEventContent(blocks, event);
    expect(resolved?.kind).toBe("tool-invocation");
    if (resolved?.kind === "tool-invocation") {
      expect(resolved.call.name).toBe("session_read_file");
      expect(resolved.result?.content).toBe("contents of a");
    }
  });

  test("degrades gracefully (null) when the event carries no sourceRef", () => {
    const event = fakeEvent();
    delete (event as { sourceRef?: unknown }).sourceRef;
    expect(resolveEventContent([assistantBlock(1, [])], event)).toBeNull();
  });

  test("degrades gracefully (null) when blocks are undefined (still loading)", () => {
    const event = fakeEvent({ sourceRef: { turnIndex: 1 } });
    expect(resolveEventContent(undefined, event)).toBeNull();
  });

  test("degrades gracefully (null) when the referenced turnIndex has no block", () => {
    const event = fakeEvent({ sourceRef: { turnIndex: 5 } });
    expect(resolveEventContent([assistantBlock(1, [])], event)).toBeNull();
  });

  test("degrades gracefully (null) when a tool-call event's toolUseId has no matching call", () => {
    const blocks = [assistantBlock(1, [{ type: "text", text: "no tool call here" }])];
    const event = fakeEvent({
      verb: "read",
      sourceRef: { turnIndex: 1, toolUseId: "call-missing" },
    });
    expect(resolveEventContent(blocks, event)).toBeNull();
  });
});

describe("sessionFilmRetry", () => {
  test("does not retry a 4xx client error", () => {
    expect(sessionFilmRetry(0, new SessionFilmError(422, "unscrubbed", "x"))).toBe(false);
  });

  test("retries a 5xx up to 3 times", () => {
    expect(sessionFilmRetry(0, new SessionFilmError(500, "internal", "x"))).toBe(true);
    expect(sessionFilmRetry(3, new SessionFilmError(500, "internal", "x"))).toBe(false);
  });
});
