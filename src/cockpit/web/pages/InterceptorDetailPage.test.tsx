/**
 * InterceptorDetailPage render tests (mt#4057 slice 2).
 *
 * The page shipped in slice 1 (mt#4010) with NO test file — its assertions
 * lived entirely in the catalog page's suite, which never rendered it. Slice 2
 * puts the health verdict on it, so it gets its own.
 *
 * The load-bearing cases are the ones where two situations look alike: a
 * declared name that never fired (measured zeros) vs one with no record at all
 * (nothing to report), and the canary verdict vs the guard-health streak — the
 * second of which cannot establish that anything works, because a fail-open
 * interceptor writes a clean decision on every crash.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InterceptorDetailPage } from "./InterceptorDetailPage";
import type { InterceptorEntry, InterceptorsPayload } from "../hooks/useInterceptors";
import type { InterceptorDetailPayload } from "../hooks/useInterceptorAggregates";
import type { InterceptorAggregateRow } from "@minsky/domain/guard-events/aggregates";

const GUARD = "example-guard";
const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function entry(overrides: Partial<InterceptorEntry> = {}): InterceptorEntry {
  return {
    guardName: GUARD,
    description: "Blocks the example failure.",
    failureClasses: ["broken-main"],
    provenance: [".minsky/hooks/example-guard.ts"],
    sourceFile: null,
    stratum: "registry",
    subject: "trajectory",
    provenanceStatus: "implementation",
    coverageGaps: [],
    registered: true,
    undescribed: false,
    point: "PreToolUse",
    pointSource: "registry",
    trajectory: null,
    interventions: [{ type: "deny" }],
    mechanism: "structural",
    role: "judge",
    coordinateGaps: [],
    families: ["guard"],
    familyState: "classified",
    deliberatelyUnauthored: false,
    ...overrides,
  };
}

function catalog(entryOverrides: Partial<InterceptorEntry> = {}): InterceptorsPayload {
  return {
    population: 1,
    divergence: { declaredButNotDescribed: [], describedButNotDeclared: [] },
    failureClasses: {
      "broken-main": {
        failure: "A commit leaves the tree unbuildable.",
        question: "What stops me committing a tree that does not build?",
      },
    },
    entries: [entry(entryOverrides)],
  };
}

function aggregateRow(overrides: Partial<InterceptorAggregateRow> = {}): InterceptorAggregateRow {
  return {
    guardName: GUARD,
    fireLog: {
      window: {
        days: 7,
        fires: 12,
        byDecision: { allow: 9, warn: 2, deny: 1, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: { avgMs: 8, p95Ms: 20, maxMs: 55, totalMs: 96, measuredFires: 12 },
      },
      lifetime: { totalFires: 340, firstFireAt: null, lastFireAt: "2026-08-12T09:00:00.000Z" },
    },
    canary: { state: "passing", lastVerifiedAt: "2026-08-13T03:00:00.000Z" },
    health: null,
    calibration: null,
    registry: null,
    ...overrides,
  };
}

function detailPayload(overrides: Partial<InterceptorDetailPayload> = {}): InterceptorDetailPayload {
  return {
    guardName: GUARD,
    windowDays: 7,
    row: aggregateRow(),
    unknownToFireLog: false,
    snapshotComputedAt: "2026-08-13T20:00:00.000Z",
    ...overrides,
  };
}

/**
 * A slow-topology row, the shape `/plant/interlock-history` used to render and
 * `InstallProvenanceField` renders now (mt#4229).
 */
function topologyRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "example-guard",
    sourceDir: ".minsky/hooks",
    installDate: "2026-05-01T00:00:00.000Z",
    commitSha: "abcdef1234567890",
    commitUrl: "https://github.com/edobry/minsky/commit/abcdef1234567890",
    retrospective: {
      eventId: "e1",
      note: "the incident that produced it",
      taskId: "mt#1234",
      createdAt: "2026-04-30T00:00:00.000Z",
      matchType: "task-ref",
    },
    ...overrides,
  };
}

type TopologyResponse =
  | { state: "ok"; payload: { status: string; computedAt: string | null; interlockCount: number; entries: unknown[] } }
  | { state: "error" };

function renderDetail(
  detail?: InterceptorDetailPayload,
  opts: { entry?: Partial<InterceptorEntry>; topology?: TopologyResponse } = {}
) {
  global.fetch = mock(async (input: unknown) => {
    const url = String(input);
    // The install-provenance join's source (mt#4229). Defaults to a ready sweep
    // carrying the one row `example-guard` joins to.
    if (url.includes("slow-topology")) {
      const t: TopologyResponse = opts.topology ?? {
        state: "ok",
        payload: {
          status: "ready",
          computedAt: "2026-08-17T00:00:00.000Z",
          interlockCount: 1,
          entries: [topologyRow()],
        },
      };
      if (t.state === "error") {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(t), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const payload = url.includes("interceptor-aggregates") ? detail : catalog(opts.entry);
    if (payload === undefined) {
      // Stands in for the widget being unreachable: the page must degrade to
      // its pending copy rather than rendering an empty health section.
      return new Response(JSON.stringify({ state: "degraded", reason: "no snapshot yet" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ state: "ok", payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/interceptors/${GUARD}`]}>
        <Routes>
          <Route path="/interceptors/:name" element={<InterceptorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("InterceptorDetailPage — the three questions slice 1 declined", () => {
  test("slice 1's scope note is GONE, not softened", async () => {
    renderDetail(detailPayload());
    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-page")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptor-detail-scope-note")).toBeNull();
  });

  test("renders the canary-backed state, the window activity, and the cost", async () => {
    renderDetail(detailPayload());

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-state-active")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-detail-window-fires").textContent).toContain("12 fires");
    expect(screen.getByTestId("interceptor-cost").textContent).toContain("12 measured");
  });

  test("every figure names the store it came from", async () => {
    // mt#3754 SC6. Four stores feed this page; a reader who cannot tell them
    // apart cannot tell "no errors" from "verified working".
    renderDetail(detailPayload());

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-sources")).toBeTruthy();
    });
    const sources = screen.getByTestId("interceptor-detail-sources").textContent ?? "";
    expect(sources).toContain("guard_events");
    expect(sources).toContain("guard_canary_runs");
    expect(sources).toContain("calibration");
    expect(sources).toContain("guard-health tracker");
  });

  test("overrides are surfaced by env var, not folded into the fire count", async () => {
    renderDetail(
      detailPayload({
        row: aggregateRow({
          fireLog: {
            window: {
              days: 7,
              fires: 5,
              byDecision: { allow: 0, warn: 0, deny: 5, other: 0 },
              overrides: { total: 2, byEnvVar: { MINSKY_SKIP_EXAMPLE: 2 } },
              duration: null,
            },
            lifetime: { totalFires: 5, firstFireAt: null, lastFireAt: null },
          },
        }),
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-overrides")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-detail-overrides").textContent).toContain(
      "MINSKY_SKIP_EXAMPLE"
    );
  });
});

describe("InterceptorDetailPage — lookalike states stay distinct", () => {
  test("a declared name that never fired shows dormant with measured zeros", async () => {
    renderDetail(
      detailPayload({
        unknownToFireLog: true,
        row: aggregateRow({
          fireLog: {
            window: {
              days: 7,
              fires: 0,
              byDecision: { allow: 0, warn: 0, deny: 0, other: 0 },
              overrides: { total: 0, byEnvVar: {} },
              duration: null,
            },
            lifetime: { totalFires: 0, firstFireAt: null, lastFireAt: null },
          },
        }),
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-state-dormant")).toBeTruthy();
    });
    // Not "broken", and not healthy-by-default (mt#3754 AT2).
    expect(screen.queryByTestId("interceptor-state-broken")).toBeNull();
    expect(screen.queryByTestId("interceptor-state-active")).toBeNull();
  });

  test("a name with no record at all reports nothing, which is not zero", async () => {
    renderDetail(detailPayload({ row: null, unknownToFireLog: true }));

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-no-aggregate")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptor-detail-window-fires")).toBeNull();
  });

  test("a broken canary reports BROKEN and its since-date, whatever the fire count says", async () => {
    renderDetail(
      detailPayload({
        row: aggregateRow({
          canary: {
            state: "broken",
            brokenSinceAt: "2026-08-09T03:00:00.000Z",
            lastCheckedAt: "2026-08-13T03:00:00.000Z",
          },
        }),
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-state-broken")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-state-broken").textContent).toContain("2026-08-09");
    // AT1: the fire-count-derived row is unchanged by the broken verdict.
    expect(screen.getByTestId("interceptor-detail-window-fires").textContent).toContain("12 fires");
  });

  test("the guard-health streak is labelled as streaks, NOT as a health verdict", async () => {
    // A fail-open interceptor writes `allow` on every crash, so a clean streak
    // is compatible with being completely broken. The label is what stops the
    // reader treating it as a second opinion on the canary.
    renderDetail(
      detailPayload({
        row: aggregateRow({
          health: { liveness: "recovered", failureCount24h: 0, failureCount7d: 2, consecutiveStreak: 0 },
        }),
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-health-streaks")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-detail-health-streaks").textContent).toContain(
      "recovered"
    );
    // The label, exactly — a loose text match also hits the traceability list's
    // own "error streaks" line, which is a different claim.
    expect(screen.getByText("Error streaks (not a health verdict)")).toBeTruthy();
  });

  test("before the first rollup the page says so instead of rendering an empty section", async () => {
    renderDetail(undefined);

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-detail-health-pending")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-detail-health-pending").textContent).toContain(
      "not zero"
    );
  });
});

/**
 * Install provenance — the coverage `WeldHistoryPage.test.tsx` carried before
 * mt#4229 absorbed that page (PR #3087 R1 flagged its deletion as a regression).
 *
 * The load-bearing property is that FOUR different reasons for "no install date"
 * stay four different messages. Collapsing any of them into the drift warning
 * makes the corpus look broken when the truth is a cold cache, a dead widget, or
 * an entry that never had a hook file — which is the absence-vs-declaration
 * conflation the whole catalog exists to prevent.
 */
describe("InterceptorDetailPage — install provenance (mt#4229)", () => {
  test("renders install date, commit link and retrospective for a joined entry", async () => {
    renderDetail(detailPayload(), { entry: { sourceFile: "example-guard" } });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-install-provenance")).toBeTruthy();
    });
    const panel = screen.getByTestId("interceptor-install-provenance");
    expect(panel.textContent).toContain("abcdef1");
    expect(panel.textContent).toContain("the incident that produced it");
    expect(panel.textContent).toContain("mt#1234");
    expect(panel.textContent).toContain(".minsky/hooks/example-guard.ts");
  });

  test("an entry with no hook file says so, rather than reporting drift", async () => {
    renderDetail(detailPayload(), { entry: { sourceFile: null } });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-install-not-a-file")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptor-install-unresolved")).toBeNull();
  });

  test("a named file the walk did not find IS reported as drift", async () => {
    renderDetail(detailPayload(), {
      entry: { sourceFile: "a-file-the-walk-never-saw" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-install-unresolved")).toBeTruthy();
    });
  });

  test("a failed topology fetch is 'unavailable', NOT drift", async () => {
    renderDetail(detailPayload(), {
      entry: { sourceFile: "example-guard" },
      topology: { state: "error" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-install-unavailable")).toBeTruthy();
    });
    // The distinction this test exists for: a dead widget must not be reported
    // as the catalog and the file walk having diverged.
    expect(screen.queryByTestId("interceptor-install-unresolved")).toBeNull();
  });

  test("a sweep that has not completed is 'pending', NOT drift", async () => {
    renderDetail(detailPayload(), {
      entry: { sourceFile: "example-guard" },
      topology: {
        state: "ok",
        payload: { status: "pending", computedAt: null, interlockCount: 0, entries: [] },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-install-pending")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptor-install-unresolved")).toBeNull();
  });
});
