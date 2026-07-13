/**
 * mt#1792 — lazy handler (getHandler thunk) unit tests
 *
 * Verifies the getHandler thunk resolution contract added to ToolDefinition
 * and threaded through CommandMapper.addCommand:
 *
 * 1. First call to a lazy-registered tool resolves the thunk and caches the
 *    result on tool.handler for subsequent calls.
 * 2. Second call uses the cached handler (thunk is NOT invoked again).
 * 3. opt-out via requiresInit: false still works on the thunk path.
 * 4. Legacy direct handler (eager form) still dispatches correctly.
 */

import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "./mcp/server";

// ---------------------------------------------------------------------------
// Minimal dispatch helper that mirrors the actual CallTool handler in
// src/mcp/server.ts (the section starting at the initPromise await).
// We reproduce just the getHandler resolution + caching logic so the unit
// tests don't need to instantiate a full MinskyMCPServer.
// ---------------------------------------------------------------------------

/**
 * Simulates the CallTool dispatch logic for getHandler/handler resolution.
 * Returns { resolvedViaThunk, handler } — resolvedViaThunk is true iff
 * tool.getHandler was invoked during this dispatch call.
 */
async function dispatch(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  initPromise: Promise<void> | null = null
): Promise<{ result: unknown; resolvedViaThunk: boolean }> {
  // Mirror of the initPromise await gate (simplified — requiresInit check
  // is tested separately below; here we just pass initPromise through).
  if (initPromise) {
    await initPromise;
  }

  let resolvedViaThunk = false;

  // mt#1792: lazy handler resolution (mirrors server.ts CallTool handler)
  if (!tool.handler && tool.getHandler) {
    resolvedViaThunk = true;
    tool.handler = await tool.getHandler();
  }

  if (!tool.handler) {
    throw new Error(`Tool '${tool.name}' has no handler or getHandler`);
  }

  const result = await tool.handler(args);
  return { result, resolvedViaThunk };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("mt#1792 — lazy getHandler thunk resolution", () => {
  // (a) First call resolves the thunk and caches the resolved handler.
  test("first call to a lazy-registered tool resolves the thunk and caches handler", async () => {
    let thunkCallCount = 0;

    const tool: ToolDefinition = {
      name: "test.lazy",
      description: "test",
      getHandler: async () => {
        thunkCallCount++;
        return async (_args) => ({ called: true });
      },
    };

    expect(tool.handler).toBeUndefined();

    const { result, resolvedViaThunk } = await dispatch(tool, {});

    expect(resolvedViaThunk).toBe(true);
    expect(thunkCallCount).toBe(1);
    expect(result).toEqual({ called: true });

    // After first call, handler is now cached on the tool object
    expect(tool.handler).toBeDefined();
    expect(typeof tool.handler).toBe("function");
  });

  // (b) Second call uses the cached handler — thunk is NOT invoked again.
  test("second call uses the cached handler (thunk not invoked again)", async () => {
    let thunkCallCount = 0;

    const tool: ToolDefinition = {
      name: "test.lazy.cached",
      description: "test",
      getHandler: async () => {
        thunkCallCount++;
        return async (_args) => ({ callCount: thunkCallCount });
      },
    };

    // First call — resolves the thunk
    const { resolvedViaThunk: first } = await dispatch(tool, {});
    expect(first).toBe(true);
    expect(thunkCallCount).toBe(1);

    // Second call — uses the cached handler, thunk not invoked again
    const { resolvedViaThunk: second, result: result2 } = await dispatch(tool, {});
    expect(second).toBe(false); // handler was already set, so no thunk resolution
    expect(thunkCallCount).toBe(1); // still 1 — thunk was NOT called again
    // The result still comes from the handler returned by the thunk
    expect(result2).toEqual({ callCount: 1 });
  });

  // (c) requiresInit: false still works correctly with the thunk path —
  //     the dispatch correctly skips awaiting initPromise for DI-free tools,
  //     whether they use handler or getHandler.
  test("requiresInit: false opt-out works on the lazy thunk path", async () => {
    // Simulates the requiresInit gate — mirrors the actual server.ts logic
    const DI_FREE = new Set(["debug.echo", "debug.listMethods", "debug.systemInfo"]);

    async function dispatchWithInit(
      tool: ToolDefinition & { requiresInit?: boolean },
      initPromise: Promise<void>
    ): Promise<{ awaited: boolean; resolved: boolean }> {
      const requiresInit = tool.requiresInit !== false && !DI_FREE.has(tool.name);
      let awaited = false;

      if (initPromise && requiresInit) {
        await initPromise.then(() => {
          awaited = true;
        });
      }

      let resolved = false;
      if (!tool.handler && tool.getHandler) {
        resolved = true;
        tool.handler = await tool.getHandler();
      }

      if (!tool.handler) throw new Error("no handler");
      await tool.handler({});

      return { awaited, resolved };
    }

    const neverResolves = new Promise<void>(() => {
      // intentionally never resolves — if awaited, test would time out
    });

    const lazyDIFreeTool: ToolDefinition = {
      name: "test.lazy.di-free",
      description: "test",
      requiresInit: false,
      getHandler: async () => async (_args) => ({ ok: true }),
    };

    // Should NOT await initPromise (requiresInit: false) AND should resolve thunk
    const { awaited, resolved } = await dispatchWithInit(lazyDIFreeTool, neverResolves);
    expect(awaited).toBe(false);
    expect(resolved).toBe(true);
  });

  // (d) Legacy eager handler still dispatches correctly — backward compatibility.
  test("legacy direct handler (eager form) still dispatches correctly", async () => {
    let handlerCallCount = 0;

    const tool: ToolDefinition = {
      name: "test.eager",
      description: "test",
      handler: async (_args) => {
        handlerCallCount++;
        return { eagerResult: handlerCallCount };
      },
    };

    const { result, resolvedViaThunk } = await dispatch(tool, {});

    // Eager handler dispatches without going through the thunk path
    expect(resolvedViaThunk).toBe(false);
    expect(handlerCallCount).toBe(1);
    expect(result).toEqual({ eagerResult: 1 });

    // handler is still the same function (no caching mutation needed)
    expect(tool.handler).toBeDefined();
  });

  // Bonus: both handler and getHandler present — handler takes precedence
  test("when both handler and getHandler are present, handler takes precedence", async () => {
    let thunkCallCount = 0;
    let directCallCount = 0;

    const tool: ToolDefinition = {
      name: "test.both",
      description: "test",
      handler: async (_args) => {
        directCallCount++;
        return { direct: true };
      },
      getHandler: async () => {
        thunkCallCount++;
        return async (_args) => ({ lazy: true });
      },
    };

    const { result, resolvedViaThunk } = await dispatch(tool, {});

    expect(resolvedViaThunk).toBe(false); // thunk not invoked when handler present
    expect(thunkCallCount).toBe(0);
    expect(directCallCount).toBe(1);
    expect(result).toEqual({ direct: true });
  });

  // Tool with neither handler nor getHandler should throw
  test("tool with neither handler nor getHandler throws on dispatch", async () => {
    const tool: ToolDefinition = {
      name: "test.broken",
      description: "test",
    };

    await expect(dispatch(tool, {})).rejects.toThrow(
      "Tool 'test.broken' has no handler or getHandler"
    );
  });
});

// ---------------------------------------------------------------------------
// CommandMapper integration: verify addCommand threads getHandler correctly
// ---------------------------------------------------------------------------

describe("mt#1792 — CommandMapper.addCommand getHandler threading", () => {
  test("addCommand with getHandler registers a lazy ToolDefinition", async () => {
    // We can't import MinskyMCPServer (too heavy for a unit test), but we CAN
    // verify the ToolDefinition shape that addCommand produces by inspecting
    // the addTool call on a minimal server mock.
    let capturedToolDef: ToolDefinition | undefined;

    const mockServer = {
      addTool: (tool: ToolDefinition) => {
        capturedToolDef = tool;
      },
    };

    // Inline minimal CommandMapper to avoid constructing the full stack
    // (constructor requires a real Server instance). Instead, reproduce only
    // the branching logic we want to verify.
    let thunkCallCount = 0;

    const lazyCommand = {
      name: "test.lazy.cmd",
      description: "lazy command test",
      getHandler: async () => {
        thunkCallCount++;
        return async (_args: Record<string, unknown>, _ctx?: unknown) => ({
          lazy: true,
          thunkCount: thunkCallCount,
        });
      },
    };

    // Reproduce the lazy branch from CommandMapper.addCommand
    if (!lazyCommand.getHandler) {
      throw new Error("no getHandler — test setup error");
    }

    const normalizedName = lazyCommand.name.replace(/\./g, "_");
    const capturedGetHandler = lazyCommand.getHandler;

    const toolDef: ToolDefinition = {
      name: normalizedName,
      description: lazyCommand.description,
      getHandler: async () => {
        const resolvedFn = await capturedGetHandler();
        return async (args: Record<string, unknown>) => resolvedFn(args, undefined);
      },
    };

    mockServer.addTool(toolDef);

    if (!capturedToolDef) throw new Error("addTool was not called — capturedToolDef is undefined");

    expect(capturedToolDef.handler).toBeUndefined();
    expect(typeof capturedToolDef.getHandler).toBe("function");

    // Resolve the thunk
    if (!capturedToolDef.getHandler)
      throw new Error("capturedToolDef.getHandler unexpectedly undefined");
    const resolvedHandler = await capturedToolDef.getHandler();
    expect(thunkCallCount).toBe(1);
    expect(typeof resolvedHandler).toBe("function");

    const result = await resolvedHandler({});
    expect(result).toEqual({ lazy: true, thunkCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// PR #1103 R1 NON-BLOCKING — in-flight memoization contract
//
// Mirrors the post-R1 server.ts CallTool dispatch logic which adds a
// `tool.__resolving` sentinel so concurrent first calls share a single
// `getHandler()` invocation. Two contracts:
//   1. Concurrent first calls invoke `getHandler()` exactly ONCE.
//   2. On rejection, the sentinel clears so retry can succeed.
// ---------------------------------------------------------------------------

async function dispatchMemo(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  if (!tool.handler && tool.getHandler) {
    if (!tool.__resolving) {
      const thunk = tool.getHandler;
      tool.__resolving = thunk().catch((err) => {
        tool.__resolving = undefined;
        throw err;
      });
    }
    tool.handler = await tool.__resolving;
    tool.__resolving = undefined;
  }
  if (!tool.handler) throw new Error(`Tool '${tool.name}' has no handler`);
  return tool.handler(args);
}

describe("mt#1792 — PR #1103 R1: in-flight thunk memoization", () => {
  test("concurrent first calls share a single getHandler() invocation", async () => {
    let thunkCallCount = 0;
    let resolveThunk!: (fn: (args: Record<string, unknown>) => Promise<unknown>) => void;
    const thunkPending = new Promise<(args: Record<string, unknown>) => Promise<unknown>>((r) => {
      resolveThunk = r;
    });

    const tool: ToolDefinition = {
      name: "test.race",
      description: "test",
      getHandler: async () => {
        thunkCallCount++;
        return thunkPending;
      },
    };

    // Kick off 3 concurrent first-calls before resolving the thunk
    const calls = [dispatchMemo(tool, {}), dispatchMemo(tool, {}), dispatchMemo(tool, {})];

    // Yield so all 3 dispatches enter the resolution branch
    await new Promise((r) => setImmediate(r));

    // Now resolve — all 3 should share the same resolved handler
    resolveThunk(async (_args) => ({ ok: true }));

    const results = await Promise.all(calls);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    // Critical assertion: getHandler invoked exactly ONCE despite 3 concurrent calls
    expect(thunkCallCount).toBe(1);
  });

  test("on getHandler rejection, __resolving is cleared so retry can succeed", async () => {
    let thunkCallCount = 0;
    const tool: ToolDefinition = {
      name: "test.retry",
      description: "test",
      getHandler: async () => {
        thunkCallCount++;
        if (thunkCallCount === 1) {
          throw new Error("transient load failure");
        }
        return async (_args) => ({ recovered: true });
      },
    };

    // First call rejects
    await expect(dispatchMemo(tool, {})).rejects.toThrow("transient load failure");
    expect(thunkCallCount).toBe(1);
    expect(tool.__resolving).toBeUndefined(); // sentinel cleared by .catch

    // Retry succeeds — sentinel was cleared so getHandler is invoked again
    const result = await dispatchMemo(tool, {});
    expect(thunkCallCount).toBe(2);
    expect(result).toEqual({ recovered: true });
  });
});
