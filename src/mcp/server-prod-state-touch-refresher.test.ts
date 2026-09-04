/**
 * mt#4938 PR #3615 R3 BLOCKING regression tests for `MinskyMCPServer.getProdStateTouchRefresher()`.
 *
 * Split into its own file rather than appended to the already near-the-1500-line-limit
 * `server.test.ts` (mt#2592's `max-lines` guard) — same pattern as this directory's other
 * `server-*.test.ts` siblings (`server-in-flight-tool-calls.test.ts`,
 * `server-response-size-guard.test.ts`, `server-tool-name-resolution.test.ts`).
 *
 * R2's version gated STARTING the dynamic import behind an already-true
 * `container.has("persistence")` check, and only attempted construction from inside the
 * import's own one-shot `.then` callback. If persistence became available only AFTER that
 * callback had already run and found it unavailable, no LATER `touch()` call ever got another
 * chance — the memoized promise permanently short-circuited any second attempt, silently
 * disabling SC1's tool-path trigger for the rest of the process's life.
 *
 * The fix: the import is kicked off unconditionally and only the PROMISE is memoized;
 * `container.has("persistence")` is re-asked, fresh, on every call until a refresher exists,
 * and an unavailable/failed construction attempt is never cached as a terminal outcome.
 *
 * `getProdStateTouchRefresher` is private; accessed via cast, mirroring `server.test.ts`'s own
 * existing pattern for `createConfiguredServer`/`triggerStaleSignal`/etc. The dynamic import is
 * the REAL module (not mocked) — constructing a `ProdStateTouchRefresher` does no I/O itself
 * (only calling `.touch()` on it would), so this is safe and faithful without needing to fake
 * the import. One consequence of using the real import, confirmed empirically while writing
 * these tests: it resolves over several event-loop turns, not within a single microtask — so
 * every test below drives calls in a bounded loop with a real timer flush between attempts,
 * rather than assuming resolution within one `await`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";

describe("getProdStateTouchRefresher (mt#4938 PR #3615 R3)", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  type RefresherHandle = { touch: (nowMs?: number) => void };

  async function makeServer() {
    const { MinskyMCPServer } = await import("./server");
    return new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
  }

  /** Minimal fake satisfying only the two container methods this method reads. */
  function fakeContainer(has: () => boolean) {
    return { has, get: () => ({}) } as unknown as Parameters<
      Awaited<ReturnType<typeof makeServer>>["setContainer"]
    >[0];
  }

  function getRefresher(server: Awaited<ReturnType<typeof makeServer>>): RefresherHandle | null {
    return (
      server as unknown as { getProdStateTouchRefresher: () => RefresherHandle | null }
    ).getProdStateTouchRefresher();
  }

  function getModulePromise(server: Awaited<ReturnType<typeof makeServer>>): unknown {
    return (server as unknown as { prodStateBootRefreshModule: unknown })
      .prodStateBootRefreshModule;
  }

  /** One microtask/timer turn — enough for the real dynamic import to make progress. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("persistence unavailable for the first two has() checks, available on the third: constructed exactly once, then cached", async () => {
    const server = await makeServer();
    let hasCalls = 0;
    server.setContainer(fakeContainer(() => (hasCalls += 1) > 2));

    // Drive calls until the refresher is built. Calls made before the dynamic import has
    // resolved return null WITHOUT reaching has() at all (mod is checked first) — bounded at
    // 20 iterations with a flush between each so the import gets real turns to settle.
    let refresher: RefresherHandle | null = null;
    let hasCallsAtConstruction = -1;
    for (let i = 0; i < 20 && !refresher; i++) {
      refresher = getRefresher(server);
      if (refresher) {
        hasCallsAtConstruction = hasCalls;
      } else {
        await flush();
      }
    }

    expect(refresher).not.toBeNull();
    expect(typeof refresher?.touch).toBe("function");
    // Exactly two FALSE has() checks preceded the TRUE one that triggered construction —
    // never cached as "unavailable", each call re-asked fresh.
    expect(hasCallsAtConstruction).toBe(3);
    expect(hasCalls).toBe(3);

    // Cached from here on: the same reference comes back, and has() is not consulted again.
    const hasCallsBeforeSecondCall = hasCalls;
    const second = getRefresher(server);
    expect(second).toBe(refresher);
    expect(hasCalls).toBe(hasCallsBeforeSecondCall);
  });

  test("persistence available from the start: constructed once, on the first call after the import resolves", async () => {
    const server = await makeServer();
    let hasCalls = 0;
    server.setContainer(
      fakeContainer(() => {
        hasCalls += 1;
        return true;
      })
    );

    let refresher: RefresherHandle | null = null;
    for (let i = 0; i < 20 && !refresher; i++) {
      refresher = getRefresher(server);
      if (!refresher) await flush();
    }

    expect(refresher).not.toBeNull();
    // Exactly one has() check — true immediately, so the first call that reaches it (once
    // the import has resolved) constructs right away; no earlier calls ever reached has() at
    // all (mod was still unresolved), and no later call re-checks it once cached.
    expect(hasCalls).toBe(1);
  });

  test("the module import is triggered at most once per server instance", async () => {
    const server = await makeServer();
    server.setContainer(fakeContainer(() => true));

    getRefresher(server);
    const promiseAfterFirstCall = getModulePromise(server);
    expect(promiseAfterFirstCall).toBeDefined();

    // A second call BEFORE the import resolves must not kick off a second import.
    getRefresher(server);
    expect(getModulePromise(server)).toBe(promiseAfterFirstCall);

    await flush();
    // …and a call AFTER it has resolved (and the refresher is cached) must not either.
    getRefresher(server);
    expect(getModulePromise(server)).toBe(promiseAfterFirstCall);
  });
});
