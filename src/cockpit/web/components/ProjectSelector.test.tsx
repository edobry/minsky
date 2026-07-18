/**
 * ProjectSelector component tests (mt#2418).
 *
 * Pattern mirrors Credentials.test.tsx: QueryClientProvider + mocked
 * globalThis.fetch + waitFor/findBy* for async settling.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectSelector } from "./ProjectSelector";
import { ProjectProvider, useProject } from "../lib/project-context";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderSelector() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProjectProvider>
        <ProjectSelector />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

/** Exposes the current selectedSlug as text, for assertions on selection state. */
function SelectedSlugProbe() {
  const { selectedSlug } = useProject();
  return <span data-testid="selected-slug">{selectedSlug ?? "ALL"}</span>;
}

function renderSelectorWithProbe() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProjectProvider>
        <ProjectSelector />
        <SelectedSlugProbe />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  try {
    localStorage.clear();
  } catch {
    /* jsdom/happy-dom always provides localStorage; ignore if not */
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockProjectsResponse(
  projects: Array<{ id: string; slug: string; displayName: string | null }>
) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as typeof globalThis.fetch;
}

describe("ProjectSelector", () => {
  test("renders nothing when zero projects are known", async () => {
    mockProjectsResponse([]);
    renderSelector();
    await waitFor(() => expect(screen.queryByLabelText("Filter by project")).toBeNull());
  });

  test("renders nothing when exactly one project is known", async () => {
    mockProjectsResponse([{ id: "1", slug: "edobry/minsky", displayName: "Minsky" }]);
    renderSelector();
    await waitFor(() => expect(screen.queryByLabelText("Filter by project")).toBeNull());
  });

  test("renders a select with All projects + each project when 2+ are known", async () => {
    mockProjectsResponse([
      { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
      { id: "2", slug: "edobry/other-repo", displayName: null },
    ]);
    renderSelector();

    const select = await screen.findByLabelText("Filter by project");
    expect(select).toBeDefined();
    expect(screen.getByText("All projects")).toBeDefined();
    expect(screen.getByText("Minsky")).toBeDefined();
    // Falls back to the raw slug when displayName is null.
    expect(screen.getByText("edobry/other-repo")).toBeDefined();
  });

  test("selecting a project updates the shared context's selectedSlug", async () => {
    mockProjectsResponse([
      { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
      { id: "2", slug: "edobry/other-repo", displayName: null },
    ]);
    renderSelectorWithProbe();

    const select = await screen.findByLabelText("Filter by project");
    expect(screen.getByTestId("selected-slug").textContent).toBe("ALL");

    fireEvent.change(select, { target: { value: "edobry/minsky" } });

    await waitFor(() =>
      expect(screen.getByTestId("selected-slug").textContent).toBe("edobry/minsky")
    );
  });
});
