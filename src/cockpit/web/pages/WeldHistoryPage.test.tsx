/**
 * WeldHistoryPage tests (mt#2602)
 *
 * Verifies the "/plant/weld-history" drill-down surface: pending vs ready
 * states, install-date + commit-link rendering, retrospective-link rendering,
 * and the honest "unknown" fallback for underivable fields.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/WeldHistoryPage.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { WeldHistoryPage } from "./WeldHistoryPage";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderWeldHistory() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <WeldHistoryPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function mockSlowTopologyFetch(payload: unknown) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/widget/slow-topology/data") {
      return Promise.resolve(
        new Response(JSON.stringify({ state: "ok", payload }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

describe("WeldHistoryPage", () => {
  test("renders an honest pending message before the first sweep completes", async () => {
    mockSlowTopologyFetch({ status: "pending", computedAt: null, interlockCount: 0, entries: [] });
    renderWeldHistory();

    await waitFor(() => {
      expect(screen.getByTestId("weld-history-computed-at").textContent).toContain(
        "Derivation pending"
      );
    });
    expect(screen.getByTestId("weld-history-empty")).toBeDefined();
  });

  test("renders derived entries with install date, commit link, and retrospective link", async () => {
    mockSlowTopologyFetch({
      status: "ready",
      computedAt: "2026-06-01T00:00:00Z",
      interlockCount: 1,
      entries: [
        {
          name: "check-branch-fresh",
          sourceDir: ".claude/hooks",
          installDate: "2026-01-01T00:00:00Z",
          commitSha: "abc1234abc1234abc1234abc1234abc1234abcd",
          commitUrl:
            "https://github.com/edobry/minsky/commit/abc1234abc1234abc1234abc1234abc1234abcd",
          retrospective: {
            eventId: "retro-1",
            note: "branch went stale mid-review",
            taskId: "mt#1483",
            createdAt: "2025-12-31T00:00:00Z",
            matchType: "task-ref",
          },
        },
      ],
    });
    renderWeldHistory();

    await waitFor(() => {
      expect(screen.getByTestId("weld-history-row-check-branch-fresh")).toBeDefined();
    });

    const row = screen.getByTestId("weld-history-row-check-branch-fresh");
    expect(row.textContent).toContain("check-branch-fresh");
    expect(row.textContent).toContain("branch went stale mid-review");
    expect(row.textContent).toContain("mt#1483");
    expect(row.textContent).toContain("matched by task ref");

    const commitLink = screen.getByText("abc1234") as HTMLAnchorElement;
    expect(commitLink.getAttribute("href")).toBe(
      "https://github.com/edobry/minsky/commit/abc1234abc1234abc1234abc1234abc1234abcd"
    );
  });

  test("renders honest 'unknown' for an interlock with no derivable install date or retrospective", async () => {
    mockSlowTopologyFetch({
      status: "ready",
      computedAt: "2026-06-01T00:00:00Z",
      interlockCount: 1,
      entries: [
        {
          name: "brand-new-hook",
          sourceDir: ".minsky/hooks",
          installDate: null,
          commitSha: null,
          commitUrl: null,
          retrospective: null,
        },
      ],
    });
    renderWeldHistory();

    await waitFor(() => {
      expect(screen.getByTestId("weld-history-row-brand-new-hook")).toBeDefined();
    });

    const row = screen.getByTestId("weld-history-row-brand-new-hook");
    // Three "unknown" cells: installed, commit, retrospective.
    const unknownCells = row.textContent?.match(/unknown/g) ?? [];
    expect(unknownCells.length).toBe(3);
  });

  test("renders an error message when the widget fetch fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not found", { status: 404 }))
    ) as typeof globalThis.fetch;
    renderWeldHistory();

    await waitFor(() => {
      expect(screen.getByTestId("weld-history-error")).toBeDefined();
    });
  });
});
