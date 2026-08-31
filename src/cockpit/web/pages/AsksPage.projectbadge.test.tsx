/**
 * AsksPage per-row project badge (mt#4773 SC1 — the asks leg).
 *
 * Parity with `widgets/Agents.projectbadge.test.tsx`: the same
 * `shouldShowProjectIndicator` when-to-show rule task/changeset/agent rows
 * use, pinned on ask rows too. Added on PR #3523 R1 (non-blocking finding:
 * agents had this coverage and asks did not).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AsksPage } from "./AsksPage";
import type { AskItem } from "../widgets/AskDetail";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = global.fetch;
const STORAGE_KEY = "cockpit.project.v1";

const MINSKY_ID = "3ac3d147-0000-0000-0000-000000000001";
const PEEZOMBIE_ID = "3ac3d147-0000-0000-0000-000000000002";

const TWO_PROJECTS = [
  { id: MINSKY_ID, slug: "edobry/minsky", displayName: "Minsky" },
  { id: PEEZOMBIE_ID, slug: "edobry/peezombie.me", displayName: null },
];

function ask(overrides: Partial<AskItem> & Pick<AskItem, "id" | "title">): AskItem {
  return {
    kind: "direction.decide",
    state: "routed",
    question: "Which way?",
    requestor: "test-agent",
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

function stubNetwork(asks: AskItem[], projects: typeof TWO_PROJECTS) {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/asks")) {
      return { ok: true, json: async () => ({ asks, total: asks.length }) } as Response;
    }
    if (url.includes("/api/projects")) {
      return { ok: true, json: async () => ({ projects }) } as Response;
    }
    return {
      ok: true,
      json: async () => ({ state: "degraded", reason: "not mocked" }),
    } as Response;
  }) as unknown as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <AsksPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* defensive */
  }
});

describe("AsksPage per-row project badge (mt#4773)", () => {
  test("all-projects view labels each row's project — displayName, or the slug when there is none", async () => {
    stubNetwork(
      [
        ask({ id: "a-1", title: "Minsky-scoped decision", projectId: MINSKY_ID }),
        ask({ id: "a-2", title: "Peezombie-scoped decision", projectId: PEEZOMBIE_ID }),
      ],
      TWO_PROJECTS
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Minsky")).toBeTruthy();
      expect(screen.getByText("edobry/peezombie.me")).toBeTruthy();
    });
  });

  test("an unstamped ask renders no badge — the mt#4772 NULL population, not an error", async () => {
    stubNetwork([ask({ id: "a-3", title: "Unstamped decision" })], TWO_PROJECTS);
    renderPage();

    await waitFor(() => expect(screen.getByText("Unstamped decision")).toBeTruthy());
    expect(screen.queryByText("Minsky")).toBeNull();
  });

  test("suppresses the badge under an explicit project selection", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    stubNetwork([ask({ id: "a-4", title: "Scoped decision", projectId: MINSKY_ID })], TWO_PROJECTS);
    renderPage();

    await waitFor(() => expect(screen.getByText("Scoped decision")).toBeTruthy());
    // Nothing to disambiguate when every visible row is that project's.
    expect(screen.queryByText("Minsky")).toBeNull();
  });
});
