/**
 * Unit tests for the S3 gauges widget (mt#2590).
 *
 * Exercises the pure predicates (isEscalationEligible, isDisconnectLogEvent)
 * directly, and readMcpDisconnectEligibleCount24h() against an in-memory mock
 * filesystem (createMockFilesystem, dependency-injected — no real disk I/O,
 * per the project's custom/no-real-fs-in-tests convention) so the async read
 * + bounded tail-scan + type-guarded parse behavior is verified end-to-end.
 */

import { describe, test, expect } from "bun:test";
import { createMockFilesystem } from "../../utils/test-utils/mocking";
import {
  isEscalationEligible,
  isDisconnectLogEvent,
  readMcpDisconnectEligibleCount24h,
  type DisconnectLogEvent,
  type DisconnectLogReaderDeps,
} from "./s3-gauges";

// readMcpDisconnectEligibleCount24h computes its 24h cutoff from the REAL
// wall clock (Date.now()) — it has no injectable clock seam — so all fixture
// timestamps below are relative to the real current time, not a fixed epoch.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const MOCK_LOG_PATH = "/mock/minsky/mcp-disconnect-log.json";

function baseEvent(overrides: Partial<DisconnectLogEvent> = {}): DisconnectLogEvent {
  return {
    kind: "disconnect",
    cause: "stdin_close",
    timestamp: new Date(NOW - HOUR).toISOString(),
    uptimeMs: 10_000,
    processRole: "main_session",
    ...overrides,
  };
}

/** Wraps createMockFilesystem's sync API in the async DisconnectLogReaderDeps shape. */
function depsFromContent(content: string | null): DisconnectLogReaderDeps {
  const mockFs = createMockFilesystem(content !== null ? { [MOCK_LOG_PATH]: content } : {});
  return {
    exists: (p) => Boolean(mockFs.existsSync(p)),
    readFile: async (p) => String(mockFs.readFileSync(p, "utf8")),
  };
}

describe("isEscalationEligible", () => {
  test("a long-lived main_session stdin_close disconnect is eligible", () => {
    expect(isEscalationEligible(baseEvent())).toBe(true);
  });

  test("non-disconnect kinds are never eligible", () => {
    expect(isEscalationEligible(baseEvent({ kind: "reconnect" }))).toBe(false);
    expect(isEscalationEligible(baseEvent({ kind: "process_start" }))).toBe(false);
  });

  test("server-initiated causes are excluded", () => {
    for (const cause of [
      "staleness_exit",
      "signal_sigterm",
      "signal_sigint",
      "signal_sighup",
      "server_close",
      "idle_timeout",
    ]) {
      expect(isEscalationEligible(baseEvent({ cause }))).toBe(false);
    }
  });

  test("short-lived (< 5s uptime) disconnects are excluded", () => {
    expect(isEscalationEligible(baseEvent({ uptimeMs: 4999 }))).toBe(false);
    expect(isEscalationEligible(baseEvent({ uptimeMs: 5000 }))).toBe(true);
  });

  test("legacy events with no uptimeMs are counted conservatively as eligible", () => {
    const { uptimeMs: _uptimeMs, ...withoutUptime } = baseEvent();
    expect(isEscalationEligible(withoutUptime as DisconnectLogEvent)).toBe(true);
  });

  test("helper-role sessions (0 tool calls) are excluded regardless of uptime", () => {
    expect(isEscalationEligible(baseEvent({ processRole: "helper", uptimeMs: 999_999 }))).toBe(
      false
    );
  });

  test("legacy events with no processRole are counted conservatively as eligible", () => {
    const { processRole: _processRole, ...withoutRole } = baseEvent();
    expect(isEscalationEligible(withoutRole as DisconnectLogEvent)).toBe(true);
  });
});

describe("isDisconnectLogEvent", () => {
  test("accepts a well-formed event", () => {
    expect(isDisconnectLogEvent(baseEvent())).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isDisconnectLogEvent(null)).toBe(false);
    expect(isDisconnectLogEvent("disconnect")).toBe(false);
    expect(isDisconnectLogEvent(42)).toBe(false);
  });

  test("rejects a missing kind or timestamp", () => {
    const { kind: _kind, ...withoutKind } = baseEvent();
    expect(isDisconnectLogEvent(withoutKind)).toBe(false);
    const { timestamp: _timestamp, ...withoutTimestamp } = baseEvent();
    expect(isDisconnectLogEvent(withoutTimestamp)).toBe(false);
  });

  test("rejects wrong-typed optional fields", () => {
    expect(isDisconnectLogEvent({ ...baseEvent(), uptimeMs: "not-a-number" })).toBe(false);
    expect(isDisconnectLogEvent({ ...baseEvent(), cause: 123 })).toBe(false);
    expect(isDisconnectLogEvent({ ...baseEvent(), processRole: 123 })).toBe(false);
  });
});

describe("readMcpDisconnectEligibleCount24h", () => {
  test("returns null when the log file does not exist", async () => {
    const deps = depsFromContent(null);
    expect(await readMcpDisconnectEligibleCount24h(MOCK_LOG_PATH, deps)).toBeNull();
  });

  test("counts only escalation-eligible disconnects within the last 24h", async () => {
    const recentEligible = JSON.stringify(baseEvent());
    const recentIneligible = JSON.stringify(baseEvent({ cause: "staleness_exit" }));
    const stale = JSON.stringify(baseEvent({ timestamp: new Date(NOW - 30 * HOUR).toISOString() }));
    const malformed = "{not valid json";

    const deps = depsFromContent(
      [recentEligible, recentIneligible, stale, malformed, ""].join("\n")
    );

    expect(await readMcpDisconnectEligibleCount24h(MOCK_LOG_PATH, deps)).toBe(1);
  });

  test("ignores non-conforming (type-guard-rejected) lines instead of throwing", async () => {
    const deps = depsFromContent(
      [
        JSON.stringify({ kind: "disconnect" /* missing timestamp */ }),
        JSON.stringify(42),
        "null",
      ].join("\n")
    );
    expect(await readMcpDisconnectEligibleCount24h(MOCK_LOG_PATH, deps)).toBe(0);
  });

  test("only scans the trailing window of an oversized log (bounded CPU per poll)", async () => {
    // Write far more than MAX_LOG_LINES_SCANNED old, ineligible lines, then a
    // single recent eligible line at the very end — proves the scan reaches
    // the tail and isn't merely truncating everything.
    const oldLines = Array.from({ length: 2500 }, () =>
      JSON.stringify(baseEvent({ timestamp: new Date(NOW - 100 * HOUR).toISOString() }))
    );
    const recent = JSON.stringify(baseEvent({ timestamp: new Date().toISOString() }));
    const deps = depsFromContent([...oldLines, recent].join("\n"));

    expect(await readMcpDisconnectEligibleCount24h(MOCK_LOG_PATH, deps)).toBe(1);
  });
});
