/**
 * ReviewerCostPage tests (mt#4557).
 *
 * The failure path is the load-bearing case here, not the happy path: SC4 /
 * AT3 require that a stale or failed query renders an explicit error, never
 * a zero -- this exact corner of the cockpit (reviewer-bot-status, mt#2076)
 * rendered healthy-looking zeros for five weeks while every underlying query
 * failed (mt#2757), and a smoke script reported PASS on 15/15 query
 * failures. The "blocked" test below exercises the widget's REAL current
 * behavior (mt#4546's accessor is unwired -- fetch() always resolves
 * degraded), so this isn't a hypothetical failure-path test: it's testing
 * what the page actually does today.
 *
 * The "ok" branch is exercised against fabricated data (mt#4546 hasn't
 * shipped a real accessor to query yet) so the rendering code itself is
 * verified ahead of that landing.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ReviewerCostPage } from "./ReviewerCostPage";
import type { ReviewerCostPayload } from "../../widgets/reviewer-cost";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function mockWidgetData(
  response: { state: "ok"; payload: ReviewerCostPayload } | { state: "degraded"; reason: string }
) {
  global.fetch = (async (url: string) => {
    if (String(url).startsWith("/api/widget/reviewer-cost/data")) {
      return { ok: true, json: async () => response } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ReviewerCostPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const OK_PAYLOAD: ReviewerCostPayload = {
  status: "ok",
  windowStart: "2026-07-26T00:00:00.000Z",
  windowEnd: "2026-08-25T00:00:00.000Z",
  dailyBuckets: [
    {
      date: "2026-08-24",
      uncachedInputCostUsd: 1.5,
      cachedInputCostUsd: 0.25,
      outputCostUsd: 3.1,
      reasoningCostUsd: 0.9,
      reviewCount: 12,
      costPerReviewUsd: 0.404,
    },
  ],
  cohorts: [
    {
      configFingerprint: "v1;effort=high;model=gpt-5;provider=openai",
      reviewCount: 40,
      costPerReviewMedianUsd: 0.38,
      costPerReviewP90Usd: 0.91,
      cacheHitRatio: 0.62,
      capPinShare: 0.83,
      r1Count: 25,
      r2PlusCount: 15,
    },
    {
      configFingerprint: null,
      reviewCount: 5,
      costPerReviewMedianUsd: null,
      costPerReviewP90Usd: null,
      cacheHitRatio: null,
      capPinShare: 0,
      r1Count: 5,
      r2PlusCount: 0,
    },
  ],
  capPinShareOverall: 0.79,
  outlierTail: [
    {
      reviewTimingId: "rt-1",
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 3321,
      costUsd: 4.21,
      configFingerprint: "v1;effort=high;model=gpt-5;provider=openai",
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  ],
};

describe("ReviewerCostPage — failure path (SC4 / AT3)", () => {
  test("the KNOWN not-yet-wired reason (mt#4546 unwired) renders a neutral notice, distinct from a live failure", async () => {
    mockWidgetData({
      state: "degraded",
      reason: "reviewer-cost: blocked on mt#4546 (review_timing accessor not yet implemented — see ask#10301)",
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId("reviewer-cost-not-yet-available")).toBeDefined()
    );
    expect(screen.getByText("Not yet available")).toBeDefined();
    expect(screen.getByTestId("reviewer-cost-not-yet-available").textContent).toContain(
      "mt#4546"
    );
    // This is deliberately NOT the urgent red error panel (mt#3348 R1) —
    // that panel is reserved for a genuine live failure, tested below.
    expect(screen.queryByTestId("reviewer-cost-error")).toBeNull();

    // The failure must not ALSO render a happy-path section underneath it —
    // that is exactly how a healthy-looking zero hides a real query failure.
    expect(screen.queryByTestId("reviewer-cost-cohorts")).toBeNull();
    expect(screen.queryByTestId("reviewer-cost-daily-spend")).toBeNull();
    expect(screen.queryByTestId("reviewer-cost-cap-pin-tile")).toBeNull();
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  test("a GENUINE live query failure (once mt#4546 is wired) renders the urgent error panel, not the neutral notice", async () => {
    mockWidgetData({
      state: "degraded",
      reason: "reviewer-cost: the database connection failed mid-request.",
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("reviewer-cost-error")).toBeDefined());
    expect(screen.getByText("Data unavailable")).toBeDefined();
    expect(screen.getByTestId("reviewer-cost-error").textContent).toContain(
      "database connection failed"
    );
    // Not the neutral "not yet available" notice — this IS a live incident.
    expect(screen.queryByTestId("reviewer-cost-not-yet-available")).toBeNull();
    expect(screen.queryByTestId("reviewer-cost-cohorts")).toBeNull();
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  test("an empty window renders an explicit no-data message, not an empty-but-successful table", async () => {
    mockWidgetData({ state: "ok", payload: { status: "no-data" } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("reviewer-cost-empty")).toBeDefined());
    expect(screen.queryByTestId("reviewer-cost-cohorts")).toBeNull();
  });
});

describe("ReviewerCostPage — ok branch (fabricated data, ahead of mt#4546 landing)", () => {
  test("renders the daily-spend table, cap-pin tile, cohort table, and outlier tail from a live payload", async () => {
    mockWidgetData({ state: "ok", payload: OK_PAYLOAD });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("reviewer-cost-daily-spend")).toBeDefined());

    // Daily spend
    expect(screen.getByTestId("reviewer-cost-daily-row-2026-08-24")).toBeDefined();
    expect(screen.getByText("$0.4040")).toBeDefined(); // that day's $/review

    // Cap-pin share — the single prominent number
    expect(screen.getByTestId("reviewer-cost-cap-pin-tile")).toBeDefined();
    expect(screen.getByText("79.0%")).toBeDefined();

    // Cohort table — two rows, including the null-fingerprint row rendering
    // as "unknown configuration" rather than being dropped or defaulted
    expect(
      screen.getByTestId("reviewer-cost-cohort-row-v1;effort=high;model=gpt-5;provider=openai")
    ).toBeDefined();
    expect(screen.getByTestId("reviewer-cost-cohort-row-unknown")).toBeDefined();
    expect(screen.getByText("unknown configuration")).toBeDefined();
    // No confound caveat (SC2): mt#4569's per-PR-parity assignment makes this
    // a genuine controlled comparison.
    expect(screen.queryByText(/confound/i)).toBeNull();

    // Outlier tail — links to its PR via the changeset route
    const prLink = screen.getByText("edobry/minsky#3321");
    expect(prLink.closest("a")?.getAttribute("href")).toBe("/changeset/3321");
  });

  test("quality-not-shown disclaimer is always present (spec's deliberate deferral)", async () => {
    mockWidgetData({ state: "ok", payload: OK_PAYLOAD });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("reviewer-cost-daily-spend")).toBeDefined());
    expect(screen.getByTestId("reviewer-cost-page").textContent).toContain(
      "Quality is not shown on this page yet"
    );
  });
});
