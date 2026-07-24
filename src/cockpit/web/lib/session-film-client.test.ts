/**
 * Tests for session-film-client.ts (mt#3184).
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  SessionFilmError,
  fetchSessionFilmEvents,
  fetchSessionFilmSessions,
  sessionFilmRetry,
} from "./session-film-client";

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

  test("throws SessionFilmError carrying status + code on a scrub-gate refusal", async () => {
    mockFetch(422, { error: { code: "unscrubbed", message: "Export refused" } });
    await expect(fetchSessionFilmEvents("abc")).rejects.toThrow(SessionFilmError);
    try {
      await fetchSessionFilmEvents("abc");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionFilmError);
      expect((err as SessionFilmError).status).toBe(422);
      expect((err as SessionFilmError).code).toBe("unscrubbed");
    }
  });

  test("passes verifiedRescrubbed=true as a query param when asserted", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ events: [], ingestedAt: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSessionFilmEvents("abc", true);
    expect(capturedUrl).toContain("verifiedRescrubbed=true");
  });
});

describe("fetchSessionFilmSessions", () => {
  test("returns the sessions array", async () => {
    mockFetch(200, {
      sessions: [
        {
          agentSessionId: "abc",
          label: "test",
          startedAt: null,
          cwd: null,
          ingestedAt: null,
          scrubGateOk: false,
        },
      ],
    });
    const rows = await fetchSessionFilmSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scrubGateOk).toBe(false);
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
