/**
 * Unit tests for the changeset recency client helpers (mt#1920 R2).
 *
 * These pin the CLIENT-side mirror of the server's compareChangesetsByRecency
 * selection: `lastActivityAt ?? createdAt`. The page's default sort, its
 * "attention" tie-breaker, and the row "Age" column all derive from these, so
 * the client default order matches the server order and the displayed age.
 */
import { describe, test, expect } from "bun:test";
import { changesetRecencyIso, changesetRecencyTime } from "./format";

describe("changesetRecencyIso", () => {
  test("prefers lastActivityAt over createdAt", () => {
    expect(
      changesetRecencyIso({
        lastActivityAt: "2026-06-25T00:00:00Z",
        createdAt: "2026-06-01T00:00:00Z",
      })
    ).toBe("2026-06-25T00:00:00Z");
  });

  test("falls back to createdAt when lastActivityAt is null", () => {
    expect(changesetRecencyIso({ lastActivityAt: null, createdAt: "2026-06-01T00:00:00Z" })).toBe(
      "2026-06-01T00:00:00Z"
    );
  });

  test("returns null when neither is present", () => {
    expect(changesetRecencyIso({ lastActivityAt: null, createdAt: null })).toBeNull();
  });
});

describe("changesetRecencyTime", () => {
  test("uses lastActivityAt as the recency key, not createdAt", () => {
    const t = changesetRecencyTime({
      lastActivityAt: "2026-06-25T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(t).toBe(new Date("2026-06-25T00:00:00Z").getTime());
  });

  test("falls back to createdAt when lastActivityAt is null", () => {
    const t = changesetRecencyTime({ lastActivityAt: null, createdAt: "2026-06-01T00:00:00Z" });
    expect(t).toBe(new Date("2026-06-01T00:00:00Z").getTime());
  });

  test("returns 0 when neither timestamp is present", () => {
    expect(changesetRecencyTime({ lastActivityAt: null, createdAt: null })).toBe(0);
  });

  test("returns 0 for an unparseable timestamp", () => {
    expect(changesetRecencyTime({ lastActivityAt: "not-a-date", createdAt: null })).toBe(0);
  });

  test("descending sort by changesetRecencyTime orders most-recently-active first", () => {
    const recent = { lastActivityAt: "2026-06-25T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
    const stale = { lastActivityAt: "2026-06-02T00:00:00Z", createdAt: "2026-06-20T00:00:00Z" };
    const sorted = [stale, recent].sort(
      (a, b) => changesetRecencyTime(b) - changesetRecencyTime(a)
    );
    expect(sorted[0]).toBe(recent);
    expect(sorted[1]).toBe(stale);
  });
});
