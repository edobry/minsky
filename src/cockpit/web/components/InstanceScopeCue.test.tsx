/**
 * InstanceScopeCue (mt#4773 SC3 / AT3's mechanism).
 *
 * The cue renders when — and only when — a specific project filter is active:
 * under "All projects" (or outside a ProjectProvider entirely) there is
 * nothing to disambiguate, so it renders nothing. Selection arrives the same
 * way the app's does: the persisted localStorage slug the provider reads on
 * mount, plus the shell's /api/projects fetch for the label.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstanceScopeCue } from "./InstanceScopeCue";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = globalThis.fetch;
const STORAGE_KEY = "cockpit.project.v1";

const PROJECTS = [
  { id: "p-1", slug: "edobry/minsky", displayName: "Minsky" },
  { id: "p-2", slug: "edobry/peezombie.me", displayName: null },
];

function stubProjectsFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function renderCue(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* defensive */
  }
});

describe("InstanceScopeCue (mt#4773)", () => {
  test("renders the standard line, with the project's label, while a filter is active", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    stubProjectsFetch();
    renderCue(
      <ProjectProvider>
        <InstanceScopeCue />
      </ProjectProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("instance-scope-cue").textContent).toContain(
        "not filtered by the Minsky project selection"
      );
    });
  });

  test("compact form renders the short marker with the full sentence as the tooltip", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/peezombie.me");
    stubProjectsFetch();
    renderCue(
      <ProjectProvider>
        <InstanceScopeCue compact />
      </ProjectProvider>
    );
    await waitFor(() => {
      const cue = screen.getByTestId("instance-scope-cue");
      expect(cue.textContent).toContain("instance-level");
      // No displayName for this project — the slug carries the tooltip label.
      expect(cue.getAttribute("title")).toContain("edobry/peezombie.me");
    });
  });

  test("renders nothing under All projects — no state to disambiguate", async () => {
    stubProjectsFetch();
    renderCue(
      <ProjectProvider>
        <InstanceScopeCue />
      </ProjectProvider>
    );
    // The provider's /api/projects fetch resolves async; the cue must stay
    // absent before AND after it lands.
    await waitFor(() => expect(screen.queryByTestId("instance-scope-cue")).toBeNull());
  });

  test("renders nothing outside a ProjectProvider — optional context, not a throw", () => {
    renderCue(<InstanceScopeCue />);
    expect(screen.queryByTestId("instance-scope-cue")).toBeNull();
  });
});
