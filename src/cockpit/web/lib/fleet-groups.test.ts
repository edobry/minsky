/**
 * Tests for the fleet needs-me banding + subagent elapsed helpers (mt#2884).
 */
import { describe, expect, test } from "bun:test";
import { needsMeBand, subagentElapsed, BAND_RANK, type BandableRow } from "./fleet-groups";

const NOW = new Date("2026-07-17T12:00:00Z").getTime();
const RECENT = "2026-07-16T12:00:00Z"; // 1d ago — inside the review window
const FOSSIL = "2026-05-01T00:00:00Z"; // ~77d ago — the live-audit fossil class

function row(overrides: Partial<BandableRow>): BandableRow {
  return {
    sessionId: "s-1",
    liveness: null,
    prNumber: null,
    prStatus: null,
    lastActivityAt: RECENT,
    ...overrides,
  };
}

describe("needsMeBand", () => {
  const askBound = new Set(["s-1"]);
  const noAsks = new Set<string>();

  test("an open ask bound to the session outranks everything — even a healthy working row", () => {
    expect(needsMeBand(row({ liveness: "healthy" }), askBound, NOW)).toBe("needs-input");
  });

  test("open PR without terminal status on an ACTIVE lane is review", () => {
    expect(needsMeBand(row({ prNumber: 2027, prStatus: "open" }), noAsks, NOW)).toBe("review");
  });

  test("fossil lane with an ancient open PR is NOT review — the live-audit false-alarm class", () => {
    expect(
      needsMeBand(
        row({ prNumber: 967, prStatus: "open", liveness: "stale", lastActivityAt: FOSSIL }),
        noAsks,
        NOW
      )
    ).toBe("idle");
  });

  test("merged/closed PRs are not review", () => {
    expect(
      needsMeBand(row({ prNumber: 2027, prStatus: "merged", liveness: "healthy" }), noAsks, NOW)
    ).toBe("working");
    expect(needsMeBand(row({ prNumber: 2027, prStatus: "closed" }), noAsks, NOW)).toBe("done");
  });

  test("liveness maps to working/idle; terminal to done", () => {
    expect(needsMeBand(row({ liveness: "healthy" }), noAsks, NOW)).toBe("working");
    expect(needsMeBand(row({ liveness: "idle" }), noAsks, NOW)).toBe("idle");
    expect(needsMeBand(row({ liveness: "stale" }), noAsks, NOW)).toBe("idle");
    expect(needsMeBand(row({ liveness: "orphaned" }), noAsks, NOW)).toBe("done");
    expect(needsMeBand(row({ liveness: null }), noAsks, NOW)).toBe("done");
  });

  test("band ranks order needs-input < review < working < idle < done", () => {
    expect(BAND_RANK["needs-input"]).toBeLessThan(BAND_RANK.review);
    expect(BAND_RANK.review).toBeLessThan(BAND_RANK.working);
    expect(BAND_RANK.working).toBeLessThan(BAND_RANK.idle);
    expect(BAND_RANK.idle).toBeLessThan(BAND_RANK.done);
  });
});

describe("subagentElapsed", () => {
  test("running node: elapsed against now", () => {
    expect(subagentElapsed("2026-07-17T11:57:30Z", null, NOW)).toBe("2m");
  });

  test("ended node: total runtime", () => {
    expect(subagentElapsed("2026-07-17T10:00:00Z", "2026-07-17T11:03:00Z", NOW)).toBe("1h 3m");
  });

  test("sub-minute runs render seconds", () => {
    expect(subagentElapsed("2026-07-17T11:59:15Z", "2026-07-17T11:59:59Z", NOW)).toBe("44s");
  });

  test("missing/invalid timestamps render nothing", () => {
    expect(subagentElapsed(null, null, NOW)).toBeNull();
    expect(subagentElapsed("garbage", null, NOW)).toBeNull();
    expect(subagentElapsed("2026-07-17T12:30:00Z", "2026-07-17T12:00:00Z", NOW)).toBeNull();
  });
});
