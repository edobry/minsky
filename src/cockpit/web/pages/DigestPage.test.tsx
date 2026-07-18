/**
 * Component tests for DigestPage (mt#2869).
 *
 * Stubs global fetch with fixture /api/activity responses and asserts the
 * page renders per-workstream Tier-1-shaped groups (headline, group cards,
 * exceptions, deeplinks), the empty state, and the error state.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DigestPage } from "./DigestPage";

const originalFetch = globalThis.fetch;

function stubActivity(events: unknown[], status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ events, total: events.length, limit: 500 }), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DigestPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  nextEventId = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

let nextEventId = 0;
function evt(
  eventType: string,
  payload: Record<string, unknown> | null,
  relatedTaskId: string | null
) {
  nextEventId += 1;
  return {
    id: `e${nextEventId}`,
    eventType,
    payload,
    relatedTaskId,
    relatedSessionId: null,
    createdAt: `2026-07-17T10:0${nextEventId % 10}:00Z`,
  };
}

describe("DigestPage", () => {
  test("renders per-workstream groups with headline, status, PR links, and exceptions", async () => {
    stubActivity([
      evt("task.status_changed", { taskId: "mt#100", newStatus: "IN-PROGRESS" }, "mt#100"),
      evt(
        "changeset.created",
        { prNumber: 42, taskId: "mt#100", title: "Make the fallback loud" },
        "mt#100"
      ),
      evt("pr.merged", { prNumber: 42, taskId: "mt#100" }, "mt#100"),
      evt("task.status_changed", { taskId: "mt#100", newStatus: "DONE" }, "mt#100"),
      evt("deploy.fail", { service: "reviewer" }, "mt#200"),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("digest-headline")).toBeTruthy();
    });

    // Headline rolls up workstreams / merges / exceptions.
    expect(screen.getByTestId("digest-headline").textContent).toContain("2 workstreams active");
    expect(screen.getByTestId("digest-headline").textContent).toContain("1 PRs merged");
    expect(screen.getByTestId("digest-headline").textContent).toContain("1 exception");

    // Group card carries the task ref as an in-app deeplink and its title.
    const taskLink = screen.getByText("mt#100").closest("a");
    expect(taskLink?.getAttribute("href")).toBe("/tasks/mt%23100");
    expect(screen.getByText("Make the fallback loud")).toBeTruthy();
    expect(screen.getByText("DONE")).toBeTruthy();

    // PR deeplink routes to the changeset detail page.
    const prLink = screen.getByText("#42").closest("a");
    expect(prLink?.getAttribute("href")).toBe("/changeset/42");

    // The deploy failure renders as an exception line on its group.
    expect(screen.getByTestId("digest-exceptions").textContent).toContain(
      "deploy FAILED (reviewer)"
    );
  });

  test("renders the empty state when the day has no recorded activity", async () => {
    stubActivity([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("digest-empty")).toBeTruthy();
    });
    expect(screen.getByTestId("digest-empty").textContent).toContain("No recorded fleet activity");
  });

  test("renders the error state when the activity endpoint fails", async () => {
    stubActivity([], 503);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("digest-error")).toBeTruthy();
    });
    expect(screen.getByTestId("digest-error").textContent).toContain("Digest unavailable");
  });
});
