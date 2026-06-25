/**
 * ChangesetDetailPage tests (mt#2535).
 *
 * Verifies the /changeset/:id detail route component:
 *   - Found state: renders PR title, state chip, linked task, and head branch.
 *   - Error state: renders an error message when the fetch fails.
 *   - Loading/pending state: renders a loading placeholder.
 *   - Empty/not-found state: renders a graceful empty state (404 from server).
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/ChangesetDetailPage.test.tsx
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ChangesetDetailPage } from "./ChangesetDetailPage";
import type { ChangesetDetailPayload } from "../widgets/ChangesetDetail";

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

/**
 * Render ChangesetDetailPage at the given changesetId (URL param).
 * Wraps in MemoryRouter at /changeset/:id and provides a QueryClient.
 */
function renderChangesetPage(changesetId: string) {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/changeset/${changesetId}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/changeset/:id" element={<ChangesetDetailPage />} />
        </Routes>
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

const FOUND_PAYLOAD: ChangesetDetailPayload = {
  pr: {
    number: 1234,
    url: "https://github.com/edobry/minsky/pull/1234",
    state: "open",
    title: "feat(mt#2535): changeset detail route",
    headBranch: "task/mt-2535",
    approved: false,
  },
  session: {
    sessionId: "abc12345-1234-1234-1234-abc123456789",
    taskId: "mt#2535",
    taskTitle: "Changeset detail page",
    status: "IN-PROGRESS",
    liveness: "healthy",
    agentId: "cockpit-dev",
    branch: "task/mt-2535",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 300_000).toISOString(),
    lastCommitHash: "abc1234",
    lastCommitMessage: "feat: initial implementation",
    commitCount: 3,
  },
  commits: [
    {
      hash: "abc1234abc1234abc1234abc1234abc1234abc1234",
      shortHash: "abc1234",
      date: new Date(Date.now() - 300_000).toISOString(),
      subject: "feat(mt#2535): partial: add changeset detail widget",
      url: "https://github.com/edobry/minsky/commit/abc1234abc1234abc1234abc1234abc1234abc1234",
    },
  ],
};

// ---------------------------------------------------------------------------
// Fetch mocks
// ---------------------------------------------------------------------------

function mockChangesetFetch(
  id: string,
  response: { status: number; body: unknown }
) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === `/api/changeset/${id}`) {
      if (response.status === 200) {
        return Promise.resolve(
          new Response(JSON.stringify(response.body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
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

function mockChangesetFetchError(id: string, errorMessage: string) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === `/api/changeset/${id}`) {
      return Promise.reject(new Error(errorMessage));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests: found state
// ---------------------------------------------------------------------------

describe("ChangesetDetailPage — found state", () => {
  test("renders the PR title", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("feat(mt#2535): changeset detail route")).toBeDefined();
    });
  });

  test("renders the PR number", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("#1234")).toBeDefined();
    });
  });

  test("renders the PR state chip", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeDefined();
    });
  });

  test("renders the linked task as an in-SPA link", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      const taskLink = screen.getByText("mt#2535");
      expect(taskLink).toBeDefined();
    });
  });

  test("renders the head branch", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("task/mt-2535")).toBeDefined();
    });
  });

  test("renders recent commits", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(
        screen.getByText("feat(mt#2535): partial: add changeset detail widget")
      ).toBeDefined();
    });
  });

  test("renders external GitHub link as secondary affordance", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /view on github/i });
      expect(link).toBeDefined();
      expect((link as HTMLAnchorElement).href).toContain("/pull/1234");
      // External link opens in new tab — not a redirect
      expect((link as HTMLAnchorElement).target).toBe("_blank");
    });
  });

  test("renders the breadcrumb with changeset id", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    // Breadcrumb renders immediately (not data-dependent)
    const nav = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(nav).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: error state
// ---------------------------------------------------------------------------

describe("ChangesetDetailPage — error state", () => {
  test("renders error message when fetch returns 500", async () => {
    mockChangesetFetch("999", {
      status: 500,
      body: { error: "Internal server error" },
    });
    renderChangesetPage("999");
    await waitFor(() => {
      const el = screen.getByText(/failed to load changeset/i);
      expect(el).toBeDefined();
    });
  });

  test("renders error message when fetch rejects", async () => {
    mockChangesetFetchError("999", "Network error");
    renderChangesetPage("999");
    await waitFor(() => {
      const el = screen.getByText(/failed to load changeset/i);
      expect(el).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: empty / not-found state
// ---------------------------------------------------------------------------

describe("ChangesetDetailPage — not-found / empty state", () => {
  test("renders empty state when server returns 404", async () => {
    mockChangesetFetch("0", {
      status: 404,
      body: { error: "No session found for changeset 0" },
    });
    renderChangesetPage("0");
    await waitFor(() => {
      expect(screen.getByText(/changeset not found/i)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: loading state
// ---------------------------------------------------------------------------

describe("ChangesetDetailPage — loading / pending state", () => {
  test("renders loading placeholder before data arrives", () => {
    // Fetch hangs — query stays in pending state
    globalThis.fetch = mock(() => new Promise(() => {})) as typeof globalThis.fetch;
    renderChangesetPage("1234");
    // Pending state message is present synchronously (before any microtask)
    expect(screen.getByText(/loading changeset/i)).toBeDefined();
  });
});
