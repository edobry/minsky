/**
 * Tests for the triage-radiator home page (mt#2881).
 *
 * Pure coverage: fleet counting, per-subsystem anomaly predicates. Component
 * coverage: all-healthy renders the single calm substrate line and zero
 * status cards; a degraded subsystem expands to its full card while the rest
 * stay on the calm line; receipts (uptime/version/credentials) never render
 * on home.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HomePage, countFleet, isSubsystemAnomalous } from "./HomePage";
import type { WidgetData } from "../lib/widget-client";
import { ProjectProvider } from "../lib/project-context";
import { PEEZOMBIE_PROJECT, stubProjectsRoute } from "../lib/test-support/projects";

// ---------------------------------------------------------------------------
// Pure predicates
// ---------------------------------------------------------------------------

const ok = (payload: unknown): WidgetData => ({ state: "ok", payload });

describe("countFleet", () => {
  test("counts attention-relevant liveness only — exited/orphaned/null are not alarms", () => {
    const now = new Date("2026-07-17T12:00:00Z").getTime();
    const counts = countFleet(
      ok({
        agents: [
          { liveness: "healthy" },
          { liveness: "healthy" },
          { liveness: "idle" },
          // Recently-stale: inside the 24h window — counts.
          { liveness: "stale", lastActivityAt: "2026-07-17T02:00:00Z" },
          // Long-dead stale husk: outside the window — ignored.
          { liveness: "stale", lastActivityAt: "2026-04-21T08:02:47Z" },
          { liveness: "exited" },
          { liveness: "orphaned" },
          { liveness: null },
        ],
      }),
      now
    );
    expect(counts).toEqual({ working: 2, idle: 1, stale: 1, total: 4 });
  });

  test("returns null for degraded/missing data", () => {
    expect(countFleet(undefined)).toBeNull();
    expect(countFleet({ state: "degraded", reason: "x" })).toBeNull();
  });
});

describe("isSubsystemAnomalous", () => {
  test("widget-level degraded state is always anomalous", () => {
    expect(
      isSubsystemAnomalous("embeddings-health", { state: "degraded", reason: "db down" })
    ).toBe(true);
  });

  test("mcp: anomaly flags or failed health probe", () => {
    const healthy = ok({
      anomalies: {
        m1HealthFailing: false,
        m2DeployFailed: false,
        m3RestartLoop: false,
        m4ResourceNearLimit: false,
      },
      health: { ok: true },
    });
    expect(isSubsystemAnomalous("mcp-server-status", healthy)).toBe(false);
    const crashLoop = ok({
      anomalies: {
        m1HealthFailing: false,
        m2DeployFailed: false,
        m3RestartLoop: true,
        m4ResourceNearLimit: false,
      },
      health: { ok: true },
    });
    expect(isSubsystemAnomalous("mcp-server-status", crashLoop)).toBe(true);
  });

  test("reviewer: per-cycle query failures are anomalous (mt#2758 — never healthy zeros)", () => {
    expect(isSubsystemAnomalous("reviewer-bot-status", ok({ db: { queryFailureCount: 0 } }))).toBe(
      false
    );
    expect(isSubsystemAnomalous("reviewer-bot-status", ok({ db: { queryFailureCount: 3 } }))).toBe(
      true
    );
  });

  test("embeddings: any non-healthy provider status", () => {
    expect(isSubsystemAnomalous("embeddings-health", ok({ status: "healthy" }))).toBe(false);
    expect(isSubsystemAnomalous("embeddings-health", ok({ status: "degraded" }))).toBe(true);
    expect(isSubsystemAnomalous("embeddings-health", ok({ status: "exhausted" }))).toBe(true);
  });

  test("loading (no data yet) is not an anomaly", () => {
    expect(isSubsystemAnomalous("mcp-server-status", undefined)).toBe(false);
  });

  test("malformed ok-payload is treated like loading, not an alarm (PR #2021 R1)", () => {
    expect(isSubsystemAnomalous("mcp-server-status", ok(null))).toBe(false);
    expect(isSubsystemAnomalous("embeddings-health", ok("garbage"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

interface StubOptions {
  embeddingsStatus?: "healthy" | "degraded";
  /** Scoped attention-widget totalPending — read whenever a `project=` param is present. */
  scopedPending?: number;
  /** Unscoped attention-widget totalPending — read for the deliberately-global fetch. */
  unscopedPending?: number;
}

function stubHome({
  embeddingsStatus = "healthy",
  scopedPending = 0,
  unscopedPending = 0,
}: StubOptions = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/api/widget/attention/data")) {
      const totalPending = url.includes("project=") ? scopedPending : unscopedPending;
      return json({ state: "ok", payload: { totalPending } });
    }
    if (url.includes("/api/asks")) return json({ asks: [] });
    if (url.includes("/api/widget/agents/data"))
      return json(ok({ agents: [{ liveness: "healthy" }, { liveness: "idle" }] }));
    if (url.includes("/api/widget/mcp-server-status/data"))
      return json(
        ok({
          anomalies: {
            m1HealthFailing: false,
            m2DeployFailed: false,
            m3RestartLoop: false,
            m4ResourceNearLimit: false,
          },
          health: { ok: true, latencyMs: 12, checkedAt: "2026-07-17T00:00:00Z" },
          deploy: null,
          recentErrors: [],
          metrics: null,
        })
      );
    if (url.includes("/api/widget/reviewer-bot-status/data"))
      return json(ok({ db: { queryFailureCount: 0, queryTotalCount: 6 } }));
    if (url.includes("/api/widget/embeddings-health/data"))
      return json(
        ok({
          status: embeddingsStatus,
          provider: "openai",
          errorCount24h: embeddingsStatus === "healthy" ? 0 : 4,
          degradedReason: embeddingsStatus === "healthy" ? null : "circuit_breaker_open",
          lastErrorAt: null,
        })
      );
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
  stubProjectsRoute();
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectProvider>
          <HomePage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const PROJECT_STORAGE_KEY = "cockpit.project.v1";

/**
 * The slug these fixtures select must be one `stubProjectsRoute()`'s payload
 * actually knows (mt#4842). `ProjectProvider` falls back to "All projects"
 * when the persisted slug names no known project — a guard that was dead for
 * as long as `/api/projects` went unstubbed and `projectList` was always
 * empty, which is how an arbitrary slug used to keep the filter active here.
 */
const PEEZOMBIE_SLUG = PEEZOMBIE_PROJECT.slug;

describe("HomePage (triage radiator)", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* jsdom/happy-dom always provides localStorage; ignore if not */
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("all healthy: one calm substrate line, zero status cards, honest empty triage", async () => {
    stubHome();
    renderHome();
    await waitFor(() => {
      const line = screen.getByTestId("substrate-calm-line");
      expect(line.textContent).toContain("Substrate healthy");
      expect(line.textContent).toContain("MCP");
      expect(line.textContent).toContain("reviewer");
      expect(line.textContent).toContain("embeddings");
    });
    await waitFor(() => expect(screen.getByText("Nothing needs you")).toBeDefined());
    // Receipts stay off the radiator (they live on /settings now).
    expect(screen.queryByText(/Uptime/i)).toBeNull();
    expect(screen.queryByText(/Credentials/)).toBeNull();
    expect(screen.queryByText(/Widgets loaded/i)).toBeNull();
  });

  test("a degraded subsystem expands to its full card; the rest stay calm", async () => {
    stubHome({ embeddingsStatus: "degraded" });
    renderHome();
    // The embeddings card renders its degraded detail...
    await waitFor(() => expect(screen.getByText("circuit_breaker_open")).toBeDefined());
    // ...while the calm line covers the remaining healthy subsystems only.
    const line = screen.getByTestId("substrate-calm-line");
    expect(line.textContent).toContain("Otherwise healthy");
    expect(line.textContent).toContain("MCP");
    expect(line.textContent).not.toContain("embeddings");
  });

  test("fleet strip renders liveness counts linking to /agents", async () => {
    stubHome();
    renderHome();
    // FleetGauge (mt#2917) renders the digit and unit label as separate
    // styled spans (instrument-row treatment), so match on the gauge's
    // combined textContent rather than a single text node.
    await waitFor(() =>
      expect(screen.getByText((_, el) => el?.textContent === "1 working")).toBeDefined()
    );
    expect(screen.getByText((_, el) => el?.textContent === "1 idle")).toBeDefined();
    const strip = screen.getByLabelText("Fleet status — open agents");
    expect(strip.getAttribute("href")).toBe("/agents");
  });

  // -------------------------------------------------------------------------
  // Cross-project needs-you leak (mt#4794) — same three fixture states as
  // Rail.attention-elsewhere.test.tsx, on the home "Needs you" region.
  // -------------------------------------------------------------------------

  test("project filter active, scoped=0/unscoped=40: 'Nothing needs you' plus a muted elsewhere line", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, PEEZOMBIE_SLUG);
    stubHome({ scopedPending: 0, unscopedPending: 40 });
    renderHome();

    await waitFor(() => expect(screen.getByText("Nothing needs you")).toBeDefined());
    const elsewhere = await screen.findByTestId("needs-you-elsewhere");
    expect(elsewhere.textContent).toBe("clear here — 40 pending in other projects →");
    expect(elsewhere.getAttribute("href")).toBe("/asks");
  });

  test("project filter active, scoped=N/unscoped=N (equal): no elsewhere line", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, PEEZOMBIE_SLUG);
    stubHome({ scopedPending: 40, unscopedPending: 40 });
    renderHome();

    // Wait for the page's fetches to settle (the substrate calm line is the
    // slowest of the bunch) before asserting absence — otherwise a false
    // negative could just mean the queries haven't resolved yet. TriageBand's
    // own "Nothing needs you" is unaffected either way here: this stub's
    // `/api/asks` route always returns an empty list, independent of the
    // attention-widget `scopedPending`/`unscopedPending` fixture values.
    await waitFor(() => expect(screen.getByTestId("substrate-calm-line")).toBeDefined());
    expect(screen.queryByTestId("needs-you-elsewhere")).toBeNull();
  });

  test("All-projects selected, pending=40: never renders an elsewhere line", async () => {
    // No persisted slug => All projects.
    stubHome({ scopedPending: 40, unscopedPending: 40 });
    renderHome();

    await waitFor(() => expect(screen.getByTestId("substrate-calm-line")).toBeDefined());
    expect(screen.queryByTestId("needs-you-elsewhere")).toBeNull();
  });
});
