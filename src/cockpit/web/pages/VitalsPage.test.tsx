/**
 * VitalsPage tests (mt#2601).
 *
 * Verifies the /vitals route component:
 *   - Live-data state: all four loop cards render live values from their
 *     respective (mocked) endpoints.
 *   - Placeholder-on-error state: a fetch failure for one loop's endpoint
 *     surfaces an honest "unavailable" status line, not a blank/crashed card
 *     or fabricated data — and doesn't take down the other three cards.
 *   - No horizontal-overflow container assumptions: the page root and the
 *     card grid use `min-w-0`, never a fixed width wider than the mobile
 *     viewport.
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/VitalsPage.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { VitalsPage } from "./VitalsPage";

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

function renderVitalsPage() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={["/vitals"]}>
      <QueryClientProvider client={queryClient}>
        <VitalsPage />
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASKS_PAYLOAD = {
  tasks: [
    { id: "mt#1", title: "a", status: "READY" },
    { id: "mt#2", title: "b", status: "READY" },
    { id: "mt#3", title: "c", status: "IN-PROGRESS" },
    { id: "mt#4", title: "d", status: "IN-REVIEW" },
  ],
};

function activityPayload(eventType: string, count: number) {
  const now = Date.now();
  return {
    events: Array.from({ length: count }, (_, i) => ({
      eventType,
      createdAt: new Date(now - i * 60_000).toISOString(),
    })),
    total: count,
    limit: 200,
  };
}

const ATTENTION_WIDGET_PAYLOAD_EMPTY = {
  state: "ok",
  payload: { activeWindow: null, cohort: [], totalPending: 0 },
};

const ASKS_PAYLOAD_EMPTY = { asks: [], total: 0 };

const BASIC_HEALTH_OK = { state: "ok", payload: { ok: true } };
const EMBEDDINGS_HEALTH_OK = { state: "ok", payload: { status: "healthy" } };
const API_HEALTH_OK = { db: "ok" };
const CREDENTIALS_OK = { credentials: [{ provider: "anthropic", configured: true }] };

const MCP_SERVER_STATUS_PAYLOAD = {
  state: "ok",
  payload: {
    health: { ok: true, statusCode: 200, lastProbeAt: new Date().toISOString(), consecutiveFailureMs: 0 },
    lastDowntimeAt: null,
    uptime24hPct: 99.9,
    deploy: {
      commitHash: "abc1234",
      commitMessage: "feat: x",
      lastDeployAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      status: "SUCCESS",
    },
    recentErrors: [],
    metrics: null,
    anomalies: {
      m1HealthFailing: false,
      m2DeployFailed: false,
      m3RestartLoop: false,
      m4ResourceNearLimit: false,
    },
  },
};

/**
 * Builds a fetch mock routing every endpoint VitalsPage's hooks touch.
 * Any endpoint not explicitly overridden falls back to a benign default so
 * tests only need to specify the endpoint(s) under test.
 */
function mockVitalsFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  const defaults: Record<string, () => Promise<Response>> = {
    "/api/tasks": () => Promise.resolve(new Response(JSON.stringify(TASKS_PAYLOAD), { status: 200 })),
    "/api/asks": () => Promise.resolve(new Response(JSON.stringify(ASKS_PAYLOAD_EMPTY), { status: 200 })),
    "/api/health": () => Promise.resolve(new Response(JSON.stringify(API_HEALTH_OK), { status: 200 })),
    "/api/credentials": () =>
      Promise.resolve(new Response(JSON.stringify(CREDENTIALS_OK), { status: 200 })),
    "/api/widget/basic-health/data": () =>
      Promise.resolve(new Response(JSON.stringify(BASIC_HEALTH_OK), { status: 200 })),
    "/api/widget/embeddings-health/data": () =>
      Promise.resolve(new Response(JSON.stringify(EMBEDDINGS_HEALTH_OK), { status: 200 })),
    "/api/widget/attention/data": () =>
      Promise.resolve(new Response(JSON.stringify(ATTENTION_WIDGET_PAYLOAD_EMPTY), { status: 200 })),
    "/api/widget/mcp-server-status/data": () =>
      Promise.resolve(new Response(JSON.stringify(MCP_SERVER_STATUS_PAYLOAD), { status: 200 })),
  };

  const merged = { ...defaults, ...overrides };

  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/activity") {
      const eventType = new URL(url, "http://localhost").searchParams.get("eventType") ?? "";
      const handler = overrides[`/api/activity:${eventType}`];
      if (handler) return handler();
      return Promise.resolve(new Response(JSON.stringify(activityPayload(eventType, 0)), { status: 200 }));
    }
    const handler = merged[pathname];
    if (handler) return handler();
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests: live data renders
// ---------------------------------------------------------------------------

describe("VitalsPage — live data", () => {
  test("renders all four loop cards", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      expect(screen.getByTestId("loop-card-work")).toBeDefined();
      expect(screen.getByTestId("loop-card-learning")).toBeDefined();
      expect(screen.getByTestId("loop-card-attention")).toBeDefined();
      expect(screen.getByTestId("loop-card-deploy")).toBeDefined();
    });
  });

  test("work loop card shows live READY/in-progress/in-review counts from /api/tasks", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-work");
      expect(card.textContent).toContain("2"); // 2 READY tasks
      expect(card.textContent).toContain("1 in progress, 1 in review");
    });
  });

  test("learning loop card shows a live memory-creation count from /api/activity", async () => {
    mockVitalsFetch({
      "/api/activity:memory.created": () =>
        Promise.resolve(new Response(JSON.stringify(activityPayload("memory.created", 3)), { status: 200 })),
    });
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-learning");
      expect(card.textContent).toContain("3");
      // Honest gap for retrospective activity (mt#2537) — not fabricated.
      expect(card.textContent).toContain("mt#2537");
    });
  });

  test("attention loop card shows live open-ask count and highlights when asks are pending", async () => {
    mockVitalsFetch({
      "/api/widget/attention/data": () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              state: "ok",
              payload: {
                activeWindow: null,
                cohort: [{ createdAt: new Date(Date.now() - 3_600_000).toISOString() }],
                totalPending: 1,
              },
            }),
            { status: 200 }
          )
        ),
      "/api/asks": () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ asks: [{ createdAt: new Date(Date.now() - 3_600_000).toISOString() }], total: 1 }),
            { status: 200 }
          )
        ),
    });
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-attention");
      expect(card.textContent).toContain("Oldest pending");
      expect(screen.getByTestId("vitals-needs-you")).toBeDefined();
    });
  });

  test("attention loop card shows 'No open asks' when nothing is pending", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-attention");
      expect(card.textContent).toContain("No open asks");
    });
    expect(screen.queryByTestId("vitals-needs-you")).toBeNull();
  });

  test("deploy loop card shows the live deploy status from the mcp-server-status widget", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-deploy");
      expect(card.textContent).toContain("OK"); // SUCCESS -> short code
      expect(card.textContent).toContain("Last deploy");
    });
  });

  test("deploy loop card's sparkline is an honest placeholder naming mt#2537", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-deploy");
      expect(card.textContent).toContain("mt#2537");
    });
  });

  test("aggregate header line reflects real system health", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    await waitFor(() => {
      expect(screen.getByText(/system nominal/)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: aggregate header — all three HeaderHealth branches
//
// mt#2601 review round 1: the reviewer flagged the header presentation's
// degraded/unknown branches as untested (only "nominal" was covered above).
// These three tests lock in the full state space so a future edit that
// breaks the degraded/unknown mapping fails a test instead of shipping
// silently. See VitalsPage.tsx's headerStatusPresentation doc comment for
// why this mapping is a verified-identical duplicate of PlantFlowPage.tsx's
// (that file is out of scope to edit — see file-surface note in the PR).
// ---------------------------------------------------------------------------

describe("VitalsPage — aggregate header health states", () => {
  test("renders 'system nominal' (liveness-healthy) when every constituent source is healthy", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    const header = await screen.findByText(/system nominal/);
    expect(header.className).toContain("text-liveness-healthy");
  });

  test("renders 'system degraded' (warn-amber) when a constituent source reports unhealthy", async () => {
    mockVitalsFetch({
      "/api/widget/embeddings-health/data": () =>
        Promise.resolve(
          new Response(JSON.stringify({ state: "ok", payload: { status: "degraded" } }), {
            status: 200,
          })
        ),
    });
    renderVitalsPage();
    const header = await screen.findByText(/system degraded/);
    expect(header.className).toContain("text-warn-amber");
  });

  test("renders 'status unknown' (muted-foreground) when the basic-health reachability probe itself fails", async () => {
    mockVitalsFetch({
      "/api/widget/basic-health/data": () =>
        Promise.resolve(
          new Response(JSON.stringify({ state: "degraded", reason: "unreachable" }), {
            status: 200,
          })
        ),
    });
    renderVitalsPage();
    const header = await screen.findByText(/status unknown/);
    expect(header.className).toContain("text-muted-foreground");
  });
});

// ---------------------------------------------------------------------------
// Tests: deploy loop card — all DeploymentStatus branches
//
// Same class of gap as the header states above: only SUCCESS was covered.
// Locks in the short-code + attention-highlight mapping for every status.
// ---------------------------------------------------------------------------

describe("VitalsPage — deploy loop status variants", () => {
  function mockDeployStatus(status: string, deploy: Record<string, unknown> | null = {}) {
    mockVitalsFetch({
      "/api/widget/mcp-server-status/data": () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              state: "ok",
              payload: {
                ...MCP_SERVER_STATUS_PAYLOAD.payload,
                deploy:
                  deploy === null
                    ? null
                    : {
                        commitHash: "abc1234",
                        commitMessage: "x",
                        lastDeployAt: new Date().toISOString(),
                        status,
                        ...deploy,
                      },
              },
            }),
            { status: 200 }
          )
        ),
    });
  }

  test("FAILED status shows the 'FAIL' short code and highlights the card border", async () => {
    mockDeployStatus("FAILED");
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => expect(card.textContent).toContain("FAIL"));
    expect(card.className).toContain("border-[oklch(var(--vsm-seam)/0.6)]");
  });

  test("CRASHED status shows the 'CRSH' short code and highlights the card border", async () => {
    mockDeployStatus("CRASHED");
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => expect(card.textContent).toContain("CRSH"));
    expect(card.className).toContain("border-[oklch(var(--vsm-seam)/0.6)]");
  });

  test("BUILDING status shows the 'BLD' short code without highlighting the border", async () => {
    mockDeployStatus("BUILDING");
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => expect(card.textContent).toContain("BLD"));
    expect(card.className).not.toContain("border-[oklch(var(--vsm-seam)/0.6)]");
  });

  test("DEPLOYING status shows the 'DPL' short code", async () => {
    mockDeployStatus("DEPLOYING");
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => expect(card.textContent).toContain("DPL"));
  });

  test("CANCELLED status shows the 'CNCL' short code", async () => {
    mockDeployStatus("CANCELLED");
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => expect(card.textContent).toContain("CNCL"));
  });

  test("no deploy recorded (null deploy field) shows the '?' short code and an honest status line", async () => {
    mockDeployStatus("UNKNOWN", null);
    renderVitalsPage();
    const card = await screen.findByTestId("loop-card-deploy");
    await waitFor(() => {
      expect(card.textContent).toContain("?");
      expect(card.textContent).toContain("No deploy recorded yet");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: placeholder-on-error state
// ---------------------------------------------------------------------------

describe("VitalsPage — error handling", () => {
  test("work loop card shows an honest unavailable status when /api/tasks fails, without breaking other cards", async () => {
    mockVitalsFetch({
      "/api/tasks": () => Promise.reject(new Error("network error")),
    });
    renderVitalsPage();
    await waitFor(() => {
      const workCard = screen.getByTestId("loop-card-work");
      expect(workCard.textContent).toContain("unavailable");
    });
    // Other cards still render normally.
    expect(screen.getByTestId("loop-card-learning")).toBeDefined();
    expect(screen.getByTestId("loop-card-attention")).toBeDefined();
    expect(screen.getByTestId("loop-card-deploy")).toBeDefined();
  });

  test("deploy loop card shows an honest unavailable status when the mcp-server-status widget errors", async () => {
    mockVitalsFetch({
      "/api/widget/mcp-server-status/data": () =>
        Promise.resolve(
          new Response(JSON.stringify({ state: "degraded", reason: "unreachable" }), { status: 200 })
        ),
    });
    renderVitalsPage();
    await waitFor(() => {
      const deployCard = screen.getByTestId("loop-card-deploy");
      expect(deployCard.textContent).toContain("unavailable");
    });
  });

  test("attention loop card shows an honest unavailable status when the attention widget errors", async () => {
    mockVitalsFetch({
      "/api/widget/attention/data": () =>
        Promise.resolve(
          new Response(JSON.stringify({ state: "degraded", reason: "db down" }), { status: 200 })
        ),
    });
    renderVitalsPage();
    await waitFor(() => {
      const card = screen.getByTestId("loop-card-attention");
      expect(card.textContent).toContain("unavailable");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: no horizontal-overflow container assumptions
// ---------------------------------------------------------------------------

describe("VitalsPage — layout", () => {
  test("page root and card grid use min-w-0 (no fixed width wider than viewport)", async () => {
    mockVitalsFetch();
    renderVitalsPage();
    const root = await screen.findByTestId("vitals-page");
    expect(root.className).toContain("min-w-0");
    expect(root.className).not.toMatch(/\bw-\[\d/);

    await waitFor(() => {
      const workCard = screen.getByTestId("loop-card-work");
      expect(workCard.className).toContain("min-w-0");
    });
  });
});
