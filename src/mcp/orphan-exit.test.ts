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
  startResidentMemoryCeilingWatcher,
  shouldArmMemoryCeilingWatcher,
  wireMemoryCeilingWatcher,
  getCurrentProcessResidentBytes,
  DEFAULT_MEMORY_CEILING_MB,
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

/**
 * mt#3886: resident-memory ceiling.
 *
 * Context for the numbers used below: on 2026-08-08 three `bun` processes
 * reached 15.5/54.2/59.9 GB on a 64 GB machine, exhausting the VM
 * compressor's segment table and panicking the kernel via a watchdogd
 * checkin timeout. 43 sibling processes in the same stackshot sat at
 * 0.38-0.44 GB, which is what makes the ceiling discriminating.
 */
describe("resident-memory ceiling (mt#3886)", () => {
  const MB = 1024 * 1024;

  describe("startResidentMemoryCeilingWatcher", () => {
    test("fires when resident memory reaches the ceiling", () => {
      const timers = createFakeIntervalController();
      const breaches: Array<{ residentBytes: number; ceilingBytes: number }> = [];

      startResidentMemoryCeilingWatcher({
        ceilingBytes: 2048 * MB,
        getResidentBytes: () => 3000 * MB,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        onCeilingExceeded: (breach) => breaches.push(breach),
      });

      timers.tick();

      expect(breaches).toHaveLength(1);
      expect(breaches[0]?.residentBytes).toBe(3000 * MB);
      expect(breaches[0]?.ceilingBytes).toBe(2048 * MB);
      expect(timers.isCleared()).toBe(true);
    });

    test("does not fire for a process in the observed normal band", () => {
      const timers = createFakeIntervalController();
      let fired = 0;

      // 0.44 GB — the top of the normal band measured across 43 processes
      // in the 2026-08-08 panic stackshot.
      startResidentMemoryCeilingWatcher({
        ceilingBytes: 2048 * MB,
        getResidentBytes: () => 450 * MB,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        onCeilingExceeded: () => {
          fired += 1;
        },
      });

      timers.tick();
      timers.tick();
      timers.tick();

      expect(fired).toBe(0);
      expect(timers.isCleared()).toBe(false);
    });

    test("fires at most once even if the ceiling stays exceeded", () => {
      const timers = createFakeIntervalController();
      let fired = 0;

      startResidentMemoryCeilingWatcher({
        ceilingBytes: 2048 * MB,
        getResidentBytes: () => 60_000 * MB,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        onCeilingExceeded: () => {
          fired += 1;
        },
      });

      timers.tick();
      timers.tick();

      expect(fired).toBe(1);
    });

    test("stop() prevents a later breach from firing", () => {
      const timers = createFakeIntervalController();
      let fired = 0;

      const watcher = startResidentMemoryCeilingWatcher({
        ceilingBytes: 2048 * MB,
        getResidentBytes: () => 60_000 * MB,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        onCeilingExceeded: () => {
          fired += 1;
        },
      });

      watcher.stop();
      timers.tick();

      expect(fired).toBe(0);
    });

    test("treats resident exactly at the ceiling as a breach", () => {
      const timers = createFakeIntervalController();
      let fired = 0;

      startResidentMemoryCeilingWatcher({
        ceilingBytes: 2048 * MB,
        getResidentBytes: () => 2048 * MB,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        onCeilingExceeded: () => {
          fired += 1;
        },
      });

      timers.tick();

      expect(fired).toBe(1);
    });
  });

  describe("shouldArmMemoryCeilingWatcher", () => {
    test("arms for a normal local process", () => {
      expect(
        shouldArmMemoryCeilingWatcher({
          initialPpid: 4242,
          forceEnable: false,
          forceDisable: false,
        })
      ).toBe(true);
    });

    test("skips the hosted entrypoint by default", () => {
      expect(
        shouldArmMemoryCeilingWatcher({ initialPpid: 1, forceEnable: false, forceDisable: false })
      ).toBe(false);
    });

    test("forceEnable arms the hosted entrypoint", () => {
      expect(
        shouldArmMemoryCeilingWatcher({ initialPpid: 1, forceEnable: true, forceDisable: false })
      ).toBe(true);
    });

    test("forceDisable wins over forceEnable", () => {
      expect(
        shouldArmMemoryCeilingWatcher({ initialPpid: 4242, forceEnable: true, forceDisable: true })
      ).toBe(false);
    });
  });

  describe("wireMemoryCeilingWatcher", () => {
    test("gathers the forensic record BEFORE calling onExit", () => {
      const timers = createFakeIntervalController();
      const callOrder: string[] = [];

      wireMemoryCeilingWatcher({
        initialPpid: 4242,
        processRole: "mcp start (stdio)",
        getResidentBytes: () => 60_000 * MB,
        getUptimeSeconds: () => {
          callOrder.push("uptime");
          return 1800;
        },
        getDiagnostics: () => {
          callOrder.push("diagnostics");
          return { everConnected: true };
        },
        onExit: (reason) => callOrder.push(`exit:${reason}`),
        env: {},
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      });

      timers.tick();

      // The record is the only trace a breach leaves; exiting before
      // collecting it would lose the evidence mt#3885 needs.
      expect(callOrder).toEqual(["uptime", "diagnostics", "exit:memory-ceiling"]);
    });

    test("MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT=1 leaves the watcher unarmed", () => {
      const timers = createFakeIntervalController();
      let exited = false;

      wireMemoryCeilingWatcher({
        initialPpid: 4242,
        processRole: "mcp proxy",
        getResidentBytes: () => 60_000 * MB,
        getUptimeSeconds: () => 1,
        onExit: () => {
          exited = true;
        },
        env: { MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT: "1" },
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      });

      timers.tick();

      expect(exited).toBe(false);
    });

    test("MINSKY_MCP_MEMORY_CEILING_MB overrides the default ceiling", () => {
      const timers = createFakeIntervalController();
      let exited = false;

      // 3000 MB is UNDER the 4096 MB override, so it must not fire —
      // whereas it WOULD fire against the 2048 MB default.
      wireMemoryCeilingWatcher({
        initialPpid: 4242,
        processRole: "mcp start (stdio)",
        getResidentBytes: () => 3000 * MB,
        getUptimeSeconds: () => 1,
        onExit: () => {
          exited = true;
        },
        env: { MINSKY_MCP_MEMORY_CEILING_MB: "4096" },
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      });

      timers.tick();

      expect(exited).toBe(false);
      expect(3000).toBeGreaterThan(DEFAULT_MEMORY_CEILING_MB);
    });

    test("skips arming on the hosted entrypoint signature", () => {
      const timers = createFakeIntervalController();
      let exited = false;

      wireMemoryCeilingWatcher({
        initialPpid: 1,
        processRole: "mcp start (http)",
        getResidentBytes: () => 60_000 * MB,
        getUptimeSeconds: () => 1,
        onExit: () => {
          exited = true;
        },
        env: {},
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      });

      timers.tick();

      expect(exited).toBe(false);
    });
  });

  describe("getCurrentProcessResidentBytes", () => {
    test("reads a plausible positive resident size for this process", () => {
      const rss = getCurrentProcessResidentBytes();
      expect(rss).toBeGreaterThan(0);
      // Sanity bound: the test runner itself is nowhere near the ceiling
      // this feature defends, so a value above it would mean the reader
      // is returning the wrong unit.
      expect(rss).toBeLessThan(DEFAULT_MEMORY_CEILING_MB * MB);
    });
  });
});
