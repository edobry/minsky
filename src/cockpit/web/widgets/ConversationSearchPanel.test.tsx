/**
 * Tests for ConversationSearchPanel (mt#2523).
 *
 * Covers the panel's own acceptance-relevant behavior:
 *   1. A search returns results carrying the conversation id + resume hint
 *      (mt#2523 SC#1/AT#1 — "searching a distinctive phrase returns its id
 *      and a resume hint").
 *   2. A windowed search over an unindexed range surfaces the coverage note
 *      (mt#2523 SC#3/AT#2 — "a clear message pointing at the indexing
 *      cadence (mt#2234), not a silent empty result").
 *   3. An empty-but-covered result set still renders a clean empty state.
 *   4. A non-OK response surfaces its error message.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationSearchPanel } from "./ConversationSearchPanel";

const originalFetch = global.fetch;

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPanel() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ConversationSearchPanel />
    </QueryClientProvider>
  );
}

function stubFetch(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Expand the panel and fill in + submit the query — the shared setup every test needs. */
async function expandAndSearch(query: string) {
  fireEvent.click(screen.getByRole("button", { name: /search conversation content/i }));
  const input = screen.getByLabelText(/search query/i);
  fireEvent.change(input, { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe("ConversationSearchPanel (mt#2523)", () => {
  test("starts collapsed — the search input is not present until expanded", () => {
    renderPanel();
    expect(screen.queryByLabelText(/search query/i)).toBeNull();
    expect(screen.getByRole("button", { name: /search conversation content/i })).toBeDefined();
  });

  test("a matched result surfaces the conversation id and a ready `claude --resume <id>` hint (AT#1)", async () => {
    stubFetch(200, {
      results: [
        {
          agentSessionId: "conv-distinctive-phrase",
          turnIndex: 3,
          userText: "the distinctive phrase we searched for",
          assistantText: null,
          startedAt: "2026-07-10T12:00:00.000Z",
          score: 0.9,
          resumeHint: "claude --resume conv-distinctive-phrase",
          sessionMetadata: {
            startedAt: "2026-07-10T11:00:00.000Z",
            model: "claude-sonnet-5",
            messageCount: 12,
            relatedTaskIds: [],
          },
        },
      ],
    });

    renderPanel();
    await expandAndSearch("distinctive phrase");

    await waitFor(() => {
      expect(screen.getByText("conv-distinctive-phrase")).toBeDefined();
      expect(screen.getByText("claude --resume conv-distinctive-phrase")).toBeDefined();
    });
  });

  test("a windowed search over an unindexed range surfaces the coverage note naming mt#2234, not a silent empty result (AT#2)", async () => {
    stubFetch(200, {
      results: [],
      coverage: {
        unindexedSessionsInWindow: 2,
        note: "2 session(s) started in this window are not yet indexed into agent_transcript_turns and cannot appear in results. They become searchable after `transcripts index-embeddings` runs (owned by mt#2234).",
      },
    });

    renderPanel();
    await expandAndSearch("something in an unindexed window");

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("mt#2234");
    });
  });

  test("an empty, fully-covered result set renders a clean empty state (no coverage banner)", async () => {
    stubFetch(200, { results: [] });

    renderPanel();
    await expandAndSearch("nothing matches this");

    await waitFor(() => {
      expect(screen.getByText(/no matching conversations found/i)).toBeDefined();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a non-OK response surfaces its error message", async () => {
    stubFetch(503, { error: "DB unavailable — persistence provider does not support SQL" });

    renderPanel();
    await expandAndSearch("anything");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("DB unavailable");
    });
  });
});
