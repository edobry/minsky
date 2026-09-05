/**
 * Tests for the mt#4996 reopen-trigger watch (mt#4988).
 *
 * The evaluator is pure, so the thresholds are exercised directly rather than
 * through a database. The cycle takes its DB and its alert sink as parameters,
 * so both are supplied as fakes — no module patching (`testing-standards.mdc`
 * §Testable Design).
 */

import { describe, expect, test } from "bun:test";
import type { ReviewerDb } from "./db/client";
import type { AlertSeverity, AlertSink } from "./alert-sink";
import {
  buildTimeoutRegimeAlertBody,
  evaluateTimeoutRegime,
  loadTimeoutRegimeWatchConfig,
  runTimeoutRegimeWatchCycle,
  sampleTimeoutRegime,
  type TimeoutRegimeSample,
  type TimeoutRegimeThresholds,
  type TimeoutRegimeTriggerName,
  type TimeoutRegimeWatchConfig,
} from "./timeout-regime-watch";

/** mt#4996's recorded thresholds — the defaults the config also produces. */
const THRESHOLDS: TimeoutRegimeThresholds = {
  maxUnrecoveredEvents: 2,
  minRecoveryRate: 0.95,
  maxRoundP999Ms: 115_000,
};

const CONFIG: TimeoutRegimeWatchConfig = {
  ...THRESHOLDS,
  enabled: true,
  intervalMs: 24 * 60 * 60 * 1000,
  windowDays: 30,
  completingRoundCapMs: 118_000,
};

/**
 * The measured baseline from mt#4996, scaled to a 30-day window: healthy on all
 * three axes. Every "should not fire" case starts from this.
 */
const BASELINE: TimeoutRegimeSample = {
  windowDays: 30,
  reviewsWithTimeout: 30,
  timeoutEvents: 40,
  unrecoveredEvents: 0,
  completingRoundP999Ms: 105_000,
  completingRounds: 15_000,
};

/** Trigger name and env var used across several cases — named so a rename lands once. */
const UNRECOVERED_COUNT: TimeoutRegimeTriggerName = "unrecovered_count";
const RECOVERY_BP_ENV = "TIMEOUT_REGIME_MIN_RECOVERY_BP";

function sample(overrides: Partial<TimeoutRegimeSample>): TimeoutRegimeSample {
  return { ...BASELINE, ...overrides };
}

function fakeDb(row: Record<string, unknown>): ReviewerDb {
  return { execute: async () => [row] } as unknown as ReviewerDb;
}

interface CapturedAlert {
  severity: AlertSeverity;
  title: string;
  body: string;
}

function fakeSink(captured: CapturedAlert[]): AlertSink {
  return {
    notify: async (severity, title, body) => {
      captured.push({ severity, title, body });
    },
  };
}

function reading(
  readings: ReturnType<typeof evaluateTimeoutRegime>,
  name: TimeoutRegimeTriggerName
) {
  const found = readings.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no reading for ${name}`);
  return found;
}

describe("evaluateTimeoutRegime — the three mt#4996 triggers", () => {
  test("AT2': the measured baseline crosses nothing", () => {
    const readings = evaluateTimeoutRegime(BASELINE, THRESHOLDS);
    expect(readings.filter((r) => r.crossed)).toEqual([]);
    // All three are still REPORTED with their values (SC1' — the margin is the
    // point, not the boolean).
    expect(readings).toHaveLength(3);
    expect(reading(readings, "recovery_rate").value).toBe(1);
  });

  test("AT3: ONE unrecovered event does not cross — mt#4881 already pages per occurrence", () => {
    const readings = evaluateTimeoutRegime(sample({ unrecoveredEvents: 1 }), THRESHOLDS);
    expect(reading(readings, UNRECOVERED_COUNT).crossed).toBe(false);
  });

  test("AT4': two unrecovered events cross the aggregate trigger", () => {
    const readings = evaluateTimeoutRegime(sample({ unrecoveredEvents: 2 }), THRESHOLDS);
    expect(reading(readings, UNRECOVERED_COUNT).crossed).toBe(true);
    expect(reading(readings, UNRECOVERED_COUNT).threshold).toBe(2);
  });

  test("AT1': recovery below 95% crosses", () => {
    // 40 events, 3 unrecovered → 92.5%.
    const readings = evaluateTimeoutRegime(
      sample({ timeoutEvents: 40, unrecoveredEvents: 3 }),
      THRESHOLDS
    );
    expect(reading(readings, "recovery_rate").crossed).toBe(true);
    expect(reading(readings, "recovery_rate").value).toBeCloseTo(0.925, 5);
  });

  test("recovery exactly at the threshold does not cross", () => {
    // 40 events, 2 unrecovered → 95.0% exactly. The trigger is "below 95%".
    const readings = evaluateTimeoutRegime(
      sample({ timeoutEvents: 40, unrecoveredEvents: 2 }),
      THRESHOLDS
    );
    expect(reading(readings, "recovery_rate").value).toBeCloseTo(0.95, 5);
    expect(reading(readings, "recovery_rate").crossed).toBe(false);
  });

  test("a quiet window reports recovery as NOT COMPUTABLE, never as zero", () => {
    // Zero timeout events is the common case across this corpus. Reporting 0%
    // would fire the trigger on every quiet window; reporting 100% would make it
    // unfalsifiable. Neither is a measurement, so the value is null.
    const readings = evaluateTimeoutRegime(
      sample({ timeoutEvents: 0, unrecoveredEvents: 0 }),
      THRESHOLDS
    );
    expect(reading(readings, "recovery_rate").value).toBeNull();
    expect(reading(readings, "recovery_rate").crossed).toBe(false);
  });

  test("p99.9 above 115s crosses; at the threshold it does not", () => {
    expect(
      reading(
        evaluateTimeoutRegime(sample({ completingRoundP999Ms: 116_000 }), THRESHOLDS),
        "round_p999_ms"
      ).crossed
    ).toBe(true);
    expect(
      reading(
        evaluateTimeoutRegime(sample({ completingRoundP999Ms: 115_000 }), THRESHOLDS),
        "round_p999_ms"
      ).crossed
    ).toBe(false);
  });

  test("no completing rounds reports null, and null never crosses", () => {
    const readings = evaluateTimeoutRegime(
      sample({ completingRoundP999Ms: null, completingRounds: 0 }),
      THRESHOLDS
    );
    expect(reading(readings, "round_p999_ms").value).toBeNull();
    expect(reading(readings, "round_p999_ms").crossed).toBe(false);
  });
});

describe("sampleTimeoutRegime — result normalisation", () => {
  test("Postgres string aggregates are coerced to numbers", async () => {
    // count()/sum() come back as strings over the pg wire protocol; a raw
    // passthrough would make every comparison a string comparison.
    const result = await sampleTimeoutRegime(
      fakeDb({
        reviews_with_timeout: "30",
        timeout_events: "40",
        unrecovered_events: "3",
        p999_ms: "104999.5",
        completing_rounds: "15000",
      }),
      { windowDays: 30, completingRoundCapMs: 118_000, nowMs: Date.UTC(2026, 8, 5) }
    );
    expect(result.timeoutEvents).toBe(40);
    expect(result.unrecoveredEvents).toBe(3);
    expect(result.completingRoundP999Ms).toBeCloseTo(104_999.5, 5);
    expect(result.completingRounds).toBe(15_000);
    expect(result.windowDays).toBe(30);
  });

  test("a NULL percentile (no completing rounds) stays null rather than becoming 0", async () => {
    const result = await sampleTimeoutRegime(
      fakeDb({
        reviews_with_timeout: "0",
        timeout_events: "0",
        unrecovered_events: "0",
        p999_ms: null,
        completing_rounds: "0",
      }),
      { windowDays: 30, completingRoundCapMs: 118_000, nowMs: Date.UTC(2026, 8, 5) }
    );
    expect(result.completingRoundP999Ms).toBeNull();
    expect(result.timeoutEvents).toBe(0);
  });
});

describe("runTimeoutRegimeWatchCycle — surfacing", () => {
  // Deliberately crosses EXACTLY ONE trigger, so the surfacing tests below are
  // about the suppression logic rather than about how many triggers happen to
  // fire. 1 unrecovered of 10 events → 90% recovery (crosses the 95% floor)
  // while the unrecovered COUNT stays at 1, below its threshold of 2. That the
  // two triggers separate at all is the point: a small window can drift on rate
  // without reaching the count.
  const CROSSING_ROW = {
    reviews_with_timeout: "8",
    timeout_events: "10",
    unrecovered_events: "1",
    p999_ms: "105000",
    completing_rounds: "15000",
  };

  test("AT1'/SC2': a crossing surfaces exactly once, and not again while it persists", async () => {
    const captured: CapturedAlert[] = [];
    const sink = fakeSink(captured);
    const db = fakeDb(CROSSING_ROW);
    const alreadyCrossed = new Set<TimeoutRegimeTriggerName>();

    const first = await runTimeoutRegimeWatchCycle(db, CONFIG, sink, alreadyCrossed);
    expect(first.notified).toEqual(["recovery_rate"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.severity).toBe("warn");

    // Same crossing, next cycle: still crossed, but NOT re-notified.
    const second = await runTimeoutRegimeWatchCycle(db, CONFIG, sink, alreadyCrossed);
    expect(second.crossed.map((r) => r.name)).toEqual(["recovery_rate"]);
    expect(second.notified).toEqual([]);
    expect(captured).toHaveLength(1);
  });

  test("a trigger that clears and re-crosses notifies again", async () => {
    const captured: CapturedAlert[] = [];
    const sink = fakeSink(captured);
    const alreadyCrossed = new Set<TimeoutRegimeTriggerName>();

    await runTimeoutRegimeWatchCycle(fakeDb(CROSSING_ROW), CONFIG, sink, alreadyCrossed);
    expect(captured).toHaveLength(1);

    // Recovered window — the trigger clears, so the suppression must clear too.
    await runTimeoutRegimeWatchCycle(
      fakeDb({ ...CROSSING_ROW, unrecovered_events: "0" }),
      CONFIG,
      sink,
      alreadyCrossed
    );
    expect(alreadyCrossed.size).toBe(0);
    expect(captured).toHaveLength(1);

    await runTimeoutRegimeWatchCycle(fakeDb(CROSSING_ROW), CONFIG, sink, alreadyCrossed);
    expect(captured).toHaveLength(2);
  });

  test("AT2'/AT3: a baseline window with one unrecovered event surfaces nothing", async () => {
    const captured: CapturedAlert[] = [];
    const result = await runTimeoutRegimeWatchCycle(
      fakeDb({
        reviews_with_timeout: "30",
        timeout_events: "40",
        unrecovered_events: "1",
        p999_ms: "105000",
        completing_rounds: "15000",
      }),
      CONFIG,
      fakeSink(captured),
      new Set()
    );
    expect(result.crossed).toEqual([]);
    expect(result.notified).toEqual([]);
    expect(captured).toEqual([]);
    // The readings are still recorded — a healthy cycle is not a silent one.
    expect(result.readings).toHaveLength(3);
  });

  test("a query failure is swallowed, not thrown — the watch never crashes the service", async () => {
    const failing = {
      execute: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as ReviewerDb;

    const captured: CapturedAlert[] = [];
    const result = await runTimeoutRegimeWatchCycle(failing, CONFIG, fakeSink(captured), new Set());
    expect(result.readings).toEqual([]);
    expect(result.crossed).toEqual([]);
    expect(captured).toEqual([]);
  });

  test("a missing alert sink does not prevent the crossing being detected", async () => {
    // Degraded boot: ALERT_SINK_TYPE unset. The crossing must still be computed
    // and logged, so the structured record survives even with no sink wired.
    const result = await runTimeoutRegimeWatchCycle(fakeDb(CROSSING_ROW), CONFIG, null, new Set());
    expect(result.notified).toEqual(["recovery_rate"]);
  });
});

describe("buildTimeoutRegimeAlertBody", () => {
  test("names the crossed trigger, its value, its threshold, and where to reopen", () => {
    const readings = evaluateTimeoutRegime(
      sample({ timeoutEvents: 40, unrecoveredEvents: 3 }),
      THRESHOLDS
    );
    const body = buildTimeoutRegimeAlertBody(
      readings.filter((r) => r.crossed),
      sample({ timeoutEvents: 40, unrecoveredEvents: 3 })
    );
    expect(body).toContain("recovery_rate");
    expect(body).toContain("92.50%");
    expect(body).toContain("95.00%");
    expect(body).toContain("mt#4996");
  });

  test("says plainly that this is not an incident", () => {
    // The channel distinction this module exists to preserve: an operator
    // reading it should not go looking for an outage.
    const readings = evaluateTimeoutRegime(sample({ unrecoveredEvents: 5 }), THRESHOLDS);
    const body = buildTimeoutRegimeAlertBody(
      readings.filter((r) => r.crossed),
      BASELINE
    );
    expect(body).toContain("Nothing is broken");
  });
});

describe("loadTimeoutRegimeWatchConfig", () => {
  test("defaults are mt#4996's recorded values, not round numbers", () => {
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TIMEOUT_REGIME_")) delete process.env[key];
    }
    try {
      const config = loadTimeoutRegimeWatchConfig();
      expect(config.enabled).toBe(false);
      expect(config.windowDays).toBe(30);
      expect(config.maxUnrecoveredEvents).toBe(2);
      expect(config.minRecoveryRate).toBeCloseTo(0.95, 5);
      expect(config.maxRoundP999Ms).toBe(115_000);
      expect(config.completingRoundCapMs).toBe(118_000);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test("the recovery rate is carried as basis points so the shared integer parser applies", () => {
    const previous = process.env[RECOVERY_BP_ENV];
    process.env[RECOVERY_BP_ENV] = "9900";
    try {
      expect(loadTimeoutRegimeWatchConfig().minRecoveryRate).toBeCloseTo(0.99, 5);
    } finally {
      if (previous === undefined) delete process.env[RECOVERY_BP_ENV];
      else process.env[RECOVERY_BP_ENV] = previous;
    }
  });
});
