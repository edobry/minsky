/**
 * MemoriesFamilies tests (mt#4763 AT5).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoriesFamilies } from "./MemoriesFamilies";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function renderFamilies() {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/widget/memories-families/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          families: [
            {
              slug: "assertion-without-verification",
              tag: "family:assertion-without-verification",
              memberCount: 66,
              firstMemberAt: "2026-01-01T00:00:00.000Z",
              mostRecentMemberAt: "2026-08-20T00:00:00.000Z",
              structuralFixTasks: ["mt#4749"],
            },
            {
              slug: "scope-creep",
              tag: "family:scope-creep",
              memberCount: 12,
              firstMemberAt: "2026-06-01T00:00:00.000Z",
              mostRecentMemberAt: "2026-08-25T00:00:00.000Z",
              structuralFixTasks: [],
            },
          ],
        },
      });
    }
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MemoriesFamilies />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("MemoriesFamilies (mt#4763 AT5)", () => {
  test("renders one row per family, defaulting to member-count descending", async () => {
    const { container } = renderFamilies();
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );
    const rows = Array.from(container.querySelectorAll('[data-testid="family-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("assertion-without-verification");
    expect(rows[0]?.textContent).toContain("66");
    expect(rows[1]?.textContent).toContain("scope-creep");
  });

  test("a family with no linked task renders an em dash, not a broken link", async () => {
    const { container } = renderFamilies();
    await waitFor(() => expect(container.textContent).toContain("scope-creep"));
    const rows = Array.from(container.querySelectorAll('[data-testid="family-row"]'));
    const scopeCreepRow = rows.find((r) => r.textContent?.includes("scope-creep"));
    expect(scopeCreepRow?.querySelector("a[href^='/tasks/']")).toBeNull();
  });

  test("a linked structural-fix task renders as a task deeplink", async () => {
    const { container } = renderFamilies();
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );
    const link = container.querySelector('a[href="/tasks/mt%234749"]');
    expect(link).not.toBeNull();
  });

  test("clicking the Members header toggles sort direction", async () => {
    const { container } = renderFamilies();
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );

    const membersHeader = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Members")
    );
    expect(membersHeader).toBeTruthy();

    // Default is already memberCount desc; one click flips to ascending.
    fireEvent.click(membersHeader as Element);

    await waitFor(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="family-row"]'));
      expect(rows[0]?.textContent).toContain("scope-creep");
      expect(rows[1]?.textContent).toContain("assertion-without-verification");
    });
  });
});
