/**
 * EntityThreadPanel tests (mt#3365).
 *
 * `global.fetch` is stubbed — no real network. QueryClientProvider is required
 * because the panel (and ConversationView beneath it) use TanStack Query hooks.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { EntityThreadPanel, deriveComposerState } from "./EntityThreadPanel";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const ENTITY_ID = "38b1c0de-0000-4000-8000-000000000000";
const THREAD_LOCAL_ID = `entity-thread:ask:${ENTITY_ID}`;

function block(
  overrides: Partial<SessionContextSnapshotBlock> & { id: string }
): SessionContextSnapshotBlock {
  return {
    type: "user-prompt",
    source: "observed",
    content: "hello",
    timestamp: "2026-07-30T18:00:00.000Z",
    rawJsonlType: "user",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/** Stub fetch: thread endpoint returns `thread`; anything else degrades. */
function stubFetch(thread: unknown, opts: { threadOk?: boolean; status?: number } = {}): void {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/entity-thread/")) {
      return jsonResponse(thread, opts.threadOk ?? true, opts.status ?? 200);
    }
    // Everything else (ConversationView's entity index, etc.) degrades quietly.
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <EntityThreadPanel entityType="ask" entityId={ENTITY_ID} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("deriveComposerState", () => {
  test("closes the composer while a send is in flight", () => {
    expect(deriveComposerState([], true)).toBe("streaming");
  });

  test("closes the composer while the agent owes a reply", () => {
    // The last turn is the operator's — the agent has the turn. Letting a
    // second question queue here would interleave two conversations.
    const blocks = [block({ id: "t#1", type: "user-prompt" })];
    expect(deriveComposerState(blocks, false)).toBe("streaming");
  });

  test("reopens the composer once the agent has replied", () => {
    const blocks = [
      block({ id: "t#1", type: "user-prompt" }),
      block({ id: "t#2", type: "assistant-text", rawJsonlType: "assistant" }),
    ];
    expect(deriveComposerState(blocks, false)).toBe("awaiting-input");
  });

  test("an empty thread accepts input", () => {
    expect(deriveComposerState([], false)).toBe("awaiting-input");
  });
});

describe("EntityThreadPanel", () => {
  test("renders a meaningful empty state, not an empty shell", async () => {
    stubFetch({
      localId: THREAD_LOCAL_ID,
      entityType: "ask",
      entityId: ENTITY_ID,
      blocks: [],
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/No discussion yet/i)).toBeDefined();
    });
    // The composer is still offered — an empty thread is the normal starting
    // state, not a disabled one.
    expect(screen.getByLabelText(/Ask a question about this ask/i)).toBeDefined();
  });

  test("renders the thread's turns when the server returns them", async () => {
    stubFetch({
      localId: THREAD_LOCAL_ID,
      entityType: "ask",
      entityId: ENTITY_ID,
      blocks: [
        block({ id: "t#1", content: "what is this asking me?" }),
        block({
          id: "t#2",
          type: "assistant-text",
          rawJsonlType: "assistant",
          content: "it is an authorization request",
        }),
      ],
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.queryByText(/No discussion yet/i)).toBeNull();
    });
  });

  test("shows an error state when the backing route fails — not a blank area", async () => {
    stubFetch({ error: "boom" }, { threadOk: false, status: 500 });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load discussion/i)).toBeDefined();
    });
  });

  test("does not render a Stop control — this thread has no interrupt channel", async () => {
    // A Stop button with nothing wired to it is worse than none; the composer
    // omits it when no `onStop` is supplied.
    stubFetch({
      localId: THREAD_LOCAL_ID,
      entityType: "ask",
      entityId: ENTITY_ID,
      blocks: [],
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/Ask a question about this ask/i)).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
  });

  test("labels the input for the entity, not for a driven session", async () => {
    // The shared composer's default aria-label says "driven session"; a screen
    // reader on the ask page must not be told that.
    stubFetch({
      localId: THREAD_LOCAL_ID,
      entityType: "ask",
      entityId: ENTITY_ID,
      blocks: [],
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/Ask a question about this ask/i)).toBeDefined();
    });
    expect(screen.queryByLabelText(/driven session/i)).toBeNull();
  });
});
