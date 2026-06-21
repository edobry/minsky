/**
 * ConversationView fetch-error branch tests (mt#2525 / mt#2420).
 *
 * The self-fetching path must FAIL LOUD when the snapshot endpoint reports a
 * wrong-id-space mistake (422 / `wrong_id_space`) — a workspace session id was
 * passed where a harness conversation id is required — and must NOT fall through
 * to the misleading "no transcript yet" empty state (the original mt#2420
 * surface). A genuine 404 still renders the "no transcript yet" empty state.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import type { ConversationId } from "@minsky/domain/ids";

const originalFetch = global.fetch;

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderWithQuery(ui: React.ReactElement) {
  return render(<QueryClientProvider client={createTestQueryClient()}>{ui}</QueryClientProvider>);
}

function stubFetch(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe("ConversationView fetch errors (mt#2525)", () => {
  test("422 wrong_id_space renders the loud wrong-id surface, not 'no transcript yet'", async () => {
    stubFetch(422, {
      error: { code: "wrong_id_space", message: "workspace id, not a conversation id" },
    });

    renderWithQuery(<ConversationView sessionId={"task359" as ConversationId} />);

    await waitFor(() =>
      expect(screen.getByText(/Wrong id type for the conversation view/i)).toBeDefined()
    );
    expect(screen.queryByText(/No conversation transcript for this session yet/i)).toBeNull();
  });

  test("404 session_not_found preserves the 'no transcript yet' empty state", async () => {
    stubFetch(404, {
      error: {
        code: "session_not_found",
        message: "No transcript found for the requested session.",
      },
    });

    renderWithQuery(<ConversationView sessionId={"real-convo-uuid" as ConversationId} />);

    await waitFor(() =>
      expect(screen.getByText(/No conversation transcript for this session yet/i)).toBeDefined()
    );
    expect(screen.queryByText(/Wrong id type for the conversation view/i)).toBeNull();
  });
});
