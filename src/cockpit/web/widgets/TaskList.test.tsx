/**
 * Tests for the TaskList widget's tasks-page pass (mt#2919).
 *
 * Pure coverage: supervision-loop status priority ordering, the COMPLETED
 * retirement (ALL_STATUSES no longer lists it; taskSortFn no longer
 * special-cases it). Component coverage: default-render foregrounds the
 * active working set above the TODO/DONE/CLOSED tail, and no COMPLETED
 * filter pill is rendered.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProvider } from "../lib/project-context";
import {
  TaskList,
  ALL_STATUSES,
  STATUS_SORT_PRIORITY,
  statusPriority,
  taskSortFn,
  type TaskListItem,
} from "./TaskList";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(overrides: Partial<TaskListItem> & Pick<TaskListItem, "id" | "status">): TaskListItem {
  return {
    title: `Task ${overrides.id}`,
    kind: "implementation",
    tags: [],
    parentId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("ALL_STATUSES", () => {
  test("does not list the retired COMPLETED status", () => {
    expect(ALL_STATUSES).not.toContain("COMPLETED");
  });

  test("lists exactly the canonical state machine's 8 statuses", () => {
    expect([...ALL_STATUSES].sort()).toEqual(
      ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED", "CLOSED"].sort()
    );
  });
});

describe("statusPriority", () => {
  test("ranks the active supervision loop above READY above the backlog above the settled tail", () => {
    expect(statusPriority("IN-REVIEW")).toBeLessThan(statusPriority("BLOCKED"));
    expect(statusPriority("BLOCKED")).toBeLessThan(statusPriority("IN-PROGRESS"));
    expect(statusPriority("IN-PROGRESS")).toBeLessThan(statusPriority("READY"));
    expect(statusPriority("READY")).toBeLessThan(statusPriority("PLANNING"));
    expect(statusPriority("PLANNING")).toBeLessThan(statusPriority("TODO"));
    expect(statusPriority("TODO")).toBeLessThan(statusPriority("DONE"));
    expect(statusPriority("DONE")).toBeLessThan(statusPriority("CLOSED"));
  });

  test("is case-insensitive", () => {
    expect(statusPriority("in-review")).toBe(statusPriority("IN-REVIEW"));
  });

  test("falls back to TODO's priority for an unrecognized status (e.g. the retired COMPLETED)", () => {
    expect(statusPriority("COMPLETED")).toBe(statusPriority("TODO"));
    expect(statusPriority("SOME-UNKNOWN-STATUS")).toBe(statusPriority("TODO"));
  });

  test("covers every key in STATUS_SORT_PRIORITY with a distinct rank", () => {
    const ranks = Object.values(STATUS_SORT_PRIORITY);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("taskSortFn", () => {
  test("status key sorts by supervision priority, not alphabetically", () => {
    const items = [
      task({ id: "mt#1", status: "TODO" }),
      task({ id: "mt#2", status: "IN-REVIEW" }),
      task({ id: "mt#3", status: "DONE" }),
      task({ id: "mt#4", status: "BLOCKED" }),
    ];
    const sorted = [...items].sort((a, b) => taskSortFn(a, b, "status", "asc"));
    expect(sorted.map((t) => t.status)).toEqual(["IN-REVIEW", "BLOCKED", "TODO", "DONE"]);
  });

  test("status key descending reverses the priority order", () => {
    const items = [
      task({ id: "mt#1", status: "TODO" }),
      task({ id: "mt#2", status: "IN-REVIEW" }),
    ];
    const sorted = [...items].sort((a, b) => taskSortFn(a, b, "status", "desc"));
    expect(sorted.map((t) => t.status)).toEqual(["TODO", "IN-REVIEW"]);
  });

  test("id key still sorts numerically (unaffected by the status-priority change)", () => {
    const items = [
      task({ id: "mt#20", status: "TODO" }),
      task({ id: "mt#3", status: "TODO" }),
      task({ id: "mt#100", status: "TODO" }),
    ];
    const sorted = [...items].sort((a, b) => taskSortFn(a, b, "id", "asc"));
    expect(sorted.map((t) => t.id)).toEqual(["mt#3", "mt#20", "mt#100"]);
  });
});

// ---------------------------------------------------------------------------
// Component — default view foregrounds the active working set
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function stubTasks(tasks: TaskListItem[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/task-list/data")) {
      return new Response(JSON.stringify({ state: "ok", payload: { tasks } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // ProjectProvider (mt#2418) fetches /api/projects on mount — an empty
    // list keeps the selector hidden and selectedSlug at "All projects",
    // matching this suite's pre-mt#2418 unscoped-fetch assertions.
    if (url.includes("/api/projects")) {
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectProvider>
          <TaskList />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskList component", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("default view renders the active working set above the TODO/DONE tail", async () => {
    stubTasks([
      task({ id: "mt#100", status: "TODO", title: "Backlog item" }),
      task({ id: "mt#200", status: "DONE", title: "Settled item" }),
      task({ id: "mt#300", status: "IN-REVIEW", title: "Needs review" }),
      task({ id: "mt#400", status: "BLOCKED", title: "Needs unblocking" }),
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText("Needs review")).toBeDefined());

    const rowTitles = screen
      .getAllByText(/Backlog item|Settled item|Needs review|Needs unblocking/)
      .map((el) => el.textContent);
    expect(rowTitles).toEqual(["Needs review", "Needs unblocking", "Backlog item", "Settled item"]);
  });

  test("does not render a COMPLETED filter pill", async () => {
    stubTasks([task({ id: "mt#100", status: "TODO" })]);
    renderList();
    await waitFor(() => expect(screen.getByText("Task mt#100")).toBeDefined());
    expect(screen.queryByLabelText("Filter by COMPLETED")).toBeNull();
  });
});
