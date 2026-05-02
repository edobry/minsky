/**
 * Tests for window commands and domain logic — mt#1489.
 *
 * Tests openWindow / closeWindow domain functions and the cron integration
 * helper. Uses the recording notifier for hermetic event assertion.
 *
 * checkAndFireCronWindows tests use an in-memory LoaderFs (empty = no config
 * file = defaults) so no real filesystem or env-var manipulation is needed.
 */

import { describe, test, expect } from "bun:test";
import { openWindow, closeWindow, checkAndFireCronWindows, OpenWindowRegistry } from "./index";
import { createRecordingWindowNotifier } from "../../../../domain/ask/attention-windows/notify";
import type { AttentionWindowConfig } from "../../../../domain/ask/attention-windows/config";
import type { LoaderFs } from "../../../../domain/ask/attention-windows/loader";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WINDOWS: AttentionWindowConfig[] = [
  {
    key: "ask-hours",
    schedule: { type: "cron", expr: "0 16 * * 1-5" },
    durationMin: 30,
    maxMisses: 2,
    description: "Daily 4pm window",
  },
  {
    key: "weekly-review",
    schedule: { type: "cron", expr: "0 10 * * 1" },
    durationMin: 60,
    maxMisses: 1,
    description: "Weekly Monday",
  },
  {
    key: "on-demand",
    schedule: { type: "manual" },
    durationMin: 30,
    maxMisses: -1,
  },
];

function makeRegistry(): OpenWindowRegistry {
  return new OpenWindowRegistry();
}

/**
 * In-memory LoaderFs: empty map means no config file exists, so the loader
 * falls back to DEFAULT_ATTENTION_WINDOWS.
 */
function makeEmptyLoaderFs(): LoaderFs {
  return {
    existsSync(_path: string): boolean {
      return false;
    },
    readFileSync(_path: string, _encoding: "utf8"): string {
      throw new Error("ENOENT");
    },
  };
}

// ---------------------------------------------------------------------------
// openWindow
// ---------------------------------------------------------------------------

describe("openWindow", () => {
  test("opens a window and records state in registry", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.windowKey).toBe("ask-hours");
    expect(result.durationMin).toBe(30);
    expect(result.alreadyOpen).toBe(false);
    expect(registry.isOpen("ask-hours")).toBe(true);
  });

  test("emits a NOTIFY opened event", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(notifier.openedEvents).toHaveLength(1);
    const evt = notifier.openedEvents[0];
    if (!evt) throw new Error("expected opened event");
    expect(evt.windowKey).toBe("ask-hours");
    expect(evt.durationMin).toBe(30);
    // expectedCloseAt should be 30 minutes after openedAt
    const opened = new Date(evt.openedAt);
    const expected = new Date(evt.expectedCloseAt);
    expect(expected.getTime() - opened.getTime()).toBe(30 * 60_000);
  });

  test("is idempotent when called twice: does not re-emit", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    const result2 = await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result2.alreadyOpen).toBe(true);
    expect(notifier.openedEvents).toHaveLength(1); // only emitted once
  });

  test("throws on unknown window key", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await expect(openWindow("nonexistent", WINDOWS, notifier, registry)).rejects.toThrow(
      "unknown window key"
    );
  });

  test("opens a manual window when called explicitly", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await openWindow("on-demand", WINDOWS, notifier, registry);
    expect(result.windowKey).toBe("on-demand");
    expect(notifier.openedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// closeWindow
// ---------------------------------------------------------------------------

describe("closeWindow", () => {
  test("closes an open window", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    const result = await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.windowKey).toBe("ask-hours");
    expect(result.wasOpen).toBe(true);
    expect(registry.isOpen("ask-hours")).toBe(false);
  });

  test("emits a NOTIFY closed event", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(notifier.closedEvents).toHaveLength(1);
    const closedEvt = notifier.closedEvents[0];
    if (!closedEvt) throw new Error("expected closed event");
    expect(closedEvt.windowKey).toBe("ask-hours");
  });

  test("is idempotent when window is not open", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.wasOpen).toBe(false);
    expect(notifier.closedEvents).toHaveLength(0);
  });

  test("throws on unknown window key", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await expect(closeWindow("nonexistent", WINDOWS, notifier, registry)).rejects.toThrow(
      "unknown window key"
    );
  });
});

// ---------------------------------------------------------------------------
// checkAndFireCronWindows
// ---------------------------------------------------------------------------

describe("checkAndFireCronWindows", () => {
  // Use an in-memory LoaderFs that has no files, causing the loader to fall
  // back to DEFAULT_ATTENTION_WINDOWS. This avoids any env-var manipulation.
  const emptyFs = makeEmptyLoaderFs();

  test("opens windows whose cron expression fires at the given time", async () => {
    // Default windows include ask-hours: "0 16 * * 1-5" (Mon-Fri 16:00)
    // 2024-04-15 is a Monday.
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const lastFiredAt = new Map<string, Date>();

    // Construct a Date whose local time reads as Monday 16:00
    const utcMs = Date.UTC(2024, 3, 15, 16, 0, 0); // April 15 2024 UTC
    const now = new Date(utcMs);
    // Shift so local hour/minute = 16:00
    const localHour = now.getHours();
    const localMinute = now.getMinutes();
    const shifted = new Date(utcMs + (16 - localHour) * 3_600_000 + (0 - localMinute) * 60_000);

    const fired = await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    // Should fire ask-hours (default window "0 16 * * 1-5") on Monday
    expect(fired).toContain("ask-hours");
  });

  test("returns an array (manual-only path)", async () => {
    // shouldWindowFireNow({ type: "manual" }, ...) always returns false.
    // Verify the cron helper returns cleanly when no windows fire.
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const fired = await checkAndFireCronWindows(
      notifier,
      registry,
      new Map(),
      new Date("2024-04-15T09:00:00.000Z"),
      emptyFs
    );
    expect(Array.isArray(fired)).toBe(true);
  });

  test("does not re-fire when lastFiredAt is in the same minute", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const lastFiredAt = new Map<string, Date>();

    const utcMs = Date.UTC(2024, 3, 15, 16, 0, 0);
    const tmp = new Date(utcMs);
    const shifted = new Date(
      utcMs + (16 - tmp.getHours()) * 3_600_000 + (0 - tmp.getMinutes()) * 60_000
    );

    // First call — should fire
    await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    const firstFiredCount = notifier.openedEvents.length;

    // Second call same minute — should NOT re-fire
    await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    expect(notifier.openedEvents).toHaveLength(firstFiredCount);
  });
});
