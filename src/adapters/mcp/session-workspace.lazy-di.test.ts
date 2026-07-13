/**
 * Integration regression test for mt#1799: MCP session-file tools must
 * resolve sessionProvider at dispatch time, not registration time.
 *
 * Simulates the start-command sequence:
 *   1. registerSessionWorkspaceTools(mapper, container)   // before init
 *   2. container.initialize()                              // later
 *   3. handler dispatch
 *
 * The bug pattern (eager DI) captures `container.has("sessionProvider") === false`
 * at step 1 and throws on step 3. The fix's thunk-based DI re-queries the
 * container at step 3, picking up the post-init provider.
 */
import { describe, test, expect } from "bun:test";
import { registerSessionWorkspaceTools } from "./session-workspace";

type CapturedHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeFakeCommandMapper(): {
  mapper: { addCommand: (cmd: { name: string; handler: CapturedHandler }) => void };
  handlers: Map<string, CapturedHandler>;
} {
  const handlers = new Map<string, CapturedHandler>();
  return {
    mapper: {
      addCommand: (cmd) => {
        handlers.set(cmd.name, cmd.handler);
      },
    },
    handlers,
  };
}

/**
 * Minimal AppContainerInterface stand-in. `has` and `get` consult a mutable
 * `provider` field so we can simulate "before init" (provider is undefined)
 * vs "after init" (provider is a real-ish value) without exercising the full
 * tsyringe container.
 */
function makeFakeContainer(): {
  container: {
    has: (key: string) => boolean;
    get: (key: string) => unknown;
  };
  setSessionProvider: (provider: unknown) => void;
} {
  let provider: unknown = undefined;
  return {
    container: {
      has: (key: string) => key === "sessionProvider" && provider !== undefined,
      get: (key: string) => {
        if (key !== "sessionProvider") throw new Error(`unexpected key ${key}`);
        return provider;
      },
    },
    setSessionProvider: (p) => {
      provider = p;
    },
  };
}

describe("registerSessionWorkspaceTools — lazy DI (mt#1799)", () => {
  test("session.read_file handler does NOT throw the eager-DI error after container init", async () => {
    const { mapper, handlers } = makeFakeCommandMapper();
    const { container, setSessionProvider } = makeFakeContainer();

    // Step 1: register BEFORE the container has sessionProvider. This is the
    // failure-mode setup — the bug captured undefined here and held forever.
    expect(container.has("sessionProvider")).toBe(false);
    registerSessionWorkspaceTools(mapper as never, container as never);

    // Step 2: simulate container.initialize() resolving sessionProvider.
    // The shape doesn't have to be real — we just need it to be non-undefined
    // so the thunk no longer returns undefined. The handler will fail later
    // (no real session DB, no real workspace) but with a DIFFERENT error.
    setSessionProvider({ getSession: () => Promise.resolve(undefined) });

    // Step 3: dispatch the handler.
    const handler = handlers.get("session.read_file");
    if (!handler) throw new Error("session.read_file handler not registered");

    // Handlers in session-workspace.ts wrap their bodies in try/catch and
    // return error response objects rather than throwing, so we need to
    // inspect BOTH possible failure surfaces: a thrown exception (rare) AND
    // the returned object's error field (typical). PR #1088 R1 caught that
    // looking at only the throw path can give a false-green pass.
    let caught: Error | undefined;
    let result: Record<string, unknown> | undefined;
    try {
      result = await handler({
        sessionId: "any-session-id",
        path: "package.json",
        should_read_entire_file: true,
      });
    } catch (e) {
      caught = e as Error;
    }

    // The handler may still fail because we have no real session storage,
    // but it MUST NOT surface the SessionPathResolver-requires-a-sessionProvider
    // error on EITHER path — that's the eager-DI bug we fixed.
    const haystack = JSON.stringify({
      thrown: caught?.message ?? "",
      returned: result ?? {},
    });
    expect(haystack).not.toContain("SessionPathResolver requires a sessionProvider");
  });

  test("the eager-DI bug pattern would have failed (sanity check on the test setup)", async () => {
    // Sanity: confirm the test setup is exercising the right sequence. If we
    // call registerSessionWorkspaceTools with NO sessionProvider available and
    // then dispatch WITHOUT ever calling setSessionProvider, the handler should
    // surface the lazy-resolver's diagnostic error (cause: thunk returned
    // undefined). This both proves the test wiring is correct AND that the
    // diagnostic-error path from mt#1799's spec fires.
    const { mapper, handlers } = makeFakeCommandMapper();
    const { container } = makeFakeContainer();

    registerSessionWorkspaceTools(mapper as never, container as never);

    const handler = handlers.get("session.read_file");
    if (!handler) throw new Error("session.read_file handler not registered");
    const result = await handler({
      sessionId: "any",
      path: "any",
      should_read_entire_file: true,
    });

    // Handlers in this module return an error response object rather than
    // throwing; the diagnostic Cause: should appear in result.error.
    const errorString = JSON.stringify(result);
    expect(errorString).toContain("stored provider thunk returned undefined");
  });
});
