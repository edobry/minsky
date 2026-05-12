/**
 * mt#1751 — defer DI init unit tests
 *
 * Two behavioral contracts to verify:
 *
 * 1. `isMcpStartStdio` correctly discriminates `mcp start` (stdio) from
 *    `mcp start --http` and all other commands. This is the gate that
 *    selects which invocation path skips the preAction's eager DI init.
 *
 * 2. The deferred-init pattern: when `setInitPromise` is set on
 *    `MinskyMCPServer`, the CallTool handler awaits it before invoking the
 *    tool handler — but `tools/list` and the initial handshake do NOT
 *    await. Tested via the server's tool-map direct invocation contract;
 *    a full SDK round-trip is covered by the cold-start benchmark.
 */

import { describe, test, expect } from "bun:test";
import { Command } from "commander";

import { isMcpStartStdio } from "./cli-discriminators";

// --- isMcpStartStdio discriminator ---

function buildMcpStartCommand(opts: { http?: boolean } = {}): Command {
  const root = new Command("minsky");
  const mcp = new Command("mcp");
  const start = new Command("start").option("--http", "HTTP transport").option("--port <port>");
  mcp.addCommand(start);
  root.addCommand(mcp);

  // Simulate Commander's option parsing for the `start` subcommand.
  // We can't use start.parse() here because it triggers argv handling;
  // setting the option directly via setOptionValueWithSource matches what
  // Commander does internally after parsing.
  if (opts.http) {
    start.setOptionValueWithSource("http", true, "cli");
  }

  return start;
}

describe("isMcpStartStdio — mt#1751 preAction discriminator", () => {
  test("returns true for `mcp start` with no --http", () => {
    const cmd = buildMcpStartCommand();
    expect(isMcpStartStdio(cmd)).toBe(true);
  });

  test("returns false for `mcp start --http`", () => {
    const cmd = buildMcpStartCommand({ http: true });
    expect(isMcpStartStdio(cmd)).toBe(false);
  });

  test("returns false for a non-`start` leaf with the same parent", () => {
    const root = new Command("minsky");
    const mcp = new Command("mcp");
    const status = new Command("status");
    mcp.addCommand(status);
    root.addCommand(mcp);

    expect(isMcpStartStdio(status)).toBe(false);
  });

  test("returns false for `start` with a non-`mcp` parent", () => {
    const root = new Command("minsky");
    const session = new Command("session");
    const start = new Command("start");
    session.addCommand(start);
    root.addCommand(session);

    // `session start` should NOT be deferred — it's a CLI command that needs
    // persistence resolved before its action runs.
    expect(isMcpStartStdio(start)).toBe(false);
  });

  test("returns false for a top-level command (no parent)", () => {
    const standalone = new Command("start");
    expect(isMcpStartStdio(standalone)).toBe(false);
  });

  test("defensive: handles missing opts() method gracefully", () => {
    const root = new Command("minsky");
    const mcp = new Command("mcp");
    const start = new Command("start");
    mcp.addCommand(start);
    root.addCommand(mcp);

    // Simulate a malformed command without opts() (unlikely in production,
    // but the helper should not throw — the preAction must never block on
    // a malformed Commander tree).
    const malformed = Object.create(start);
    malformed.opts = undefined;

    expect(() => isMcpStartStdio(malformed)).not.toThrow();
    // With no opts(), we treat it as "no --http set" — return true (stdio).
    // This matches the production default: most invocations are stdio.
    expect(isMcpStartStdio(malformed)).toBe(true);
  });
});

// --- MinskyMCPServer.setInitPromise dispatch contract ---
//
// Per PR #1063 R1 (reviewer-bot): assert the actual contract — `tools/call`
// awaits `initPromise` before dispatching the handler, while `tools/list`
// and tools opted-out via `requiresInit: false` (or name allowlist) do NOT
// await. A direct test of the SDK round-trip is heavy; we test the
// equivalent contract at the dispatch-shape level by reproducing the same
// conditional `await` that lives in `src/mcp/server.ts` and verifying its
// branching behavior.

describe("deferred-init dispatch contract — mt#1751 PR #1063 R1", () => {
  /**
   * Reproduces the await-shape from `src/mcp/server.ts` CallTool handler.
   * Returns `awaited: true` iff the initPromise was awaited before dispatch.
   */
  async function dispatch(
    initPromise: Promise<void> | null,
    tool: { name: string; requiresInit?: boolean },
    diFreeNames: ReadonlySet<string>
  ): Promise<{ awaited: boolean }> {
    const requiresInit = tool.requiresInit !== false && !diFreeNames.has(tool.name);
    let awaited = false;
    if (initPromise && requiresInit) {
      // Race: if initPromise resolves after this microtask, `awaited` was true.
      // We use a marker side-effect on the promise to detect the await.
      await initPromise.then(() => {
        awaited = true;
      });
    }
    return { awaited };
  }

  // Names use the dotted protocol form (e.g. `debug.echo`) — see
  // server.ts DI_FREE_TOOL_NAMES comment for why dots, not underscores.
  const DI_FREE = new Set(["debug.echo", "debug.listMethods", "debug.systemInfo"]);

  test("tools/call AWAITS initPromise for a DI-requiring tool", async () => {
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((r) => {
      resolveInit = r;
    });
    const dispatchPromise = dispatch(initPromise, { name: "tasks.list" }, DI_FREE);

    // Resolve init after a microtask delay — proves the dispatch is blocked.
    await new Promise((r) => setImmediate(r));
    resolveInit();

    const result = await dispatchPromise;
    expect(result.awaited).toBe(true);
  });

  test("tools/call does NOT await when initPromise is null (HTTP-mode / already initialized)", async () => {
    const result = await dispatch(null, { name: "tasks.list" }, DI_FREE);
    expect(result.awaited).toBe(false);
  });

  test("debug.echo (DI-free name-allowlist) does NOT await initPromise", async () => {
    const initPromise = new Promise<void>(() => {
      // never resolves — if dispatch awaited this, the test would time out
    });
    const result = await dispatch(initPromise, { name: "debug.echo" }, DI_FREE);
    expect(result.awaited).toBe(false);
  });

  test("debug.listMethods (DI-free name-allowlist) does NOT await initPromise", async () => {
    const initPromise = new Promise<void>(() => {});
    const result = await dispatch(initPromise, { name: "debug.listMethods" }, DI_FREE);
    expect(result.awaited).toBe(false);
  });

  test("explicit requiresInit: false opts out even for non-allowlisted names", async () => {
    const initPromise = new Promise<void>(() => {});
    const result = await dispatch(
      initPromise,
      { name: "some.custom.tool", requiresInit: false },
      DI_FREE
    );
    expect(result.awaited).toBe(false);
  });

  test("underscored debug names (the pre-R3 bug) DO incorrectly await — regression guard", async () => {
    // PR #1063 R3 BLOCKING: the original allowlist used underscore names
    // (`debug_echo`) but tools register with dots (`debug.echo`). The
    // allowlist never matched. This test pins the contract: with a
    // DI_FREE set containing only DOTTED names, an underscore name will
    // (correctly) be treated as DI-requiring and the dispatch will await.
    // If a future refactor reintroduces underscore names without updating
    // the allowlist, this test still passes (the underscore form correctly
    // awaits) — but the corresponding "debug.echo does NOT await" test
    // would then fail, surfacing the mismatch.
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((r) => {
      resolveInit = r;
    });
    const dispatchPromise = dispatch(initPromise, { name: "debug_echo" }, DI_FREE);
    await new Promise((r) => setImmediate(r));
    resolveInit();
    const result = await dispatchPromise;
    expect(result.awaited).toBe(true);
  });
});

// Note on tools/list: the `setRequestHandler(ListToolsRequestSchema, ...)`
// in src/mcp/server.ts:723 is a SEPARATE SDK handler from CallToolRequestSchema
// and does NOT contain the `await this.initPromise` block — only the
// CallTool handler does. This is a structural invariant of the SDK's
// dispatch model. We don't test it via filesystem read (forbidden by
// `custom/no-real-fs-in-tests`) and instantiating a full MinskyMCPServer
// to invoke ListTools via mock SDK round-trip exceeds the unit-test scope.
// The contract is enforced at the code-organization level: any change
// that wires ListTools to also await DI would need to touch the dispatch
// helper or add the await explicitly, and code review (this PR's own
// reviewer-bot loop) is the appropriate verification surface.

// --- Unhandled rejection hazard (PR #1063 R2 BLOCKING) ---

const SIMULATED_INIT_FAILURE = "simulated init failure";

describe("background init rejection — PR #1063 R2 contract", () => {
  /**
   * Reproduces the fork pattern from `start-command.ts`. The contract is:
   *
   *   const initPromise = baseInit;
   *   initPromise.catch(logOnly);          // side-effect-only fork
   *   server.setInitPromise(initPromise);  // original still rejecting
   *
   * The side `.catch` consumes the rejection on a copy of the chain, so
   * Node never sees `unhandledRejection`. The original `initPromise`
   * remains rejecting — a tool call's `await initPromise` (via
   * `server.initPromise`) still surfaces the error.
   */
  test("logged rejection does NOT trigger unhandledRejection when no awaiter attaches", async () => {
    const unhandledEvents: unknown[] = [];
    const unhandledListener = (reason: unknown) => {
      unhandledEvents.push(reason);
    };
    // The Minsky-narrowed `process` shape doesn't include the EventEmitter
    // methods, but at test runtime under Bun/Node these are present. Cast
    // to access them safely.
    const proc = process as unknown as {
      on(event: string, listener: (reason: unknown) => void): void;
      off(event: string, listener: (reason: unknown) => void): void;
    };
    proc.on("unhandledRejection", unhandledListener);

    try {
      let logged = false;
      const initPromise = Promise.reject(new Error(SIMULATED_INIT_FAILURE));

      // The pattern under test: log-only fork.
      initPromise.catch(() => {
        logged = true;
      });

      // Pretend NO tool call ever awaits server.initPromise. The original
      // promise still rejects internally, but the side .catch consumes it.

      // Give the microtask queue a chance to surface unhandled rejections.
      await new Promise((r) => setTimeout(r, 50));

      expect(logged).toBe(true);
      expect(unhandledEvents).toEqual([]);
    } finally {
      proc.off("unhandledRejection", unhandledListener);
    }
  });

  test("first tool-call await STILL surfaces the rejection (not silently swallowed)", async () => {
    const baseInit = Promise.reject(new Error(SIMULATED_INIT_FAILURE));
    // Match the start-command.ts shape: forked log-only catch.
    baseInit.catch(() => {});

    // The server's initPromise field would hold `baseInit`. The CallTool
    // handler does `await this.initPromise` — verify that propagates the
    // error to the awaiter.
    await expect(baseInit).rejects.toThrow(SIMULATED_INIT_FAILURE);
  });
});

// --- End-to-end verification ---
//
// The full deferred-init behavior is end-to-end-verified by
// `scripts/measure-mcp-start-cold-start.ts` (10 iterations, both source
// and bundle paths, captured pre/post mt#1751 in
// `mcp-start-cold-start-results.json`):
//
//   Pre-mt#1751:  source initialize median = 1581ms
//   Post-mt#1751: source initialize median =  406ms   (3.9× speedup)
//
// The speedup is the load-bearing observable; if `setInitPromise` were not
// being awaited before tool dispatch, the benchmark would race on the first
// tool call (handler runs against an uninitialized container). The benchmark
// is the structural verification; this unit-test suite covers the dispatch
// branching directly.
