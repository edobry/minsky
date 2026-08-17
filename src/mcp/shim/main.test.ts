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
import { handleLine } from "./main";
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
