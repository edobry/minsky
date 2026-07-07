/**
 * PlantFlowPage tests (mt#2389, converged mt#2423)
 *
 * Verifies the node-link canvas board served at /plant:
 *   - Page container and header are present.
 *   - All VSM organ node panels are present (via data-testid on nodes).
 *   - READY node shows live /api/tasks count.
 *   - Loading state handled correctly.
 *   - Cross-links to the retired comparison routes are gone (mt#2423).
 *   - Instrument layer (mt#2466): S2 interlock valves, vessel tanks,
 *     memory reservoir, and the reading-grammar legend are present.
 *   - Retired routes (/plant-flow, /plant-grid) redirect to /plant
 *     (exercises App.tsx's exported plantRoutes wiring).
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
import { Suspense } from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes } from "react-router-dom";
import { PlantFlowPage } from "./PlantFlowPage";
import { plantRoutes } from "../App";

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
    if (pathname === "/api/activity") {
      return Promise.resolve(
        new Response(JSON.stringify({ events: [], total: 0, limit: 50 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

/**
 * Full-fidelity mock covering every endpoint the plant board's instrument
 * hooks call (mt#2590): /api/tasks, /api/activity, the attention/s3-gauges/
 * mcp-server-status/embeddings-health/basic-health widgets, /api/health, and
 * /api/credentials. Each source is independently overridable; omitted sources
 * fall back to a benign default so unrelated tests don't need to specify
 * every field.
 */
interface PlantBoardFetchOverrides {
  tasks?: Array<{ id: string; title: string; status: string }>;
  totalPending?: number;
  mcpDisconnectsEligibleCount24h?: number | null;
  subagentPartialUncommittedCount?: number | null;
  s3GaugesFails?: boolean;
  basicHealthFails?: boolean;
  mcpServerHealthy?: boolean;
  deployStatus?: string | null;
  embeddingsStatus?: "healthy" | "degraded" | "exhausted";
  dbStatus?: "ok" | "degraded" | "unreachable";
  credentials?: Array<{ provider: string; configured: boolean }>;
  /** Rows returned for a REPLAY window fetch (a `/api/activity` request
   *  carrying `since`/`until`) — distinct from the live poll's always-empty
   *  default, so replay tests can assert on specific fired gestures. */
  replayEvents?: Array<{
    id: string;
    eventType: string;
    payload?: Record<string, unknown>;
    createdAt: string;
  }>;
  /** mt#2602 — the slow-topology widget's derived interlock count + entries. */
  slowTopologyStatus?: "pending" | "ready";
  slowTopologyInterlockCount?: number;
  slowTopologyEntries?: Array<Record<string, unknown>>;
}

function mockPlantBoardFetch(overrides: PlantBoardFetchOverrides = {}) {
  const tasks = overrides.tasks ?? [];
  const totalPending = overrides.totalPending ?? 0;
  const credentials = overrides.credentials ?? [{ provider: "github", configured: true }];

  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );

    if (pathname === "/api/tasks") return json({ tasks });
    if (pathname === "/api/activity") {
      const search =
        typeof url === "string"
          ? new URL(url, "http://localhost").searchParams
          : new URLSearchParams();
      // A replay-window request carries since/until; the live poll never does.
      if (search.has("since") || search.has("until")) {
        const events = overrides.replayEvents ?? [];
        return json({ events, total: events.length, limit: 500 });
      }
      return json({ events: [], total: 0, limit: 50 });
    }

    if (pathname === "/api/widget/attention/data") {
      return json({ state: "ok", payload: { activeWindow: null, cohort: [], totalPending } });
    }

    if (pathname === "/api/widget/s3-gauges/data") {
      if (overrides.s3GaugesFails) return json({ error: "not found" }, 404);
      return json({
        state: "ok",
        payload: {
          mcpDisconnects: {
            eligibleCount24h: overrides.mcpDisconnectsEligibleCount24h ?? 0,
            threshold: 3,
          },
          subagentDispatches: {
            partialUncommittedCount: overrides.subagentPartialUncommittedCount ?? 0,
            threshold: 2,
          },
          attention: { value: null },
        },
      });
    }

    if (pathname === "/api/widget/basic-health/data") {
      if (overrides.basicHealthFails) return json({ error: "not found" }, 404);
      return json({ state: "ok", payload: { uptimeSec: 10, version: "test", loadedWidgetCount: 1 } });
    }

    if (pathname === "/api/widget/mcp-server-status/data") {
      return json({
        state: "ok",
        payload: {
          health: { ok: overrides.mcpServerHealthy ?? true },
          deploy:
            overrides.deployStatus !== undefined && overrides.deployStatus !== null
              ? { status: overrides.deployStatus }
              : null,
        },
      });
    }

    if (pathname === "/api/widget/embeddings-health/data") {
      return json({ state: "ok", payload: { status: overrides.embeddingsStatus ?? "healthy" } });
    }

    if (pathname === "/api/widget/slow-topology/data") {
      return json({
        state: "ok",
        payload: {
          status: overrides.slowTopologyStatus ?? "ready",
          computedAt: overrides.slowTopologyStatus === "pending" ? null : "2026-06-01T00:00:00Z",
          interlockCount: overrides.slowTopologyInterlockCount ?? 0,
          entries: overrides.slowTopologyEntries ?? [],
        },
      });
    }

    if (pathname === "/api/health") {
      return json({ status: "ok", db: overrides.dbStatus ?? "ok" });
    }

    if (pathname === "/api/credentials") {
      return json({ credentials });
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
    expect(screen.getByText(/MINSKY.*PLANT/i)).toBeDefined();
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

  // ---- Cross-links (retired routes, mt#2423) ----

  test("renders no cross-links to the retired schematic/grid routes", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.queryByRole("link", { name: /schematic/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /grid/i })).toBeNull();
  });

  // ---- Instrument layer (mt#2466) ----

  test("renders the four S2 interlock valves on the spine", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    for (const key of ["ready", "agents", "pr", "done"]) {
      expect(screen.getByTestId(`flow-node-valve-${key}`)).toBeDefined();
    }
  });

  test("renders vessel tanks in READY and REVIEW", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("vessel-tank-queued")).toBeDefined();
    expect(screen.getByTestId("vessel-tank-awaiting")).toBeDefined();
  });

  test("renders the memory reservoir in the learning loop", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("memory-reservoir")).toBeDefined();
  });

  test("legend is collapsed by default (mt#2591 — avoids occluding the S1 pipeline tail)", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByTestId("plant-legend")).toBeDefined();
    // Collapsed: the reading-grammar body is not in the DOM, and the toggle
    // button reports its "closed" accessible state.
    expect(screen.queryByText(/S2 valves/i)).toBeNull();
    expect(screen.getByLabelText("Expand legend")).toBeDefined();
  });

  test("renders the legend with the S2 organ entry once expanded", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    fireEvent.click(screen.getByLabelText("Expand legend"));
    expect(screen.getByText(/S2 valves/i)).toBeDefined();
  });

  // ---- Version / subtitle ----

  test("renders the v2 notice in header subtitle", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    expect(screen.getByText(/v2.*node-link canvas.*event-driven motion/i)).toBeDefined();
  });

  // ---- Idle honesty (mt#2377 v2.0) ----

  test("initial render fires no gestures — idle reads calm", () => {
    mockTasksFetch([]);
    const { container } = renderPlantFlow();
    expect(container.querySelectorAll(".vsm-gesture-pulse").length).toBe(0);
    expect(container.querySelectorAll('[data-testid^="gesture-dot-"]').length).toBe(0);
  });

  // ---- 3★ scan sweep (mt#2590) ----

  test("renders the 3★ scan sweep as the S3 idle animation", () => {
    mockPlantBoardFetch();
    const { container } = renderPlantFlow();
    const sweep = screen.getByTestId("vsm-scan-sweep");
    expect(sweep).toBeDefined();
    expect(container.querySelector('[data-testid="vsm-scan-sweep"] .vsm-scan')).not.toBeNull();
  });

  // ---- Ask-pulse gating (mt#2590 — honest-motion law) ----

  test("ask pulse is absent when 0 asks are open", async () => {
    mockPlantBoardFetch({ totalPending: 0 });
    const { container } = renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("asks-open-count").textContent).toContain("0");
    });

    expect(container.querySelectorAll(".vsm-ask-pulse").length).toBe(0);
    expect(screen.getByText("no ask pending")).toBeDefined();
  });

  test("ask pulse is present when >= 1 ask is open, on both the seam badge and the S5 YOU badge", async () => {
    mockPlantBoardFetch({ totalPending: 2 });
    const { container } = renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("asks-open-count").textContent).toContain("2");
    });

    expect(screen.getByTestId("seam-ask-badge").className).toContain("vsm-ask-pulse");
    expect(screen.getByTestId("you-badge").className).toContain("vsm-ask-pulse");
    expect(container.querySelectorAll(".vsm-ask-pulse").length).toBe(2);
    expect(screen.getByText("ask pending")).toBeDefined();
  });

  // ---- Slow-clock topology (mt#2602) ----

  test("the DONE valve shows a derived interlock count badge once the sweep is ready", async () => {
    mockPlantBoardFetch({ slowTopologyStatus: "ready", slowTopologyInterlockCount: 37 });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("s2-valve-interlock-count").textContent).toContain("37");
    });
  });

  test("no interlock count badge renders while the sweep is pending (honest, not a fabricated zero)", async () => {
    mockPlantBoardFetch({ slowTopologyStatus: "pending" });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("flow-node-valve-done")).toBeDefined();
    });
    expect(screen.queryByTestId("s2-valve-interlock-count")).toBeNull();
  });

  test("the learning-loop node exposes an interlock-history drill-down link", () => {
    mockPlantBoardFetch();
    renderPlantFlow();
    const link = screen.getByTestId("weld-history-link");
    expect(link).toBeDefined();
    // Clicking navigates via react-router's useNavigate — exercised here to
    // confirm it doesn't throw; the destination page has its own test file.
    expect(() => fireEvent.click(link)).not.toThrow();
  });

  // ---- Header health (mt#2590 — honest fallback) ----

  test("header reads nominal when every health source is healthy", async () => {
    mockPlantBoardFetch({ mcpServerHealthy: true, embeddingsStatus: "healthy", dbStatus: "ok" });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("header-status").textContent).toMatch(/nominal/i);
    });
  });

  test("header is not nominal when a health source reports degraded", async () => {
    mockPlantBoardFetch({ mcpServerHealthy: false });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("header-status").textContent).not.toMatch(/nominal/i);
      expect(screen.getByTestId("header-status").textContent).toMatch(/degraded/i);
    });
  });

  test("header reads unknown (not nominal) when the reachability probe itself fails", async () => {
    mockPlantBoardFetch({ basicHealthFails: true });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("header-status").textContent).toMatch(/unknown/i);
      expect(screen.getByTestId("header-status").textContent).not.toMatch(/nominal/i);
    });
  });

  // ---- Gauges (mt#2590 — real data + honest placeholder on fetch error) ----

  test("gauges render a real value and move the needle when tracker values change", async () => {
    mockPlantBoardFetch({ mcpDisconnectsEligibleCount24h: 5, subagentPartialUncommittedCount: 1 });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("gauge-value-mcp disc.").textContent).toBe("5");
      expect(screen.getByTestId("gauge-value-dispatch").textContent).toBe("1");
    });

    // Setpoints match the CLAUDE.md-documented alarm thresholds named in the sublabels.
    expect(screen.getByText("alarm 3/24h")).toBeDefined();
    expect(screen.getByText("alarm 2/sess")).toBeDefined();
  });

  test("gauges render the honest placeholder when the s3-gauges fetch fails", async () => {
    mockPlantBoardFetch({ s3GaugesFails: true });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("gauge-value-mcp disc.").textContent).toBe("—");
      expect(screen.getByTestId("gauge-value-dispatch").textContent).toBe("—");
    });
  });

  test("attention gauge always renders the honest placeholder (no HTTP surface exists)", async () => {
    mockPlantBoardFetch();
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("gauge-value-attention").textContent).toBe("—");
    });
  });

  // ---- Infra Supply (mt#2590 — real per-service health) ----

  test("infra supply dot flips within one breath poll when a supply service degrades", async () => {
    mockPlantBoardFetch({ mcpServerHealthy: true });
    renderPlantFlow();

    await waitFor(() => {
      const dot = screen.getByTestId("infra-dot-status-MCP server");
      expect(dot.getAttribute("data-health")).toBe("healthy");
    });

    cleanup();
    mockPlantBoardFetch({ mcpServerHealthy: false });
    renderPlantFlow();

    await waitFor(() => {
      const dot = screen.getByTestId("infra-dot-status-MCP server");
      expect(dot.getAttribute("data-health")).toBe("unhealthy");
    });
  });

  test("infra supply shows the honest unknown dot for reviewer bot (no HTTP surface exists)", async () => {
    mockPlantBoardFetch();
    renderPlantFlow();

    await waitFor(() => {
      const dot = screen.getByTestId("infra-dot-status-reviewer bot");
      expect(dot.getAttribute("data-health")).toBe("unknown");
    });
  });

  // ---- S4 backlog + deploy chip (mt#2590) ----

  test("S4 backlog tank shows real TODO/PLANNING counts", async () => {
    mockPlantBoardFetch({
      tasks: [
        { id: "mt-1", title: "a", status: "TODO" },
        { id: "mt-2", title: "b", status: "TODO" },
        { id: "mt-3", title: "c", status: "PLANNING" },
      ],
    });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByText("PLANNING 1 · TODO 2")).toBeDefined();
    });
  });

  test("S4 deploy chip shows an honest placeholder when deploy status is unreachable", async () => {
    mockPlantBoardFetch({ deployStatus: null });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("s4-deploy-chip").textContent).toContain("—");
    });
  });

  test("S4 deploy chip shows live when deploy status is SUCCESS", async () => {
    mockPlantBoardFetch({ deployStatus: "SUCCESS" });
    renderPlantFlow();

    await waitFor(() => {
      expect(screen.getByTestId("s4-deploy-chip").textContent).toContain("live");
    });
  });

  // ---- S4 mesh region (mt#2591 — canon: mt#2375 §S4 "reserved/honestly-empty") ----

  test("S4 renders an honestly-empty mesh region with no fake data", () => {
    mockTasksFetch([]);
    renderPlantFlow();
    const mesh = screen.getByTestId("s4-mesh-region");
    expect(mesh).toBeDefined();
    expect(mesh.textContent).toMatch(/mesh.*reserved/i);
    // No numeric/status content — an honestly-empty placeholder, not a stat.
    expect(mesh.textContent).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// Time-scrubber replay (mt#2600) — scrubber-untouched-changes-nothing is
// covered implicitly by every `describe("PlantFlowPage", ...)` test above
// (mode defaults to "live", ScrubberBar's own fetch stays disabled until a
// window is committed); this block adds explicit coverage for that
// invariant plus the replay-specific behavior itself.
// ---------------------------------------------------------------------------

describe("time-scrubber replay (mt#2600)", () => {
  function fillReplayWindow(sinceLocal: string, untilLocal: string) {
    fireEvent.change(screen.getByLabelText("Replay window start"), {
      target: { value: sinceLocal },
    });
    fireEvent.change(screen.getByLabelText("Replay window end"), {
      target: { value: untilLocal },
    });
  }

  test("scrubber untouched: no replay banner/frame border, live controls unaffected", () => {
    mockPlantBoardFetch();
    renderPlantFlow();

    expect(screen.getByTestId("scrubber-bar")).toBeDefined();
    expect(screen.getByTestId("replay-frame")).toBeDefined();
    expect(screen.queryByTestId("replay-banner")).toBeNull();
    expect(screen.queryByTestId("replay-indicator")).toBeNull();
    // The live-mode since/until inputs are shown; "Enter replay" is disabled
    // until both are filled with a valid, ordered range.
    expect(screen.getByLabelText("Replay window start")).toBeDefined();
    expect(screen.getByLabelText("Replay window end")).toBeDefined();
    expect((screen.getByLabelText("Enter replay") as HTMLButtonElement).disabled).toBe(true);
  });

  test("entering replay shows the honest-motion banner + border frame and replays the window's gestures", async () => {
    mockPlantBoardFetch({
      replayEvents: [
        {
          id: "e1",
          eventType: "task.status_changed",
          payload: { newStatus: "DONE" },
          createdAt: "2026-07-03T23:25:00.000Z",
        },
        {
          id: "e2",
          eventType: "pr.merged",
          payload: {},
          createdAt: "2026-07-03T23:25:00.050Z",
        },
      ],
    });
    const { container } = renderPlantFlow();

    fillReplayWindow("2026-07-03T20:00:00", "2026-07-03T20:10:00");
    fireEvent.click(screen.getByLabelText("Enter replay"));

    await waitFor(() => {
      expect(screen.getByTestId("replay-banner")).toBeDefined();
      expect(screen.getByTestId("replay-indicator")).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText("Play replay"));

    await waitFor(
      () => {
        expect(container.querySelectorAll(".vsm-gesture-pulse").length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );
  });

  test("exiting replay clears the banner/frame and returns to the live scrubber controls", async () => {
    mockPlantBoardFetch({ replayEvents: [] });
    renderPlantFlow();

    fillReplayWindow("2026-07-03T20:00:00", "2026-07-03T20:10:00");
    fireEvent.click(screen.getByLabelText("Enter replay"));

    await waitFor(() => {
      expect(screen.getByTestId("replay-banner")).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText("Exit replay"));

    await waitFor(() => {
      expect(screen.queryByTestId("replay-banner")).toBeNull();
      expect(screen.queryByTestId("replay-indicator")).toBeNull();
      expect(screen.getByLabelText("Replay window start")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Retired-route redirects (mt#2423) — exercises App.tsx's plantRoutes wiring:
// /plant renders the board; the retired comparison paths redirect to it.
// ---------------------------------------------------------------------------

describe("plant route convergence (App.tsx plantRoutes)", () => {
  function renderPlantRoutesAt(initialPath: string) {
    const queryClient = createTestQueryClient();
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={null}>
            <Routes>{plantRoutes}</Routes>
          </Suspense>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  test("/plant renders the node-link board", async () => {
    mockTasksFetch([]);
    renderPlantRoutesAt("/plant");
    await waitFor(() => {
      expect(screen.getByTestId("plant-flow-page")).toBeDefined();
    });
  });

  test("/plant-flow redirects to the /plant board", async () => {
    mockTasksFetch([]);
    renderPlantRoutesAt("/plant-flow");
    await waitFor(() => {
      expect(screen.getByTestId("plant-flow-page")).toBeDefined();
    });
  });

  test("/plant-grid redirects to the /plant board", async () => {
    mockTasksFetch([]);
    renderPlantRoutesAt("/plant-grid");
    await waitFor(() => {
      expect(screen.getByTestId("plant-flow-page")).toBeDefined();
    });
  });
});