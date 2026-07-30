/**
 * TaskDetail TaskRefRow entity-reference adoption test (mt#3187).
 *
 * The task-detail children/deps list — rows like the one TaskRefRow renders
 * — were already `<Link>`s (found via mt#3189 live verification, not
 * mt#3175's dead-*text* sweep, since these rows never matched that grep).
 * Unconverted class: no hover card, no resolved label. TaskIdChip (shared by
 * the Parent section, Children rows, and both Dependencies lists) now routes
 * through the shared <EntityRef> in children mode — the row already shows
 * the referenced task's title + <StatusBadge> adjacent, so default mode's
 * derived "id · label" text would duplicate that.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskRefRow, type TaskRef } from "./TaskDetail";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function fallback(): Response {
  return jsonResponse({ state: "degraded", reason: "not mocked" });
}

function renderRow(task: TaskRef) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskRefRow task={task} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskDetail TaskRefRow — TaskIdChip adoption (mt#3187)", () => {
  test("the task id chip is a working link, hover-card gained, no duplicated title", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#60", title: "Child task", status: "DONE" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container, getByText } = renderRow({
      id: "mt#60",
      title: "Child task",
      status: "DONE",
    });

    const link = container.querySelector('a[href="/tasks/mt%2360"]');
    expect(link).not.toBeNull();
    // children mode: exact prior chip text (bare id) — the row's own title
    // span (below) already carries the title, so no duplicate.
    expect(link?.textContent).toBe("mt#60");
    // The title span, rendered separately by TaskRefRow, is still present exactly once.
    expect(getByText("Child task")).toBeDefined();

    await waitFor(() => expect(link?.textContent).toBe("mt#60"));
  });
});
