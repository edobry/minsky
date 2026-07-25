/**
 * Attention widget DigestRow entity-reference adoption test (mt#3187).
 *
 * Shape 3: `ask.parentTaskId` becomes a link via the shared <EntityRef> in
 * children mode. Complication: the row is itself a <Link to="/asks"> — a
 * naive drop-in <EntityRef> would nest an <a> inside an <a>, invalid HTML
 * with unpredictable click/focus behavior. DigestRow resolves this by
 * hoisting the task ref OUT of the row's Link so both are sibling anchors;
 * this test asserts the resulting DOM has no nested anchors and that the
 * row's own /asks navigation still works.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DigestRow, type AttentionAsk } from "./Attention";

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

function baseAsk(overrides: Partial<AttentionAsk> = {}): AttentionAsk {
  return {
    id: "ask-1",
    kind: "direction.decide",
    state: "routed",
    title: "Pick an approach",
    question: "Which approach should we take?",
    requestor: "agent-1",
    createdAt: new Date().toISOString(),
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

function renderRow(ask: AttentionAsk) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DigestRow ask={ask} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Attention DigestRow — Shape 3: ask.parentTaskId (mt#3187)", () => {
  test("renders the task ref as a working link with NO <a> nested inside an <a>", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#50", title: "Some task", status: "READY" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRow(baseAsk({ parentTaskId: "mt#50" }));

    // The row's own navigation to /asks still works.
    const rowLink = container.querySelector('a[href="/asks"]');
    expect(rowLink).not.toBeNull();

    // The task ref is its own working link.
    const taskLink = container.querySelector('a[href="/tasks/mt%2350"]');
    expect(taskLink).not.toBeNull();
    expect(taskLink?.textContent).toBe("mt#50");

    // Neither anchor is nested inside the other — the invalid-HTML case this
    // conversion exists to avoid.
    expect(rowLink?.querySelector("a")).toBeNull();
    expect(taskLink?.closest("a") === taskLink).toBe(true);
    expect(taskLink?.closest('a[href="/asks"]')).toBeNull();

    await waitFor(() => expect(taskLink?.textContent).toBe("mt#50"));
  });

  test("absent parentTaskId renders no task link, and the row link is unaffected", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderRow(baseAsk());
    expect(container.querySelector('a[href^="/tasks/"]')).toBeNull();
    expect(container.querySelector('a[href="/asks"]')).not.toBeNull();
  });
});
