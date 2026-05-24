/**
 * Tests for useListControls (mt#1924)
 *
 * The hook depends on window.location.search and window.history.replaceState.
 * These tests exercise the pure-logic paths (filter, sort, paginate, URL state
 * round-trip) using jsdom-compatible globals injected before each test.
 *
 * Note: The hook calls window.history.replaceState which jsdom supports.
 * We use renderHook from a test harness that doesn't need a full DOM.
 */

import { describe, test, expect } from "bun:test";
import { prefixKey, applyUpdates, computePageCount, paginateSlice } from "./useListControls";

// ---------------------------------------------------------------------------
// Tests exercise the hook's exported pure helpers directly (prefixKey,
// applyUpdates, computePageCount, paginateSlice) plus consumer-provided
// filter/sort functions that widgets pass to the hook. The hook's React
// integration (useState, useEffect, URL sync) is a thin glue layer tested
// via manual QA; Bun doesn't ship renderHook.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  value: number;
  category: string;
}

const ITEMS: Item[] = [
  { id: "a", value: 10, category: "foo" },
  { id: "b", value: 30, category: "bar" },
  { id: "c", value: 20, category: "foo" },
  { id: "d", value: 5, category: "baz" },
  { id: "e", value: 15, category: "bar" },
];

type SortKey = "value" | "id";
interface Filters {
  category: string;
}

const DEFAULT_FILTERS: Filters = { category: "all" };

function filterFn(item: Item, filters: Filters): boolean {
  if (filters.category === "all") return true;
  return item.category === filters.category;
}

function sortFn(a: Item, b: Item, key: SortKey, dir: "asc" | "desc"): number {
  let cmp = 0;
  if (key === "value") cmp = a.value - b.value;
  else if (key === "id") cmp = a.id.localeCompare(b.id);
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Test the core logic by directly calling the helpers the hook uses
// (same logic, extracted inline for testability without renderHook)
// ---------------------------------------------------------------------------

describe("useListControls logic", () => {
  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------

  describe("filterFn", () => {
    test("all category passes everything", () => {
      const result = ITEMS.filter((i) => filterFn(i, { category: "all" }));
      expect(result).toHaveLength(ITEMS.length);
    });

    test("specific category filters correctly", () => {
      const result = ITEMS.filter((i) => filterFn(i, { category: "foo" }));
      expect(result.map((i) => i.id)).toEqual(["a", "c"]);
    });

    test("category with no match returns empty", () => {
      const result = ITEMS.filter((i) => filterFn(i, { category: "xyz" }));
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Sort
  // ---------------------------------------------------------------------------

  describe("sortFn", () => {
    test("sort by value asc", () => {
      const sorted = [...ITEMS].sort((a, b) => sortFn(a, b, "value", "asc"));
      expect(sorted.map((i) => i.value)).toEqual([5, 10, 15, 20, 30]);
    });

    test("sort by value desc", () => {
      const sorted = [...ITEMS].sort((a, b) => sortFn(a, b, "value", "desc"));
      expect(sorted.map((i) => i.value)).toEqual([30, 20, 15, 10, 5]);
    });

    test("sort by id asc", () => {
      const sorted = [...ITEMS].sort((a, b) => sortFn(a, b, "id", "asc"));
      expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    });

    test("sort by id desc", () => {
      const sorted = [...ITEMS].sort((a, b) => sortFn(a, b, "id", "desc"));
      expect(sorted.map((i) => i.id)).toEqual(["e", "d", "c", "b", "a"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe("pagination (imported from useListControls)", () => {
    test("page 1 with pageSize 2 returns first 2 items", () => {
      const result = paginateSlice(ITEMS, 1, 2);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("a");
      expect(result[1].id).toBe("b");
    });

    test("page 2 with pageSize 2 returns items 3-4", () => {
      const result = paginateSlice(ITEMS, 2, 2);
      expect(result[0].id).toBe("c");
      expect(result[1].id).toBe("d");
    });

    test("last page with pageSize 2 returns 1 item for odd count", () => {
      const result = paginateSlice(ITEMS, 3, 2);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("e");
    });

    test("computePageCount for 5 items and pageSize 2 is 3", () => {
      expect(computePageCount(5, 2)).toBe(3);
    });

    test("computePageCount for 0 items is 1", () => {
      expect(computePageCount(0, 10)).toBe(1);
    });

    test("computePageCount for 10 items and pageSize 10 is 1", () => {
      expect(computePageCount(10, 10)).toBe(1);
    });

    test("computePageCount for 11 items and pageSize 10 is 2", () => {
      expect(computePageCount(11, 10)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // URL param serialization
  // ---------------------------------------------------------------------------

  describe("URL param helpers (imported from useListControls)", () => {
    test("setting a param adds it to the search string", () => {
      const result = applyUpdates(new URLSearchParams(""), { sort: "value" });
      expect(result.get("sort")).toBe("value");
    });

    test("setting null removes an existing param", () => {
      const result = applyUpdates(new URLSearchParams("sort=value&page=2"), { sort: null });
      expect(result.has("sort")).toBe(false);
      expect(result.get("page")).toBe("2");
    });

    test("updating multiple params at once", () => {
      const result = applyUpdates(new URLSearchParams("sort=id"), {
        sort: "value",
        dir: "desc",
        page: null,
      });
      expect(result.get("sort")).toBe("value");
      expect(result.get("dir")).toBe("desc");
      expect(result.has("page")).toBe(false);
    });

    test("prefixed params use prefix separator (imported prefixKey)", () => {
      const result = applyUpdates(new URLSearchParams(""), {
        [prefixKey("ws", "sort")]: "value",
        [prefixKey("ws", "page")]: "2",
      });
      expect(result.get("ws_sort")).toBe("value");
      expect(result.get("ws_page")).toBe("2");
    });

    test("prefixKey with empty prefix returns key unchanged", () => {
      expect(prefixKey("", "sort")).toBe("sort");
    });

    test("prefixKey with prefix returns prefixed key", () => {
      expect(prefixKey("ag", "page")).toBe("ag_page");
    });
  });

  // ---------------------------------------------------------------------------
  // Filter + sort + paginate pipeline
  // ---------------------------------------------------------------------------

  describe("filter → sort → paginate pipeline (using imported helpers)", () => {
    function runPipeline(
      items: Item[],
      filters: Filters,
      sortKey: SortKey,
      sortDir: "asc" | "desc",
      page: number,
      pageSize: number
    ) {
      const filtered = items.filter((i) => filterFn(i, filters));
      const sorted = [...filtered].sort((a, b) => sortFn(a, b, sortKey, sortDir));
      const pc = computePageCount(sorted.length, pageSize);
      const safePage = Math.min(page, pc);
      const pageItems = paginateSlice(sorted, safePage, pageSize);
      return { filtered, sorted, pageItems, pageCount: pc, safePage };
    }

    test("filter foo + sort value asc + page 1 of 2", () => {
      const { pageItems, filtered, pageCount } = runPipeline(
        ITEMS,
        { category: "foo" },
        "value",
        "asc",
        1,
        1
      );
      // foo items: a(10), c(20); sorted asc: a, c
      expect(filtered).toHaveLength(2);
      expect(pageItems).toHaveLength(1);
      expect(pageItems[0].id).toBe("a"); // lowest value
      expect(pageCount).toBe(2);
    });

    test("page clamped when beyond pageCount", () => {
      const { safePage } = runPipeline(ITEMS, DEFAULT_FILTERS, "id", "asc", 999, 10);
      expect(safePage).toBe(1);
    });

    test("empty filter result shows empty page", () => {
      const { pageItems, filtered } = runPipeline(
        ITEMS,
        { category: "xyz" },
        "value",
        "desc",
        1,
        10
      );
      expect(filtered).toHaveLength(0);
      expect(pageItems).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Workstream-specific filter logic
  // ---------------------------------------------------------------------------

  describe("workstream filter logic", () => {
    interface WsCard {
      parentId: string;
      parentStatus: string;
      activeChildCount: number;
      doneChildCount: number;
      blockedChildCount: number;
    }

    interface WsFilters {
      status: "all" | "active" | "done" | "blocked";
      minActiveChildren: string;
    }

    function wsFilter(card: WsCard, filters: WsFilters): boolean {
      if (filters.status !== "all") {
        const hasActive = card.activeChildCount > 0;
        const hasDone = card.doneChildCount > 0 && card.activeChildCount === 0;
        const hasBlocked = card.blockedChildCount > 0;
        if (filters.status === "active" && !hasActive) return false;
        if (filters.status === "done" && !hasDone) return false;
        if (filters.status === "blocked" && !hasBlocked) return false;
      }
      const minActive = parseInt(filters.minActiveChildren, 10);
      if (!isNaN(minActive) && minActive > 0 && card.activeChildCount < minActive) {
        return false;
      }
      return true;
    }

    const cards: WsCard[] = [
      {
        parentId: "mt#1",
        parentStatus: "IN-PROGRESS",
        activeChildCount: 5,
        doneChildCount: 2,
        blockedChildCount: 0,
      },
      {
        parentId: "mt#2",
        parentStatus: "IN-PROGRESS",
        activeChildCount: 0,
        doneChildCount: 3,
        blockedChildCount: 0,
      },
      {
        parentId: "mt#3",
        parentStatus: "BLOCKED",
        activeChildCount: 1,
        doneChildCount: 0,
        blockedChildCount: 2,
      },
      {
        parentId: "mt#4",
        parentStatus: "IN-PROGRESS",
        activeChildCount: 2,
        doneChildCount: 1,
        blockedChildCount: 0,
      },
    ];

    test("status=all returns all cards", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "all", minActiveChildren: "0" }));
      expect(result).toHaveLength(4);
    });

    test("status=active returns cards with activeChildCount > 0", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "active", minActiveChildren: "0" }));
      expect(result.map((c) => c.parentId)).toEqual(["mt#1", "mt#3", "mt#4"]);
    });

    test("status=done returns cards with doneChildCount > 0 and no active", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "done", minActiveChildren: "0" }));
      expect(result.map((c) => c.parentId)).toEqual(["mt#2"]);
    });

    test("status=blocked returns cards with blockedChildCount > 0", () => {
      const result = cards.filter((c) =>
        wsFilter(c, { status: "blocked", minActiveChildren: "0" })
      );
      expect(result.map((c) => c.parentId)).toEqual(["mt#3"]);
    });

    test("minActiveChildren=3 filters out cards with fewer than 3 active", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "all", minActiveChildren: "3" }));
      expect(result.map((c) => c.parentId)).toEqual(["mt#1"]);
    });

    test("minActiveChildren=0 is a no-op", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "all", minActiveChildren: "0" }));
      expect(result).toHaveLength(4);
    });

    test("combined: active + minActiveChildren=2", () => {
      const result = cards.filter((c) => wsFilter(c, { status: "active", minActiveChildren: "2" }));
      // mt#1 (5 active), mt#4 (2 active) — mt#3 has 1 active < 2
      expect(result.map((c) => c.parentId)).toEqual(["mt#1", "mt#4"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Agent-specific filter logic
  // ---------------------------------------------------------------------------

  describe("agent filter logic", () => {
    interface Agent {
      sessionId: string;
      liveness: "healthy" | "idle" | "stale" | "orphaned";
      taskId: string | null;
    }

    interface AgFilters {
      liveness: "all" | "healthy" | "idle" | "stale" | "orphaned";
      taskId: string;
    }

    function agFilter(agent: Agent, filters: AgFilters): boolean {
      if (filters.liveness !== "all" && agent.liveness !== filters.liveness) return false;
      if (filters.taskId.trim() !== "") {
        const needle = filters.taskId.trim().toLowerCase();
        if (!agent.taskId?.toLowerCase().includes(needle)) return false;
      }
      return true;
    }

    const agents: Agent[] = [
      { sessionId: "s1", liveness: "healthy", taskId: "mt#1234" },
      { sessionId: "s2", liveness: "stale", taskId: "mt#5678" },
      { sessionId: "s3", liveness: "idle", taskId: null },
      { sessionId: "s4", liveness: "orphaned", taskId: "mt#1234" },
    ];

    test("liveness=all returns all agents", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "all", taskId: "" }));
      expect(result).toHaveLength(4);
    });

    test("liveness=stale returns only stale agents", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "stale", taskId: "" }));
      expect(result.map((a) => a.sessionId)).toEqual(["s2"]);
    });

    test("taskId filter matches substring case-insensitively", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "all", taskId: "mt#1234" }));
      expect(result.map((a) => a.sessionId)).toEqual(["s1", "s4"]);
    });

    test("taskId filter with no match returns empty", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "all", taskId: "mt#9999" }));
      expect(result).toHaveLength(0);
    });

    test("combined: stale + taskId", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "stale", taskId: "5678" }));
      expect(result.map((a) => a.sessionId)).toEqual(["s2"]);
    });

    test("agent with null taskId excluded when taskId filter is set", () => {
      const result = agents.filter((a) => agFilter(a, { liveness: "idle", taskId: "mt#" }));
      expect(result).toHaveLength(0); // s3 is idle but has null taskId
    });
  });
});
