/**
 * PlantFlowPage tests (mt#2389)
 *
 * Verifies the node-link canvas board at /plant-flow:
 *   - Page container and header are present.
 *   - All VSM organ node panels are present (via data-testid on nodes).
 *   - READY node shows live /api/tasks count (same hook as PlantGridPage).
 *   - Loading state handled correctly.
 *   - Cross-links to /plant and /plant-grid are present.
 *
 * NOTE on @xyflow/react:
 *   react-flow renders on a canvas using ResizeObserver + DOM measurement, which
 *   JSDOM does not fully support. We suppress ResizeObserver and SVGElement width/height
 *   method errors that JSDOM throws on every react-flow mount. The test still verifies
 *   the React tree renders; visual canvas verification requires a browser.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/PlantFlowPage.test.tsx
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PlantFlowPage } from "./PlantFlowPage";

// ---------------------------------------------------------------------------
// Suppress known JSDOM/react-flow canvas compat errors
// react-flow uses ResizeObserver and SVGElement methods not in JSDOM; these
// would produce console noise that isn't relevant to the tests here.
// ---------------------------------------------------------------------------
const _origConsoleError = console.error;
beforeEach(() => {
  // Provide a no-op ResizeObserver if JSDOM doesn't have one
  if (typeof globalThis.ResizeObserver === "undefined") {
    // @ts-expect-error - JSDOM polyfill
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Suppress react-flow's SVG/canvas-specific errors in JSDOM context
  console.error = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === "string") {
      if (
        msg.includes("ResizeObserver") ||
        msg.includes("getBBox") ||
        msg.includes("getComputedStyle") ||
        msg.includes("SVGElement") ||
        msg.includes("Not implemented") ||
        msg.includes("useLayoutEffect") ||
        msg.includes("ReactFlowProvider")
      ) {
        return; // suppress known JSDOM compat noise
      }
    }
    _origConsoleError(...args);
  };
});

afterEach(() => {
  console.error = _origConsoleError;
  cleanup();
  globalThis.fetch = originalFetch;
});

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

function renderPlantFlow() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PlantFlowPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
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

describe("PlantFlowPage", () => {
  // ---- Structural ----

  test("renders the page container with data-testid", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("plant-flow-page")).toBeDefined();
  });

  test("renders the plant-flow header with correct title", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByText(/MINSKY.*PLANT FLOW/i)).toBeDefined();
  });

  test("renders the flow canvas container", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("plant-flow-canvas")).toBeDefined();
  });

  // ---- Organ nodes (tested via data-testid on the HTML node shells) ----

  test("renders S5 Identity organ node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-s5-identity")).toBeDefined();
  });

  test("renders S4 Future organ node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-s4-future")).toBeDefined();
  });

  test("renders S3 Management organ node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-s3-management")).toBeDefined();
  });

  test("renders TASKS lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-tasks")).toBeDefined();
  });

  test("renders READY lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-ready")).toBeDefined();
  });

  test("renders SESSIONS lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-sessions")).toBeDefined();
  });

  test("renders AGENTS lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-agents")).toBeDefined();
  });

  test("renders PR lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-pr")).toBeDefined();
  });

  test("renders REVIEW lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-review")).toBeDefined();
  });

  test("renders DONE lifecycle stage node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-done")).toBeDefined();
  });

  test("renders Attention Seam node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-attention-seam")).toBeDefined();
  });

  test("renders Learning Loop node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-learning-loop")).toBeDefined();
  });

  test("renders Infra Supply node", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("flow-node-infra-supply")).toBeDefined();
  });

  // ---- Live READY count ----

  test("shows loading indicator while READY count is fetching", () => {
    globalThis.fetch = mock(
      () => new Promise(() => {}) // never resolves — keeps query in loading state
    ) as typeof globalThis.fetch;

    renderPlantFlow();
    expect(screen.getByText("…")).toBeDefined();
  });

  test("shows READY count = 4 when four READY tasks in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Task one", status: "READY" },
      { id: "mt-2", title: "Task two", status: "READY" },
      { id: "mt-3", title: "Task three", status: "READY" },
      { id: "mt-4", title: "Task four", status: "READY" },
      { id: "mt-5", title: "Task five", status: "IN_PROGRESS" },
      { id: "mt-6", title: "Task six", status: "DONE" },
    ]);

    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByText("4")).toBeDefined();
    });
  });

  test("shows READY count = 0 when no READY tasks in response", async () => {
    mockTasksFetch([
      { id: "mt-1", title: "Task A", status: "IN_PROGRESS" },
      { id: "mt-2", title: "Task B", status: "DONE" },
    ]);

    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByText("0")).toBeDefined();
    });
  });

  // ---- Cross-links ----

  test("renders cross-link to SVG schematic (/plant)", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    const link = screen.getByRole("link", { name: /schematic/i });
    expect(link).toBeDefined();
  });

  test("renders cross-link to panel-grid (/plant-grid)", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    const link = screen.getByRole("link", { name: /grid/i });
    expect(link).toBeDefined();
  });

  // ---- Version / subtitle ----

  test("renders the v1 notice in header subtitle", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByText(/v1.*node-link canvas/i)).toBeDefined();
  });
});
