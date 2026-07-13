/**
 * Unit tests for the changeset recency ordering helpers (mt#1920 R1).
 *
 * Pins the contract the reviewer flagged: `/api/changesets` orders newest-first
 * by a recency PROXY (lastActivityAt, falling back to createdAt), NOT by
 * session.createdAt alone. These tests exercise the pure comparator directly.
 */
import { describe, test, expect } from "bun:test";
import {
  changesetRecencyTimestamp,
  compareChangesetsByRecency,
  type ChangesetRecencyFields,
} from "./session-detail";

function cs(lastActivityAt: string | null, createdAt: string | null) {
  return { session: { lastActivityAt, createdAt } satisfies ChangesetRecencyFields };
}

describe("changesetRecencyTimestamp", () => {
  test("prefers lastActivityAt over createdAt", () => {
    const t = changesetRecencyTimestamp({
      lastActivityAt: "2026-06-25T00:00:00Z",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(t).toBe(new Date("2026-06-25T00:00:00Z").getTime());
  });

  test("falls back to createdAt when lastActivityAt is null", () => {
    const t = changesetRecencyTimestamp({
      lastActivityAt: null,
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(t).toBe(new Date("2026-06-01T00:00:00Z").getTime());
  });

  test("returns 0 when neither timestamp is present", () => {
    expect(changesetRecencyTimestamp({ lastActivityAt: null, createdAt: null })).toBe(0);
  });

  test("returns 0 for an unparseable timestamp", () => {
    expect(changesetRecencyTimestamp({ lastActivityAt: "not-a-date", createdAt: null })).toBe(0);
  });
});

describe("compareChangesetsByRecency", () => {
  test("orders newest-first by the recency proxy", () => {
    const older = cs("2026-06-01T00:00:00Z", "2026-05-01T00:00:00Z");
    const newer = cs("2026-06-25T00:00:00Z", "2026-05-01T00:00:00Z");
    const sorted = [older, newer].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(newer);
    expect(sorted[1]).toBe(older);
  });

  test("uses lastActivityAt, not createdAt, as the sort key", () => {
    // `recent` was created earliest but is the most-recently-active — it must
    // sort first. A createdAt-only sort (the pre-fix behavior) would invert this.
    const recent = cs("2026-06-25T00:00:00Z", "2026-01-01T00:00:00Z");
    const stale = cs("2026-06-02T00:00:00Z", "2026-06-20T00:00:00Z");
    const sorted = [stale, recent].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(recent);
    expect(sorted[1]).toBe(stale);
  });

  test("a session with null lastActivityAt sorts by its createdAt", () => {
    const a = cs(null, "2026-06-20T00:00:00Z"); // createdAt proxy (Jun 20)
    const b = cs("2026-06-10T00:00:00Z", "2026-01-01T00:00:00Z"); // lastActivity Jun 10
    const sorted = [b, a].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(a);
    expect(sorted[1]).toBe(b);
  });

  test("rows with no recency data sort last", () => {
    const dated = cs("2026-06-01T00:00:00Z", null);
    const undated = cs(null, null);
    const sorted = [undated, dated].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(dated);
    expect(sorted[1]).toBe(undated);
  });
});
