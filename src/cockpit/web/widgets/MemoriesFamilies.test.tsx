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
import { ProjectProvider } from "../lib/project-context";
import { MINSKY_PROJECT, stubProjectsRoute } from "../lib/test-support/projects";

const originalFetch = global.fetch;
const PROJECT_STORAGE_KEY = "cockpit.project.v1"; // mirrors project-context.tsx's STORAGE_KEY

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  localStorage.removeItem(PROJECT_STORAGE_KEY);
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function renderFamilies() {
  const calls: string[] = [];
  global.fetch = mock(async (url: string) => {
    calls.push(url);
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
  stubProjectsRoute();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <MemoriesFamilies />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, calls };
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

describe("MemoriesFamilies — project scoping (PR #3500 R1 BLOCKING)", () => {
  test("with a project selected, the fetch carries project=<slug>", async () => {
    // A slug `stubProjectsRoute()`'s payload knows: an unknown one is reset to
    // "All projects" by ProjectProvider once the list loads (mt#4842), which
    // would leave this assertion passing only on the pre-reset first fetch.
    localStorage.setItem(PROJECT_STORAGE_KEY, MINSKY_PROJECT.slug);
    const { container, calls } = renderFamilies();
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );
    const familiesCall = calls.find((c) => c.startsWith("/api/widget/memories-families/data"));
    expect(familiesCall).toContain(`project=${encodeURIComponent(MINSKY_PROJECT.slug)}`);
  });

  test("with no project selected (All projects), the fetch carries no project param", async () => {
    const { container, calls } = renderFamilies();
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );
    const familiesCall = calls.find((c) => c.startsWith("/api/widget/memories-families/data"));
    expect(familiesCall).not.toContain("project=");
  });
});
