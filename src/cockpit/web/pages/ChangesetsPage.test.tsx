/**
 * ChangesetsPage tests (mt#1920).
 *
 * Verifies the /changesets list route component:
 *   - List state: renders rows for each active changeset.
 *   - Empty state: renders a graceful empty state when no changesets exist.
 *   - Error state: renders an error message when the fetch fails.
 *   - Loading state: renders a loading placeholder before data arrives.
 *   - Row navigation: clicking a row navigates to /changeset/:prNumber.
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/ChangesetsPage.test.tsx
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ChangesetsPage } from "./ChangesetsPage";
import type { ChangesetsListResponse } from "../widgets/Changesets";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Captures the current location path for navigation assertions. */
function LocationCapture({ onLocation }: { onLocation: (path: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname);
  return null;
}

/**
 * Render ChangesetsPage at /changesets.
 * Accepts an optional location callback to capture navigation outcomes.
 */
function renderChangesetsPage(onLocation?: (path: string) => void) {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={["/changesets"]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/changesets" element={<ChangesetsPage />} />
          {/* Catch-all so navigate("/changeset/:id") doesn't 404 in tests */}
          <Route path="/changeset/:id" element={<div data-testid="changeset-detail" />} />
        </Routes>
        {onLocation && <LocationCapture onLocation={onLocation} />}
      </QueryClientProvider>
    </MemoryRouter>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const OPEN_CHANGESET = {
  pr: {
    number: 42,
    url: "https://github.com/edobry/minsky/pull/42",
    state: "open",
    title: "feat(mt#1920): changesets list page",
    headBranch: "task/mt-1920",
    approved: false,
  },
  session: {
    sessionId: "aaa11111-0000-0000-0000-000000000001",
    taskId: "mt#1920",
    taskTitle: "Changesets list page",
    status: "IN-PROGRESS",
    liveness: "healthy" as const,
    agentId: "cockpit-dev",
    branch: "task/mt-1920",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 600_000).toISOString(),
    lastCommitHash: "abc1234",
    lastCommitMessage: "feat: add changeset list",
    commitCount: 2,
  },
};

const DRAFT_CHANGESET = {
  pr: {
    number: 99,
    url: "https://github.com/edobry/minsky/pull/99",
    state: "draft",
    title: "wip(mt#9999): draft changeset",
    headBranch: "task/mt-9999",
    approved: null,
  },
  session: {
    sessionId: "bbb22222-0000-0000-0000-000000000002",
    taskId: "mt#9999",
    taskTitle: "Draft task",
    status: "IN-PROGRESS",
    liveness: "healthy" as const,
    agentId: "cockpit-dev",
    branch: "task/mt-9999",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
    lastCommitHash: "def5678",
    lastCommitMessage: "wip: stub",
    commitCount: 1,
  },
};

const LIST_PAYLOAD: ChangesetsListResponse = {
  changesets: [OPEN_CHANGESET, DRAFT_CHANGESET],
};

const EMPTY_PAYLOAD: ChangesetsListResponse = { changesets: [] };

// ---------------------------------------------------------------------------
// Fetch mocks
// ---------------------------------------------------------------------------

function mockChangesetsFetch(response: { status: number; body: unknown }) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/changesets") {
      return Promise.resolve(
        new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

function mockChangesetsFetchError(errorMessage: string) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/changesets") {
      return Promise.reject(new Error(errorMessage));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests: list state
// ---------------------------------------------------------------------------

describe("ChangesetsPage — list state", () => {
  test("renders a row for each changeset", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText("feat(mt#1920): changesets list page")).toBeDefined();
      expect(screen.getByText("wip(mt#9999): draft changeset")).toBeDefined();
    });
  });

  test("renders PR numbers for each row", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText("#42")).toBeDefined();
      expect(screen.getByText("#99")).toBeDefined();
    });
  });

  test("renders state chips for each row", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeDefined();
      expect(screen.getByText("Draft")).toBeDefined();
    });
  });

  test("renders task ids for rows that have them", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText("mt#1920")).toBeDefined();
    });
  });

  test("renders GitHub link-out as secondary affordance", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      const links = screen.getAllByRole("link", { name: /view on github/i });
      expect(links.length).toBe(2);
      const hrefs = links.map((l) => (l as HTMLAnchorElement).href);
      expect(hrefs.some((h) => h.includes("/pull/42"))).toBe(true);
      expect(hrefs.some((h) => h.includes("/pull/99"))).toBe(true);
      // All link-outs must open in new tab
      expect(links.every((l) => (l as HTMLAnchorElement).target === "_blank")).toBe(true);
    });
  });

  test("renders the page heading with active count", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText("Changesets")).toBeDefined();
      expect(screen.getByText(/2 active/)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: row navigation to /changeset/:id
// ---------------------------------------------------------------------------

describe("ChangesetsPage — row navigation", () => {
  test("clicking a row navigates to /changeset/:prNumber", async () => {
    mockChangesetsFetch({ status: 200, body: LIST_PAYLOAD });
    let capturedPath = "/changesets";
    renderChangesetsPage((path) => {
      capturedPath = path;
    });

    await waitFor(() => {
      expect(screen.getByText("feat(mt#1920): changesets list page")).toBeDefined();
    });

    // Click the row button (not the GitHub link)
    const buttons = screen.getAllByRole("button");
    const rowButton = buttons.find((b) =>
      b.textContent?.includes("feat(mt#1920): changesets list page")
    );
    expect(rowButton).toBeDefined();
    fireEvent.click(rowButton!);

    await waitFor(() => {
      expect(capturedPath).toBe("/changeset/42");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: empty state
// ---------------------------------------------------------------------------

describe("ChangesetsPage — empty state", () => {
  test("renders empty state when there are no changesets", async () => {
    mockChangesetsFetch({ status: 200, body: EMPTY_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText(/no active changesets/i)).toBeDefined();
    });
  });

  test("empty state does not show a row count", async () => {
    mockChangesetsFetch({ status: 200, body: EMPTY_PAYLOAD });
    renderChangesetsPage();
    await waitFor(() => {
      // The heading "Changesets" is present but no count badge
      expect(screen.getByText("Changesets")).toBeDefined();
      expect(screen.queryByText(/active/)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: error state
// ---------------------------------------------------------------------------

describe("ChangesetsPage — error state", () => {
  test("renders error message when fetch returns 500", async () => {
    mockChangesetsFetch({ status: 500, body: { error: "Internal server error" } });
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText(/failed to load changesets/i)).toBeDefined();
    });
  });

  test("renders error message when fetch rejects", async () => {
    mockChangesetsFetchError("Network error");
    renderChangesetsPage();
    await waitFor(() => {
      expect(screen.getByText(/failed to load changesets/i)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: loading state
// ---------------------------------------------------------------------------

describe("ChangesetsPage — loading state", () => {
  test("renders loading placeholder before data arrives", () => {
    // Fetch hangs — query stays in pending state
    globalThis.fetch = mock(() => new Promise(() => {})) as typeof globalThis.fetch;
    renderChangesetsPage();
    expect(screen.getByText(/loading changesets/i)).toBeDefined();
  });
});
