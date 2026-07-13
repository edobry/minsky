/**
 * ConversationsPage live-badge tests (mt#2749).
 *
 * Verifies the /conversations list renders the pulsing live badge for a row
 * whose `agentSessionId` is present in the transcript watcher's active-session
 * registry (`GET /api/health`'s `transcriptWatcher.activeSessions`, sourced
 * via `useActiveConversationSessions`) and withholds it for an absent one.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/ConversationsPage.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationsPage } from "./ConversationsPage";
import type { WidgetData } from "../lib/widget-client";
import type { ConversationRow } from "../lib/conversations-source";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderConversationsPage() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={["/conversations"]}>
      <QueryClientProvider client={queryClient}>
        <ConversationsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_ID = "conv-active-session-id";
const INACTIVE_ID = "conv-inactive-session-id";

const CONVERSATION_ROWS: ConversationRow[] = [
  {
    agentSessionId: ACTIVE_ID,
    harness: "claude-code",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    cwd: "/Users/edobry/Projects/minsky",
    label: "Active Conversation",
  },
  {
    agentSessionId: INACTIVE_ID,
    harness: "claude-code",
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date(Date.now() - 1800_000).toISOString(),
    cwd: "/Users/edobry/Projects/minsky",
    label: "Inactive Conversation",
  },
];

const CONVERSATIONS_PAYLOAD: WidgetData = {
  state: "ok",
  payload: { sessions: CONVERSATION_ROWS },
};

/** Mocks both /api/widget/context-inspector/data and /api/health by pathname. */
function mockFetches(activeSessionIds: string[]) {
  mockFetchesWithTimestamps(activeSessionIds.map((agentSessionId) => ({ agentSessionId })));
}

/**
 * Same as {@link mockFetches} but lets each entry override `lastEventAt` —
 * used to exercise the recency filter (mt#2749): an entry with a stale
 * `lastEventAt` is present in the raw registry but must NOT show the badge.
 */
function mockFetchesWithTimestamps(
  activeSessions: Array<{ agentSessionId: string; lastEventAt?: string }>
) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/widget/context-inspector/data") {
      return Promise.resolve(
        new Response(JSON.stringify(CONVERSATIONS_PAYLOAD), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/api/health") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            transcriptWatcher: {
              activeSessions: activeSessions.map(({ agentSessionId, lastEventAt }) => ({
                agentSessionId,
                isSubagent: false,
                lastEventAt: lastEventAt ?? new Date().toISOString(),
                lastIngestAt: null,
                lastTurnsIngested: 0,
              })),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationsPage — live badge (mt#2749)", () => {
  test("renders both conversation rows", async () => {
    mockFetches([ACTIVE_ID]);
    renderConversationsPage();
    await waitFor(() => {
      expect(screen.getByText("Active Conversation")).toBeDefined();
    });
    expect(screen.getByText("Inactive Conversation")).toBeDefined();
  });

  test("shows the live badge for a row whose agentSessionId is active", async () => {
    mockFetches([ACTIVE_ID]);
    renderConversationsPage();

    await waitFor(() => {
      expect(screen.getByText("Active Conversation")).toBeDefined();
    });

    const activeRow = screen.getByLabelText(`Open conversation Active Conversation`);
    await waitFor(() => {
      expect(activeRow.querySelector('[aria-label="live"]')).not.toBeNull();
    });
  });

  test("withholds the live badge for a row whose agentSessionId is NOT active", async () => {
    mockFetches([ACTIVE_ID]);
    renderConversationsPage();

    await waitFor(() => {
      expect(screen.getByText("Inactive Conversation")).toBeDefined();
    });

    const inactiveRow = screen.getByLabelText(`Open conversation Inactive Conversation`);
    // Give the active-sessions query a tick to settle before asserting absence.
    await waitFor(() => {
      expect(screen.getByText("Active Conversation")).toBeDefined();
    });
    expect(inactiveRow.querySelector('[aria-label="live"]')).toBeNull();
  });

  test("shows no live badges when the active-sessions set is empty", async () => {
    mockFetches([]);
    const { container } = renderConversationsPage();

    await waitFor(() => {
      expect(screen.getByText("Active Conversation")).toBeDefined();
    });

    expect(container.querySelectorAll('[aria-label="live"]').length).toBe(0);
  });

  // Recency filter (mt#2749) — the transcript watcher's boot scan stamps
  // lastEventAt to "now" for every PRE-EXISTING file it discovers
  // (TranscriptWatcher.seedExisting()), so raw presence in activeSessions is
  // NOT sufficient evidence of genuine live activity. A row present in the
  // registry but with a stale lastEventAt must NOT show the badge.
  test("withholds the badge when the registry entry's lastEventAt is stale (boot-scan false positive)", async () => {
    const staleTimestamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days old
    mockFetchesWithTimestamps([{ agentSessionId: ACTIVE_ID, lastEventAt: staleTimestamp }]);
    renderConversationsPage();

    await waitFor(() => {
      expect(screen.getByText("Active Conversation")).toBeDefined();
    });

    const activeRow = screen.getByLabelText(`Open conversation Active Conversation`);
    // Give the active-sessions query a tick to settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeRow.querySelector('[aria-label="live"]')).toBeNull();
  });
});
