/**
 * Published share page tests (mt#4024).
 *
 * The properties asserted here are about EXPOSURE and about what an anonymous
 * reader is told, which is why they are worth having on top of the server-side
 * route tests: those cover what the API returns, these cover what a person with
 * no account actually sees, and whether this page reaches for anything it has
 * no right to.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/SharedConversationPage.test.tsx
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SharedConversationPage } from "./SharedConversationPage";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

const TOKEN = "a".repeat(64);

function turnBlock(
  i: number,
  role: "user" | "assistant",
  body: string
): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: body },
    timestamp: new Date(Date.UTC(2026, 7, 11, 16, 0, i)).toISOString(),
    turnIndex: i,
    rawJsonlType: role,
  };
}

let requested: string[] = [];
let originalFetch: typeof globalThis.fetch;

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function renderSharePage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/s/:token" element={<SharedConversationPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  requested = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("SharedConversationPage (mt#4024)", () => {
  test("renders the shared conversation's turns for a caller with no session", async () => {
    stubFetch(200, {
      conversationId: "agent-ae1576839e37ecab9",
      label: "Passkey gate research",
      createdAt: "2026-08-12T00:00:00.000Z",
      blocks: [
        turnBlock(0, "user", "can we publish a conversation"),
        turnBlock(1, "assistant", "no such capability exists yet"),
      ],
    });

    renderSharePage();

    await waitFor(() => expect(screen.getByTestId("share-page")).toBeTruthy());
    expect(screen.getByText(/can we publish a conversation/)).toBeTruthy();
    expect(screen.getByText(/no such capability exists yet/)).toBeTruthy();
    expect(screen.getByText("Passkey gate research")).toBeTruthy();
  });

  test("reads ONLY the public share endpoint — no gated route is touched", async () => {
    stubFetch(200, {
      conversationId: "agent-ae1576839e37ecab9",
      label: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      blocks: [turnBlock(0, "user", "hello")],
    });

    renderSharePage();
    await waitFor(() => expect(screen.getByTestId("share-page")).toBeTruthy());

    // The whole point of the page: one request, to the one allow-listed path.
    // An entity-index or snapshot fetch here would 401 for the reader and would
    // mean the page had reached past what the operator published.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toBe(`/api/shares/public/${TOKEN}`);
  });

  test("a revoked link says it was turned off, and renders no content", async () => {
    stubFetch(410, { error: "This share link has been revoked" });

    renderSharePage();

    await waitFor(() => expect(screen.getByTestId("share-revoked")).toBeTruthy());
    expect(screen.queryByTestId("share-page")).toBeNull();
  });

  test("an unknown token says the link does not name anything", async () => {
    stubFetch(404, { error: "No such share link" });

    renderSharePage();

    await waitFor(() => expect(screen.getByTestId("share-unknown")).toBeTruthy());
  });

  test("a transcript that stops passing the scrub gate stops rendering", async () => {
    // The server re-checks at render, not only at publish. This is what the
    // reader sees when a live link's transcript no longer qualifies.
    stubFetch(422, { error: "This conversation is no longer publishable" });

    renderSharePage();

    await waitFor(() => expect(screen.getByTestId("share-unpublishable")).toBeTruthy());
  });
});
