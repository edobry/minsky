/**
 * AsksPage GroupSubjectBadge entity-reference adoption test (mt#3187).
 *
 * Shape 3: `group.subject` (ask-groups.ts `askSubject` — the shared work
 * anchor for a decision group) is a MIXED id-space: an `mt#N` Minsky task
 * ref, a `gh#N` GitHub issue ref, or another producer-supplied string.
 * <EntityRef> assumes a known RoutableEntityType, so only the `mt#N` case is
 * routed through it; a mis-sniffed `gh#` must NOT render as a broken Minsky
 * link (per this task's spec).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GroupSubjectBadge } from "./AsksPage";

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

function renderBadge(subject: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GroupSubjectBadge subject={subject} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AsksPage GroupSubjectBadge — Shape 3: group.subject mixed id-space (mt#3187)", () => {
  test("an mt# subject routes through EntityRef as a working task link", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#77", title: "Some task", status: "READY" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderBadge("mt#77");
    const link = container.querySelector('a[href="/tasks/mt%2377"]');
    expect(link).not.toBeNull();
    // children mode: exact prior text (bare subject), no dense-row line-height growth.
    expect(link?.textContent).toBe("mt#77");
    await waitFor(() => expect(link?.textContent).toBe("mt#77"));
  });

  test("a gh# subject stays plain text — NOT rendered as a broken Minsky link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderBadge("gh#1761");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("gh#1761");
  });

  test("an unrecognized subject shape also stays plain text", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderBadge("something-else");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("something-else");
  });
});
