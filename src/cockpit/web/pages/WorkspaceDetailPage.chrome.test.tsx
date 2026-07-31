/**
 * Pinned run-detail chrome on the WORKSPACE host (mt#3344, SC6).
 *
 * The sibling of `ConversationPage.chrome.test.tsx`. `RunDetail` is shared by
 * both hosts but they pass DIFFERENT chrome into it — a label header on
 * `/conversation/:id`, a breadcrumb on `/agents/:id` — so pinning the one does
 * not prove the other pins. Before this file the workspace host had no
 * structural coverage at all (PR #2425 reviewer note).
 *
 * This also pins the negative half of SC6: criteria 3 and 4 (the activity line
 * at the tail, the presence value in the header) are conversation-host-only,
 * because `ConversationPresenceChip` is mounted solely by `ConversationPage`.
 * A future change that starts mounting presence here should have to update
 * this test deliberately rather than acquire the behavior by accident.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/WorkspaceDetailPage.chrome.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceDetailPage } from "./WorkspaceDetailPage";

const WORKSPACE_ID = "mt3344-workspace-chrome-test";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function mockFetches(driven: { sessionId: string; status: string } | null = null) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";

    if (pathname === `/api/agents/${encodeURIComponent(WORKSPACE_ID)}`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            session: {
              sessionId: WORKSPACE_ID,
              shortId: "ws#42",
              taskId: "mt#3344",
              taskTitle: "Run detail chrome",
              status: "IN-REVIEW",
              liveness: "healthy",
              agentId: null,
              branch: "task/mt-3344",
              repoName: "edobry/minsky",
              repoUrl: null,
              createdAt: null,
              lastActivityAt: null,
              lastCommitHash: null,
              lastCommitMessage: null,
              commitCount: 0,
            },
            commits: [],
            pr: null,
            conversation: null,
            conversations: [],
            driven,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

function renderWorkspaceDetailPage() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/agents/${WORKSPACE_ID}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/agents/:id" element={<WorkspaceDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("mt#3344 — pinned run-detail chrome on the workspace host (SC6)", () => {
  test("the breadcrumb and the tab strip share ONE pinned, opaque container", async () => {
    mockFetches();
    const { getByTestId, getByRole, getByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));

    expect(chrome.className).toContain("sticky");
    expect(chrome.className).toContain("top-0");
    expect(chrome.className).toContain("bg-background");

    // The breadcrumb is this host's chrome — it must be INSIDE the pinned
    // container, not a preceding sibling of RunDetail as it was before.
    const breadcrumb = getByLabelText("Breadcrumb");
    const tablist = getByRole("tablist");
    expect(chrome.contains(breadcrumb)).toBe(true);
    expect(chrome.contains(tablist)).toBe(true);
  });

  test("no presence value or activity line is mounted on this host", async () => {
    mockFetches();
    const { getByTestId, queryByTestId } = renderWorkspaceDetailPage();

    await waitFor(() => getByTestId("run-detail-chrome"));

    // SC6's explicit scoping: `/agents/:id` has no presence readout today and
    // mt#3344 does not add one.
    expect(queryByTestId("conversation-presence-value")).toBeNull();
    expect(queryByTestId("conversation-presence-activity")).toBeNull();
  });
});

describe("mt#3400 — the driven banner is pinned with the chrome", () => {
  test("the return-to-drive-view banner lives INSIDE the pinned container", async () => {
    mockFetches({ sessionId: "ds-abc123", status: "running" });
    const { getByTestId, getByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));
    const banner = await waitFor(() => getByLabelText("Open driven session (running)"));

    // Containment IS the fix. mt#3344 pinned the chrome but left this banner a
    // following sibling, so on the Conversation tab it scrolled out of view the
    // moment the transcript reached its live edge — removing the only route
    // back to the interactive drive view from exactly the surface an operator
    // reading the conversation is looking at.
    expect(chrome.contains(banner)).toBe(true);
    expect(banner.getAttribute("href")).toBe("/driven/ds-abc123");
  });

  test("no driven session → no banner, and the chrome keeps its geometry", async () => {
    mockFetches(null);
    const { getByTestId, queryByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));
    expect(queryByLabelText(/^Open driven session/)).toBeNull();
    // The no-banner case must be untouched by this change: spacing comes from
    // the banner's own `mb-2`, never from padding added to the container.
    expect(chrome.className).toContain("pt-4");
    expect(chrome.className).not.toContain("pb-2");
  });
});
