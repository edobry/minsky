/**
 * Tests for the MCP-server probe-history store (mt#2077).
 *
 * Covers the pure history math (uptime %, last downtime, trailing-failure
 * duration, the M1 >60s threshold) and the file IO round-trip.
 *
 * Real filesystem I/O is intentional for the persistence tests — the store is a
 * thin wrapper over fs primitives (same posture as lifecycle.test.ts), so mocked
 * fs would test the mock rather than the contract.
 */
/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O IS the contract */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  HEALTH_FAIL_THRESHOLD_MS,
  PROBE_HISTORY_WINDOW_MS,
  appendSample,
  consecutiveFailureMs,
  getProbeHistoryFilePath,
  healthFailing,
  lastDowntime,
  pruneHistory,
  readProbeHistory,
  uptimePct,
  writeProbeHistory,
  type ProbeHistory,
  type ProbeSample,
} from "./mcp-probe-history";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function ok(at: number): ProbeSample {
  return { at: new Date(at).toISOString(), ok: true, statusCode: 200 };
}
function fail(at: number, statusCode: number | null = null): ProbeSample {
  return { at: new Date(at).toISOString(), ok: false, statusCode };
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe("uptimePct", () => {
  test("null when no samples in window", () => {
    expect(uptimePct({ samples: [] }, PROBE_HISTORY_WINDOW_MS, 1_000_000)).toBeNull();
  });

  test("100% when all samples ok", () => {
    const h: ProbeHistory = { samples: [ok(0), ok(30 * SECOND), ok(60 * SECOND)] };
    expect(uptimePct(h, PROBE_HISTORY_WINDOW_MS, 90 * SECOND)).toBe(100);
  });

  test("ratio of ok/total within the window", () => {
    const h: ProbeHistory = {
      samples: [ok(0), fail(30 * SECOND), ok(60 * SECOND), fail(90 * SECOND)],
    };
    expect(uptimePct(h, PROBE_HISTORY_WINDOW_MS, 120 * SECOND)).toBe(50);
  });

  test("samples outside the window are excluded", () => {
    const now = 25 * 60 * MINUTE; // 25h
    const old = ok(0); // older than 24h
    const recent = fail(now - MINUTE);
    expect(uptimePct({ samples: [old, recent] }, PROBE_HISTORY_WINDOW_MS, now)).toBe(0);
  });
});

describe("lastDowntime", () => {
  test("null when no failures recorded", () => {
    expect(lastDowntime({ samples: [ok(0), ok(SECOND)] })).toBeNull();
  });

  test("returns the most recent failing sample timestamp", () => {
    const f = fail(50 * SECOND);
    const h: ProbeHistory = { samples: [fail(10 * SECOND), ok(30 * SECOND), f, ok(70 * SECOND)] };
    expect(lastDowntime(h)).toBe(f.at);
  });
});

describe("consecutiveFailureMs", () => {
  test("0 when history empty", () => {
    expect(consecutiveFailureMs({ samples: [] }, 1000)).toBe(0);
  });

  test("0 when the latest sample is ok", () => {
    const h: ProbeHistory = { samples: [fail(0), ok(30 * SECOND)] };
    expect(consecutiveFailureMs(h, 60 * SECOND)).toBe(0);
  });

  test("measures from the first failure of the trailing run to now", () => {
    const h: ProbeHistory = { samples: [ok(0), fail(30 * SECOND), fail(60 * SECOND)] };
    expect(consecutiveFailureMs(h, 90 * SECOND)).toBe(60 * SECOND);
  });

  test("an intervening ok resets the trailing run", () => {
    const h: ProbeHistory = {
      samples: [fail(0), ok(30 * SECOND), fail(60 * SECOND)],
    };
    expect(consecutiveFailureMs(h, 90 * SECOND)).toBe(30 * SECOND);
  });
});

describe("healthFailing (M1)", () => {
  test("false when the failing run is at or under 60s", () => {
    const h: ProbeHistory = { samples: [fail(0), fail(30 * SECOND)] };
    // first failure at 0, now at 60s → exactly 60s, NOT > threshold
    expect(healthFailing(h, 60 * SECOND)).toBe(false);
  });

  test("true once the failing run exceeds 60s — synthetic M1", () => {
    const h: ProbeHistory = { samples: [fail(0), fail(30 * SECOND), fail(70 * SECOND)] };
    expect(healthFailing(h, 70 * SECOND)).toBe(true);
    expect(HEALTH_FAIL_THRESHOLD_MS).toBe(60 * SECOND);
  });

  test("false when currently healthy even after a past outage", () => {
    const h: ProbeHistory = { samples: [fail(0), fail(70 * SECOND), ok(100 * SECOND)] };
    expect(healthFailing(h, 100 * SECOND)).toBe(false);
  });
});

describe("appendSample / pruneHistory", () => {
  test("appendSample adds the newest sample", () => {
    const h = appendSample({ samples: [ok(0)] }, fail(SECOND), PROBE_HISTORY_WINDOW_MS, SECOND);
    expect(h.samples.length).toBe(2);
    expect(h.samples[1]?.ok).toBe(false);
  });

  test("pruning drops samples older than the window", () => {
    const now = 25 * 60 * MINUTE;
    const h = appendSample(
      { samples: [ok(0)] }, // older than 24h
      ok(now),
      PROBE_HISTORY_WINDOW_MS,
      now
    );
    expect(h.samples.length).toBe(1);
    expect(h.samples[0]?.at).toBe(new Date(now).toISOString());
  });

  test("pruneHistory drops malformed-timestamp samples", () => {
    const bad: ProbeSample = { at: "not-a-date", ok: true, statusCode: 200 };
    const h = pruneHistory({ samples: [bad, ok(1000)] }, PROBE_HISTORY_WINDOW_MS, 2000);
    expect(h.samples.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STATE_DIR_ENV = "MINSKY_STATE_DIR";

describe("probe-history persistence", () => {
  let tmpStateDir: string;
  let priorStateDir: string | undefined;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-probe-history-test-"));
    priorStateDir = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = tmpStateDir;
  });

  afterEach(() => {
    if (priorStateDir === undefined) {
      delete process.env[STATE_DIR_ENV];
    } else {
      process.env[STATE_DIR_ENV] = priorStateDir;
    }
    try {
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("file path is <cockpitStateDir>/mcp-probe-history.json", () => {
    expect(getProbeHistoryFilePath()).toBe(
      path.join(tmpStateDir, "cockpit", "mcp-probe-history.json")
    );
  });

  test("read on missing file returns an empty history", () => {
    expect(readProbeHistory()).toEqual({ samples: [] });
  });

  test("write + read round-trips", () => {
    const history: ProbeHistory = { samples: [ok(0), fail(SECOND, 503)] };
    writeProbeHistory(history);
    expect(readProbeHistory()).toEqual(history);
  });

  test("read on malformed JSON returns an empty history", () => {
    const p = getProbeHistoryFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json {{{");
    expect(readProbeHistory()).toEqual({ samples: [] });
  });

  test("read drops wrong-shape samples", () => {
    const p = getProbeHistoryFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        samples: [{ at: "2026-01-01T00:00:00.000Z", ok: true, statusCode: 200 }, { bogus: 1 }],
      })
    );
    expect(readProbeHistory().samples.length).toBe(1);
  });
});
