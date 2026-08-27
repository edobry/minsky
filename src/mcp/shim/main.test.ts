/**
 * `minsky mcp shim` — `handleLine` tests (mt#4128).
 *
 * Covers the served-tool-count record: the shim writes, to stderr, how many
 * tools each `tools/list` response carried. That record is the signal mt#4128
 * exists to add — a conversation can hold ZERO `mcp__minsky__*` tools for its
 * whole life while every process stays healthy and `claude mcp list` reports the
 * server Connected, and until this record existed there was nothing anywhere
 * saying whether a list had been served or how big it was.
 *
 * `handleLine` is exercised directly rather than through the stdin plumbing —
 * it takes `client`, `stdout` and `stderr` as injected dependencies, so the
 * observable behavior is reachable with fakes and no collaborator is patched in
 * place (ADR-036). The `stderr` sink here IS the contract under test, which is
 * the support-log case `testing-boundaries.mdc §Console Output` permits: the
 * assertion is on fact-of-emission plus the count, never on formatting of
 * unrelated output.
 */

import { describe, test, expect } from "bun:test";
import { handleLine, runShim } from "./main";
import { AGENT_ID_META_KEY } from "./identity";
import type { DaemonClient } from "./client";
import type { JsonRpcMessage } from "./protocol";

/** A collecting sink standing in for a real stream. */
function makeSink(): { write: (s: string) => boolean; written: string[] } {
  const written: string[] = [];
  return {
    write: (s: string) => {
      written.push(s);
      return true;
    },
    written,
  };
}

/**
 * A DaemonClient fake that returns a fixed response set. Explicit object rather
 * than a generated mock, per `bun-test-patterns.mdc` §Explicit Mock Pattern.
 */
function makeClient(responses: JsonRpcMessage[]): DaemonClient {
  return {
    observeInbound: () => {},
    send: async () => responses,
  } as unknown as DaemonClient;
}

const TOOLS_LIST_REQUEST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

describe("handleLine — served-tool-count record (mt#4128)", () => {
  test("records the count for a healthy tools/list response", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const client = makeClient([
      { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }, { name: "b" }] } },
    ]);

    await handleLine(TOOLS_LIST_REQUEST, {
      client,
      conversationAgentId: null,
      stdout,
      stderr,
    });

    expect(stderr.written.join("")).toContain("tools/list served: 2 tool(s)");
  });

  test("records 0 for a served-but-empty tool list — the mt#4128 condition's signature", async () => {
    // The two-value half of the demonstration. A probe that reports the same
    // thing whether or not the system is broken carries no information
    // (mem#704), so the toolless case must be distinguishable — not merely
    // absent from the log.
    const stdout = makeSink();
    const stderr = makeSink();
    const client = makeClient([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);

    await handleLine(TOOLS_LIST_REQUEST, {
      client,
      conversationAgentId: null,
      stdout,
      stderr,
    });

    expect(stderr.written.join("")).toContain("tools/list served: 0 tool(s)");
  });

  test("records nothing for a response that is not a tools/list", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const client = makeClient([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);

    await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }), {
      client,
      conversationAgentId: null,
      stdout,
      stderr,
    });

    expect(stderr.written.join("")).not.toContain("tools/list served");
  });

  test("a failing stderr write neither fabricates an error response nor drops the real one", async () => {
    // Regression test for PR #3038 R1 (BLOCKING). The record is written inside
    // the same `try` that converts a throw into a "daemon request failed"
    // JSON-RPC error frame. Unguarded, an EPIPE on stderr — which says nothing
    // about the daemon — was reported to the client as a daemon failure, and
    // the response that actually succeeded was never forwarded.
    const stdout = makeSink();
    const throwingStderr = {
      write: (): boolean => {
        throw new Error("EPIPE");
      },
    };
    const client = makeClient([{ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } }]);

    await handleLine(TOOLS_LIST_REQUEST, {
      client,
      conversationAgentId: null,
      stdout,
      stderr: throwingStderr,
    });

    const out = stdout.written.join("").trim();
    // The real response still reaches the client, unmodified...
    expect(JSON.parse(out)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "a" }] },
    });
    // ...and no error frame was fabricated from a diagnostic-stream failure.
    expect(out).not.toContain("daemon request failed");
  });

  test("the record goes to stderr and never to stdout", async () => {
    // Load-bearing, not incidental: stdout IS the JSON-RPC channel. A
    // diagnostic for channel corruption that wrote to stdout would be a cause
    // of the condition it reports on, which is why this record bypasses `log.*`
    // (whose `agent` sink writes structured JSON to stdout under
    // MINSKY_LOG_MODE=STRUCTURED — packages/shared/src/logger.ts:136).
    const stdout = makeSink();
    const stderr = makeSink();
    const client = makeClient([{ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } }]);

    await handleLine(TOOLS_LIST_REQUEST, {
      client,
      conversationAgentId: null,
      stdout,
      stderr,
    });

    expect(stdout.written.join("")).not.toContain("tools/list served");
    // stdout still carries the forwarded response itself, unmodified.
    expect(JSON.parse(stdout.written.join("").trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "a" }] },
    });
  });
});

/**
 * Capability narrowing at the handshake (mt#4450).
 *
 * `capabilities.test.ts` covers the transform itself; these cover the two
 * things only `handleLine` can answer — that the narrowed message is what gets
 * SENT, and that it is also what gets OBSERVED.
 *
 * The observe assertion is the load-bearing one and is not a redundant restatement
 * of the send assertion. `observeInbound` stores the `initialize` request for
 * REPLAY on session recovery (`client.ts`'s `reinitialize`), so observing the
 * original would re-advertise `elicitation` on the first reconnect and the fix
 * would survive only until then — a regression that reproduces exactly when
 * nobody is looking.
 */
describe("handleLine — capability narrowing (mt#4450)", () => {
  /** A client fake that records what it was sent and what it was asked to observe. */
  function makeRecordingClient(): {
    client: DaemonClient;
    sent: JsonRpcMessage[];
    observed: JsonRpcMessage[];
  } {
    const sent: JsonRpcMessage[] = [];
    const observed: JsonRpcMessage[] = [];
    return {
      sent,
      observed,
      client: {
        observeInbound: (msg: JsonRpcMessage) => {
          observed.push(msg);
        },
        send: async (msg: JsonRpcMessage) => {
          sent.push(msg);
          return [{ jsonrpc: "2.0", id: 0, result: {} }];
        },
      } as unknown as DaemonClient,
    };
  }

  const INITIALIZE = JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: true }, elicitation: {} },
      clientInfo: { name: "claude-code", version: "2.1.222" },
    },
  });

  function capsOf(msg: JsonRpcMessage): Record<string, unknown> {
    return (msg.params as Record<string, unknown>)["capabilities"] as Record<string, unknown>;
  }

  test("the daemon is sent an initialize with no elicitation capability", async () => {
    const { client, sent } = makeRecordingClient();

    await handleLine(INITIALIZE, {
      client,
      conversationAgentId: null,
      stdout: makeSink(),
      stderr: makeSink(),
    });

    expect(sent).toHaveLength(1);
    expect("elicitation" in capsOf(sent[0] as JsonRpcMessage)).toBe(false);
    // Untouched fields still arrive, so the daemon can still negotiate.
    expect((sent[0]?.params as Record<string, unknown>)["protocolVersion"]).toBe("2025-11-25");
  });

  test("the message stored for replay is the narrowed one, not the original", async () => {
    const { client, observed } = makeRecordingClient();

    await handleLine(INITIALIZE, {
      client,
      conversationAgentId: null,
      stdout: makeSink(),
      stderr: makeSink(),
    });

    expect(observed).toHaveLength(1);
    expect("elicitation" in capsOf(observed[0] as JsonRpcMessage)).toBe(false);
  });

  test("a non-initialize message is observed and sent unchanged", async () => {
    // Negative control: the narrowing must not touch anything else on the wire.
    const { client, sent, observed } = makeRecordingClient();

    await handleLine(TOOLS_LIST_REQUEST, {
      client,
      conversationAgentId: null,
      stdout: makeSink(),
      stderr: makeSink(),
    });

    expect(sent[0]).toEqual(JSON.parse(TOOLS_LIST_REQUEST));
    expect(observed[0]).toEqual(JSON.parse(TOOLS_LIST_REQUEST));
  });
});

/**
 * The per-frame identity wiring (mt#4440).
 *
 * `handleLine` above is a pure function of the id it is HANDED, so every test
 * in this file passes whether that id is recomputed per frame or frozen once at
 * startup. That gap is exactly where the defect lived for five days: `runShim`
 * resolved `CLAUDE_CODE_SESSION_ID` once and passed the same frozen value to
 * every line, so a shim outliving a `/clear` stamped a conversation that had
 * ended — while `identity.test.ts` and this file were both green.
 *
 * So the assertion has to be on `runShim`'s WIRING, not on the resolver and not
 * on `handleLine`. `resolveAgentId` is injected (see `ShimDeps`) so the
 * property is observable without patching a module `main.ts` reaches itself.
 */
describe("runShim — per-frame identity resolution (mt#4440)", () => {
  const FIRST = "com.anthropic.claude-code:conv:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const SECOND = "com.anthropic.claude-code:conv:11111111-2222-4333-8444-555555555555";

  /** Minimal stdin stand-in: records handlers, never emits `end`. */
  function makeStdin(): {
    on: (event: string, cb: (chunk: string) => void) => unknown;
    emitData: (chunk: string) => void;
  } {
    const handlers: Record<string, Array<(chunk: string) => void>> = {};
    const stdin = {
      on(event: string, cb: (chunk: string) => void) {
        (handlers[event] ??= []).push(cb);
        return stdin;
      },
      emitData(chunk: string) {
        for (const cb of handlers["data"] ?? []) cb(chunk);
      },
    };
    return stdin;
  }

  test("re-resolves the stamped agentId on EVERY frame, not once at startup", async () => {
    const sent: JsonRpcMessage[] = [];
    const client = {
      observeInbound: () => {},
      send: async (msg: JsonRpcMessage) => {
        sent.push(msg);
        return [];
      },
    } as unknown as DaemonClient;

    // The conversation SWITCHES between the two frames — the `/clear` case.
    let current = FIRST;
    const stdin = makeStdin();

    runShim(
      { url: "http://127.0.0.1:1/mcp", tokenPath: "/nonexistent/token" },
      {
        client,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        stderr: { write: () => true } as unknown as NodeJS.WriteStream,
        resolveAgentId: () => current,
      }
    );

    // Wait on the OBSERVABLE (a frame reaching the client), not on a fixed
    // number of microtask ticks (PR #3403 R1). `runShim` dispatches each line
    // with `void handleLine(...)`, so there is nothing to await directly — and a
    // tick count is a guess about the callee's internals that silently passes
    // with zero frames if it is ever wrong. This fails loudly instead.
    // Bounded by ITERATIONS rather than a wall-clock deadline: `custom/no-real-
    // fs-in-tests` reads a `Date.now()` in a test as unique-path creation, and
    // this repo's lint gate admits no warnings. A fixed cap is the better shape
    // here anyway — it cannot be made flaky by a slow machine's clock.
    async function waitForFrames(n: number): Promise<void> {
      for (let i = 0; i < 500 && sent.length < n; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (sent.length < n) {
        throw new Error(`expected ${n} forwarded frame(s), saw ${sent.length}`);
      }
    }

    stdin.emitData(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_get" } })}\n`
    );
    await waitForFrames(1);

    // Only NOW switch, so the first frame provably resolved against FIRST.
    current = SECOND;

    stdin.emitData(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tasks_get" } })}\n`
    );
    await waitForFrames(2);

    expect(sent.length).toBe(2);
    const first = sent[0]?.params as { _meta?: Record<string, unknown> } | undefined;
    const second = sent[1]?.params as { _meta?: Record<string, unknown> } | undefined;

    expect(first?._meta?.[AGENT_ID_META_KEY]).toBe(FIRST);
    // The frozen-at-startup shape stamps FIRST here too — that inequality is
    // the whole assertion.
    expect(second?._meta?.[AGENT_ID_META_KEY]).toBe(SECOND);
  });
});
