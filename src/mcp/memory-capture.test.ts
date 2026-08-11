/**
 * Tests for mt#3973's resident-memory capture.
 *
 * Every collaborator is injected (timers, RSS reader, clock, artifact writer,
 * env), so nothing here patches a module import — the design constraint from
 * `testing-standards.mdc §Testable Design`.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MEMORY_CAPTURE_WATERMARK_MB,
  buildCaptureFileStem,
  buildCaptureRecord,
  decideCaptureArm,
  getCaptureDir,
  startResidentMemoryCaptureWatcher,
  wireMemoryCaptureWatcher,
  type MemoryCaptureRecord,
  type WriteCaptureOptions,
} from "./memory-capture";

const MB = 1024 * 1024;

/** The process class these tests stand in for. */
const ROLE = "mcp start (stdio)";
/** A plausible long-running, allocation-heavy tool — the mt#3885 shape. */
const SLOW_TOOL = "transcripts_search-text";

/** Assert exactly one item and return it, without a non-null assertion. */
function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  const first = items[0];
  if (first === undefined) throw new Error("expected exactly one item");
  return first;
}

/**
 * A controllable stand-in for setInterval/clearInterval. `tick()` runs the
 * registered callback, so a test drives the poll loop explicitly instead of
 * waiting on real time.
 */
function createFakeTimers() {
  let callback: (() => void) | undefined;
  let cleared = false;
  const setIntervalFn = ((cb: () => void) => {
    callback = cb;
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = (() => {
    cleared = true;
  }) as unknown as typeof clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    tick: () => callback?.(),
    get cleared() {
      return cleared;
    },
  };
}

describe("buildCaptureRecord", () => {
  test("sorts in-flight tool calls longest-running first", () => {
    const record = buildCaptureRecord({
      capturedAt: new Date("2026-08-11T19:00:00.000Z"),
      pid: 4242,
      processRole: ROLE,
      residentBytes: 1500 * MB,
      watermarkBytes: 1024 * MB,
      uptimeSeconds: 900,
      inFlightToolCalls: [
        { toolName: "tasks_get", elapsedMs: 12 },
        { toolName: SLOW_TOOL, elapsedMs: 91_000 },
        { toolName: "memory_search", elapsedMs: 400 },
      ],
      heapSnapshotPath: null,
    });

    expect(record.inFlightToolCalls.map((c) => c.toolName)).toEqual([
      SLOW_TOOL,
      "memory_search",
      "tasks_get",
    ]);
    expect(record.task).toBe("mt#3973");
    expect(record.capturedAt).toBe("2026-08-11T19:00:00.000Z");
    expect(record.residentBytes).toBe(1500 * MB);
  });

  test("does not mutate the caller's array", () => {
    const inFlight = [
      { toolName: "a", elapsedMs: 1 },
      { toolName: "b", elapsedMs: 2 },
    ];
    buildCaptureRecord({
      capturedAt: new Date(0),
      pid: 1,
      processRole: "r",
      residentBytes: 1,
      watermarkBytes: 1,
      uptimeSeconds: 1,
      inFlightToolCalls: inFlight,
      heapSnapshotPath: null,
    });
    expect(inFlight.map((c) => c.toolName)).toEqual(["a", "b"]);
  });

  test("omits optional fields when not supplied", () => {
    const record = buildCaptureRecord({
      capturedAt: new Date(0),
      pid: 1,
      processRole: "r",
      residentBytes: 1,
      watermarkBytes: 1,
      uptimeSeconds: 1,
      inFlightToolCalls: [],
      heapSnapshotPath: null,
    });
    expect("heapSnapshotSkippedReason" in record).toBe(false);
    expect("diagnostics" in record).toBe(false);
  });
});

describe("buildCaptureFileStem", () => {
  test("slugifies the role so the process class is readable in the filename", () => {
    const stem = buildCaptureFileStem(new Date("2026-08-11T19:00:00.000Z"), 777, ROLE);
    expect(stem).toBe("memory-capture-2026-08-11T19-00-00-000Z-mcp-start-stdio-pid777");
  });

  test("falls back to 'unknown' when the role slugifies to nothing", () => {
    expect(buildCaptureFileStem(new Date(0), 5, "()")).toContain("-unknown-pid5");
  });
});

describe("decideCaptureArm", () => {
  test("arms when the watermark is below the ceiling", () => {
    expect(
      decideCaptureArm({ watermarkBytes: 1024 * MB, ceilingBytes: 2048 * MB, forceDisable: false })
    ).toEqual({ armed: true });
  });

  test("refuses when the watermark is at or above the ceiling — it could never fire", () => {
    expect(
      decideCaptureArm({ watermarkBytes: 2048 * MB, ceilingBytes: 2048 * MB, forceDisable: false })
    ).toEqual({ armed: false, reason: "watermark-not-below-ceiling" });
    expect(
      decideCaptureArm({ watermarkBytes: 4096 * MB, ceilingBytes: 2048 * MB, forceDisable: false })
    ).toEqual({ armed: false, reason: "watermark-not-below-ceiling" });
  });

  test("forceDisable wins over an otherwise-valid configuration", () => {
    expect(
      decideCaptureArm({ watermarkBytes: 1024 * MB, ceilingBytes: 2048 * MB, forceDisable: true })
    ).toEqual({ armed: false, reason: "disabled" });
  });
});

describe("getCaptureDir", () => {
  test("honors MINSKY_STATE_DIR", () => {
    expect(getCaptureDir({ MINSKY_STATE_DIR: "/tmp/state" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/state/memory-captures"
    );
  });
});

describe("startResidentMemoryCaptureWatcher", () => {
  test("does not fire below the watermark", () => {
    const timers = createFakeTimers();
    let fired = 0;
    startResidentMemoryCaptureWatcher({
      watermarkBytes: 1024 * MB,
      getResidentBytes: () => 500 * MB,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      onWatermarkCrossed: () => {
        fired += 1;
      },
    });
    timers.tick();
    timers.tick();
    expect(fired).toBe(0);
  });

  test("fires once at the watermark and never again", () => {
    const timers = createFakeTimers();
    const observed: number[] = [];
    startResidentMemoryCaptureWatcher({
      watermarkBytes: 1024 * MB,
      getResidentBytes: () => 1200 * MB,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      onWatermarkCrossed: (bytes) => observed.push(bytes),
    });
    timers.tick();
    timers.tick();
    timers.tick();
    expect(observed).toEqual([1200 * MB]);
    expect(timers.cleared).toBe(true);
  });

  test("stop() prevents a later crossing from firing", () => {
    const timers = createFakeTimers();
    let fired = 0;
    let resident = 100 * MB;
    const watcher = startResidentMemoryCaptureWatcher({
      watermarkBytes: 1024 * MB,
      getResidentBytes: () => resident,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      onWatermarkCrossed: () => {
        fired += 1;
      },
    });
    watcher.stop();
    resident = 5000 * MB;
    timers.tick();
    expect(fired).toBe(0);
  });
});

describe("wireMemoryCaptureWatcher", () => {
  function wire(
    env: NodeJS.ProcessEnv,
    resident: number,
    inFlight = [] as { toolName: string; elapsedMs: number }[]
  ) {
    const timers = createFakeTimers();
    const written: WriteCaptureOptions[] = [];
    const watcher = wireMemoryCaptureWatcher({
      processRole: ROLE,
      ceilingBytes: 2048 * MB,
      getResidentBytes: () => resident,
      getUptimeSeconds: () => 1234,
      getInFlightToolCalls: () => inFlight,
      env,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      writeArtifact: (options) => {
        written.push(options);
        return `/captures/${options.fileStem}.json`;
      },
      now: () => new Date("2026-08-11T19:00:00.000Z"),
    });
    return { timers, written, watcher };
  }

  test("writes an artifact naming the in-flight tool calls", () => {
    const { timers, written } = wire({} as NodeJS.ProcessEnv, 1500 * MB, [
      { toolName: SLOW_TOOL, elapsedMs: 91_000 },
    ]);
    timers.tick();

    expect(written).toHaveLength(1);
    const record = only(written).record as MemoryCaptureRecord;
    expect(record.processRole).toBe(ROLE);
    expect(record.residentBytes).toBe(1500 * MB);
    expect(record.uptimeSeconds).toBe(1234);
    expect(record.inFlightToolCalls).toEqual([{ toolName: SLOW_TOOL, elapsedMs: 91_000 }]);
  });

  test("records why no heap snapshot was taken when it was not requested", () => {
    const { timers, written } = wire({} as NodeJS.ProcessEnv, 1500 * MB);
    timers.tick();
    const record = only(written).record as MemoryCaptureRecord;
    expect(record.heapSnapshotPath).toBeNull();
    expect(record.heapSnapshotSkippedReason).toContain("MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT=1");
    expect(only(written).heapSnapshotBytes).toBeFalsy();
  });

  test("honors a custom watermark", () => {
    const { timers, written } = wire(
      { MINSKY_MCP_MEMORY_CAPTURE_MB: "256" } as NodeJS.ProcessEnv,
      300 * MB
    );
    timers.tick();
    expect(written).toHaveLength(1);
    expect((only(written).record as MemoryCaptureRecord).watermarkBytes).toBe(256 * MB);
  });

  test("does not arm when disabled", () => {
    const { timers, written } = wire(
      { MINSKY_MCP_DISABLE_MEMORY_CAPTURE: "1" } as NodeJS.ProcessEnv,
      5000 * MB
    );
    timers.tick();
    expect(written).toHaveLength(0);
  });

  test("does not arm when the watermark is not below the ceiling", () => {
    const { timers, written } = wire(
      { MINSKY_MCP_MEMORY_CAPTURE_MB: "4096" } as NodeJS.ProcessEnv,
      5000 * MB
    );
    timers.tick();
    expect(written).toHaveLength(0);
  });

  test("an artifact-write failure is swallowed, so the kill ceiling is unaffected", () => {
    const timers = createFakeTimers();
    wireMemoryCaptureWatcher({
      processRole: ROLE,
      ceilingBytes: 2048 * MB,
      getResidentBytes: () => 1500 * MB,
      getUptimeSeconds: () => 1,
      env: {} as NodeJS.ProcessEnv,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      writeArtifact: () => {
        throw new Error("read-only filesystem");
      },
    });

    // The assertion IS that this does not throw: the ceiling's self-terminate
    // is the machine's protection against a kernel panic, and a diagnostic that
    // failed must not be able to take it down with it.
    expect(() => timers.tick()).not.toThrow();
  });

  test("the default watermark leaves room below the shipped 2048MB ceiling", () => {
    // Guards the mt#3973 design constraint: a watermark at or above the ceiling
    // is a watcher that can never fire, and the default must not be one.
    expect(DEFAULT_MEMORY_CAPTURE_WATERMARK_MB).toBeLessThan(2048);
  });
});
