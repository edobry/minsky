/**
 * Regression test for mt#3110 — React error #310 ("Rendered more hooks than
 * during the previous render") on the cockpit `agents-page` ErrorBoundary.
 *
 * Root cause: `GoToActionButton` called `useEffect` AFTER a conditional early
 * return (`if (action.type === "disabled") return ...`). `resolveGoToAction`
 * resolves to `{ type: "disabled" }` for a `dispatched-agent` row whenever
 * `agent.attachState` is `"detached"` or `null`, and to `{ type: "focus" |
 * "navigate" }` once `attachState` becomes `"attached-external"` or
 * `"in-cockpit"`. Because each row's `GoToActionButton` instance is keyed by
 * `agent.sessionId` and therefore persists across the widget's 5s poll
 * ticks, a row whose `attachState` flips between those two buckets across
 * two poll responses causes the SAME component instance to call 2 hooks on
 * one render and 3 on the next — the exact "Rendered more hooks" violation.
 *
 * This test reproduces that render sequence directly (mount with a
 * "disabled" agent, then `rerender` the SAME instance with a "non-disabled"
 * agent) without waiting on the real 5s poll interval.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GoToActionButton, type AgentRow } from "./Agents";

function baseAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    sessionId: "row-1",
    kind: "dispatched-agent",
    title: "row-1",
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
    interfaceBinding: null,
    ...overrides,
  };
}

function renderButton(agent: AgentRow) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GoToActionButton agent={agent} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("GoToActionButton hook order across attachState transitions (mt#3110)", () => {
  test("attachState flipping from detached to attached-external does not throw (rules-of-hooks safe)", () => {
    const { rerender } = renderButton(baseAgent({ attachState: "detached" }));

    expect(() =>
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <GoToActionButton agent={baseAgent({ attachState: "attached-external" })} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    ).not.toThrow();
  });

  test("attachState flipping from null (degraded) to in-cockpit does not throw (rules-of-hooks safe)", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GoToActionButton agent={baseAgent({ attachState: null })} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(() =>
      rerender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GoToActionButton agent={baseAgent({ attachState: "in-cockpit" })} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    ).not.toThrow();
  });

  test("attachState flipping the other direction (attached-external back to detached) does not throw", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GoToActionButton agent={baseAgent({ attachState: "attached-external" })} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(() =>
      rerender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GoToActionButton agent={baseAgent({ attachState: "detached" })} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    ).not.toThrow();
  });
});
