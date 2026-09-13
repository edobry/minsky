/**
 * Remainder disposition — pure core (mt#5131).
 *
 * AT1's fixture shape (fresh / stale-and-pointed / stale-and-unpointed / parked-
 * and-pointed), AT2 (session-owned and container kinds are never candidates),
 * idempotence, the zero-pointings guard, and the per-run cap. The clock is
 * injected and every date-relative fixture is anchored to it.
 */

import { describe, test, expect } from "bun:test";
import {
  AUTO_EXPIRED_TAG,
  autoExpiredSection,
  isParkedRow,
  isRemainderCandidate,
  planRemainderSweep,
  resurrectedSection,
  tagsAfterPark,
  tagsAfterResurrect,
  type RemainderPointing,
  type RemainderTaskRow,
} from "./remainder-expiry";

const NOW_MS = Date.UTC(2026, 8, 13, 11, 0, 0);
const DAY = 86_400_000;
const daysAgo = (n: number) => NOW_MS - n * DAY;

function row(overrides: Partial<RemainderTaskRow> & { id: string }): RemainderTaskRow {
  return {
    status: "TODO",
    kind: "implementation",
    tags: [],
    updatedAtMs: daysAgo(120),
    ...overrides,
  };
}

const POINTING: RemainderPointing = {
  id: "p-hooks",
  name: "hooks",
  query: { tags: ["hooks"] },
};
const noAncestors = () => [] as string[];
const UNPOINTED_1 = "stale-unpointed-1";
const UNPOINTED_2 = "stale-unpointed-2";

describe("isRemainderCandidate", () => {
  test("open, unowned, untouched 90+ days → candidate; touched 89 days ago → not", () => {
    expect(isRemainderCandidate(row({ id: "a", updatedAtMs: daysAgo(90) }), NOW_MS)).toBe(true);
    expect(isRemainderCandidate(row({ id: "b", updatedAtMs: daysAgo(89) }), NOW_MS)).toBe(false);
  });

  test("AT2: a session-owned status or a container/claim kind is never a candidate, however stale", () => {
    for (const status of ["IN-PROGRESS", "IN-REVIEW"]) {
      expect(isRemainderCandidate(row({ id: "s", status }), NOW_MS)).toBe(false);
    }
    for (const kind of ["work-package", "umbrella"]) {
      expect(isRemainderCandidate(row({ id: "k", kind }), NOW_MS)).toBe(false);
    }
  });

  test("terminal rows are not candidates; BLOCKED, PLANNING and READY are", () => {
    expect(isRemainderCandidate(row({ id: "d", status: "DONE" }), NOW_MS)).toBe(false);
    expect(isRemainderCandidate(row({ id: "c", status: "CLOSED" }), NOW_MS)).toBe(false);
    for (const status of ["BLOCKED", "PLANNING", "READY"]) {
      expect(isRemainderCandidate(row({ id: "o", status }), NOW_MS)).toBe(true);
    }
  });

  test("isParkedRow is CLOSED plus the tag — a hand-closed task is nobody's to reopen", () => {
    expect(isParkedRow(row({ id: "p", status: "CLOSED", tags: [AUTO_EXPIRED_TAG] }))).toBe(true);
    expect(isParkedRow(row({ id: "h", status: "CLOSED", tags: [] }))).toBe(false);
    expect(isParkedRow(row({ id: "t", status: "TODO", tags: [AUTO_EXPIRED_TAG] }))).toBe(false);
  });
});

describe("planRemainderSweep", () => {
  const fixture: RemainderTaskRow[] = [
    row({ id: "fresh-1", updatedAtMs: daysAgo(3) }),
    row({ id: "fresh-2", updatedAtMs: daysAgo(30), tags: ["hooks"] }),
    row({ id: "stale-pointed-1", tags: ["hooks"] }),
    row({ id: "stale-pointed-2", tags: ["hooks", "other"], updatedAtMs: daysAgo(400) }),
    row({ id: UNPOINTED_1, updatedAtMs: daysAgo(200) }),
    row({ id: UNPOINTED_2, tags: ["misc"], updatedAtMs: daysAgo(95) }),
    row({ id: "parked-pointed", status: "CLOSED", tags: [AUTO_EXPIRED_TAG, "hooks"] }),
    row({ id: "parked-unpointed", status: "CLOSED", tags: [AUTO_EXPIRED_TAG] }),
  ];

  test("AT1: six open + one parked-and-matching → park the two unpointed stale, resurrect the one", () => {
    const plan = planRemainderSweep(fixture, [POINTING], noAncestors, { nowMs: NOW_MS });
    // Oldest first.
    expect(plan.park).toEqual([UNPOINTED_1, UNPOINTED_2]);
    expect(plan.resurrect).toEqual([
      { id: "parked-pointed", pointingId: "p-hooks", pointingName: "hooks" },
    ]);
    expect(plan.parkingSuspended).toBeNull();
    expect(plan.capped).toBe(false);
    expect(plan.pointingIds).toEqual(["p-hooks"]);
  });

  test("a second run over the applied state plans nothing (idempotent)", () => {
    const first = planRemainderSweep(fixture, [POINTING], noAncestors, { nowMs: NOW_MS });
    const after = fixture.map((r) => {
      if (first.park.includes(r.id)) {
        return { ...r, status: "CLOSED", tags: tagsAfterPark(r.tags), updatedAtMs: NOW_MS };
      }
      if (first.resurrect.some((x) => x.id === r.id)) {
        return { ...r, status: "TODO", tags: tagsAfterResurrect(r.tags), updatedAtMs: NOW_MS };
      }
      return r;
    });
    const second = planRemainderSweep(after, [POINTING], noAncestors, { nowMs: NOW_MS });
    expect(second.park).toEqual([]);
    expect(second.resurrect).toEqual([]);
  });

  test("with ZERO live pointings nothing parks, the would-park set is still reported, and resurrection is empty", () => {
    const plan = planRemainderSweep(fixture, [], noAncestors, { nowMs: NOW_MS });
    expect(plan.park).toEqual([]);
    expect(plan.parkingSuspended).toBe("no live pointings");
    // Oldest first: 400, 200, 120, 95 days.
    expect(plan.wouldPark).toEqual([
      "stale-pointed-2",
      UNPOINTED_1,
      "stale-pointed-1",
      UNPOINTED_2,
    ]);
    expect(plan.resurrect).toEqual([]);
    expect(plan.pointingIds).toEqual([]);
  });

  test("the cap bounds parks (oldest first) and flags it; resurrection is never capped", () => {
    const plan = planRemainderSweep(fixture, [POINTING], noAncestors, { nowMs: NOW_MS, cap: 1 });
    expect(plan.park).toEqual([UNPOINTED_1]);
    expect(plan.capped).toBe(true);
    expect(plan.wouldPark).toHaveLength(2);
    expect(plan.resurrect).toHaveLength(1);
    const zero = planRemainderSweep(fixture, [POINTING], noAncestors, { nowMs: NOW_MS, cap: 0 });
    expect(zero.park).toEqual([]);
    expect(zero.resurrect).toHaveLength(1);
  });

  test("a pointing over a parent subtree matches through the ancestor lookup", () => {
    const subtree: RemainderPointing = {
      id: "p-tree",
      name: "tree",
      query: { parentIds: ["mt#1"] },
    };
    const ancestorsOf = (id: string) => (id === UNPOINTED_1 ? ["mt#1"] : []);
    const plan = planRemainderSweep(fixture, [subtree], ancestorsOf, { nowMs: NOW_MS });
    expect(plan.park).not.toContain(UNPOINTED_1);
    expect(plan.park).toContain("stale-pointed-1"); // the tag pointing is not live here
  });

  test("the first matching pointing names the resurrection", () => {
    const second: RemainderPointing = { id: "p-2", name: "second", query: { tags: ["hooks"] } };
    const plan = planRemainderSweep(fixture, [second, POINTING], noAncestors, { nowMs: NOW_MS });
    expect(plan.resurrect[0]?.pointingId).toBe("p-2");
  });
});

describe("annotations and tags", () => {
  test("the spec sections name the date, the pointings checked, and the reopen path", () => {
    const parked = autoExpiredSection(NOW_MS, ["p-hooks", "p-2"]);
    expect(parked).toContain("## Auto-expired (2026-09-13)");
    expect(parked).toContain("Pointings checked: p-hooks, p-2");
    expect(parked).toContain("CLOSED → TODO");
    expect(autoExpiredSection(NOW_MS, [])).toContain("(none live)");
    const back = resurrectedSection(NOW_MS, POINTING);
    expect(back).toContain("## Resurrected (2026-09-13) by pointing p-hooks");
    expect(back).toContain('"hooks"');
  });

  test("tag transitions are exact and idempotent", () => {
    expect(tagsAfterPark(["a"])).toEqual(["a", AUTO_EXPIRED_TAG]);
    expect(tagsAfterPark(["a", AUTO_EXPIRED_TAG])).toEqual(["a", AUTO_EXPIRED_TAG]);
    expect(tagsAfterResurrect(["a", AUTO_EXPIRED_TAG])).toEqual(["a"]);
    expect(tagsAfterResurrect(["a"])).toEqual(["a"]);
  });
});
