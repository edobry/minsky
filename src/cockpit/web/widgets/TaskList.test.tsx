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
  selectionNeedsTerminal,
  type TaskListItem,
} from "./TaskList";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(
  overrides: Partial<TaskListItem> & Pick<TaskListItem, "id" | "status">
): TaskListItem {
  return {
    title: `Task ${overrides.id}`,
    kind: "implementation",
    tags: [],
    parentId: null,
    project: null,
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
    const items = [task({ id: "mt#1", status: "TODO" }), task({ id: "mt#2", status: "IN-REVIEW" })];
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

interface StubProject {
  id: string;
  slug: string;
  displayName: string | null;
}

/**
 * `projects` defaults to `[]` — an empty list keeps the selector hidden and
 * selectedSlug at "All projects", matching this suite's pre-mt#2418
 * unscoped-fetch assertions. Tests exercising the mt#4729 project-badge
 * states pass 2+ fixtures explicitly.
 */
function stubTasks(tasks: TaskListItem[], projects: StubProject[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/task-list/data")) {
      return new Response(JSON.stringify({ state: "ok", payload: { tasks } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // ProjectProvider (mt#2418) fetches /api/projects on mount.
    if (url.includes("/api/projects")) {
      return new Response(JSON.stringify({ projects }), {
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

// ---------------------------------------------------------------------------
// Component — project badge states (mt#4729)
// ---------------------------------------------------------------------------

const MINSKY_PROJECT: StubProject = {
  id: "p-minsky",
  slug: "edobry/minsky",
  displayName: "Minsky",
};
const PEEZOMBIE_PROJECT: StubProject = {
  id: "p-peezombie",
  slug: "edobry/peezombie",
  displayName: null,
};

describe("TaskList project badge", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("renders a project badge per row when 2+ projects exist and none is selected", async () => {
    stubTasks(
      [
        task({ id: "mt#100", status: "TODO", title: "Minsky task", project: "edobry/minsky" }),
        task({
          id: "mt#200",
          status: "TODO",
          title: "Peezombie task",
          project: "edobry/peezombie",
        }),
      ],
      [MINSKY_PROJECT, PEEZOMBIE_PROJECT]
    );
    renderList();
    await waitFor(() => expect(screen.getByText("Minsky task")).toBeDefined());

    // displayName wins for Minsky; peezombie's null displayName falls back
    // to its slug (mirrors ProjectSelector's own fallback).
    expect(screen.getByText("Minsky")).toBeDefined();
    expect(screen.getByText("edobry/peezombie")).toBeDefined();
  });

  test("suppresses the project badge when only one project is known", async () => {
    stubTasks(
      [task({ id: "mt#100", status: "TODO", title: "Solo task", project: "edobry/minsky" })],
      [MINSKY_PROJECT]
    );
    renderList();
    await waitFor(() => expect(screen.getByText("Solo task")).toBeDefined());
    expect(screen.queryByText("Minsky")).toBeNull();
  });

  test("suppresses the project badge when a single project is explicitly selected", async () => {
    // Guaranteed cleanup (mt#4730 PR #3471 R2): the prior version removed this
    // key only after the assertions below, so a thrown assertion left it set
    // for the rest of the shared `bun test` process — `localStorage` is a
    // single global installed once by dom-setup.ts, not reset per file. That
    // was harmless before mt#4730's apiFetch() started default-appending the
    // CURRENT selection to every fetch; afterward it broke
    // widget-client.test.ts's exact-URL assertions in CI, where this file
    // (under widgets/) runs before lib/widget-client.test.ts. try/finally
    // guarantees the leak cannot happen regardless of assertion outcome.
    try {
      localStorage.setItem("cockpit.project.v1", "edobry/minsky");
    } catch {
      /* jsdom/happy-dom always provides localStorage; ignore if not */
    }
    try {
      stubTasks(
        [task({ id: "mt#100", status: "TODO", title: "Scoped task", project: "edobry/minsky" })],
        [MINSKY_PROJECT, PEEZOMBIE_PROJECT]
      );
      renderList();
      await waitFor(() => expect(screen.getByText("Scoped task")).toBeDefined());
      expect(screen.queryByText("Minsky")).toBeNull();
    } finally {
      try {
        localStorage.removeItem("cockpit.project.v1");
      } catch {
        /* ignore */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal-status fetch predicate (mt#4774)
//
// The DONE/CLOSED filter buttons were dead controls: the widget payload omits
// terminal statuses by default, so selecting DONE narrowed a set that could
// never contain one. This predicate is what turns a selection into the
// larger fetch; the server half is pinned in
// `src/cockpit/widgets/task-list.test.ts`.
// ---------------------------------------------------------------------------

describe("selectionNeedsTerminal (mt#4774)", () => {
  test("false for the default 'all' selection — the active-work payload stays the default", () => {
    expect(selectionNeedsTerminal("all")).toBe(false);
    expect(selectionNeedsTerminal("")).toBe(false);
  });

  test("false for any selection of only non-terminal statuses", () => {
    expect(selectionNeedsTerminal("TODO")).toBe(false);
    expect(selectionNeedsTerminal("TODO,IN-PROGRESS,BLOCKED")).toBe(false);
  });

  test("true for DONE or CLOSED, alone or mixed with active statuses", () => {
    expect(selectionNeedsTerminal("DONE")).toBe(true);
    expect(selectionNeedsTerminal("CLOSED")).toBe(true);
    expect(selectionNeedsTerminal("TODO,DONE")).toBe(true);
    expect(selectionNeedsTerminal("DONE,CLOSED")).toBe(true);
  });

  test("normalizes case and whitespace the same way the filter itself does", () => {
    // parseStatusFilter upper-cases and trims, so a URL-typed ?tl_status=done
    // must opt in too — otherwise a hand-edited deep link renders empty.
    expect(selectionNeedsTerminal("done")).toBe(true);
    expect(selectionNeedsTerminal(" DONE , TODO ")).toBe(true);
  });

  // NOT covered here, deliberately: "selecting DONE in a scope with zero DONE
  // tasks shows the empty banner rather than hanging on Loading" — the PR
  // #3530 R1 defect. Two approaches were tried and both fail at the same
  // point: this widget's status filter is URL-persisted through
  // `history.replaceState`, and under happy-dom that write is not reflected
  // back into `window.location.search`, so `useListControls` never observes
  // the change. Seeding the URL before render and clicking the real chip both
  // leave the filter at "all", which makes any assertion here vacuous — the
  // first attempt DID pass in the full suite while failing in isolation,
  // which is what a vacuous pass looks like.
  //
  // The behavior is verified in a real browser instead (recorded in the PR),
  // the same split `src/cockpit/CLAUDE.md` prescribes for anything happy-dom
  // structurally cannot observe. The defect is also gone by construction
  // rather than by re-gating: R2 deletes the suppression branch entirely, so
  // there is no state left that can fail to clear.

  test("every status the UI offers is classified — no status silently misses the opt-in", () => {
    // Guards the pair: ALL_STATUSES drives the buttons, and each one either
    // needs the larger payload or is present in the default one. A status
    // added to the UI later shows up here as a decision to make.
    const needsFetch = ALL_STATUSES.filter((s) => selectionNeedsTerminal(s));
    expect(needsFetch.sort()).toEqual(["CLOSED", "DONE"]);
  });
});
