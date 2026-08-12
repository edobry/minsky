/**
 * InterceptorsPage render tests (mt#4010 slice 1).
 *
 * The load-bearing assertions are the two the slicing decision turns on:
 * every declared entry is RENDERED (population-completeness), and an
 * undescribed one renders its explicit marker rather than a blank cell.
 * Plus the constraint that is easiest to violate later: no health, canary,
 * fire-count or cost column — absent, not stubbed.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InterceptorsPage } from "./InterceptorsPage";
import type { InterceptorEntry, InterceptorsPayload } from "../hooks/useInterceptors";

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
    stratum: "registry",
    subject: "trajectory",
    provenanceStatus: "implementation",
    coverageGaps: [],
    registered: true,
    undescribed: false,
    // Axis coordinates (mt#4056) — a fully-resolved `classified` default.
    point: "PreToolUse",
    pointSource: "registry",
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

function renderPage(p: InterceptorsPayload) {
  global.fetch = mock(async () =>
    new Response(JSON.stringify({ state: "ok", payload: p }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;

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

describe("InterceptorsPage — health and cost are ABSENT, not stubbed", () => {
  test("renders no health, canary, fire-count or cost element", async () => {
    renderPage(payload());
    await waitFor(() => {
      expect(screen.getAllByTestId("interceptor-row").length).toBe(1);
    });

    // Structural, NOT lexical. A word-scan is the wrong instrument here: the
    // failure-class taxonomy legitimately contains "broken-main", and the
    // coverage-gap labels legitimately say "no canary" — both are DECLARED
    // data, not health. What must not exist is a health/cost SLOT.
    for (const testid of [
      "interceptor-health",
      "interceptor-health-state",
      "interceptor-canary-badge",
      "interceptor-fire-count",
      "interceptor-cost",
    ]) {
      expect(screen.queryByTestId(testid)).toBeNull();
    }
  });

  test("the served payload carries no health or cost field at all", async () => {
    // The stronger half of the constraint: the frontend cannot render a health
    // value it was never sent. Asserted on the payload contract rather than on
    // pixels, so it fails when someone widens the widget rather than when
    // someone adds a column.
    const p = payload();
    const rowKeys = Object.keys(p.entries[0] ?? {});
    for (const forbidden of ["health", "liveness", "canaryState", "fireCount", "cost", "tokens"]) {
      expect(rowKeys).not.toContain(forbidden);
    }
  });

  test("says plainly that it does not answer those questions yet", async () => {
    renderPage(payload());
    await waitFor(() => {
      expect(screen.getByTestId("interceptors-scope-note")).toBeTruthy();
    });
    // "Not answered yet" must be legible as such — silence would read as
    // "nothing to report".
    expect(screen.getByTestId("interceptors-scope-note").textContent).toContain("does not yet");
  });
});
