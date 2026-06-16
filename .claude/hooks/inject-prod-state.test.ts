import { describe, test, expect } from "bun:test";
import {
  parseProdStateCache,
  formatAge,
  formatProdState,
  PROD_STATE_STALENESS_MS,
  type ProdStateCacheRecord,
} from "./inject-prod-state";

const NOW = Date.parse("2026-06-16T20:00:00.000Z");

function recordAt(ageMs: number, over: Partial<ProdStateCacheRecord> = {}): ProdStateCacheRecord {
  return {
    ledgerRows: 48,
    latestAppliedAtMs: Date.parse("2026-06-16T14:02:00.000Z"),
    checkedAt: new Date(NOW - ageMs).toISOString(),
    ...over,
  };
}

describe("parseProdStateCache", () => {
  test("parses a valid record", () => {
    const rec = parseProdStateCache(
      JSON.stringify({ ledgerRows: 48, latestAppliedAtMs: 1718500000000, checkedAt: "x" })
    );
    expect(rec).toEqual({ ledgerRows: 48, latestAppliedAtMs: 1718500000000, checkedAt: "x" });
  });

  test("accepts a null latestAppliedAtMs", () => {
    const rec = parseProdStateCache(
      JSON.stringify({ ledgerRows: 0, latestAppliedAtMs: null, checkedAt: "x" })
    );
    expect(rec?.latestAppliedAtMs).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseProdStateCache("{not json")).toBeNull();
  });

  test("returns null when checkedAt is missing/empty", () => {
    expect(
      parseProdStateCache(JSON.stringify({ ledgerRows: 1, latestAppliedAtMs: null }))
    ).toBeNull();
    expect(
      parseProdStateCache(JSON.stringify({ ledgerRows: 1, latestAppliedAtMs: null, checkedAt: "" }))
    ).toBeNull();
  });

  test("returns null when ledgerRows is not a finite number", () => {
    expect(
      parseProdStateCache(
        JSON.stringify({ ledgerRows: "48", latestAppliedAtMs: null, checkedAt: "x" })
      )
    ).toBeNull();
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

describe("formatProdState", () => {
  test("null cache -> UNKNOWN, instructs not to assert from memory", () => {
    const out = formatProdState(null, NOW);
    expect(out).toMatch(/UNKNOWN/);
    expect(out).toMatch(/do not assert/i);
    expect(out).toMatch(/__drizzle_migrations/);
  });

  test("fresh cache -> ground-truth snapshot with counts + latest", () => {
    const out = formatProdState(recordAt(5 * 60000), NOW);
    expect(out).toMatch(/48 migrations applied/);
    expect(out).toMatch(/latest applied 2026-06-16T14:02:00/);
    expect(out).toMatch(/ground truth/i);
    expect(out).not.toMatch(/STALE/);
  });

  test("fresh cache with null latest omits the 'latest applied' clause", () => {
    const out = formatProdState(recordAt(5 * 60000, { latestAppliedAtMs: null }), NOW);
    expect(out).toMatch(/48 migrations applied/);
    expect(out).not.toMatch(/latest applied/);
  });

  test("stale cache (age > threshold) -> STALE, instructs re-verify", () => {
    const out = formatProdState(recordAt(PROD_STATE_STALENESS_MS + 60000), NOW);
    expect(out).toMatch(/STALE/);
    expect(out).toMatch(/re-verify/i);
  });

  test("unparseable checkedAt is treated as infinitely stale", () => {
    const out = formatProdState(
      { ledgerRows: 1, latestAppliedAtMs: null, checkedAt: "not-a-date" },
      NOW
    );
    expect(out).toMatch(/STALE/);
  });
});
