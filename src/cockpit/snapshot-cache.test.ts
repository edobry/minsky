/**
 * Tests for the conversation-snapshot cache (mt#4258).
 *
 * The two properties worth pinning are the ones whose failure modes are silent:
 * an UNBOUNDED cache leaks multi-megabyte snapshots until the daemon dies, and a
 * cache that ignores its version token serves a conversation missing its newest
 * turns while looking completely healthy. Both are asserted directly rather than
 * through the route, so a failure names the defect instead of a 500.
 */

import { describe, expect, test } from "bun:test";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";

import {
  DEFAULT_MAX_ENTRIES,
  ifNoneMatchSatisfies,
  OVERVIEW_FRESHNESS_CEILING_MS,
  OverviewCache,
  SnapshotCache,
  snapshotEtag,
} from "./snapshot-cache";

/** A snapshot carrying just enough shape to be identifiable in an assertion. */
function snapshotWith(id: string, blockCount: number): SessionContextSnapshot {
  return {
    agentSessionId: id,
    harness: "claude_code",
    blocks: Array.from({ length: blockCount }, (_, i) => ({
      id: `${id}:${i}`,
      type: "user-prompt",
      source: "observed",
      content: `block ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })),
    assembledAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  } as unknown as SessionContextSnapshot;
}

describe("SnapshotCache", () => {
  test("returns a stored snapshot when the version token matches", () => {
    const cache = new SnapshotCache();
    const snap = snapshotWith("conv-a", 3);
    cache.set("conv-a", "10-2-live", snap);

    expect(cache.get("conv-a", "10-2-live")).toBe(snap);
  });

  test("a changed token is a MISS — an appending conversation never serves stale turns", () => {
    const cache = new SnapshotCache();
    cache.set("conv-a", "10-2-live", snapshotWith("conv-a", 10));

    // The conversation gained a turn: the probe now yields a different token.
    expect(cache.get("conv-a", "11-2-live")).toBeUndefined();
  });

  test("a stale entry is EVICTED on the miss, not merely skipped", () => {
    const cache = new SnapshotCache();
    cache.set("conv-a", "10-2-live", snapshotWith("conv-a", 10));
    expect(cache.size()).toBe(1);

    cache.get("conv-a", "11-2-live");

    // Retaining it would hold megabytes that can never be served again.
    expect(cache.size()).toBe(0);
  });

  test("an ended conversation re-assembles: ended_at is part of the token", () => {
    const cache = new SnapshotCache();
    cache.set("conv-a", "10-2-live", snapshotWith("conv-a", 10));

    expect(cache.get("conv-a", "10-2-2026-01-01T00:00:00.000Z")).toBeUndefined();
  });

  test("evicts the least-recently-used entry once full", () => {
    const cache = new SnapshotCache(3);
    cache.set("a", "t", snapshotWith("a", 1));
    cache.set("b", "t", snapshotWith("b", 1));
    cache.set("c", "t", snapshotWith("c", 1));

    cache.set("d", "t", snapshotWith("d", 1));

    expect(cache.size()).toBe(3);
    expect(cache.get("a", "t")).toBeUndefined();
    expect(cache.get("b", "t")).toBeDefined();
    expect(cache.get("d", "t")).toBeDefined();
  });

  test("a READ refreshes recency, so the hot entry is not the eviction victim", () => {
    const cache = new SnapshotCache(3);
    cache.set("a", "t", snapshotWith("a", 1));
    cache.set("b", "t", snapshotWith("b", 1));
    cache.set("c", "t", snapshotWith("c", 1));

    // Touch "a" — it is now the most recently used, so "b" is the victim.
    expect(cache.get("a", "t")).toBeDefined();
    cache.set("d", "t", snapshotWith("d", 1));

    expect(cache.get("a", "t")).toBeDefined();
    expect(cache.get("b", "t")).toBeUndefined();
  });

  test("overwriting a key refreshes recency rather than keeping its old position", () => {
    const cache = new SnapshotCache(2);
    cache.set("a", "t1", snapshotWith("a", 1));
    cache.set("b", "t1", snapshotWith("b", 1));

    cache.set("a", "t2", snapshotWith("a", 2));
    cache.set("c", "t1", snapshotWith("c", 1));

    expect(cache.get("a", "t2")).toBeDefined();
    expect(cache.get("b", "t1")).toBeUndefined();
  });

  test("the bound holds under sustained churn — this is the leak guard", () => {
    const cache = new SnapshotCache(DEFAULT_MAX_ENTRIES);
    for (let i = 0; i < 500; i++) {
      cache.set(`conv-${i}`, "t", snapshotWith(`conv-${i}`, 50));
    }
    expect(cache.size()).toBe(DEFAULT_MAX_ENTRIES);
  });

  test("a non-positive bound is a programming error, not a silently-empty cache", () => {
    expect(() => new SnapshotCache(0)).toThrow(RangeError);
    expect(() => new SnapshotCache(-1)).toThrow(RangeError);
    expect(() => new SnapshotCache(1.5)).toThrow(RangeError);
  });

  test("clear() drops everything", () => {
    const cache = new SnapshotCache();
    cache.set("a", "t", snapshotWith("a", 1));
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe("ifNoneMatchSatisfies", () => {
  // PR #3104 R2. Every miss here is silent and expensive: the route skips its
  // 304 and re-sends the whole multi-megabyte body, which is the exact cost this
  // feature exists to avoid. Nothing errors; revalidation just stops happening.
  const etag = snapshotEtag("2067-919-live");

  test("matches the exact etag the server emitted", () => {
    expect(ifNoneMatchSatisfies(etag, etag)).toBe(true);
  });

  test("matches a member of a comma-separated LIST", () => {
    expect(ifNoneMatchSatisfies(`W/"other", ${etag}, W/"third"`, etag)).toBe(true);
  });

  test("matches under WEAK comparison — W/ ignored on either side", () => {
    expect(ifNoneMatchSatisfies('"2067-919-live"', etag)).toBe(true);
    expect(ifNoneMatchSatisfies('W/"2067-919-live"', '"2067-919-live"')).toBe(true);
  });

  test("matches the wildcard", () => {
    expect(ifNoneMatchSatisfies("*", etag)).toBe(true);
  });

  test("does NOT match a different token — the control", () => {
    expect(ifNoneMatchSatisfies('W/"9999-1-live"', etag)).toBe(false);
    expect(ifNoneMatchSatisfies('W/"other", W/"third"', etag)).toBe(false);
  });

  test("does not match an absent or empty header", () => {
    expect(ifNoneMatchSatisfies(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfies("", etag)).toBe(false);
    expect(ifNoneMatchSatisfies("   ", etag)).toBe(false);
  });

  test("tolerates surrounding whitespace in a list", () => {
    expect(ifNoneMatchSatisfies(`   ${etag}   `, etag)).toBe(true);
    expect(ifNoneMatchSatisfies(`W/"a" ,   ${etag}`, etag)).toBe(true);
  });
});

describe("snapshotEtag", () => {
  test("renders a quoted weak validator", () => {
    expect(snapshotEtag("10-2-live")).toBe('W/"10-2-live"');
  });

  test("distinct tokens produce distinct etags", () => {
    expect(snapshotEtag("10-2-live")).not.toBe(snapshotEtag("11-2-live"));
  });
});

/**
 * `OverviewCache` (mt#4429).
 *
 * Validity here is a CONJUNCTION, and each half exists because the other cannot
 * see a particular staleness. The tests are written to fail if either half is
 * dropped — a token-only cache passes the ceiling tests' setup and serves a
 * stale git commit list; a TTL-only cache passes the token tests' setup and
 * serves a stale turn count.
 */
describe("OverviewCache", () => {
  const T0 = 1_000_000;
  const payload = (label: string): { label: string } => ({ label });

  test("serves a stored payload when the token matches and the entry is fresh", () => {
    const cache = new OverviewCache<{ label: string }>();
    const value = payload("mt#4429 spec audit");
    cache.set("conv-a", "tok-1", value, T0);

    expect(cache.get("conv-a", "tok-1", T0 + 1_000)).toBe(value);
  });

  test("a changed token is a MISS even when the entry is fresh", () => {
    // The conversation gained a turn one millisecond after the store: the
    // ceiling is nowhere near expiry, so ONLY the token can catch this.
    const cache = new OverviewCache<{ label: string }>();
    cache.set("conv-a", "tok-1", payload("stale"), T0);

    expect(cache.get("conv-a", "tok-2", T0 + 1)).toBeUndefined();
  });

  test("an expired entry is a MISS even when the token still matches", () => {
    // Nothing about the conversation changed, so the token is identical — this
    // is the git/PR drift the token structurally cannot see, and ONLY the
    // ceiling can catch it.
    const cache = new OverviewCache<{ label: string }>();
    cache.set("conv-a", "tok-1", payload("stale commits"), T0);

    expect(cache.get("conv-a", "tok-1", T0 + OVERVIEW_FRESHNESS_CEILING_MS + 1)).toBeUndefined();
  });

  test("the ceiling is exclusive at the boundary", () => {
    const cache = new OverviewCache<{ label: string }>();
    cache.set("conv-a", "tok-1", payload("edge"), T0);

    expect(cache.get("conv-a", "tok-1", T0 + OVERVIEW_FRESHNESS_CEILING_MS - 1)).toBeDefined();
    expect(cache.get("conv-a", "tok-1", T0 + OVERVIEW_FRESHNESS_CEILING_MS)).toBeUndefined();
  });

  test("evicts least-recently-used beyond the bound", () => {
    const cache = new OverviewCache<{ label: string }>(2);
    cache.set("a", "t", payload("a"), T0);
    cache.set("b", "t", payload("b"), T0);
    cache.set("c", "t", payload("c"), T0);

    expect(cache.size()).toBe(2);
    expect(cache.get("a", "t", T0)).toBeUndefined();
    expect(cache.get("c", "t", T0)).toBeDefined();
  });

  test("an expired entry is DELETED on read, not merely withheld", () => {
    // PR #3252 R1 BLOCKING. Withholding is not enough: the token matched, so
    // the inner lookup already refreshed recency. An undeleted expired entry is
    // therefore the LAST thing that would be evicted.
    const cache = new OverviewCache<{ label: string }>();
    cache.set("conv-a", "tok-1", payload("expired"), T0);
    expect(cache.size()).toBe(1);

    cache.get("conv-a", "tok-1", T0 + OVERVIEW_FRESHNESS_CEILING_MS + 1);

    expect(cache.size()).toBe(0);
  });

  test("reading expired keys does not evict the live ones — the poisoning case", () => {
    // The failure this guards is not a leaked slot, it is INVERTED eviction
    // priority: without the delete, each expired read promotes a never-servable
    // entry above a servable one, and a cache read repeatedly at the ceiling
    // ends up holding nothing useful.
    const cache = new OverviewCache<{ label: string }>(2);
    cache.set("stale-a", "tok", payload("stale-a"), T0);
    cache.set("stale-b", "tok", payload("stale-b"), T0);

    const past = T0 + OVERVIEW_FRESHNESS_CEILING_MS + 1;
    cache.get("stale-a", "tok", past);
    cache.get("stale-b", "tok", past);
    expect(cache.size()).toBe(0);

    // Both slots are free, so a live entry stored afterwards survives.
    cache.set("live", "tok", payload("live"), past);
    expect(cache.get("live", "tok", past + 1)?.label).toBe("live");
  });

  test("rejects a non-positive freshness ceiling rather than degrading silently", () => {
    expect(() => new OverviewCache(8, 0)).toThrow(RangeError);
    expect(() => new OverviewCache(8, -1)).toThrow(RangeError);
    expect(() => new OverviewCache(8, 1.5)).toThrow(RangeError);
  });
});
