/**
 * Tests for the `tools/call` test-support helper (mt#4854).
 *
 * The helper exists so four suites can drive the real dispatch path; its own contract —
 * which `ctx.mcpReq` members are supplied, and who wins when the caller supplies one —
 * had no coverage, and PR #3547 R2 found the code contradicting its own docblock: the
 * caller's `mcpReq` was silently discarded while the comment claimed otherwise.
 *
 * These assert the contract directly rather than through a real SDK `Server`, because
 * the question is entirely about the object the helper constructs.
 */

import { describe, test, expect } from "bun:test";
import { getToolsCallHandler } from "./tools-call-handler";

/** A stand-in for the SDK `Server`'s private registry, capturing the ctx it is handed. */
function fakeSdkServer(): { server: unknown; seen: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const handlers = new Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>([
    [
      "tools/call",
      async (_request: unknown, ctx: unknown) => {
        captured = ctx as Record<string, unknown>;
        return { ok: true };
      },
    ],
  ]);
  return { server: { _requestHandlers: handlers }, seen: () => captured };
}

describe("getToolsCallHandler (mt#4854)", () => {
  test("supplies both ctx.mcpReq members our dispatch path and the SDK reach", async () => {
    const { server, seen } = fakeSdkServer();

    await getToolsCallHandler(server)({ method: "tools/call" });

    const mcpReq = seen()?.mcpReq as { requestState: () => unknown; notify: () => unknown };
    // `requestState` is read by the SDK's own _invokeInputRequiredCapableHandler before it
    // delegates; `notify` by server.ts:1471 when a request carries a progressToken.
    expect(typeof mcpReq.requestState).toBe("function");
    expect(typeof mcpReq.notify).toBe("function");
    expect(mcpReq.requestState()).toBeUndefined();
  });

  test("a caller-supplied mcpReq member WINS over the default, and the others survive", async () => {
    const { server, seen } = fakeSdkServer();
    const notifications: unknown[] = [];

    await getToolsCallHandler(server)(
      { method: "tools/call" },
      { mcpReq: { notify: async (n: unknown) => void notifications.push(n) } }
    );

    const mcpReq = seen()?.mcpReq as {
      requestState: () => unknown;
      notify: (n: unknown) => Promise<void>;
    };
    // The override reaches the handler...
    await mcpReq.notify("progress-tick");
    expect(notifications).toEqual(["progress-tick"]);
    // ...and does NOT clobber the sibling default. This is the R2 regression: with the
    // caller's `mcpReq` spread in the WRONG order, one of these two assertions fails —
    // either the override is discarded, or supplying one member drops the other.
    expect(typeof mcpReq.requestState).toBe("function");
  });

  test("top-level ctx keys the caller supplies are preserved", async () => {
    const { server, seen } = fakeSdkServer();

    await getToolsCallHandler(server)({ method: "tools/call" }, { sessionId: "session-abc" });

    // `sessionId` stays top-level in SDK v2 (its own contextPropertyMap maps
    // `.sessionId` -> `.sessionId`), and diagnostic-capture.ts reads it from there.
    expect(seen()?.sessionId).toBe("session-abc");
  });

  test("throws a named error when no tools/call handler is registered", () => {
    expect(() => getToolsCallHandler({ _requestHandlers: new Map() })).toThrow(
      "Expected tools/call handler to be registered"
    );
  });
});
