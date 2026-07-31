/**
 * Tests for relative tab movement — the ordering math behind ⌘⇧[ / ⌘⇧] and
 * ⌃Tab / ⌃⇧Tab (mt#3469).
 *
 * Split out of `tabs.test.tsx` rather than appended to it: that file is already
 * 360 lines and the house limit warns at 400.
 */
import { describe, test, expect } from "bun:test";
import { stepInOrder, mruOrderedPaths, type EntityTab } from "./tabs";

function tab(id: string, lastActiveAt?: number): EntityTab {
  return {
    kind: "task",
    entityId: `mt#${id}`,
    path: `/tasks/mt%23${id}`,
    label: `mt#${id}`,
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  };
}

const A = tab("1").path;
const B = tab("2").path;
const C = tab("3").path;

describe("stepInOrder", () => {
  test("next moves one position right, prev one left", () => {
    expect(stepInOrder([A, B, C], B, "next")).toBe(C);
    expect(stepInOrder([A, B, C], B, "prev")).toBe(A);
  });

  test("next wraps past the last entry to the first", () => {
    expect(stepInOrder([A, B, C], C, "next")).toBe(A);
  });

  test("prev wraps past the first entry to the last", () => {
    expect(stepInOrder([A, B, C], A, "prev")).toBe(C);
  });

  test("is a no-op below two entries, so every binding is inert there", () => {
    expect(stepInOrder([], null, "next")).toBeNull();
    expect(stepInOrder([A], A, "next")).toBeNull();
    expect(stepInOrder([A], A, "prev")).toBeNull();
    expect(stepInOrder([A], null, "next")).toBeNull();
  });

  test("entering from a non-entity route lands at the near end, not nowhere", () => {
    // Rail/list pages open no tab, so there is no current position to be
    // relative to. Dying there would make the shortcut dead on the routes the
    // operator arrives from most often.
    expect(stepInOrder([A, B, C], null, "next")).toBe(A);
    expect(stepInOrder([A, B, C], null, "prev")).toBe(C);
  });

  test("a current path absent from the list is treated the same as no position", () => {
    expect(stepInOrder([A, B], "/tasks/mt%23999", "next")).toBe(A);
    expect(stepInOrder([A, B], "/tasks/mt%23999", "prev")).toBe(B);
  });

  test("walking the full length returns to the starting point", () => {
    let at: string | null = A;
    for (let i = 0; i < 3; i++) at = stepInOrder([A, B, C], at, "next");
    expect(at).toBe(A);
  });
});

describe("mruOrderedPaths", () => {
  test("puts the active tab first, then the rest most-recent-first", () => {
    const tabs = [tab("1", 100), tab("2", 300), tab("3", 200)];
    expect(mruOrderedPaths(tabs, B)).toEqual([B, C, A]);
  });

  test("anchors the active tab at index 0 even when it is not the most recent", () => {
    // The provider stamps the active tab on navigation, so in practice it holds
    // the max recency — but a same-millisecond tie or a localStorage-restored
    // ordinal can break that, and the cycle's index 0 must stay deterministic.
    const tabs = [tab("1", 500), tab("2", 100), tab("3", 400)];
    expect(mruOrderedPaths(tabs, B)[0]).toBe(B);
  });

  test("breaks recency ties by open order", () => {
    const tabs = [tab("1", 100), tab("2", 100), tab("3", 100)];
    expect(mruOrderedPaths(tabs, null)).toEqual([A, B, C]);
  });

  test("ranks a back-filled ordinal below any real activation timestamp", () => {
    // `backfillTabRecency` gives legacy payloads ordinal recencies (0, 1, 2…),
    // which are necessarily smaller than an epoch-ms stamp.
    const tabs = [tab("1", 0), tab("2", Date.now())];
    expect(mruOrderedPaths(tabs, null)).toEqual([B, A]);
  });

  test("omits a missing active path rather than inventing an entry for it", () => {
    const tabs = [tab("1", 100), tab("2", 200)];
    expect(mruOrderedPaths(tabs, "/tasks/mt%23999")).toEqual([B, A]);
  });

  test("returns an empty list for an empty tab set", () => {
    expect(mruOrderedPaths([], null)).toEqual([]);
  });
});

describe("held MRU cycle walks a frozen order", () => {
  // The regression this guards: the provider's open-on-visit effect stamps
  // `lastActiveAt` on every navigation. Recomputing the order between
  // keypresses therefore re-sorts it, and the second press returns to where the
  // first started — which is why the provider freezes the snapshot for the
  // duration of a held cycle and only stamps the tab it lands on.
  const tabs = [tab("1", 100), tab("2", 200), tab("3", 300)];
  const activePath = C; // most recent, as the provider would have stamped it

  test("two steps through the frozen order reach the third tab", () => {
    const frozen = mruOrderedPaths(tabs, activePath);
    expect(frozen).toEqual([C, B, A]);
    expect(frozen[1]).toBe(B);
    expect(frozen[2]).toBe(A);
  });

  test("recomputing after each step would bounce between two tabs instead", () => {
    // Simulate the un-frozen behavior: step once, stamp the landed tab as most
    // recent (what the effect does), then recompute.
    const stamped = tabs.map((t) => (t.path === B ? { ...t, lastActiveAt: 400 } : t));
    const recomputed = mruOrderedPaths(stamped, B);
    expect(recomputed[1]).toBe(C); // back to where the cycle started
    expect(recomputed[1]).not.toBe(A);
  });

  test("stepping backwards through a frozen order retraces it", () => {
    const frozen = mruOrderedPaths(tabs, activePath);
    let index = 0;
    index = (index + 1) % frozen.length; // ⌃Tab
    index = (index + 1) % frozen.length; // ⌃Tab
    expect(frozen[index]).toBe(A);
    index = (index - 1 + frozen.length) % frozen.length; // ⌃⇧Tab
    expect(frozen[index]).toBe(B);
  });
});
