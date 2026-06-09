/**
 * PlantPage tests (mt#2376)
 *
 * Verifies the plant board's one wired level — the READY tank count — reflects
 * the mocked /api/tasks response, and that placeholder/loading states are
 * handled correctly.
 *
 * Run via: bun test src/cockpit
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PlantPage } from "./PlantPage";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPlant() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PlantPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockTasksFetch(tasks: Array<{ id: string; title: string; status: string }>) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/tasks") {
      return Promise.resolve(
        new Response(JSON.stringify({ tasks }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlantPage", () => {
  test("renders the plant board header", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByText(/MINSKY.*WHOLE-SYSTEM PLANT/i)).toBeDefined();
  });

  test("renders the page container with data-testid", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByTestId("plant-page")).toBeDefined();
  });

  test("renders VSM organ labels in SVG", () => {
    mockTasksFetch([]);
    renderPlant();
    // Each organ label appears in both the SVG schematic and the legend sidebar,
    // so use getAllByText which allows multiple matches.
    expect(screen.getAllByText(/S5.*IDENTITY/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/S4.*FUTURE/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/S1.*OPERATIONS/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/S3.*3★/i).length).toBeGreaterThan(0);
  });

  test("shows loading indicator '…' while READY count is fetching", () => {
    // Hang the fetch so the query stays in loading state
    globalThis.fetch = mock(
      () => new Promise(() => {}) // never resolves
    ) as typeof globalThis.fetch;

    renderPlant();
    // The loading placeholder is "…" for the READY tank count
    expect(screen.getByText("…")).toBeDefined();
  });

  test("shows READY count = 3 when three READY tasks in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Task one", status: "READY" },
      { id: "mt-2", title: "Task two", status: "READY" },
      { id: "mt-3", title: "Task three", status: "READY" },
      { id: "mt-4", title: "Task four", status: "IN_PROGRESS" },
      { id: "mt-5", title: "Task five", status: "DONE" },
    ]);

    renderPlant();

    await waitFor(() => {
      expect(screen.getByText("3")).toBeDefined();
    });
  });

  test("shows READY count = 0 when no READY tasks in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Task A", status: "IN_PROGRESS" },
      { id: "mt-2", title: "Task B", status: "DONE" },
    ]);

    renderPlant();

    await waitFor(() => {
      expect(screen.getByText("0")).toBeDefined();
    });
  });

  test("shows READY count = 1 when exactly one READY task in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Solo ready", status: "READY" },
      { id: "mt-2", title: "Not ready", status: "PLANNING" },
    ]);

    renderPlant();

    await waitFor(() => {
      expect(screen.getByText("1")).toBeDefined();
    });
  });

  test("renders placeholder '—' markers for non-wired levels", () => {
    mockTasksFetch([]);
    renderPlant();
    // Multiple '—' placeholders appear for the unconnected levels
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  test("renders the INFRA SUPPLY region label", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByText("INFRA SUPPLY")).toBeDefined();
  });

  test("renders the attention seam label", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByText("attention seam")).toBeDefined();
  });

  test("renders the LEARNING LOOP label", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByText("LEARNING LOOP")).toBeDefined();
  });

  test("renders the legend sidebar", () => {
    mockTasksFetch([]);
    renderPlant();
    expect(screen.getByRole("complementary", { name: /legend/i })).toBeDefined();
  });

  test("renders legend idle-honesty section content", () => {
    mockTasksFetch([]);
    renderPlant();
    // The legend has text about the idle-honesty constraint
    expect(screen.getByText(/3★ sweep/i)).toBeDefined();
  });
});
