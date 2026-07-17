/**
 * Tests for the home page's needs-me band (mt#2881).
 *
 * Pure coverage: tier banding, ranking (tier then oldest-first), flood
 * grouping. Component coverage: ranked rendering, honest empty state, flood
 * collapse, tier-distribution health chip.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TriageBand,
  displayTier,
  rankAsks,
  groupByKind,
  FLOOD_THRESHOLD,
  MIN_N_FOR_DISTRIBUTION,
} from "./TriageBand";
import type { AskItem } from "./AskDetail";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ask(overrides: Partial<AskItem> & Pick<AskItem, "id" | "kind" | "createdAt">): AskItem {
  return {
    state: "routed",
    title: `Ask ${overrides.id}`,
    question: "q",
    requestor: "fixture-agent",
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  } as AskItem;
}

const HIGH_OLD = ask({
  id: "high-old",
  kind: "authorization.approve",
  createdAt: "2026-07-01T00:00:00Z",
});
const MEDIUM = ask({ id: "medium", kind: "direction.decide", createdAt: "2026-07-10T00:00:00Z" });
const LOW_NEW = ask({
  id: "low-new",
  kind: "information.retrieve",
  createdAt: "2026-07-16T00:00:00Z",
});
const HIGH_NEW = ask({
  id: "high-new",
  kind: "stuck.unblock",
  createdAt: "2026-07-15T00:00:00Z",
});

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("displayTier", () => {
  test("collapses the 7-band kind priority into 3 display tiers", () => {
    expect(displayTier({ kind: "stuck.unblock" })).toBe("high");
    expect(displayTier({ kind: "authorization.approve" })).toBe("high");
    expect(displayTier({ kind: "direction.decide" })).toBe("medium");
    expect(displayTier({ kind: "quality.review" })).toBe("medium");
    expect(displayTier({ kind: "coordination.notify" })).toBe("low");
    expect(displayTier({ kind: "information.retrieve" })).toBe("low");
  });
});

describe("rankAsks", () => {
  test("orders by tier first, then OLDEST first within a tier", () => {
    const ranked = rankAsks([LOW_NEW, MEDIUM, HIGH_NEW, HIGH_OLD]);
    expect(ranked.map((a) => a.id)).toEqual(["high-old", "high-new", "medium", "low-new"]);
  });
});

describe("groupByKind", () => {
  test("one group per kind with count and oldest timestamp, tier-ranked", () => {
    const groups = groupByKind([
      LOW_NEW,
      ask({ id: "a1", kind: "authorization.approve", createdAt: "2026-07-05T00:00:00Z" }),
      HIGH_OLD,
    ]);
    expect(groups[0]?.kind).toBe("authorization.approve");
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.oldestCreatedAt).toBe("2026-07-01T00:00:00Z");
    expect(groups[1]?.kind).toBe("information.retrieve");
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function stubAsks(asks: AskItem[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/asks")) {
      return new Response(JSON.stringify({ asks }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function renderBand() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TriageBand />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TriageBand component", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("renders ranked rows linking to each ask's detail", async () => {
    stubAsks([LOW_NEW, HIGH_OLD]);
    renderBand();
    await waitFor(() => expect(screen.getByText("2 pending →")).toBeDefined());
    const links = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((h) => h?.startsWith("/ask/"));
    expect(links[0]).toBe("/ask/high-old");
    expect(links[1]).toBe("/ask/low-new");
  });

  test("renders the honest empty state when nothing is pending", async () => {
    stubAsks([]);
    renderBand();
    await waitFor(() => expect(screen.getByText("Nothing needs you")).toBeDefined());
  });

  test("collapses to per-kind flood rows above the threshold", async () => {
    const many = Array.from({ length: FLOOD_THRESHOLD + 2 }, (_, i) =>
      ask({
        id: `flood-${i}`,
        kind: "coordination.notify",
        createdAt: `2026-07-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      })
    );
    stubAsks(many);
    renderBand();
    await waitFor(() =>
      expect(screen.getByText(`${FLOOD_THRESHOLD + 2} × coordination.notify`)).toBeDefined()
    );
    // Individual rows are not rendered in flood mode.
    expect(screen.queryByText("Ask flood-0")).toBeNull();
  });

  test("flags unhealthy tier distribution on large queues", async () => {
    // n = MIN_N_FOR_DISTRIBUTION, 2 high → 20% > 5% ceiling.
    const queue = [
      ask({ id: "h1", kind: "stuck.unblock", createdAt: "2026-07-01T00:00:00Z" }),
      ask({ id: "h2", kind: "authorization.approve", createdAt: "2026-07-02T00:00:00Z" }),
      ...Array.from({ length: MIN_N_FOR_DISTRIBUTION - 2 }, (_, i) =>
        ask({
          id: `l${i}`,
          kind: "information.retrieve",
          createdAt: `2026-07-${String(3 + i).padStart(2, "0")}T00:00:00Z`,
        })
      ),
    ];
    stubAsks(queue);
    renderBand();
    await waitFor(() => expect(screen.getByText("tiering: 20% high")).toBeDefined());
  });
});
