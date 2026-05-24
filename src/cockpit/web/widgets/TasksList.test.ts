/**
 * Tests for TasksList widget logic (mt#1923)
 *
 * Tests the pure-logic helpers used by TasksList:
 *   - extractTasks: parse graph payload → flat TaskRow list
 *   - filter/sort pipeline: same pattern as useListControls.test.ts
 *
 * React rendering is not tested here (Bun doesn't ship renderHook /
 * testing-library). The filter/sort functions are exercised directly
 * as unit tests on the callback logic extracted for testability.
 */

import { describe, test, expect } from "bun:test";
import { prefixKey, applyUpdates, paginateSlice, computePageCount } from "../lib/useListControls";

// ---------------------------------------------------------------------------
// Types mirrored from TasksList.tsx (kept in sync manually)
// ---------------------------------------------------------------------------

type TaskStatus =
  | "TODO"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED"
  | "PLANNING"
  | "COMPLETED";

interface GraphNode {
  id: string;
  label: string;
  status: TaskStatus;
}

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// Inline implementation of extractTasks for testing
// (matches the implementation in TasksList.tsx)
// ---------------------------------------------------------------------------

function extractTasksFromNodes(nodes: GraphNode[]): TaskRow[] {
  return nodes.map((n) => {
    const colonIdx = n.label.indexOf(": ");
    const title = colonIdx >= 0 ? n.label.slice(colonIdx + 2) : "";
    return {
      id: n.id,
      title,
      status: n.status,
      parentId: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Inline implementations of filter / sort used by TasksList
// ---------------------------------------------------------------------------

interface TaskFilters {
  status: string;
}

function taskFilterFn(item: TaskRow, filters: TaskFilters): boolean {
  if (filters.status && item.status !== filters.status) return false;
  return true;
}

type TaskSortKey = "id" | "title" | "status";

function extractIdNum(id: string): number {
  const m = id.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function taskSortFn(a: TaskRow, b: TaskRow, key: TaskSortKey, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1;
  switch (key) {
    case "id":
      return sign * (extractIdNum(a.id) - extractIdNum(b.id));
    case "title":
      return sign * a.title.localeCompare(b.title);
    case "status":
      return sign * a.status.localeCompare(b.status);
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Sample graph nodes
// ---------------------------------------------------------------------------

const NODES: GraphNode[] = [
  { id: "mt#100", label: "mt#100: First task", status: "TODO" },
  { id: "mt#200", label: "mt#200: Second task", status: "IN-PROGRESS" },
  { id: "mt#300", label: "mt#300: Third task", status: "DONE" },
  { id: "mt#400", label: "mt#400: Blocked one", status: "BLOCKED" },
  { id: "mt#50", label: "mt#50: Early task", status: "PLANNING" },
  { id: "mt#150", label: "mt#150: Ready task", status: "READY" },
  { id: "mt#99", label: "mt#99", status: "CLOSED" }, // no title (no colon)
];

// ---------------------------------------------------------------------------
// extractTasks
// ---------------------------------------------------------------------------

describe("extractTasks", () => {
  test("extracts id, status, and title from nodes", () => {
    const rows = extractTasksFromNodes(NODES);
    expect(rows).toHaveLength(NODES.length);

    const first = rows.find((r) => r.id === "mt#100");
    expect(first?.title).toBe("First task");
    expect(first?.status).toBe("TODO");
    expect(first?.parentId).toBeNull();
  });

  test("title is empty string when no colon separator in label", () => {
    const rows = extractTasksFromNodes(NODES);
    const closed = rows.find((r) => r.id === "mt#99");
    expect(closed?.title).toBe(""); // label is just "mt#99" with no ": "
  });

  test("handles empty node list", () => {
    const rows = extractTasksFromNodes([]);
    expect(rows).toHaveLength(0);
  });

  test("preserves status values exactly", () => {
    const rows = extractTasksFromNodes(NODES);
    const statuses = rows.map((r) => r.status);
    expect(statuses).toContain("TODO");
    expect(statuses).toContain("IN-PROGRESS");
    expect(statuses).toContain("DONE");
    expect(statuses).toContain("BLOCKED");
    expect(statuses).toContain("PLANNING");
    expect(statuses).toContain("READY");
    expect(statuses).toContain("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

describe("taskFilterFn", () => {
  const tasks = extractTasksFromNodes(NODES);

  test("empty status filter passes all tasks", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "" }));
    expect(result).toHaveLength(tasks.length);
  });

  test("status=TODO returns only TODO tasks", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "TODO" }));
    expect(result.map((t) => t.id)).toEqual(["mt#100"]);
  });

  test("status=DONE returns only DONE tasks", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "DONE" }));
    expect(result.map((t) => t.id)).toEqual(["mt#300"]);
  });

  test("status=IN-PROGRESS returns in-progress tasks", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "IN-PROGRESS" }));
    expect(result.map((t) => t.id)).toEqual(["mt#200"]);
  });

  test("status=BLOCKED returns blocked tasks", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "BLOCKED" }));
    expect(result.map((t) => t.id)).toEqual(["mt#400"]);
  });

  test("filter with no match returns empty", () => {
    const result = tasks.filter((t) => taskFilterFn(t, { status: "COMPLETED" }));
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sort logic
// ---------------------------------------------------------------------------

describe("taskSortFn", () => {
  const tasks = extractTasksFromNodes(NODES);

  test("sort by id asc (numeric)", () => {
    const sorted = [...tasks].sort((a, b) => taskSortFn(a, b, "id", "asc"));
    // mt#50, mt#99, mt#100, mt#150, mt#200, mt#300, mt#400
    expect(sorted[0].id).toBe("mt#50");
    expect(sorted[1].id).toBe("mt#99");
    expect(sorted[sorted.length - 1].id).toBe("mt#400");
  });

  test("sort by id desc (numeric) — highest first", () => {
    const sorted = [...tasks].sort((a, b) => taskSortFn(a, b, "id", "desc"));
    expect(sorted[0].id).toBe("mt#400");
    expect(sorted[sorted.length - 1].id).toBe("mt#50");
  });

  test("sort by title asc", () => {
    const sorted = [...tasks].sort((a, b) => taskSortFn(a, b, "title", "asc"));
    // Empty string sorts before "B" in localeCompare
    expect(sorted[0].title).toBe(""); // mt#99 has no title
    const nonEmpty = sorted.filter((t) => t.title !== "");
    expect(nonEmpty[0].title).toBe("Blocked one");
    expect(nonEmpty[1].title).toBe("Early task");
  });

  test("sort by title desc", () => {
    const sorted = [...tasks].sort((a, b) => taskSortFn(a, b, "title", "desc"));
    expect(sorted[0].title).toBe("Third task");
  });

  test("sort by status asc", () => {
    const sorted = [...tasks].sort((a, b) => taskSortFn(a, b, "status", "asc"));
    // BLOCKED, CLOSED, DONE, IN-PROGRESS, PLANNING, READY, TODO
    expect(sorted[0].status).toBe("BLOCKED");
    expect(sorted[sorted.length - 1].status).toBe("TODO");
  });
});

// ---------------------------------------------------------------------------
// Filter + sort + paginate pipeline
// ---------------------------------------------------------------------------

describe("filter → sort → paginate pipeline for tasks", () => {
  const tasks = extractTasksFromNodes(NODES);

  function runPipeline(
    filters: TaskFilters,
    sortKey: TaskSortKey,
    sortDir: "asc" | "desc",
    page: number,
    pageSize: number
  ) {
    const filtered = tasks.filter((t) => taskFilterFn(t, filters));
    const sorted = [...filtered].sort((a, b) => taskSortFn(a, b, sortKey, sortDir));
    const pc = computePageCount(sorted.length, pageSize);
    const safePage = Math.min(page, pc);
    const pageItems = paginateSlice(sorted, safePage, pageSize);
    return { filtered, sorted, pageItems, pageCount: pc };
  }

  test("no filter, sort by id desc, page 1 of 1 (pageSize 25)", () => {
    const { filtered, sorted, pageItems, pageCount } = runPipeline(
      { status: "" },
      "id",
      "desc",
      1,
      25
    );
    expect(filtered).toHaveLength(tasks.length);
    expect(sorted[0].id).toBe("mt#400"); // highest id
    expect(pageItems).toHaveLength(tasks.length);
    expect(pageCount).toBe(1);
  });

  test("status=DONE filter + sort id asc", () => {
    const { filtered, pageItems } = runPipeline({ status: "DONE" }, "id", "asc", 1, 25);
    expect(filtered).toHaveLength(1);
    expect(pageItems[0].id).toBe("mt#300");
  });

  test("pagination: pageSize=2, page 2 of all tasks sorted by id asc", () => {
    const { pageItems, pageCount } = runPipeline({ status: "" }, "id", "asc", 2, 2);
    // sorted asc: mt#50, mt#99, mt#100, mt#150, mt#200, mt#300, mt#400
    // page 1 = [mt#50, mt#99], page 2 = [mt#100, mt#150]
    expect(pageItems[0].id).toBe("mt#100");
    expect(pageItems[1].id).toBe("mt#150");
    expect(pageCount).toBe(4); // ceil(7/2)
  });

  test("page clamped beyond pageCount", () => {
    const { pageItems } = runPipeline({ status: "TODO" }, "id", "asc", 99, 10);
    // Only one TODO task, one page
    expect(pageItems).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// URL param helpers (tk prefix for tasks namespace)
// ---------------------------------------------------------------------------

describe("tk-prefix URL params", () => {
  test("prefixKey with tk prefix creates correct param names", () => {
    expect(prefixKey("tk", "sort")).toBe("tk_sort");
    expect(prefixKey("tk", "page")).toBe("tk_page");
    expect(prefixKey("tk", "f_status")).toBe("tk_f_status");
  });

  test("applyUpdates with tk-prefixed keys", () => {
    const result = applyUpdates(new URLSearchParams(""), {
      [prefixKey("tk", "sort")]: "id",
      [prefixKey("tk", "dir")]: "desc",
      [prefixKey("tk", "f_status")]: "TODO",
    });
    expect(result.get("tk_sort")).toBe("id");
    expect(result.get("tk_dir")).toBe("desc");
    expect(result.get("tk_f_status")).toBe("TODO");
  });

  test("clearing tk-prefixed filter removes param", () => {
    const base = new URLSearchParams("tk_f_status=TODO&tk_sort=id");
    const result = applyUpdates(base, { [prefixKey("tk", "f_status")]: null });
    expect(result.has("tk_f_status")).toBe(false);
    expect(result.get("tk_sort")).toBe("id");
  });
});
