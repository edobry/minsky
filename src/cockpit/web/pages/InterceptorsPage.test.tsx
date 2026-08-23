/**
 * InterceptorsPage render tests (mt#4010 slice 1, mt#4057 slice 2).
 *
 * The load-bearing assertions are the two the slicing decision turns on:
 * every declared entry is RENDERED (population-completeness), and an
 * undescribed one renders its explicit marker rather than a blank cell.
 *
 * Slice 2 replaced the "health and cost are ABSENT" block with its inverse.
 * The constraint that survived the replacement, and is the easiest to violate
 * later: a figure whose SOURCE failed still must not render as zero.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InterceptorsPage } from "./InterceptorsPage";
import type { InterceptorEntry, InterceptorsPayload } from "../hooks/useInterceptors";
import type { InterceptorAggregatesCatalogPayload } from "../hooks/useInterceptorAggregates";
import type {
  InterceptorAggregateRow,
  InterceptorAggregatesSnapshot,
} from "@minsky/domain/guard-events/aggregates";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function entry(overrides: Partial<InterceptorEntry> = {}): InterceptorEntry {
  return {
    guardName: "example-guard",
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
    // Axis coordinates (mt#4056) — a fully-resolved `classified` default.
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

function payload(overrides: Partial<InterceptorsPayload> = {}): InterceptorsPayload {
  return {
    population: 1,
    divergence: { declaredButNotDescribed: [], describedButNotDeclared: [] },
    failureClasses: {
      "broken-main": {
        failure: "A commit leaves the tree unbuildable.",
        question: "What stops me committing a tree that does not build?",
      },
    },
    entries: [entry()],
    ...overrides,
  };
}

function aggregateRow(
  overrides: {
    guardName?: string;
    windowFires?: number;
    lifetimeFires?: number;
    canary?: InterceptorAggregateRow["canary"];
    duration?: InterceptorAggregateRow["fireLog"]["window"]["duration"];
  } = {}
): InterceptorAggregateRow {
  return {
    guardName: overrides.guardName ?? "example-guard",
    fireLog: {
      window: {
        days: 7,
        fires: overrides.windowFires ?? 4,
        byDecision: { allow: overrides.windowFires ?? 4, warn: 0, deny: 0, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: overrides.duration ?? null,
      },
      lifetime: { totalFires: overrides.lifetimeFires ?? 40, firstFireAt: null, lastFireAt: null },
    },
    canary: overrides.canary === undefined ? { state: "passing" } : overrides.canary,
    health: null,
    calibration: null,
    registry: null,
  };
}

function snapshot(
  overrides: Partial<InterceptorAggregatesSnapshot> = {}
): InterceptorAggregatesSnapshot {
  const rows = overrides.rows ?? [aggregateRow()];
  return {
    computedAt: "2026-08-13T20:00:00.000Z",
    windowDays: 7,
    population: rows.length,
    rows,
    declaredOnlyRows: overrides.declaredOnlyRows ?? [],
    calibrationReviewDue: overrides.calibrationReviewDue ?? [],
    sources: {},
    sourceFailures: overrides.sourceFailures ?? [],
    refreshDurationMs: 2500,
    ...overrides,
  };
}

/**
 * Route by widget id rather than answering every request with one payload:
 * the page now makes TWO independent fetches, and a single-answer mock would
 * feed the catalog payload to the aggregates hook and quietly render the
 * pending state in every test.
 */
function renderPage(p: InterceptorsPayload, aggregates?: InterceptorAggregatesCatalogPayload) {
  global.fetch = mock(async (input: unknown) => {
    const url = String(input);
    const payloadForUrl = url.includes("interceptor-aggregates")
      ? (aggregates ?? { status: "pending" as const, snapshot: null })
      : p;
    return new Response(JSON.stringify({ state: "ok", payload: payloadForUrl }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InterceptorsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("InterceptorsPage — population completeness", () => {
  test("renders one row per declared entry", async () => {
    const entries = [
      entry({ guardName: "alpha-guard" }),
      entry({ guardName: "beta-detector", stratum: "standalone" }),
      entry({ guardName: "gamma-step", stratum: "precommit" }),
    ];
    renderPage(payload({ population: entries.length, entries }));

    await waitFor(() => {
      expect(screen.getAllByTestId("interceptor-row").length).toBe(entries.length);
    });
    // Derived from the payload, not a hard-coded number: the assertion has to
    // survive the corpus growing.
    expect(screen.getByTestId("interceptors-summary").textContent).toContain(String(entries.length));
  });

  test("mounts the lifecycle spine over the same entries, with a merge gate at the merge station (mt#4011)", async () => {
    const entries = [
      entry({ guardName: "alpha-guard" }),
      entry({ guardName: "merge-gate", trajectory: "delivery" }),
    ];
    renderPage(payload({ population: entries.length, entries }));

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-spine")).toBeTruthy();
    });
    const merge = screen.getByTestId("spine-station-merge-time");
    expect(merge.querySelector('[data-guard="merge-gate"]')).toBeTruthy();
  });

  test("groups by stratum, and a stratum with no entries renders no heading", async () => {
    renderPage(
      payload({ entries: [entry({ guardName: "only-registry", stratum: "registry" })] })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptors-group-registry")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptors-group-fixture")).toBeNull();
  });
});

describe("InterceptorsPage — gaps render as gaps", () => {
  test("an undescribed entry shows the explicit marker, not an empty cell", async () => {
    renderPage(
      payload({
        entries: [
          entry({
            guardName: "orphan-guard",
            description: null,
            undescribed: true,
            failureClasses: [],
            provenance: [],
            provenanceStatus: "none",
            coverageGaps: ["tuningOwnership", "attentionCost", "canary"],
            registered: false,
          }),
        ],
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-undescribed")).toBeTruthy();
    });
    expect(screen.getByTestId("interceptor-undescribed").textContent).toContain("undescribed");
  });

  test("population divergence surfaces as a finding when present", async () => {
    renderPage(
      payload({
        divergence: {
          declaredButNotDescribed: ["ghost-guard"],
          describedButNotDeclared: [],
        },
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("interceptors-divergence").textContent).toContain("ghost-guard");
    });
  });

  test("no divergence renders NO reassuring zero — the block is absent", async () => {
    renderPage(payload());
    await waitFor(() => {
      expect(screen.getAllByTestId("interceptor-row").length).toBe(1);
    });
    expect(screen.queryByTestId("interceptors-divergence")).toBeNull();
  });
});

describe("InterceptorsPage — health and cost (mt#4057 slice 2)", () => {
  test("slice 1's scope note is GONE, not softened", async () => {
    // SC5. The note's entire function was to mark the gap while it existed;
    // leaving any version of it keeps telling the reader a question is
    // unanswered that this page now answers.
    renderPage(payload(), { status: "ready", snapshot: snapshot() });
    await waitFor(() => {
      expect(screen.getByTestId("interceptors-attention-bar")).toBeTruthy();
    });
    expect(screen.queryByTestId("interceptors-scope-note")).toBeNull();
  });

  test("the attention counts render above the fold, from their own sources", async () => {
    renderPage(payload(), {
      status: "ready",
      snapshot: snapshot({
        rows: [
          aggregateRow({ guardName: "a", canary: { state: "broken", brokenSinceAt: "2026-08-01T00:00:00Z" } }),
          aggregateRow({ guardName: "b", canary: { state: "never-verified" } }),
        ],
        calibrationReviewDue: [
          { logName: "l1", mappedGuardName: "a", reason: "past-threshold", injectedFiresSinceLastReview: 9 },
          { logName: "l2", mappedGuardName: "b", reason: "never-fired", injectedFiresSinceLastReview: 0 },
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("attention-broken")).toBeTruthy();
    });
    expect(screen.getByTestId("attention-broken").textContent).toContain("1");
    expect(screen.getByTestId("attention-never-verified").textContent).toContain("1");
    expect(screen.getByTestId("attention-review-due").textContent).toContain("1");
    expect(screen.getByTestId("attention-graduation-overdue").textContent).toContain("1");
  });

  test("a failed source renders as unavailable, NEVER as zero", async () => {
    // The constraint that outlived slice 1's absence discipline: "0 broken"
    // and "we could not check" are opposite messages, and the second one is
    // the state that actually needs the operator.
    renderPage(payload(), {
      status: "ready",
      snapshot: snapshot({ rows: [aggregateRow({ canary: null })], sourceFailures: ["canary"] }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("attention-broken")).toBeTruthy();
    });
    expect(screen.getByTestId("attention-broken").textContent).toContain("—");
    expect(screen.getByTestId("attention-broken").textContent).not.toContain("0");
    expect(screen.getByTestId("interceptors-source-failures").textContent).toContain("canary");
  });

  test("each row carries its state chip and its cost figure with the measured denominator", async () => {
    renderPage(payload(), {
      status: "ready",
      snapshot: snapshot({
        rows: [
          aggregateRow({
            guardName: "example-guard",
            windowFires: 400,
            duration: { avgMs: 12.5, p95Ms: 30, maxMs: 88, totalMs: 150, measuredFires: 12 },
          }),
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-state-active")).toBeTruthy();
    });
    const cost = screen.getByTestId("interceptor-cost").textContent ?? "";
    expect(cost).toContain("12 measured");
    // The 388 fires with no recorded duration are named, so the total cannot
    // be read as covering all 400.
    expect(cost).toContain("388 untimed");
  });

  test("a declared name with no aggregate row is marked, not left blank", async () => {
    renderPage(payload({ entries: [entry({ guardName: "ghost-guard" })] }), {
      status: "ready",
      snapshot: snapshot({ rows: [aggregateRow({ guardName: "someone-else" })] }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("interceptor-no-aggregate")).toBeTruthy();
    });
  });

  test("before the first rollup, the pending state says so instead of showing zeros", async () => {
    renderPage(payload());
    await waitFor(() => {
      expect(screen.getByTestId("interceptors-health-pending")).toBeTruthy();
    });
    expect(screen.queryByTestId("attention-broken")).toBeNull();
    expect(screen.getByTestId("interceptors-health-pending").textContent).toContain("not zero");
  });
});
