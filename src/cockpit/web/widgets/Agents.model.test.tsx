/**
 * Agents.tsx per-node/per-row model badge tests (mt#3070).
 *
 * Covers the task's acceptance tests at the component level:
 *   - Two subagent invocations whose transcripts carry a known model:
 *     each subagent node in the expanded tree renders the mapped
 *     dispatch-model registry label.
 *   - A subagent with a NULL model: the node renders the explicit muted-dash
 *     unknown state, never a guess.
 *   - Top-level run rows also show model where known — including the
 *     raw-id fallback for a model id not in the dispatch-model registry.
 *
 * Follows the same stubNetwork/renderAgents pattern as Agents.peek.test.tsx.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agents, type AgentRow } from "./Agents";
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
    lastActivityAt: "2026-07-18T00:00:00Z",
    agentId: null,
    conversationId: null,
    cwd: null,
    subagents: [],
    model: null,
    driven: null,
    attachState: null,
    interfaceBinding: { kind: "unbound", lastObservedAt: "2026-07-18T00:00:00Z" },
    ...overrides,
  };
}

function stubNetwork(agents: AgentRow[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/agents/data")) {
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

function renderAgents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectProvider>
          <Agents />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Agents per-node/per-row model badge (mt#3070)", () => {
  test("AT: two subagent nodes with a known model each render the mapped registry label", async () => {
    stubNetwork([
      baseRow({
        sessionId: "parent-row",
        subagents: [
          {
            conversationId: "conv-child-1",
            label: "child task one",
            cwd: null,
            startedAt: "2026-07-18T00:00:00Z",
            endedAt: null,
            model: "claude-sonnet-5",
          },
          {
            conversationId: "conv-child-2",
            label: "child task two",
            cwd: null,
            startedAt: "2026-07-18T00:00:00Z",
            endedAt: null,
            model: "claude-opus-4-8",
          },
        ],
      }),
    ]);
    renderAgents();

    await waitFor(() => expect(screen.getByLabelText("Expand subagents")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Expand subagents"));

    await waitFor(() => expect(screen.getByText("child task one")).toBeDefined());
    expect(screen.getByText("Sonnet")).toBeDefined();
    expect(screen.getByText("Opus")).toBeDefined();
  });

  test("AT: a subagent with a NULL model renders the muted-dash unknown state, never a guess", async () => {
    stubNetwork([
      baseRow({
        sessionId: "parent-row",
        // Parent row's OWN model is known — isolates the assertion to the
        // child subagent node's unknown state, not an incidental second
        // "unknown" badge on the parent row too.
        model: "claude-sonnet-5",
        subagents: [
          {
            conversationId: "conv-child-1",
            label: "child task",
            cwd: null,
            startedAt: "2026-07-18T00:00:00Z",
            endedAt: null,
            model: null,
          },
        ],
      }),
    ]);
    renderAgents();

    await waitFor(() => expect(screen.getByLabelText("Expand subagents")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Expand subagents"));

    await waitFor(() => expect(screen.getByText("child task")).toBeDefined());
    // Parent row shows its known model...
    expect(screen.getByText("Sonnet")).toBeDefined();
    // ...while the child node with no model shows the explicit unknown state.
    expect(screen.getByLabelText("Model unknown")).toBeDefined();
  });

  test("top-level run rows show model where known, mapping to the registry label", async () => {
    stubNetwork([baseRow({ sessionId: "top-row", model: "claude-sonnet-5" })]);
    renderAgents();

    await waitFor(() => expect(screen.getByText("top-row")).toBeDefined());
    expect(screen.getByText("Sonnet")).toBeDefined();
  });

  test("an unrecognized model id falls back to rendering the raw id, never hiding the value", async () => {
    stubNetwork([baseRow({ sessionId: "top-row", model: "some-future-model-id" })]);
    renderAgents();

    await waitFor(() => expect(screen.getByText("top-row")).toBeDefined());
    expect(screen.getByText("some-future-model-id")).toBeDefined();
  });

  test("a top-level row with no model renders the muted-dash unknown state", async () => {
    stubNetwork([baseRow({ sessionId: "top-row", model: null })]);
    renderAgents();

    await waitFor(() => expect(screen.getByText("top-row")).toBeDefined());
    expect(screen.getByLabelText("Model unknown")).toBeDefined();
  });
});
