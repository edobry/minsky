/**
 * PlantGridPage tests (mt#2388)
 *
 * Verifies the panel-grid board:
 *   - All VSM organ panels are present.
 *   - READY tank count reflects the mocked /api/tasks response.
 *   - Loading and placeholder states are handled correctly.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PlantGridPage } from "./PlantGridPage";

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

function renderPlantGrid() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PlantGridPage />
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

describe("PlantGridPage", () => {
  test("renders the plant-grid header", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByText(/MINSKY.*PLANT GRID/i)).toBeDefined();
  });

  test("renders the page container with data-testid", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("plant-grid-page")).toBeDefined();
  });

  test("renders the grid board", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("plant-grid-board")).toBeDefined();
  });

  test("renders S5 Identity panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-s5-identity")).toBeDefined();
  });

  test("renders S1 Operations panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-s1-operations")).toBeDefined();
  });

  test("renders S3 Gauges panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-s3-gauges")).toBeDefined();
  });

  test("renders S4 Future panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-s4-future")).toBeDefined();
  });

  test("renders Attention/Ask seam panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-attention-seam")).toBeDefined();
  });

  test("renders Learning Loop panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-learning-loop")).toBeDefined();
  });

  test("renders Infra Supply panel", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByTestId("panel-infra-supply")).toBeDefined();
  });

  test("shows loading indicator while READY count is fetching", () => {
    // Hang the fetch so the query stays in loading state
    globalThis.fetch = mock(
      () => new Promise(() => {}) // never resolves
    ) as typeof globalThis.fetch;

    renderPlantGrid();
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

    renderPlantGrid();

    await waitFor(() => {
      expect(screen.getByText("3")).toBeDefined();
    });
  });

  test("shows READY count = 0 when no READY tasks in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Task A", status: "IN_PROGRESS" },
      { id: "mt-2", title: "Task B", status: "DONE" },
    ]);

    renderPlantGrid();

    await waitFor(() => {
      expect(screen.getByText("0")).toBeDefined();
    });
  });

  test("renders cross-link to SVG schematic (/plant)", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    const link = screen.getByRole("link", { name: /schematic layout/i });
    expect(link).toBeDefined();
  });

  test("renders the S1 spine SVG with lifecycle stages", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    // The S1 spine should show the lifecycle stage labels
    expect(screen.getByText("TASKS")).toBeDefined();
    expect(screen.getByText("SESSIONS")).toBeDefined();
    expect(screen.getByText("AGENTS")).toBeDefined();
    expect(screen.getByText("PR")).toBeDefined();
    expect(screen.getByText("DONE")).toBeDefined();
    expect(screen.getByText("READY")).toBeDefined();
  });

  test("renders infra supply status items", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByText(/MCP server/i)).toBeDefined();
    expect(screen.getByText(/Postgres/i)).toBeDefined();
    expect(screen.getByText(/embeddings/i)).toBeDefined();
  });

  test("renders the v1 notice in header subtitle", () => {
    mockTasksFetch([]);
    renderPlantGrid();
    expect(screen.getByText(/v1.*READY tank live/i)).toBeDefined();
  });
});
