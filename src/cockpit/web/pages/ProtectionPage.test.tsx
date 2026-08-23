/**
 * ProtectionPage render tests (mt#4287) — the operator rendering.
 *
 * The load-bearing test is the VOCABULARY one, and it is load-bearing only
 * because of its negative control: a scan that cannot fail proves nothing, and
 * a term list that happens to match nothing on either surface would pass here
 * while catching no regression ever (mem#704). So the same scanner is pointed
 * at the MAINTAINER page, where it must FIND matches.
 *
 * The other tests pin the four derived rendering choices the module docblock
 * names, because each is the kind of thing a later pass "tidies" back toward a
 * conventional table: all-working collapses to one line, no interceptor names,
 * degraded-first ordering, and unknown never rendering as zero.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProtectionPage } from "./ProtectionPage";
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

/**
 * The banned vocabulary (mt#4287 SC4).
 *
 * Measured on the maintainer surface 2026-08-19: the LIFECYCLE half is what
 * actually crosses (`canary` 18, `calibration` 6, `review-due` 3, `graduation`
 * 3); `threshold`, `false positive`, `flip`, `deny-capable` and `tuning
 * ownership` were already at 0 there, living in the data model rather than the
 * page. Both halves are listed: the first four are the live job, the rest are
 * regression bars.
 */
const BANNED_TERMS = [
  "threshold",
  "false positive",
  "calibration",
  "review-due",
  "review due",
  "graduation",
  "canary",
  "flip/tune/keep",
  "deny-capable",
  "tuning ownership",
];

function scanForBannedTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return BANNED_TERMS.filter((term) => haystack.includes(term));
}

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
      "secret-exposure": {
        failure: "A credential reaches a persisted surface.",
        question: "What stops a secret leaking into something permanent?",
      },
      "blind-enforcement": {
        // Both fields are maintainer-plane on purpose — this is the fixture
        // that would leak if the page rendered catalog copy verbatim.
        failure: "A calibration log past its review window, or a guard erroring in a streak.",
        question: "What tells me the guards themselves are still working?",
      },
    },
    entries: [entry()],
    ...overrides,
  };
}

function aggregateRow(
  overrides: {
    guardName?: string;
    deny?: number;
    warn?: number;
    canary?: InterceptorAggregateRow["canary"];
    duration?: InterceptorAggregateRow["fireLog"]["window"]["duration"];
  } = {}
): InterceptorAggregateRow {
  const deny = overrides.deny ?? 0;
  const warn = overrides.warn ?? 0;
  return {
    guardName: overrides.guardName ?? "example-guard",
    fireLog: {
      window: {
        days: 7,
        fires: deny + warn,
        byDecision: { allow: 0, warn, deny, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: overrides.duration ?? null,
      },
      lifetime: { totalFires: deny + warn, firstFireAt: null, lastFireAt: null },
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
    declaredOnlyRows: [],
    calibrationReviewDue: [],
    sources: {},
    sourceFailures: [],
    refreshDurationMs: 2500,
    ...overrides,
  };
}

function renderWith(
  Component: () => JSX.Element,
  p: InterceptorsPayload,
  aggregates?: InterceptorAggregatesCatalogPayload
) {
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
        <Component />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const READY = (s: InterceptorAggregatesSnapshot): InterceptorAggregatesCatalogPayload => ({
  status: "ready",
  snapshot: s,
});

describe("ProtectionPage — vocabulary (SC4)", () => {
  test("renders none of the banned lifecycle/tuning terms", async () => {
    // The fixture deliberately includes `blind-enforcement`, whose catalog copy
    // carries "calibration" and "review window" in BOTH its fields.
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          entry({ guardName: "example-guard", failureClasses: ["blind-enforcement"] }),
          entry({ guardName: "second-guard", failureClasses: ["secret-exposure"] }),
        ],
      }),
      READY(snapshot({ rows: [aggregateRow(), aggregateRow({ guardName: "second-guard" })] }))
    );
    await screen.findByTestId("protection-classes");
    expect(scanForBannedTerms(document.body.textContent ?? "")).toEqual([]);
  });

  test("NEGATIVE CONTROL: the same scanner finds matches on the maintainer surface", async () => {
    // Without this, a scanner matching nothing anywhere would pass the test
    // above forever while catching no regression. The maintainer page renders
    // the lifecycle vocabulary by design, so it is the control.
    renderWith(InterceptorsPage, payload(), READY(snapshot()));
    await screen.findByTestId("interceptors-page");
    const found = scanForBannedTerms(document.body.textContent ?? "");
    expect(found.length).toBeGreaterThan(0);
  });

  test("renders no interceptor NAMES — counts only (mem#802 bans detector names)", async () => {
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          entry({ guardName: "require-review-before-merge", failureClasses: ["broken-main"] }),
          entry({ guardName: "block-secret-file-read", failureClasses: ["secret-exposure"] }),
        ],
      }),
      READY(
        snapshot({
          rows: [
            aggregateRow({ guardName: "require-review-before-merge", deny: 3 }),
            aggregateRow({ guardName: "block-secret-file-read", warn: 1 }),
          ],
        })
      )
    );
    await screen.findByTestId("protection-classes");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("require-review-before-merge");
    expect(text).not.toContain("block-secret-file-read");
    // ...but the COUNT is present, so the operator still knows the scale.
    expect(text).toContain("2 checks");
  });
});

describe("ProtectionPage — health rendering", () => {
  test("all working collapses to ONE calm line, with no per-class health chips", async () => {
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          entry({ guardName: "a", failureClasses: ["broken-main"] }),
          entry({ guardName: "b", failureClasses: ["secret-exposure"] }),
        ],
      }),
      READY(
        snapshot({ rows: [aggregateRow({ guardName: "a" }), aggregateRow({ guardName: "b" })] })
      )
    );
    await screen.findByTestId("protection-health-working");
    expect(screen.getByTestId("protection-health-working").textContent).toContain(
      "All 2 checks working"
    );
    // The anti-pattern this guards: a grid of green chips, one per class.
    expect(screen.queryByTestId("protection-health-degraded")).toBeNull();
    expect(screen.queryByTestId("protection-health-unknown")).toBeNull();
    // Scoped to the ROWS, not the whole body: the ordering caption says
    // "anything not working first" by design, and asserting over the body
    // matched that caption rather than the per-class chips this is about.
    for (const row of screen.getAllByTestId("protection-class-row")) {
      expect(row.textContent).not.toContain("not working");
      expect(row.textContent).not.toContain("Can't confirm");
    }
  });

  test("a broken check renders loudly and is NOT reported as working", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "a", failureClasses: ["secret-exposure"] })] }),
      READY(
        snapshot({
          rows: [aggregateRow({ guardName: "a", canary: { state: "broken" } })],
        })
      )
    );
    await screen.findByTestId("protection-health-degraded");
    expect(screen.getByTestId("protection-health-degraded").textContent).toContain("1 check");
    expect(screen.queryByTestId("protection-health-working")).toBeNull();
  });

  test("a failed source renders UNKNOWN, never zero or working (SC6)", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "a", failureClasses: ["broken-main"] })] }),
      READY(snapshot({ rows: [aggregateRow({ guardName: "a" })], sourceFailures: ["canary"] }))
    );
    await screen.findByTestId("protection-health-unknown");
    expect(screen.getByTestId("protection-health-unknown").textContent).toContain(
      "not the same as everything being fine"
    );
    expect(screen.queryByTestId("protection-health-working")).toBeNull();
  });

  test("the pending state makes no claim about whether checks are working", async () => {
    renderWith(ProtectionPage, payload());
    await screen.findByTestId("protection-pending");
    expect(screen.queryByTestId("protection-health-working")).toBeNull();
    expect(screen.queryByTestId("protection-totals")).toBeNull();
  });
});

describe("ProtectionPage — ordering and figures", () => {
  test("degraded first, then cost descending — not alphabetical, not by count", async () => {
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          // `broken-main` has the MOST checks and the LEAST cost, and sorts
          // first alphabetically — three ways to get this wrong.
          entry({ guardName: "q1", failureClasses: ["broken-main"] }),
          entry({ guardName: "q2", failureClasses: ["broken-main"] }),
          entry({ guardName: "q3", failureClasses: ["broken-main"] }),
          entry({ guardName: "costly", failureClasses: ["blind-enforcement"] }),
          entry({ guardName: "broken", failureClasses: ["secret-exposure"] }),
        ],
      }),
      READY(
        snapshot({
          rows: [
            aggregateRow({ guardName: "q1" }),
            aggregateRow({ guardName: "q2" }),
            aggregateRow({ guardName: "q3" }),
            aggregateRow({ guardName: "costly", deny: 40, warn: 60 }),
            aggregateRow({ guardName: "broken", canary: { state: "broken" } }),
          ],
        })
      )
    );
    await screen.findByTestId("protection-classes");
    const order = screen
      .getAllByTestId("protection-class-row")
      .map((el) => el.getAttribute("data-class-id"));
    expect(order).toEqual(["secret-exposure", "blind-enforcement", "broken-main"]);
  });

  test("blind-enforcement renders its operator override, not the catalog's maintainer copy", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "a", failureClasses: ["blind-enforcement"] })] }),
      READY(snapshot({ rows: [aggregateRow({ guardName: "a" })] }))
    );
    await screen.findByTestId("protection-classes");
    const text = document.body.textContent ?? "";
    expect(text).toContain("What makes sure the protection itself is still working?");
    expect(text).not.toContain("What tells me the guards themselves are still working?");
  });

  test("AT2: a class with zero fires states the quiet result rather than showing zeros", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "quiet", failureClasses: ["secret-exposure"] })] }),
      READY(snapshot({ rows: [aggregateRow({ guardName: "quiet", deny: 0, warn: 0 })] }))
    );
    await screen.findByTestId("protection-classes");
    const row = screen.getByTestId("protection-class-row");
    expect(screen.getByTestId("protection-class-quiet").textContent).toContain(
      "Nothing needed stopping here"
    );
    // Not an empty state, and not the zero triplet that reads like a broken feed.
    expect(row.textContent).not.toContain("stopped 0");
    expect(row.textContent).not.toContain("flagged 0");
    // Still not an implied failure — the class is present and counted.
    expect(row.textContent).toContain("1 check");
    expect(screen.queryByTestId("protection-health-degraded")).toBeNull();
  });

  test("AT3: a rendered cost figure equals the snapshot's own value for the same set", async () => {
    // Two checks in one class, 40 + 60 stops and 30 + 70 flags, so the row must
    // read 100/100 — the sum of the snapshot rows, not either one and not the
    // fire count.
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          entry({ guardName: "a", failureClasses: ["broken-main"] }),
          entry({ guardName: "b", failureClasses: ["broken-main"] }),
        ],
      }),
      READY(
        snapshot({
          rows: [
            aggregateRow({ guardName: "a", deny: 40, warn: 30 }),
            aggregateRow({ guardName: "b", deny: 60, warn: 70 }),
          ],
        })
      )
    );
    await screen.findByTestId("protection-classes");
    const row = screen.getByTestId("protection-class-row");
    expect(row.textContent).toContain("stopped 100");
    expect(row.textContent).toContain("flagged 100");
    expect(screen.getByTestId("protection-total-stopped").textContent).toContain("100");
  });

  test("an unmeasured duration reads as not-measured, not as 0ms", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "a", failureClasses: ["broken-main"] })] }),
      READY(snapshot({ rows: [aggregateRow({ guardName: "a", deny: 5, duration: null })] }))
    );
    await screen.findByTestId("protection-total-time");
    expect(screen.getByTestId("protection-total-time").textContent).toContain("not measured");
    expect(screen.getByTestId("protection-total-stopped").textContent).toContain("5");
  });

  test("totals dedupe an interceptor carried by several classes", async () => {
    renderWith(
      ProtectionPage,
      payload({
        entries: [
          entry({ guardName: "multi", failureClasses: ["broken-main", "secret-exposure"] }),
        ],
      }),
      READY(snapshot({ rows: [aggregateRow({ guardName: "multi", deny: 4 })] }))
    );
    await screen.findByTestId("protection-total-checks");
    // Two class rows, ONE check, and the stop count is not doubled.
    expect(screen.getAllByTestId("protection-class-row")).toHaveLength(2);
    expect(screen.getByTestId("protection-total-checks").textContent).toContain("1");
    expect(screen.getByTestId("protection-total-stopped").textContent).toContain("4");
  });
});

describe("formatOperatorDuration is exercised through the page", () => {
  test("a multi-hour total renders in hours, not thousands of seconds", async () => {
    renderWith(
      ProtectionPage,
      payload({ entries: [entry({ guardName: "a", failureClasses: ["broken-main"] })] }),
      READY(
        snapshot({
          rows: [
            aggregateRow({
              guardName: "a",
              deny: 10,
              duration: {
                avgMs: 3700,
                p95Ms: 5000,
                maxMs: 9000,
                totalMs: 10_080_000,
                measuredFires: 2732,
              },
            }),
          ],
        })
      )
    );
    await screen.findByTestId("protection-total-time");
    expect(screen.getByTestId("protection-total-time").textContent).toContain("2.8 hr");
  });
});

describe("scanForBannedTerms", () => {
  test("the scanner itself discriminates", () => {
    expect(scanForBannedTerms("all clear here")).toEqual([]);
    expect(scanForBannedTerms("the canary passed")).toEqual(["canary"]);
  });
});
