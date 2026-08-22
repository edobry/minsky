import { describe, test, expect } from "bun:test";
import { DaemonClient, DaemonRequestError } from "./client";
import type { JsonRpcMessage } from "./protocol";

interface FakeCall {
  url: string;
  init: RequestInit;
}

/**
 * Builds a fake `fetch` from a queue of canned responses/throws, recording
 * every call for assertions. Each queue entry is either a factory returning
 * a Response, or an Error to throw (simulating a network-level failure).
 */
function makeFakeFetch(queue: Array<(() => Response) | Error>) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("fake fetch queue exhausted");
    }
    if (next instanceof Error) throw next;
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CONTENT_TYPE_JSON = "application/json";
const ECONNREFUSED_MESSAGE = "connect ECONNREFUSED";

function jsonResponse(body: unknown, opts: { status?: number; sessionId?: string } = {}): Response {
  const headers = new Headers({ "content-type": CONTENT_TYPE_JSON });
  if (opts.sessionId) headers.set("mcp-session-id", opts.sessionId);
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers });
}

/** A 404 response shaped like src/mcp/server.ts's "Session not found" (-32001). */
function sessionNotFoundResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }),
    { status: 404, headers: { "content-type": CONTENT_TYPE_JSON } }
  );
}

function sseResponse(events: string[], opts: { sessionId?: string } = {}): Response {
  const headers = new Headers({ "content-type": "text/event-stream" });
  if (opts.sessionId) headers.set("mcp-session-id", opts.sessionId);
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return new Response(body, { status: 200, headers });
}

function noSleep() {
  return async (_ms: number) => {};
}

const INIT_REQUEST: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
};

const TOOL_CALL: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "tasks_get", arguments: { taskId: "mt#3812" } },
};

describe("DaemonClient.send — happy path", () => {
  test("posts JSON and returns the parsed JSON-RPC response, capturing the session id", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-1" }),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: "tok", fetchImpl });

    const result = await client.send(INIT_REQUEST);

    expect(result).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(client.sessionId).toBe("sess-1");
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["content-type"]).toBe(CONTENT_TYPE_JSON);
  });

  test("attaches mcp-session-id on subsequent requests once captured", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-1" }),
      () => jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }, { sessionId: "sess-1" }),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: null, fetchImpl });

    await client.send(INIT_REQUEST);
    await client.send(TOOL_CALL);

    const secondHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(secondHeaders["mcp-session-id"]).toBe("sess-1");
  });

  test("parses a multi-event SSE response into multiple JSON-RPC messages", async () => {
    const { fetchImpl } = makeFakeFetch([
      () =>
        sseResponse(
          [
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} }),
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }),
          ],
          { sessionId: "sess-1" }
        ),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: null, fetchImpl });

    const result = await client.send(TOOL_CALL);

    expect(result).toHaveLength(2);
    expect(result[0]?.method).toBe("notifications/progress");
    expect(result[1]?.result).toEqual({ ok: true });
  });
});

describe("DaemonClient.send — cold-start retry (mt#3811 acceptance test)", () => {
  test("retries connection-refused-class failures and succeeds once the daemon returns, without surfacing an error", async () => {
    const { fetchImpl } = makeFakeFetch([
      new TypeError(`fetch failed: ${ECONNREFUSED_MESSAGE}`),
      new TypeError(`fetch failed: ${ECONNREFUSED_MESSAGE}`),
      () => jsonResponse({ jsonrpc: "2.0", id: 2, result: { ok: true } }, { sessionId: "sess-1" }),
    ]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: noSleep(),
      retryIntervalMs: 1,
      retryWindowMs: 1000,
    });

    const result = await client.send(TOOL_CALL);

    expect(result).toEqual([{ jsonrpc: "2.0", id: 2, result: { ok: true } }]);
  });

  test("throws DaemonRequestError once the retry window is exhausted", async () => {
    const { fetchImpl } = makeFakeFetch([
      new TypeError(ECONNREFUSED_MESSAGE),
      new TypeError(ECONNREFUSED_MESSAGE),
      new TypeError(ECONNREFUSED_MESSAGE),
      new TypeError(ECONNREFUSED_MESSAGE),
    ]);
    // Deadline computed at call time; a 0ms window with any sleep tick
    // exceeding it guarantees at least one retry attempt then a timeout.
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: async () => {
        // Simulate real time passing so Date.now() >= deadline on the next check.
        await new Promise((r) => setTimeout(r, 5));
      },
      retryIntervalMs: 1,
      retryWindowMs: 1,
    });

    await expect(client.send(TOOL_CALL)).rejects.toThrow(DaemonRequestError);
  });

  test("isConnectionRefused override: a classifier returning false skips the retry and fails immediately", async () => {
    const { fetchImpl, calls } = makeFakeFetch([new TypeError(ECONNREFUSED_MESSAGE)]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: noSleep(),
      isConnectionRefused: () => false,
    });

    await expect(client.send(TOOL_CALL)).rejects.toThrow(DaemonRequestError);
    // No retry happened — exactly one call was made.
    expect(calls).toHaveLength(1);
  });
});

describe("DaemonClient.send — transparent session re-initialization (Scope: restart handling)", () => {
  test("replays the cached initialize + initialized notification and resends the original request after a 404 session-not-found", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      // 1. original initialize
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-old" }),
      // 2. tools/call with stale session -> daemon restarted -> 404 -32001
      () => sessionNotFoundResponse(),
      // 3. replayed initialize (session-less) -> new session id
      () => jsonResponse({ jsonrpc: "2.0", id: "replay", result: {} }, { sessionId: "sess-new" }),
      // 4. replayed notifications/initialized (best-effort, no body needed)
      () => new Response("", { status: 202 }),
      // 5. retried original tools/call, now with sess-new -> succeeds
      () =>
        jsonResponse({ jsonrpc: "2.0", id: 2, result: { ok: true } }, { sessionId: "sess-new" }),
    ]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: noSleep(),
    });

    // Mirrors main.ts's real call order: observeInbound() records the cached
    // initialize/initialized frames BEFORE send() forwards them — the client
    // never observes its own traffic.
    client.observeInbound(INIT_REQUEST);
    await client.send(INIT_REQUEST);
    client.observeInbound({ jsonrpc: "2.0", method: "notifications/initialized" });

    const result = await client.send(TOOL_CALL);

    expect(result).toEqual([{ jsonrpc: "2.0", id: 2, result: { ok: true } }]);
    expect(client.sessionId).toBe("sess-new");

    // Call 2 carried the stale session id; call 5 (final retry) carries the new one.
    const staleCallHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(staleCallHeaders["mcp-session-id"]).toBe("sess-old");
    const finalCallHeaders = calls[4]?.init.headers as Record<string, string>;
    expect(finalCallHeaders["mcp-session-id"]).toBe("sess-new");
  });

  test("throws DaemonRequestError when there is no cached initialize to replay", async () => {
    const { fetchImpl } = makeFakeFetch([() => sessionNotFoundResponse()]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: noSleep(),
    });

    // No prior observeInbound(initialize) call — nothing cached to replay.
    await expect(client.send(TOOL_CALL)).rejects.toThrow(DaemonRequestError);
  });
});

describe("DaemonClient.send — no silent drops on HTTP failure", () => {
  test("a non-404 error response throws DaemonRequestError instead of returning an empty result", async () => {
    const { fetchImpl } = makeFakeFetch([() => new Response("internal error", { status: 500 })]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      sleep: noSleep(),
    });

    await expect(client.send(TOOL_CALL)).rejects.toThrow(DaemonRequestError);
  });
});

describe("DaemonClient.closeSession", () => {
  test("sends a DELETE with the current session id when a session is established", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-1" }),
      () => new Response("", { status: 200 }),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: "tok", fetchImpl });

    await client.send(INIT_REQUEST);
    await client.closeSession();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("DELETE");
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["mcp-session-id"]).toBe("sess-1");
  });

  test("is a no-op when no session has ever been established", async () => {
    const { fetchImpl, calls } = makeFakeFetch([]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: null, fetchImpl });

    await client.closeSession();

    expect(calls).toHaveLength(0);
  });

  test("never throws even if the DELETE request fails", async () => {
    const { fetchImpl } = makeFakeFetch([
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-1" }),
      new TypeError("connection reset"),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: null, fetchImpl });

    await client.send(INIT_REQUEST);
    await expect(client.closeSession()).resolves.toBeUndefined();
  });
});

/**
 * Request timeout (mt#4450) — AT4.
 *
 * Two independent properties, because the bug this backstops was invisible in
 * exactly the gap between them: a request the daemon ACCEPTED and never
 * answered used to ride an undocumented runtime default and then surface as a
 * connection failure, which is the opposite diagnosis.
 */
describe("DaemonClient — request timeout (mt#4450)", () => {
  /** The error shape `AbortSignal.timeout()` rejects with. */
  function timeoutError(): Error {
    const err = new Error("The operation timed out.");
    err.name = "TimeoutError";
    return err;
  }

  test("every POST carries an abort signal", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    const client = new DaemonClient({ url: "http://d/mcp", authToken: null, fetchImpl });

    await client.send(INIT_REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal).toBeDefined();
  });

  test("a timeout is reported as an unanswered request, NOT as an unreachable daemon", async () => {
    // The discriminating assertion. `DEFAULT_IS_CONNECTION_REFUSED` returns
    // true for every network-level throw, so without the explicit timeout
    // branch this same input produces "daemon unreachable after 15000ms retry
    // window" — a message that sends the reader to look at whether the daemon
    // is running, when in fact it accepted the request and held it.
    const { fetchImpl } = makeFakeFetch([timeoutError()]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      requestTimeoutMs: 1234,
    });

    const err = await client.send(INIT_REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(DaemonRequestError);
    expect((err as Error).message).toContain("1234ms");
    expect((err as Error).message).toContain("never answered");
    expect((err as Error).message).not.toContain("unreachable");
  });

  test("a genuine connection failure is still retried, not misread as a timeout", async () => {
    // Negative control for the branch above: the timeout check must not
    // swallow the connection-refused path it was inserted in front of. A
    // refused connection followed by a success still succeeds.
    const { fetchImpl, calls } = makeFakeFetch([
      new TypeError(ECONNREFUSED_MESSAGE),
      () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    const client = new DaemonClient({
      url: "http://d/mcp",
      authToken: null,
      fetchImpl,
      retryIntervalMs: 1,
    });

    await expect(client.send(INIT_REQUEST)).resolves.toBeDefined();
    expect(calls).toHaveLength(2);
  });
});
