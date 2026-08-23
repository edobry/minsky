/**
 * Unit coverage for the mt#4112 out-of-process child memory bound.
 *
 * The integration half — a real wedged child actually being SIGKILLed and
 * replaced — is `child-memory-restart.test.ts`. This file covers the parts that
 * a live run cannot make deterministic: which QUANTITY is compared (AT7), and
 * what the artifact records.
 */

import { describe, expect, test } from "bun:test";
import {
  armChildMemoryCeiling,
  createChildMemoryReader,
  writeChildBreachRecord,
  PROXY_CHILD_PROCESS_ROLE,
} from "../../../src/mcp/stdio-proxy/child-memory-ceiling";
import type { ProcessMemoryResult } from "@minsky/shared/process-memory";
import type { WriteCaptureOptions } from "../../../src/mcp/memory-capture";

const MB = 1024 * 1024;

function okReading(bytes: number): ProcessMemoryResult {
  return { ok: true, bytes, source: "phys_footprint" };
}

describe("createChildMemoryReader", () => {
  test("resolves the pid on every tick, so a respawn needs no re-arming", () => {
    const pids = [111, 222, undefined];
    let call = 0;
    const seen: number[] = [];
    const reader = createChildMemoryReader({
      getChildPid: () => pids[call++],
      readMemory: (pid) => {
        seen.push(pid);
        return okReading(pid * MB);
      },
    });

    expect(reader()).toBe(111 * MB);
    expect(reader()).toBe(222 * MB);
    // No child right now: skip the tick rather than measure something else.
    expect(reader()).toBeNull();
    expect(seen).toEqual([111, 222]);
  });

  test("an unmeasurable pid reads null, never zero", () => {
    const reader = createChildMemoryReader({
      getChildPid: () => 999,
      readMemory: () => ({ ok: false, reason: "footprint(1) produced no reading" }),
    });

    // A 0 here would compare as under any ceiling forever — the failure mt#4104
    // exists to make unrepresentable.
    expect(reader()).toBeNull();
  });
});

describe("armChildMemoryCeiling", () => {
  /** Collects the callback instead of running timers. */
  function fakeTimers() {
    const ticks: Array<() => void> = [];
    let cleared = 0;
    return {
      ticks,
      clearedCount: () => cleared,
      setIntervalFn: ((fn: () => void) => {
        ticks.push(fn);
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {
        cleared += 1;
      }) as unknown as typeof clearInterval,
    };
  }

  test("compares the swap-inclusive reading, not RSS (AT7)", () => {
    const timers = fakeTimers();
    const breaches: number[] = [];

    // The mt#4099 specimen's exact shape: RSS collapsed under swap while the
    // footprint climbed. A reader wired to RSS would report 900MB here and this
    // assertion would fail — which is the point of asserting the value rather
    // than only the wiring.
    armChildMemoryCeiling({
      getChildPid: () => 4242,
      readMemory: () => okReading(3000 * MB),
      onBreach: (breach) => breaches.push(breach.residentBytes),
      env: { MINSKY_MCP_MEMORY_CEILING_MB: "2048" },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.ticks[0]?.();
    expect(breaches).toEqual([3000 * MB]);
  });

  test("keeps polling after a breach, so the NEXT child is guarded too", () => {
    const timers = fakeTimers();
    let breaches = 0;

    armChildMemoryCeiling({
      getChildPid: () => 4242,
      readMemory: () => okReading(3000 * MB),
      onBreach: () => {
        breaches += 1;
      },
      env: { MINSKY_MCP_MEMORY_CEILING_MB: "2048" },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.ticks[0]?.();
    timers.ticks[0]?.();
    expect(breaches).toBe(2);
    // A one-shot watcher would have cleared its interval on the first breach and
    // left every later child unbounded.
    expect(timers.clearedCount()).toBe(0);
  });

  test("a child under the ceiling is never touched", () => {
    const timers = fakeTimers();
    let breaches = 0;

    armChildMemoryCeiling({
      getChildPid: () => 4242,
      readMemory: () => okReading(300 * MB),
      onBreach: () => {
        breaches += 1;
      },
      env: { MINSKY_MCP_MEMORY_CEILING_MB: "2048" },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    for (let i = 0; i < 20; i += 1) timers.ticks[0]?.();
    expect(breaches).toBe(0);
  });

  test("MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT=1 arms nothing", () => {
    const timers = fakeTimers();

    const watcher = armChildMemoryCeiling({
      getChildPid: () => 4242,
      readMemory: () => okReading(9999 * MB),
      onBreach: () => {
        throw new Error("must not fire when the ceiling is disabled");
      },
      env: { MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT: "1" },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    expect(timers.ticks.length).toBe(0);
    // Still a valid watcher handle, so the caller needs no null check.
    expect(() => watcher.stop()).not.toThrow();
  });
});

describe("writeChildBreachRecord", () => {
  test("records the role, the ceiling it crossed, and why there is no heap snapshot", () => {
    let written: WriteCaptureOptions | null = null;

    const path = writeChildBreachRecord({
      pid: 5150,
      residentBytes: 3000 * MB,
      ceilingBytes: 2048 * MB,
      uptimeSeconds: 42,
      now: () => new Date("2026-08-13T20:00:00.000Z"),
      env: { MINSKY_STATE_DIR: "/tmp/mt4112-test-state" },
      writeArtifact: (options) => {
        written = options;
        return "/tmp/mt4112-test-state/memory-captures/record.json";
      },
    });

    expect(path).toBe("/tmp/mt4112-test-state/memory-captures/record.json");
    if (written === null) throw new Error("writeArtifact was never called");
    const { record, captureDir } = written as WriteCaptureOptions;
    expect(record.pid).toBe(5150);
    expect(record.processRole).toBe(PROXY_CHILD_PROCESS_ROLE);
    expect(record.residentBytes).toBe(3000 * MB);
    // The threshold actually crossed is the ceiling, not mt#3973's watermark.
    expect(record.watermarkBytes).toBe(2048 * MB);
    expect(record.uptimeSeconds).toBe(42);
    expect(record.heapSnapshotPath).toBeNull();
    expect(record.heapSnapshotSkippedReason).toContain("out-of-process");
    // An empty tool-call list here means "the proxy cannot see them", which is a
    // different claim from "none were running".
    expect(record.diagnostics?.inFlightToolCallsUnknown).toBe(true);
    expect(captureDir).toContain("/tmp/mt4112-test-state");
  });

  test("a failed write is swallowed, so a capture failure cannot block the kill", () => {
    const path = writeChildBreachRecord({
      pid: 5150,
      residentBytes: 3000 * MB,
      ceilingBytes: 2048 * MB,
      uptimeSeconds: 1,
      writeArtifact: () => {
        throw new Error("disk full");
      },
    });

    expect(path).toBeNull();
  });
});
