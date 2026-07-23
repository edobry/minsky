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
    shortId: "ws#42",
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
  detail: {
    body: "This PR adds the changeset detail route.",
    author: "minsky-ai[bot]",
    additions: 66,
    deletions: 8,
    changedFiles: 2,
    mergedAt: null,
    mergedBy: null,
    reviewCount: 1,
  },
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
  }) as unknown as typeof globalThis.fetch;
}

function mockChangesetFetchError(id: string, errorMessage: string) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === `/api/changeset/${id}`) {
      return Promise.reject(new Error(errorMessage));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
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

  test("renders external GitHub link as a primary affordance", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /open on github/i });
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

  // R1 fix (mt#2535): non-numeric ids get a 400 from the server, which the
  // client fetcher throws as an Error — so the ERROR state fires, not not-found.
  test("renders ERROR state (not not-found) when server returns 400 for non-numeric id", async () => {
    // The client encodes the id in the URL; the mock matches on the encoded path.
    const nonNumericId = "abc";
    mockChangesetFetch(nonNumericId, {
      status: 400,
      body: { error: "Invalid changeset id: expected a PR number" },
    });
    renderChangesetPage(nonNumericId);
    await waitFor(() => {
      // Must show the ERROR branch, not the not-found branch.
      expect(screen.getByText(/failed to load changeset/i)).toBeDefined();
    });
    // Confirm the not-found text is NOT rendered.
    const notFound = screen.queryByText(/changeset not found/i);
    expect(notFound).toBeNull();
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
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
    renderChangesetPage("1234");
    // Pending state message is present synchronously (before any microtask)
    expect(screen.getByText(/loading changeset/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: mt#3096 — live-PR sourcing, title fallback, honest degradation
// ---------------------------------------------------------------------------

describe("ChangesetDetailPage — live PR sourcing (mt#3096)", () => {
  test("renders the PR description from the live payload", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText(/adds the changeset detail route/i)).toBeDefined();
    });
  });

  test("renders the diffstat from the live payload", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("+66")).toBeDefined();
      expect(screen.getByText(/2 files/)).toBeDefined();
    });
  });

  test("renders the author from the live payload", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("minsky-ai[bot]")).toBeDefined();
    });
  });

  /**
   * The originating bug: a null PR title rendered as the literal "(no title)"
   * even though the row this page is reached from already fell back to the
   * task title. Both surfaces now share `changesetDisplayTitle`.
   */
  test("falls back to the task title instead of rendering a placeholder", async () => {
    const noTitlePayload: ChangesetDetailPayload = {
      ...FOUND_PAYLOAD,
      pr: { ...FOUND_PAYLOAD.pr, title: null },
    };
    mockChangesetFetch("1234", { status: 200, body: noTitlePayload });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("Changeset detail page")).toBeDefined();
    });
    expect(screen.queryByText(/\(no title\)/i)).toBeNull();
  });

  test("falls back to the branch when neither PR title nor task title exists", async () => {
    const barePayload: ChangesetDetailPayload = {
      ...FOUND_PAYLOAD,
      pr: { ...FOUND_PAYLOAD.pr, title: null },
      session: { ...FOUND_PAYLOAD.session!, taskTitle: null, taskId: null },
    };
    mockChangesetFetch("1234", { status: 200, body: barePayload });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getAllByText("task/mt-2535").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/\(no title\)/i)).toBeNull();
  });

  /**
   * A merged PR whose session was cleaned up: `session` is null. The page must
   * still render from live PR data rather than 404ing or crashing.
   */
  test("renders a merged PR that has no Minsky session", async () => {
    const mergedNoSession: ChangesetDetailPayload = {
      pr: {
        number: 2222,
        url: "https://github.com/edobry/minsky/pull/2222",
        state: "merged",
        title: "feat(mt#3055): check-premise cue",
        headBranch: "task/mt-3055",
        approved: null,
      },
      session: null,
      commits: [],
      detail: {
        body: null,
        author: "minsky-ai[bot]",
        additions: 66,
        deletions: 8,
        changedFiles: 2,
        mergedAt: new Date(Date.now() - 600_000).toISOString(),
        mergedBy: "edobry",
        reviewCount: 0,
      },
    };
    mockChangesetFetch("2222", { status: 200, body: mergedNoSession });
    renderChangesetPage("2222");
    await waitFor(() => {
      expect(screen.getByText("feat(mt#3055): check-premise cue")).toBeDefined();
    });
    expect(screen.getByText("Merged")).toBeDefined();
    expect(screen.getByText("edobry")).toBeDefined();
  });

  /**
   * Honest degradation: when the live fetch failed the page says so, rather
   * than presenting a stale snapshot as if it were current.
   */
  test("shows a degraded notice when live PR data is unavailable", async () => {
    const degraded: ChangesetDetailPayload = { ...FOUND_PAYLOAD, detail: null };
    mockChangesetFetch("1234", { status: 200, body: degraded });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText(/live pull-request data unavailable/i)).toBeDefined();
    });
  });

  test("does not show the degraded notice when live data is present", async () => {
    mockChangesetFetch("1234", { status: 200, body: FOUND_PAYLOAD });
    renderChangesetPage("1234");
    await waitFor(() => {
      expect(screen.getByText("feat(mt#2535): changeset detail route")).toBeDefined();
    });
    expect(screen.queryByText(/live pull-request data unavailable/i)).toBeNull();
  });
});