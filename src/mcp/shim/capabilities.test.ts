/**
 * `minsky mcp shim` — capability-narrowing tests (mt#4450).
 *
 * `stripUnsupportedCapabilities` is a pure function over a JSON-RPC message, so
 * these are value-in/value-out assertions with no collaborator patched in place
 * (ADR-036, `testing-standards.mdc §Testable Design`).
 *
 * The case that matters most is the LAST one: MCP declares a capability as an
 * empty object (`"elicitation": {}`), which is falsy-adjacent enough that a
 * truthiness check reads as correct and silently forwards every real
 * declaration. That test is the reason the implementation uses `in`.
 */

import { describe, test, expect } from "bun:test";
import { stripUnsupportedCapabilities, SERVER_INITIATED_CAPABILITIES } from "./capabilities";
import type { JsonRpcMessage } from "./protocol";

/** The `initialize` params Claude Code actually sends (ADR-038 §Question 1, Observation B). */
function realInitialize(): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: true }, elicitation: {} },
      clientInfo: { name: "claude-code", version: "2.1.222" },
    },
  } as JsonRpcMessage;
}

function capsOf(msg: JsonRpcMessage): Record<string, unknown> {
  return (msg.params as Record<string, unknown>)["capabilities"] as Record<string, unknown>;
}

describe("stripUnsupportedCapabilities (mt#4450)", () => {
  test("removes every server-initiated capability from a real Claude Code initialize", () => {
    const narrowed = stripUnsupportedCapabilities(realInitialize());

    expect(narrowed).not.toBeNull();
    const caps = capsOf(narrowed as JsonRpcMessage);
    expect("elicitation" in caps).toBe(false);
    expect("roots" in caps).toBe(false);
  });

  test("leaves the rest of the initialize params untouched", () => {
    const narrowed = stripUnsupportedCapabilities(realInitialize()) as JsonRpcMessage;
    const params = narrowed.params as Record<string, unknown>;

    expect(params["protocolVersion"]).toBe("2025-11-25");
    expect(params["clientInfo"]).toEqual({ name: "claude-code", version: "2.1.222" });
    expect(narrowed.id).toBe(0);
    expect(narrowed.method).toBe("initialize");
  });

  test("preserves capabilities that are NOT server-initiated", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { capabilities: { elicitation: {}, experimental: { someFlag: true } } },
    } as JsonRpcMessage;

    const caps = capsOf(stripUnsupportedCapabilities(msg) as JsonRpcMessage);
    expect("elicitation" in caps).toBe(false);
    expect(caps["experimental"]).toEqual({ someFlag: true });
  });

  test("does not mutate the input message", () => {
    const msg = realInitialize();
    stripUnsupportedCapabilities(msg);

    // The original must still be forwardable unchanged — `handleLine` keeps a
    // reference to it and the caller decides which one to use.
    expect("elicitation" in capsOf(msg)).toBe(true);
  });

  describe("returns null (caller forwards the original untouched)", () => {
    test("for a non-initialize method", () => {
      const msg = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { capabilities: { elicitation: {} } },
      } as JsonRpcMessage;
      expect(stripUnsupportedCapabilities(msg)).toBeNull();
    });

    test("when initialize declares no server-initiated capability", () => {
      const msg = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { capabilities: { experimental: {} } },
      } as JsonRpcMessage;
      expect(stripUnsupportedCapabilities(msg)).toBeNull();
    });

    test.each([
      ["missing params", { jsonrpc: "2.0", id: 0, method: "initialize" }],
      ["array params", { jsonrpc: "2.0", id: 0, method: "initialize", params: [] }],
      [
        "missing capabilities",
        { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "x" } },
      ],
      [
        "null capabilities",
        { jsonrpc: "2.0", id: 0, method: "initialize", params: { capabilities: null } },
      ],
      [
        "array capabilities",
        { jsonrpc: "2.0", id: 0, method: "initialize", params: { capabilities: [] } },
      ],
    ])("for %s", (_label, msg) => {
      expect(stripUnsupportedCapabilities(msg as JsonRpcMessage)).toBeNull();
    });
  });

  test("every name in SERVER_INITIATED_CAPABILITIES is actually stripped", () => {
    // Guards the set against an entry being added to the constant and not
    // reaching the filter — the two are one line apart today, and a future
    // refactor that splits them would otherwise fail silently.
    for (const name of SERVER_INITIATED_CAPABILITIES) {
      const msg = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { capabilities: { [name]: {}, experimental: {} } },
      } as JsonRpcMessage;

      const narrowed = stripUnsupportedCapabilities(msg);
      expect(narrowed).not.toBeNull();
      expect(name in capsOf(narrowed as JsonRpcMessage)).toBe(false);
    }
  });

  test("an empty-object declaration is removed — the falsy-value trap", () => {
    // NEGATIVE CONTROL for the implementation choice: `"elicitation": {}` is
    // the form the MCP spec prescribes, and `{}` is the value a truthiness
    // check would... actually pass. The trap is the inverse and worth pinning
    // explicitly: a check like `if (caps.elicitation)` DOES fire on `{}`, but
    // one written as `if (caps.elicitation === true)` or a `Boolean(...)` over
    // a declared-but-undefined entry does not. Both real forms are asserted.
    const emptyObject = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { capabilities: { elicitation: {} } },
    } as JsonRpcMessage;
    const explicitUndefined = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { capabilities: { elicitation: undefined } },
    } as JsonRpcMessage;

    expect(
      "elicitation" in capsOf(stripUnsupportedCapabilities(emptyObject) as JsonRpcMessage)
    ).toBe(false);
    expect(
      "elicitation" in capsOf(stripUnsupportedCapabilities(explicitUndefined) as JsonRpcMessage)
    ).toBe(false);
  });
});
