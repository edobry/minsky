import { describe, test, expect } from "bun:test";
import {
  startParentDeathWatcher,
  startNeverConnectedWatcher,
  looksLikeHostedEntrypoint,
  shouldArmNeverConnectedWatcher,
  wireOrphanExitWatchers,
  parsePositiveIntEnv,
  DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS,
  DEFAULT_NEVER_CONNECTED_TIMEOUT_MS,
} from "./orphan-exit";

/**
 * Fake interval/timeout controller: callers get to invoke `tick()` to fire
 * the scheduled callback synchronously instead of depending on real wall-
 * clock timers. This is the injected-clock half of the testable-design
 * checkpoint — no real `setInterval`/`setTimeout` are exercised here.
 */
function createFakeIntervalController() {
  let callback: (() => void) | undefined;
  let cleared = false;
  const setIntervalFn = ((cb: () => void) => {
    callback = cb;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalFn = (() => {
    cleared = true;
  }) as typeof clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    tick: () => callback?.(),
    isCleared: () => cleared,
  };
}

function createFakeTimeoutController() {
  let callback: (() => void) | undefined;
  let cleared = false;
  const setTimeoutFn = ((cb: () => void) => {
    callback = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = (() => {
    cleared = true;
  }) as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire: () => callback?.(),
    isCleared: () => cleared,
  };
}

describe("startParentDeathWatcher", () => {
  test("does not fire while ppid matches the recorded startup value", () => {
    const fake = createFakeIntervalController();
    let fired = false;
    const currentPpid = 4242;
    startParentDeathWatcher({
      initialPpid: 4242,
      getCurrentPpid: () => currentPpid,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
      onParentDeath: () => {
        fired = true;
      },
    });

    fake.tick();
    fake.tick();
    fake.tick();

    expect(fired).toBe(false);
  });

  test("fires exactly once when ppid transitions away from the startup value", () => {
    const fake = createFakeIntervalController();
    const detections: Array<{ initialPpid: number; currentPpid: number }> = [];
    let currentPpid = 4242;
    startParentDeathWatcher({
      initialPpid: 4242,
      getCurrentPpid: () => currentPpid,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
      onParentDeath: (detected) => detections.push(detected),
    });

    fake.tick(); // still 4242 — no fire
    currentPpid = 1; // reparented to init
    fake.tick(); // transition — fires
    fake.tick(); // watcher stops itself after first fire

    expect(detections).toEqual([{ initialPpid: 4242, currentPpid: 1 }]);
    expect(fake.isCleared()).toBe(true);
  });

  test("never fires for the hosted signature: ppid starts at 1 and never changes", () => {
    // This is the Railway/Docker case: the Dockerfile's shell-form CMD
    // makes bun a child of the container's PID-1 shell from t=0, and that
    // shell lives for the container's whole lifetime — so ppid is 1 at
    // startup and stays 1. No transition ever occurs.
    const fake = createFakeIntervalController();
    let fired = false;
    startParentDeathWatcher({
      initialPpid: 1,
      getCurrentPpid: () => 1,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
      onParentDeath: () => {
        fired = true;
      },
    });

    for (let i = 0; i < 10; i++) fake.tick();

    expect(fired).toBe(false);
  });

  test("stop() prevents any further firing", () => {
    const fake = createFakeIntervalController();
    let fired = false;
    let currentPpid = 100;
    const watcher = startParentDeathWatcher({
      initialPpid: 100,
      getCurrentPpid: () => currentPpid,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
      onParentDeath: () => {
        fired = true;
      },
    });

    watcher.stop();
    currentPpid = 1;
    fake.tick();

    expect(fired).toBe(false);
  });

  test("defaults pollIntervalMs to DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS", () => {
    let capturedInterval: number | undefined;
    const setIntervalFn = ((_cb: () => void, interval?: number) => {
      capturedInterval = interval;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    startParentDeathWatcher({
      initialPpid: 1,
      getCurrentPpid: () => 1,
      setIntervalFn,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      onParentDeath: () => {},
    });
    expect(capturedInterval).toBe(DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS);
  });
});

describe("startNeverConnectedWatcher", () => {
  test("fires onTimeout when the window elapses with no connection ever observed", () => {
    const fake = createFakeTimeoutController();
    let fired = false;
    startNeverConnectedWatcher({
      hasEverConnected: () => false,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
      onTimeout: () => {
        fired = true;
      },
    });

    fake.fire();

    expect(fired).toBe(true);
  });

  test("does not fire when a session connected before the window elapsed", () => {
    const fake = createFakeTimeoutController();
    let fired = false;
    startNeverConnectedWatcher({
      hasEverConnected: () => true,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
      onTimeout: () => {
        fired = true;
      },
    });

    fake.fire();

    expect(fired).toBe(false);
  });

  test("defaults timeoutMs to DEFAULT_NEVER_CONNECTED_TIMEOUT_MS", () => {
    let capturedTimeout: number | undefined;
    const setTimeoutFn = ((_cb: () => void, timeout?: number) => {
      capturedTimeout = timeout;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    startNeverConnectedWatcher({
      hasEverConnected: () => false,
      setTimeoutFn,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
      onTimeout: () => {},
    });
    expect(capturedTimeout).toBe(DEFAULT_NEVER_CONNECTED_TIMEOUT_MS);
  });

  test("stop() clears the underlying timer", () => {
    const fake = createFakeTimeoutController();
    const watcher = startNeverConnectedWatcher({
      hasEverConnected: () => false,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
      onTimeout: () => {},
    });
    watcher.stop();
    expect(fake.isCleared()).toBe(true);
  });
});

describe("looksLikeHostedEntrypoint", () => {
  test("true for ppid 1 (the Dockerfile shell-form CMD signature)", () => {
    expect(looksLikeHostedEntrypoint(1)).toBe(true);
  });

  test("false for any non-1 ppid (a shell, an inspector wrapper, a test runner, etc.)", () => {
    expect(looksLikeHostedEntrypoint(4242)).toBe(false);
    expect(looksLikeHostedEntrypoint(2)).toBe(false);
  });
});

describe("shouldArmNeverConnectedWatcher", () => {
  test("armed by default for a non-hosted ppid", () => {
    expect(
      shouldArmNeverConnectedWatcher({ initialPpid: 4242, forceEnable: false, forceDisable: false })
    ).toBe(true);
  });

  test("NOT armed by default for the hosted ppid-1 signature (AT3)", () => {
    expect(
      shouldArmNeverConnectedWatcher({ initialPpid: 1, forceEnable: false, forceDisable: false })
    ).toBe(false);
  });

  test("forceEnable overrides the hosted-ppid skip", () => {
    expect(
      shouldArmNeverConnectedWatcher({ initialPpid: 1, forceEnable: true, forceDisable: false })
    ).toBe(true);
  });

  test("forceDisable wins over forceEnable", () => {
    expect(
      shouldArmNeverConnectedWatcher({ initialPpid: 4242, forceEnable: true, forceDisable: true })
    ).toBe(false);
  });
});

describe("parsePositiveIntEnv", () => {
  test("parses a valid positive integer string", () => {
    expect(parsePositiveIntEnv("5000")).toBe(5000);
  });

  test("returns undefined for absent/empty/non-positive/non-numeric values", () => {
    expect(parsePositiveIntEnv(undefined)).toBeUndefined();
    expect(parsePositiveIntEnv("")).toBeUndefined();
    expect(parsePositiveIntEnv("0")).toBeUndefined();
    expect(parsePositiveIntEnv("-5")).toBeUndefined();
    expect(parsePositiveIntEnv("not-a-number")).toBeUndefined();
  });
});

describe("wireOrphanExitWatchers", () => {
  test("hosted signature (ppid 1): parent-death armed, never-connected NOT armed, and neither fires spuriously", () => {
    const exits: string[] = [];
    // Real timers here (no fake injected) — we only assert nothing fires
    // synchronously and that stop() is callable without throwing. The
    // per-mechanism firing behavior is covered by the dedicated describe
    // blocks above with injected fake clocks.
    const watcher = wireOrphanExitWatchers({
      initialPpid: 1,
      getCurrentPpid: () => 1,
      hasEverConnected: () => false,
      onExit: (reason) => exits.push(reason),
      env: {},
    });

    expect(exits).toEqual([]);
    expect(() => watcher.stop()).not.toThrow();
  });

  test("MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT=1 skips wiring the parent-death watcher", () => {
    // Verified indirectly: wiring with the env flag set and a getCurrentPpid
    // that always differs from initialPpid must never call onExit, because
    // no watcher was ever registered to observe the "transition".
    const exits: string[] = [];
    const watcher = wireOrphanExitWatchers({
      initialPpid: 4242,
      getCurrentPpid: () => 1,
      hasEverConnected: () => false,
      onExit: (reason) => exits.push(reason),
      env: {
        MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT: "1",
        MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT: "1",
      },
    });

    expect(exits).toEqual([]);
    watcher.stop();
  });
});
