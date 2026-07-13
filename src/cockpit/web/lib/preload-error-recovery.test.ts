/**
 * Stale-chunk recovery guard (mt#2674).
 *
 * handlePreloadError must reload exactly once per RELOAD_WINDOW_MS: the
 * first vite:preloadError after a rebuild triggers a reload that picks up
 * fresh chunk hashes; if chunks are STILL missing right after that reload
 * (genuinely broken build), the guard suppresses further reloads so the
 * error surfaces through the widget error boundary instead of looping.
 *
 * DOM-free by design: hooks (reload/now/storage) and the event are faked so
 * the tests run under plain bun:test without happy-dom.
 */
import { describe, test, expect } from "bun:test";
import {
  handlePreloadError,
  installPreloadErrorRecovery,
  RELOAD_WINDOW_MS,
} from "./preload-error-recovery";

function makeFakes(startAt = 1_000_000) {
  const store = new Map<string, string>();
  let currentTime = startAt;
  let reloadCount = 0;
  let preventDefaultCount = 0;
  return {
    hooks: {
      reload: () => {
        reloadCount += 1;
      },
      now: () => currentTime,
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
      },
    },
    event: {
      preventDefault: () => {
        preventDefaultCount += 1;
      },
    },
    advance: (ms: number) => {
      currentTime += ms;
    },
    counts: () => ({ reloadCount, preventDefaultCount }),
  };
}

describe("handlePreloadError (mt#2674)", () => {
  test("first chunk-load failure triggers a reload and suppresses the error", () => {
    const f = makeFakes();
    const reloaded = handlePreloadError(f.event, f.hooks);
    expect(reloaded).toBe(true);
    expect(f.counts()).toEqual({ reloadCount: 1, preventDefaultCount: 1 });
  });

  test("a second failure inside the guard window does NOT reload again", () => {
    const f = makeFakes();
    handlePreloadError(f.event, f.hooks);
    f.advance(RELOAD_WINDOW_MS - 1);
    const reloaded = handlePreloadError(f.event, f.hooks);
    expect(reloaded).toBe(false);
    expect(f.counts().reloadCount).toBe(1);
    // the error is NOT suppressed the second time — it must surface
    expect(f.counts().preventDefaultCount).toBe(1);
  });

  test("a failure after the guard window elapses reloads again (next rebuild)", () => {
    const f = makeFakes();
    handlePreloadError(f.event, f.hooks);
    f.advance(RELOAD_WINDOW_MS + 1);
    const reloaded = handlePreloadError(f.event, f.hooks);
    expect(reloaded).toBe(true);
    expect(f.counts().reloadCount).toBe(2);
  });

  test("garbage in storage is treated as no prior reload", () => {
    const f = makeFakes();
    f.hooks.storage.setItem("minsky:preload-error-reload-at", "not-a-number");
    const reloaded = handlePreloadError(f.event, f.hooks);
    expect(reloaded).toBe(true);
  });
});

describe("installPreloadErrorRecovery (mt#2674)", () => {
  test("wires a vite:preloadError listener that reloads via win.location", () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    let reloadCount = 0;
    const store = new Map<string, string>();
    const fakeWin = {
      addEventListener: (type: string, fn: (event: { preventDefault: () => void }) => void) => {
        listeners.set(type, fn);
      },
      location: {
        reload: () => {
          reloadCount += 1;
        },
      },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
      },
    };

    installPreloadErrorRecovery(fakeWin as never);
    const listener = listeners.get("vite:preloadError");
    expect(listener).toBeDefined();

    listener?.({ preventDefault: () => {} });
    expect(reloadCount).toBe(1);
  });

  test("a throwing storage never breaks the listener", () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    const fakeWin = {
      addEventListener: (type: string, fn: (event: { preventDefault: () => void }) => void) => {
        listeners.set(type, fn);
      },
      location: { reload: () => {} },
      sessionStorage: {
        getItem: () => {
          throw new Error("storage disabled");
        },
        setItem: () => {
          throw new Error("storage disabled");
        },
      },
    };

    installPreloadErrorRecovery(fakeWin as never);
    expect(() => listeners.get("vite:preloadError")?.({ preventDefault: () => {} })).not.toThrow();
  });
});
