/**
 * Integration-level regression test for mt#3110 — reproduces the actual
 * failure path (a poll-tick data-shape change while the `agents-page`
 * ErrorBoundary is mounted) rather than driving `GoToActionButton` directly.
 *
 * Simulates a poll tick by forcing a TanStack Query refetch (rather than
 * waiting the real 5s `refetchInterval`) where the SAME row's
 * `attachState` flips from `"detached"` to `"attached-external"` between
 * the first fetch and the refetch — the exact trigger this widget's own
 * 5s polling can produce in production. Mounted through the real
 * `ErrorBoundary` (the same component `App.tsx` wraps the `/agents` route
 * with, id `"agents-page"`) so a hook-order violation surfaces as the
 * boundary's "Widget agents-page crashed" fallback, matching the original
 * live crash evidence in the task spec.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agents, type AgentRow } from "./Agents";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = globalThis.fetch;

function baseRow(overrides: Partial<AgentRow> & Pick<AgentRow, "sessionId">): AgentRow {
  return {
    kind: "dispatched-agent",
    title: overrides.sessionId,
    liveness: "healthy",
    taskId: null,
    taskTitle: null,
    prNumber: null,
    prStatus: null,
    lastActivityAt: "2026-07-23T00:00:00Z",
    agentId: null,
    conversationId: null,
    cwd: null,
    subagents: [],
    model: null,
    driven: null,
    attachState: null,
    interfaceBinding: { kind: "unbound", lastObservedAt: "2026-07-23T00:00:00Z" },
    ...overrides,
  };
}

/** Stubs the agents-data fetch to return `sequence[callIndex]` on each successive call
 *  (clamped to the last entry once exhausted) — simulates the poll returning a
 *  different payload on the second tick. */
function stubNetworkSequence(sequence: AgentRow[][]) {
  let callIndex = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/agents/data")) {
      const agents = sequence[Math.min(callIndex, sequence.length - 1)] ?? [];
      callIndex += 1;
      return new Response(
        JSON.stringify({ state: "ok", payload: { agents, totalCount: agents.length } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/health")) {
      return new Response(JSON.stringify({ transcriptWatcher: { activeSessions: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/asks")) {
      return new Response(JSON.stringify({ asks: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/projects")) {
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("agents-page ErrorBoundary survives an attachState poll-tick change (mt#3110)", () => {
  test("row's attachState flipping detached -> attached-external across a refetch does not trip the boundary", async () => {
    stubNetworkSequence([
      [baseRow({ sessionId: "row-1", attachState: "detached" })],
      [baseRow({ sessionId: "row-1", attachState: "attached-external" })],
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProjectProvider>
            <ErrorBoundary id="agents-page">
              <Agents />
            </ErrorBoundary>
          </ProjectProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText("row-1")).toBeDefined());
    expect(screen.queryByText(/crashed/i)).toBeNull();

    // Force the poll-tick refetch (rather than waiting the real 5s refetchInterval).
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["agents"] });
    });

    // The boundary must NOT have tripped — the row (now attached-external) still renders.
    await waitFor(() => expect(screen.getByText("row-1")).toBeDefined());
    expect(screen.queryByText(/crashed/i)).toBeNull();
    expect(screen.getByTitle("Raise the attached terminal")).toBeDefined();
  });

  test("row's attachState flipping null -> in-cockpit across a refetch does not trip the boundary", async () => {
    stubNetworkSequence([
      [baseRow({ sessionId: "row-2", attachState: null })],
      [baseRow({ sessionId: "row-2", attachState: "in-cockpit" })],
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProjectProvider>
            <ErrorBoundary id="agents-page">
              <Agents />
            </ErrorBoundary>
          </ProjectProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText("row-2")).toBeDefined());
    expect(screen.queryByText(/crashed/i)).toBeNull();

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["agents"] });
    });

    await waitFor(() => expect(screen.getByText("row-2")).toBeDefined());
    expect(screen.queryByText(/crashed/i)).toBeNull();
  });
});