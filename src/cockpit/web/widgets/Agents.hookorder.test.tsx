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
 *
 * Why `rerender` exercises the SAME instance, and how that was established
 * (PR #2253 R1 raised the opposite concern — that the rerender remounts the
 * subtree, which would make these assertions vacuous): React reconciles by
 * element TYPE and POSITION, not by prop identity, so re-rendering the root
 * with fresh provider elements of the same type at the same position updates
 * props on the existing fibers and preserves the child instance and its hook
 * state. Rather than rest on that argument, it was verified by negative
 * control: with the fix reverted (the early return moved back above the
 * hooks), all three tests here AND both tests in the integration sibling
 * fail with React's own "Rendered more hooks than during the previous
 * render." / "Rendered fewer hooks than expected. This may be caused by an
 * accidental early return statement." A remount would have reset the hook
 * count and produced no error at all. Independently, `renderButton` below
 * now holds ONE QueryClient per test and re-renders through a single wrapper,
 * so provider identity is constant across the rerender regardless.
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

/**
 * Mounts the button and returns `rerenderWith`, which re-renders through the
 * SAME wrapper and the SAME QueryClient — only the `agent` prop changes, which
 * is what a poll tick does in production.
 */
function renderButton(agent: AgentRow) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (a: AgentRow) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GoToActionButton agent={a} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const utils = render(wrap(agent));
  return { ...utils, rerenderWith: (a: AgentRow) => utils.rerender(wrap(a)) };
}

afterEach(() => {
  cleanup();
});

describe("GoToActionButton hook order across attachState transitions (mt#3110)", () => {
  test("attachState flipping from detached to attached-external does not throw (rules-of-hooks safe)", () => {
    const { rerenderWith } = renderButton(baseAgent({ attachState: "detached" }));

    expect(() => rerenderWith(baseAgent({ attachState: "attached-external" }))).not.toThrow();
  });

  test("attachState flipping from null (degraded) to in-cockpit does not throw (rules-of-hooks safe)", () => {
    const { rerenderWith } = renderButton(baseAgent({ attachState: null }));

    expect(() => rerenderWith(baseAgent({ attachState: "in-cockpit" }))).not.toThrow();
  });

  test("attachState flipping the other direction (attached-external back to detached) does not throw", () => {
    const { rerenderWith } = renderButton(baseAgent({ attachState: "attached-external" }));

    expect(() => rerenderWith(baseAgent({ attachState: "detached" }))).not.toThrow();
  });
});
