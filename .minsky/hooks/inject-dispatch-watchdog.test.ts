/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: the readCache tests
   exercise the REAL fs.existsSync/readFileSync pair readCache() calls, specifically to pin
   the missing-vs-malformed distinction (R1 non-blocking #1); mocking fs would defeat the
   point of testing that distinction against real filesystem semantics */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseDispatchWatchdogCache,
  formatAge,
  formatDispatchWatchdogState,
  readCache,
  type DispatchWatchdogCacheRecord,
} from "./inject-dispatch-watchdog";

const NOW = "2026-07-07T12:00:00.000Z";

function cacheAt(
  flags: DispatchWatchdogCacheRecord["flags"] = [],
  over: Partial<DispatchWatchdogCacheRecord> = {}
): DispatchWatchdogCacheRecord {
  return {
    checkedAt: NOW,
    staleMs: 30 * 60 * 1000,
    flags,
    ...over,
  };
}

function flag(over: Partial<DispatchWatchdogCacheRecord["flags"][number]> = {}) {
  return {
    taskId: "mt#2646",
    subagentSessionId: "session-1",
    agentType: "implementer",
    taskStatus: "IN-PROGRESS",
    startedAt: "2026-07-07T11:00:00.000Z",
    lastActivityAt: "2026-07-07T11:00:00.000Z",
    staleForMs: 60 * 60 * 1000,
    ...over,
  };
}

describe("parseDispatchWatchdogCache", () => {
  test("parses a valid record with flags", () => {
    const rec = parseDispatchWatchdogCache(JSON.stringify(cacheAt([flag()])));
    expect(rec).toEqual(cacheAt([flag()]));
  });

  test("parses a valid record with no flags", () => {
    const rec = parseDispatchWatchdogCache(JSON.stringify(cacheAt([])));
    expect(rec?.flags).toEqual([]);
  });

  test("returns null on malformed JSON", () => {
    expect(parseDispatchWatchdogCache("{not json")).toBeNull();
  });

  test("returns null when checkedAt is missing/empty", () => {
    expect(parseDispatchWatchdogCache(JSON.stringify({ staleMs: 100, flags: [] }))).toBeNull();
    expect(
      parseDispatchWatchdogCache(JSON.stringify({ checkedAt: "", staleMs: 100, flags: [] }))
    ).toBeNull();
  });

  test("returns null when staleMs is not a finite number", () => {
    expect(
      parseDispatchWatchdogCache(JSON.stringify({ checkedAt: "x", staleMs: "100", flags: [] }))
    ).toBeNull();
  });

  test("returns null when flags is not an array", () => {
    expect(
      parseDispatchWatchdogCache(JSON.stringify({ checkedAt: "x", staleMs: 100, flags: {} }))
    ).toBeNull();
  });

  test("skips malformed individual flag entries but keeps the well-formed ones", () => {
    const rec = parseDispatchWatchdogCache(
      JSON.stringify(cacheAt([flag(), { taskId: "mt#1" /* missing required fields */ }]))
    );
    expect(rec?.flags).toHaveLength(1);
    expect(rec?.flags[0]?.taskId).toBe("mt#2646");
  });

  test("normalizes a missing subagentSessionId to null", () => {
    const raw = { ...flag() };
    delete (raw as Record<string, unknown>).subagentSessionId;
    const rec = parseDispatchWatchdogCache(JSON.stringify(cacheAt([raw as never])));
    expect(rec?.flags[0]?.subagentSessionId).toBeNull();
  });
});

describe("formatAge", () => {
  test.each([
    [5 * 60000, "5m"],
    [90 * 60000, "1h"],
    [49 * 3600000, "2d"],
    [0, "0m"],
  ] as const)("%i ms -> %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });

  test("negative/NaN -> unknown", () => {
    expect(formatAge(-1)).toBe("unknown");
    expect(formatAge(NaN)).toBe("unknown");
  });
});

describe("formatDispatchWatchdogState", () => {
  test("null cache -> silent (no known-flaggable state yet)", () => {
    expect(formatDispatchWatchdogState(null)).toBeNull();
  });

  test("empty flags -> silent (nothing stalled)", () => {
    expect(formatDispatchWatchdogState(cacheAt([]))).toBeNull();
  });

  test("non-empty flags -> warning naming the task, status, and staleness age", () => {
    const out = formatDispatchWatchdogState(cacheAt([flag()]));
    expect(out).toMatch(/DISPATCH WATCHDOG/);
    expect(out).toMatch(/mt#2646/);
    expect(out).toMatch(/IN-PROGRESS/);
    expect(out).toMatch(/1h/);
    expect(out).toMatch(/session-1/);
  });

  test("points at the probe (session.status probe=true) and the resume protocol", () => {
    const out = formatDispatchWatchdogState(cacheAt([flag()]));
    expect(out).toMatch(/session\.status/);
    expect(out).toMatch(/probe=true/);
    expect(out).toMatch(/orchestrate/);
    expect(out).toMatch(/SendMessage-resume/);
  });

  test("a missing subagentSessionId renders a readable placeholder, not 'null'", () => {
    const out = formatDispatchWatchdogState(cacheAt([flag({ subagentSessionId: null })]));
    expect(out).toMatch(/\(no session id\)/);
  });

  test("multiple flags each get their own line", () => {
    const out = formatDispatchWatchdogState(
      cacheAt([flag({ taskId: "mt#1" }), flag({ taskId: "mt#2" })])
    );
    expect(out).toMatch(/mt#1/);
    expect(out).toMatch(/mt#2/);
    expect(out).toMatch(/2 in-flight subagent dispatch/);
  });
});

describe("readCache (R1 non-blocking #1: missing vs malformed distinction)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempCachePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "mt2646-readcache-"));
    tempDirs.push(dir);
    return join(dir, "dispatch-watchdog-cache.json");
  }

  test("missing: a nonexistent cache path -> kind 'missing'", () => {
    const result = readCache(tempCachePath()); // never written
    expect(result.kind).toBe("missing");
  });

  test("ok: a well-formed cache file -> kind 'ok' with the parsed record", () => {
    const path = tempCachePath();
    const record = cacheAt([flag()]);
    writeFileSync(path, JSON.stringify(record));

    const result = readCache(path);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.record).toEqual(record);
  });

  test("malformed: a present-but-unparseable cache file -> kind 'malformed', distinct from 'missing'", () => {
    const path = tempCachePath();
    writeFileSync(path, "{not valid json");

    const result = readCache(path);
    expect(result.kind).toBe("malformed");
  });

  test("malformed: valid JSON that fails schema validation -> kind 'malformed'", () => {
    const path = tempCachePath();
    writeFileSync(path, JSON.stringify({ notTheRightShape: true }));

    const result = readCache(path);
    expect(result.kind).toBe("malformed");
  });
});
