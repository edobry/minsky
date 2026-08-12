/**
 * Published-links inventory tests (mt#4024).
 *
 * This page answers "what is readable by anyone with a link right now," so the
 * assertions are about that question staying answerable: a live share is
 * listed with its last-access time, a revoked one stays listed rather than
 * vanishing, and revoke actually calls the endpoint and refetches.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/SharedLinksPage.test.tsx
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SharedLinksPage } from "./SharedLinksPage";
import type { ShareSummary } from "../lib/shares-client";

const LIVE: ShareSummary = {
  id: "share-live",
  conversationId: "agent-ae1576839e37ecab9",
  label: "Passkey gate research",
  createdAt: "2026-08-11T10:00:00.000Z",
  revokedAt: null,
  lastAccessedAt: "2026-08-12T09:30:00.000Z",
};

const REVOKED: ShareSummary = {
  id: "share-revoked",
  conversationId: "agent-bb1576839e37ecab9",
  label: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  revokedAt: "2026-08-02T10:00:00.000Z",
  lastAccessedAt: null,
};

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

function stubFetch(shares: () => ShareSummary[]) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url === "/api/shares") {
      return new Response(JSON.stringify({ shares: shares() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/revoke")) {
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SharedLinksPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("SharedLinksPage (mt#4024)", () => {
  test("lists a live share with its conversation and last-access time", async () => {
    stubFetch(() => [LIVE]);
    renderPage();

    const row = await screen.findByTestId("share-row-live");
    expect(row.textContent).toContain("Passkey gate research");
    expect(row.textContent).toContain("Live");
    // Last-opened is what turns the list into an exposure readout rather than
    // a receipt: a link opened after the reader was done is worth noticing.
    expect(row.textContent).not.toContain("—");
  });

  test("a revoked share stays listed rather than disappearing", async () => {
    stubFetch(() => [LIVE, REVOKED]);
    renderPage();

    const revoked = await screen.findByTestId("share-row-revoked");
    expect(revoked.textContent).toContain("Revoked");
    // No revoke control on something already revoked.
    expect(revoked.querySelector("button")).toBeNull();
  });

  test("the count names only what is still readable", async () => {
    stubFetch(() => [LIVE, REVOKED]);
    renderPage();

    await screen.findByTestId("share-row-live");
    expect(screen.getByText(/1 readable by anyone holding the link/)).toBeTruthy();
  });

  test("revoke posts to the share's revoke endpoint and refetches the list", async () => {
    let revokedYet = false;
    stubFetch(() => (revokedYet ? [{ ...LIVE, revokedAt: "2026-08-12T12:00:00.000Z" }] : [LIVE]));

    renderPage();
    const row = await screen.findByTestId("share-row-live");
    const button = row.querySelector("button");
    if (!button) throw new Error("live row has no revoke button");

    revokedYet = true;
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("share-row-revoked")).toBeTruthy());
    expect(calls.some((c) => c.url === "/api/shares/share-live/revoke" && c.method === "POST")).toBe(
      true
    );
  });

  test("an empty inventory says so rather than rendering an empty table", async () => {
    stubFetch(() => []);
    renderPage();

    await waitFor(() => expect(screen.getByTestId("shares-empty")).toBeTruthy());
  });
});
