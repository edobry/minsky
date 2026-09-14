/**
 * TaskDetail header renders the task's creation channel (mt#5136 SC4).
 *
 * `GET /api/tasks/:id` now carries `task.origin` (`human` | `agent` |
 * `automated` | null). The header shows it as a badge beside `kind` when it
 * carries a value, and shows nothing for a NULL row — a task that predates the
 * column is "unknown", and rendering "null-filed" would present an absence as
 * a fact. The payload field is optional so a server still serving the
 * pre-column shape validates rather than dropping the page into ErrorState.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskDetail } from "./TaskDetail";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function detailPayload(origin: string | null | undefined) {
  return {
    task: {
      id: "mt#77",
      title: "Fix the widget",
      status: "READY",
      kind: "implementation",
      tags: ["provenance"],
      ...(origin === undefined ? {} : { origin }),
    },
    spec: "## Summary\n\nBody.",
    parent: null,
    children: [],
    deps: { outgoing: [], incoming: [] },
    actions: [],
  };
}

function renderDetail(payload: unknown) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/tasks/mt%2377")) return jsonResponse(payload);
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskDetail taskId="mt#77" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskDetail header — creation channel badge (mt#5136)", () => {
  test("an agent-filed task shows the channel beside its kind", async () => {
    const { container } = renderDetail(detailPayload("agent"));
    await waitFor(() => {
      const badge = container.querySelector('[data-testid="task-origin"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe("agent-filed");
    });
  });

  test("a row that predates the column (origin null) renders no badge", async () => {
    const { container, getByText } = renderDetail(detailPayload(null));
    await waitFor(() => expect(getByText("implementation")).toBeDefined());
    expect(container.querySelector('[data-testid="task-origin"]')).toBeNull();
  });

  test("a payload without the field at all still validates and renders", async () => {
    const { container, getByText } = renderDetail(detailPayload(undefined));
    await waitFor(() => expect(getByText("implementation")).toBeDefined());
    expect(container.querySelector('[data-testid="task-origin"]')).toBeNull();
  });
});
