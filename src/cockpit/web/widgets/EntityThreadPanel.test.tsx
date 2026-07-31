/**
 * EntityThreadPanel tests (mt#3365).
 *
 * `global.fetch` is stubbed — no real network. QueryClientProvider is required
 * because the panel (and ConversationView beneath it) use TanStack Query hooks.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import {
  EntityThreadPanel,
  deriveComposerState,
  derivePollInterval,
  isThreadStranded,
} from "./EntityThreadPanel";

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
  const operatorTurn = [block({ id: "t#1", type: "user-prompt" })];
  const answered = [
    block({ id: "t#1", type: "user-prompt" }),
    block({ id: "t#2", type: "assistant-text", rawJsonlType: "assistant" }),
  ];

  test("closes the composer while a send is in flight", () => {
    expect(deriveComposerState([], true, false)).toBe("streaming");
  });

  test("closes the composer while a LIVE agent owes a reply", () => {
    expect(deriveComposerState(operatorTurn, false, true)).toBe("streaming");
  });

  test("does NOT claim the agent is responding when no agent is live", () => {
    // The stranding defect (mt#3402): an unanswered operator turn looks
    // identical whether the agent is thinking or gone. Without the liveness
    // input this returned "streaming" forever against a dead process.
    expect(deriveComposerState(operatorTurn, false, false)).toBe("awaiting-input");
  });

  test("reopens the composer once the agent has replied", () => {
    expect(deriveComposerState(answered, false, true)).toBe("awaiting-input");
  });

  test("an empty thread accepts input", () => {
    expect(deriveComposerState([], false, false)).toBe("awaiting-input");
  });
});

describe("isThreadStranded", () => {
  const operatorTurn = [block({ id: "t#1", type: "user-prompt" })];
  const answered = [
    block({ id: "t#1", type: "user-prompt" }),
    block({ id: "t#2", type: "assistant-text", rawJsonlType: "assistant" }),
  ];

  test("an unanswered operator turn with no live agent is stranded", () => {
    expect(isThreadStranded(operatorTurn, false, false)).toBe(true);
  });

  test("an unanswered operator turn with a LIVE agent is not stranded — it is thinking", () => {
    expect(isThreadStranded(operatorTurn, false, true)).toBe(false);
  });

  test("a thread resting after the agent's reply is idle, not stranded", () => {
    // Distinguishing these matters: flagging every not-live thread would put a
    // warning under every normal, fully-answered conversation.
    expect(isThreadStranded(answered, false, false)).toBe(false);
  });

  test("an in-flight send is never stranded", () => {
    expect(isThreadStranded(operatorTurn, true, false)).toBe(false);
  });

  test("an empty thread is not stranded", () => {
    expect(isThreadStranded([], false, false)).toBe(false);
  });
});

describe("derivePollInterval", () => {
  test("polls on a cadence when idle", () => {
    expect(derivePollInterval(false)).toBeGreaterThan(0);
  });

  test("pauses polling while a send is in flight", () => {
    // A poll started before the send can resolve AFTER it and overwrite the
    // freshly-invalidated list with a pre-send snapshot — the operator's own
    // message would flicker out (PR #2437 R1 BLOCKING).
    expect(derivePollInterval(true)).toBe(false);
  });
});

describe("EntityThreadPanel — a failed send must not destroy the draft", () => {
  test("keeps the typed message in the box when the send fails, and names the retry", async () => {
    // The server-side route deliberately persists the operator's message
    // before touching the agent so a failure never loses it. The client must
    // not undo that guarantee by clearing the textarea on a failed POST
    // (PR #2437 R1 BLOCKING).
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/message") && init?.method === "POST") {
        return jsonResponse({ error: "agent unreachable" }, false, 502);
      }
      if (url.includes("/api/entity-thread/")) {
        return jsonResponse({
          localId: THREAD_LOCAL_ID,
          entityType: "ask",
          entityId: ENTITY_ID,
          blocks: [],
        });
      }
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    renderPanel();

    const input = (await waitFor(() =>
      screen.getByLabelText(/Ask a question about this ask/i)
    )) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "what is this asking me?" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText(/Failed to send/i)).toBeDefined();
    });

    // The draft is still there — pressing Send again IS the retry path.
    expect(input.value).toBe("what is this asking me?");
    expect(screen.getByText(/still in the box/i)).toBeDefined();
  });

  test("clears the box once the send succeeds", async () => {
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/message") && init?.method === "POST") {
        return jsonResponse({ localId: THREAD_LOCAL_ID, seeded: true, delivered: true });
      }
      if (url.includes("/api/entity-thread/")) {
        return jsonResponse({
          localId: THREAD_LOCAL_ID,
          entityType: "ask",
          entityId: ENTITY_ID,
          blocks: [],
        });
      }
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    renderPanel();

    const input = (await waitFor(() =>
      screen.getByLabelText(/Ask a question about this ask/i)
    )) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "a question" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(input.value).toBe("");
    });
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
