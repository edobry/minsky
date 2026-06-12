/**
 * Workstreams slice/altitude parameterization tests (mt#2385)
 *
 * Verifies the multi-instance mechanism: two Workstreams instances rendered
 * on one page at different altitudes fetch distinct slices, render distinct
 * content, and cache under distinct TanStack Query keys (no collision).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workstreams } from "./Workstreams";
import {
  useWorkstreamsData,
  workstreamsQueryKey,
  parseAltitude,
  type WorkstreamAltitude,
} from "../lib/use-workstreams-data";

// ---------------------------------------------------------------------------
// Fixtures — one workstream; the rollup slice strips children, the actionable
// slice keeps only the IN-PROGRESS child.
// ---------------------------------------------------------------------------

const ROLLUP_PAYLOAD = {
  state: "ok",
  payload: {
    altitude: "rollup",
    workstreams: [
      {
        parentId: "mt#10",
        parentTitle: "Rollup Parent Title",
        parentStatus: "IN-PROGRESS",
        children: [],
        activeChildCount: 2,
        doneChildCount: 1,
        blockedChildCount: 0,
      },
    ],
  },
};

const ACTIONABLE_PAYLOAD = {
  state: "ok",
  payload: {
    altitude: "actionable",
    workstreams: [
      {
        parentId: "mt#10",
        parentTitle: "Rollup Parent Title",
        parentStatus: "IN-PROGRESS",
        children: [{ id: "mt#11", title: "Actionable Child Row", status: "IN-PROGRESS" }],
        activeChildCount: 2,
        doneChildCount: 1,
        blockedChildCount: 0,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Harness — a component that fetches via the param-aware hook, twice on one page
// ---------------------------------------------------------------------------

function WorkstreamsInstance({ altitude }: { altitude: WorkstreamAltitude }) {
  const query = useWorkstreamsData(altitude);
  if (query.data === undefined) {
    return <p>{`loading-${altitude}`}</p>;
  }
  return <Workstreams data={query.data} title={`Workstreams (${altitude})`} />;
}

describe("Workstreams altitude parameterization (mt#2385)", () => {
  const originalFetch = globalThis.fetch;
  let requestedUrls: string[] = [];
  let queryClient: QueryClient;

  beforeEach(() => {
    requestedUrls = [];
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const body = url.includes("altitude=rollup")
        ? ROLLUP_PAYLOAD
        : url.includes("altitude=actionable")
          ? ACTIONABLE_PAYLOAD
          : { state: "degraded", reason: "unexpected url in test" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("two instances at different altitudes fetch, render, and cache distinctly", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WorkstreamsInstance altitude="rollup" />
          <WorkstreamsInstance altitude="actionable" />
        </QueryClientProvider>
      </MemoryRouter>
    );

    // Both instances render their own slice's content
    await waitFor(() => {
      expect(screen.getByText("Workstreams (rollup)")).toBeDefined();
      expect(screen.getByText("Workstreams (actionable)")).toBeDefined();
    });

    // The actionable slice's child row renders exactly once (only in that instance);
    // the rollup instance has no child rows.
    await waitFor(() => {
      expect(screen.getAllByText("Actionable Child Row").length).toBe(1);
    });

    // Distinct request URLs — one per altitude
    expect(requestedUrls.some((u) => u.includes("altitude=rollup"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("altitude=actionable"))).toBe(true);

    // Distinct cache entries under distinct keys — no collision
    const rollupCached = queryClient.getQueryData(workstreamsQueryKey("rollup"));
    const actionableCached = queryClient.getQueryData(workstreamsQueryKey("actionable"));
    expect(rollupCached).toBeDefined();
    expect(actionableCached).toBeDefined();
    expect(rollupCached).not.toEqual(actionableCached);
  });

  test("full altitude fetches the bare widget endpoint (no query string)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({ state: "ok", payload: { altitude: "full", workstreams: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WorkstreamsInstance altitude="full" />
        </QueryClientProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Workstreams (full)")).toBeDefined();
    });

    expect(requestedUrls).toEqual(["/api/widget/workstreams/data"]);
  });

  test("parseAltitude falls back to full on unknown or absent values", () => {
    expect(parseAltitude("rollup")).toBe("rollup");
    expect(parseAltitude("actionable")).toBe("actionable");
    expect(parseAltitude("full")).toBe("full");
    expect(parseAltitude("ceo")).toBe("full");
    expect(parseAltitude(null)).toBe("full");
    expect(parseAltitude(undefined)).toBe("full");
  });
});
