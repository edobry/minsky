/**
 * AskPage tests (mt#2669).
 *
 * The deeplink-resolution contract: the page resolves the ask by a dedicated
 * per-id fetch (seeded from the pending-list cache when present), and never
 * renders a terminal-sounding verdict for an ask the server would return.
 *
 *   - Live ask absent from the list cache: per-id fetch renders detail
 *     (the 2026-07-08 fresh-cockpit-boot deeplink repro).
 *   - Terminal ask: state-specific message with the recorded response,
 *     not the old generic "no longer pending".
 *   - Unknown id: "not found" only after the per-id fetch settles.
 *   - Seeded cache: a live ask already in the list cache renders immediately.
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/AskPage.test.tsx
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AskPage } from "./AskPage";
import { TabsProvider } from "../lib/tabs";
import type { AskItem } from "../widgets/AskDetail";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeAsk(overrides: Partial<AskItem> = {}): AskItem {
  return {
    id: "0147caa5-e208-4fac-9b1c-0479787a9a24",
    kind: "direction.decide",
    state: "suspended",
    title: "Calibration-review disposition",
    question: "Which disposition should the calibration review take?",
    requestor: "agent",
    routingTarget: "operator",
    createdAt: "2026-07-08T03:18:00.000Z",
    suspendedAt: "2026-07-08T03:18:05.000Z",
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

function renderAskPage(askId: string, queryClient = createTestQueryClient()) {
  return render(
    <MemoryRouter initialEntries={[`/ask/${askId}`]}>
      <QueryClientProvider client={queryClient}>
        <TabsProvider>
          <Routes>
            <Route path="/ask/:id" element={<AskPage />} />
          </Routes>
        </TabsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AskPage deeplink resolution (mt#2669)", () => {
  test("live ask absent from the list cache renders detail via per-id fetch", async () => {
    const ask = makeAsk();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      if (url.endsWith("/api/asks")) return jsonResponse({ asks: [], total: 0 });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("terminal ask renders a state-specific message with the recorded response", async () => {
    const ask = makeAsk({
      state: "closed",
      response: { responder: "operator", payload: { option: "flip" } },
      respondedAt: "2026-07-08T05:00:00.000Z",
      closedAt: "2026-07-08T05:00:00.000Z",
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/This ask was resolved/)).toBeDefined();
    });
    expect(screen.getByText(/by operator/)).toBeDefined();
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("expired ask names the expiry, not a generic message", async () => {
    const ask = makeAsk({ state: "expired" });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/This ask was expired/)).toBeDefined();
    });
  });

  test("unknown id renders not-found only after the per-id fetch settles", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/asks/")) return jsonResponse({ error: "Ask not found" }, 404);
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage("00000000-0000-0000-0000-000000000000");

    await waitFor(() => {
      expect(screen.getByText(/No ask with this id was found/)).toBeDefined();
    });
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("live ask already in the list cache renders immediately (seeded initialData)", async () => {
    const ask = makeAsk();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["asks"], { asks: [ask], total: 1 });

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id, queryClient);

    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
  });
});
