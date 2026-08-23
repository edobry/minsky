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
  deriveOriginNotice,
  derivePendingRepliesNotice,
  deriveAgentStoppedNotice,
  deriveConversationSwapNotice,
  deriveRecoveredRepliesNotice,
  derivePollInterval,
  fetchEntityThread,
  isThreadStranded,
  ThreadStoreUnavailableError,
  type EntityThreadPanelProps,
} from "./EntityThreadPanel";
import { RESOLVE_PROPOSAL_FENCE } from "../lib/resolve-proposal";

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

function renderPanel(props: Partial<EntityThreadPanelProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <EntityThreadPanel entityType="ask" entityId={ENTITY_ID} {...props} />
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

  test("UNKNOWN liveness falls back to the block-derived reading, not to dead", () => {
    // A daemon predating the `live` field returns `undefined` (PR #2460 R1
    // BLOCKING). Treating that as `false` would reopen the composer against an
    // agent that may well be mid-turn, letting a second question interleave
    // into a live child — the mt#3402 defect inverted.
    expect(deriveComposerState(operatorTurn, false, undefined)).toBe("streaming");
    expect(deriveComposerState(answered, false, undefined)).toBe("awaiting-input");
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

  test("UNKNOWN liveness is not stranded — absence of a signal is not evidence of death", () => {
    expect(isThreadStranded(operatorTurn, false, undefined)).toBe(false);
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

describe("EntityThreadPanel — database unavailable (mt#3398)", () => {
  test("a 503 renders a DATABASE notice, not a thread failure", async () => {
    // The incident copy said "Failed to load discussion", which reads as "your
    // thread is broken" — while the turns were intact and the agent was still
    // running. The message must name the database and promise a retry.
    stubFetch({}, { threadOk: false, status: 503 });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/can't reach its database/i)).toBeDefined();
    });
    expect(screen.queryByText(/Failed to load discussion/i)).toBeNull();
  });

  test("a NON-503 error still renders the ordinary thread failure", async () => {
    // The two must stay distinguishable; collapsing them would hide real bugs
    // behind a reassuring "we'll retry" that never comes true.
    stubFetch({}, { threadOk: false, status: 500 });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load discussion/i)).toBeDefined();
    });
    expect(screen.queryByText(/can't reach its database/i)).toBeNull();
  });

  test("fetchEntityThread throws the typed error on 503 so callers can branch", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () =>
      ({ ok: false, status: 503, json: async () => ({}), text: async () => "" }) as Response
    ) as unknown as typeof fetch;
    try {
      await expect(fetchEntityThread("ask", ENTITY_ID)).rejects.toBeInstanceOf(
        ThreadStoreUnavailableError
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("deriveOriginNotice (mt#3367)", () => {
  test("says the answer is grounded in the originating conversation", () => {
    expect(deriveOriginNotice(true)).toMatch(/conversation that filed this/i);
  });

  test("says plainly when the originating conversation is unreachable", () => {
    // The majority case (~46% reachability). The principal should know which
    // grounding an answer has rather than assuming the richer one.
    expect(deriveOriginNotice(false)).toMatch(/isn't reachable/i);
  });

  test("UNKNOWN says NOTHING rather than claiming the origin is missing", () => {
    // Same discipline as `live` (mt#3402): a daemon that doesn't report the
    // field must not be read as a negative answer.
    expect(deriveOriginNotice(undefined)).toBeNull();
  });
});

/**
 * mt#4036 AT3 — a dropped reply must render as something the operator can tell
 * apart from an agent that never answered.
 *
 * On 2026-08-11 both states rendered identically: nothing. The operator asked
 * "Well?" into that silence and the reply to that was dropped too.
 */
describe("derivePendingRepliesNotice (mt#4036)", () => {
  test("says the agent DID answer when a reply is still being retried", () => {
    const notice = derivePendingRepliesNotice({
      pending: 1,
      lost: 0,
      oldestFailedAt: "2026-08-11T03:29:35Z",
    });
    // The load-bearing half: it must not read as agent silence.
    expect(notice).toMatch(/agent answered/i);
    expect(notice).toMatch(/retrying/i);
  });

  test("says plainly when a reply is not coming back", () => {
    const notice = derivePendingRepliesNotice({ pending: 0, lost: 2, oldestFailedAt: null });
    expect(notice).toMatch(/lost/i);
    // An operator told only "lost" has no next move; the notice must give one.
    expect(notice).toMatch(/ask again/i);
  });

  test("leads with the lost replies when some are lost and some pending", () => {
    const notice = derivePendingRepliesNotice({
      pending: 3,
      lost: 1,
      oldestFailedAt: "2026-08-11T03:29:35Z",
    });
    expect(notice?.indexOf("lost")).toBeLessThan(notice?.indexOf("retried") ?? 0);
  });

  test("singular and plural read correctly", () => {
    expect(derivePendingRepliesNotice({ pending: 1, lost: 0, oldestFailedAt: null })).toContain(
      "1 reply"
    );
    expect(derivePendingRepliesNotice({ pending: 2, lost: 0, oldestFailedAt: null })).toContain(
      "2 replies"
    );
  });

  test("an absent field says NOTHING — same discipline as live and originSeeded", () => {
    // A daemon predating this field reports nothing; inventing a reassuring
    // "0 pending" would assert a check that never ran.
    expect(derivePendingRepliesNotice(undefined)).toBeNull();
  });

  test("an all-zero report says nothing", () => {
    expect(derivePendingRepliesNotice({ pending: 0, lost: 0, oldestFailedAt: null })).toBeNull();
  });
});

/**
 * mt#4037 — a restart-killed agent must not be reported as an agent that gave
 * up, and the operator must be told they can get it back.
 *
 * On 2026-08-11 a cockpit restart killed a thread's agent mid-task and the
 * panel said "The agent stopped before answering — send again to ask." That
 * blames the agent for a daemon shutdown; the operator waited 12h34m.
 */
describe("deriveAgentStoppedNotice (mt#4037)", () => {
  test("names the COCKPIT as what stopped the agent, not the agent", () => {
    const notice = deriveAgentStoppedNotice("cockpit-restart");
    expect(notice).toMatch(/cockpit restarted/i);
    // The load-bearing half the stranded line lacked: a way back.
    expect(notice).toMatch(/send anything/i);
  });

  test("says plainly when the conversation cannot be resumed at all", () => {
    const notice = deriveAgentStoppedNotice("unrecoverable");
    expect(notice).toMatch(/can't be resumed/i);
    // Must still leave the operator a move, or the panel is a dead end.
    expect(notice).toMatch(/start a fresh one/i);
  });

  test("UNKNOWN says NOTHING rather than inventing a cause", () => {
    // Same discipline as `live` and `originSeeded`: a daemon that reports no
    // reason must not be read as asserting one. The panel falls back to the
    // vaguer stranded line, which is at least true.
    expect(deriveAgentStoppedNotice(undefined)).toBeNull();
  });
});

/**
 * mt#4093 — the panel must not render continuity that is not there.
 *
 * On 2026-08-12 a thread's agent was silently replaced by a fresh one with no
 * history. The operator nudged the thread and the incoming agent answered
 * "Nothing was in flight" — true of the conversation IT could see, false of the
 * 119 turns still on screen. Nothing in the panel distinguished the two.
 */
describe("deriveConversationSwapNotice (mt#4093)", () => {
  test("says the current agent has not seen the messages above", () => {
    const notice = deriveConversationSwapNotice({
      replacedConversationId: "1b355295-0000-4000-8000-000000000000",
    });
    // The state, not the mechanism — this is what tells the operator to re-ask
    // rather than wait for an answer that is never coming.
    expect(notice).toMatch(/has not seen the messages above/i);
    expect(notice).toMatch(/fresh agent/i);
  });

  test("does not put the replaced conversation id on screen", () => {
    // It addresses an on-disk transcript the panel cannot open, so rendering it
    // would offer the operator a handle that leads nowhere.
    const notice = deriveConversationSwapNotice({
      replacedConversationId: "1b355295-0000-4000-8000-000000000000",
    });
    expect(notice).not.toContain("1b355295-0000-4000-8000-000000000000");
  });

  test("says NOTHING when no swap is on record", () => {
    // Absent means "no swap recorded", the same discipline `agentStopReason`
    // and `originSeeded` follow. A daemon predating the field must not be read
    // as asserting continuity it never checked.
    expect(deriveConversationSwapNotice(undefined)).toBeNull();
  });

  test("the notice REACHES the render, above the history it qualifies", async () => {
    // The derive tests above prove the string; this proves the panel actually
    // puts it on screen. A correct notice the render never reaches is exactly
    // the shape of the defect — a true fact the operator cannot see.
    stubFetch({
      localId: "entity-thread:ask:abc",
      blocks: [
        block({ id: "t#1", type: "user-prompt" }),
        block({ id: "t#2", type: "assistant-text", rawJsonlType: "assistant" }),
      ],
      live: false,
      conversationSwap: { replacedConversationId: "1b355295-0000-4000-8000-000000000000" },
    });
    renderPanel();

    const notice = await screen.findByTestId("entity-thread-conversation-swap");
    expect(notice.textContent).toMatch(/has not seen the messages above/i);
  });

  test("a recovered reply is disclosed, and coexists with the swap notice", async () => {
    // mt#4073. The recovered turn lands at the END of the thread carrying its
    // ORIGINAL timestamp, so without this the operator sees an hour-old answer
    // below newer messages and no reason for it. Asserted alongside the swap
    // notice because the restart that recovers one reply is frequently the same
    // restart that swapped the conversation — both must show.
    stubFetch({
      localId: "entity-thread:ask:abc",
      blocks: [block({ id: "t#1", type: "user-prompt" })],
      live: false,
      recoveredReplies: { count: 1, oldestOriginallySentAt: "2026-08-12T21:01:32.000Z" },
      conversationSwap: { replacedConversationId: "1b355295-0000-4000-8000-000000000000" },
    });
    renderPanel();

    const notice = await screen.findByTestId("entity-thread-recovered-replies");
    expect(notice.textContent).toMatch(/recovered from the agent's transcript/i);
    expect(await screen.findByTestId("entity-thread-conversation-swap")).toBeDefined();
  });

  test("a thread with nothing recovered renders no recovery notice", async () => {
    // No reassuring zero — absent means "nothing to report", the same
    // discipline `shouldReportPendingReplies` and `originSeeded` follow.
    expect(deriveRecoveredRepliesNotice(undefined)).toBeNull();
    expect(deriveRecoveredRepliesNotice({ count: 0 })).toBeNull();
  });

  test("the recovery notice is pluralized on its count", async () => {
    expect(deriveRecoveredRepliesNotice({ count: 1 })).toMatch(/^A reply that failed to save/);
    expect(deriveRecoveredRepliesNotice({ count: 3 })).toMatch(/^3 replies that failed to save/);
  });

  test("a swapped-in agent that is ALSO stranded shows both notices, not one", async () => {
    // The swap notice sits outside the pending/stopped/stranded chain on
    // purpose: those are mutually exclusive answers to "why is no reply
    // coming?", while this answers "whose conversation is the history?".
    // Suppressing it to show one of them would restore the silent continuity.
    stubFetch({
      localId: "entity-thread:ask:abc",
      blocks: [block({ id: "t#1", type: "user-prompt" })],
      live: false,
      agentStopReason: "cockpit-restart",
      conversationSwap: { replacedConversationId: "1b355295-0000-4000-8000-000000000000" },
    });
    renderPanel();

    expect(await screen.findByTestId("entity-thread-conversation-swap")).toBeDefined();
    expect(await screen.findByTestId("entity-thread-agent-stopped")).toBeDefined();
  });

  test("no swap on the response renders no notice at all", async () => {
    stubFetch({
      localId: "entity-thread:ask:abc",
      blocks: [block({ id: "t#1", type: "user-prompt" })],
      live: true,
    });
    renderPanel();

    // Waited for the panel to settle first, so this is an assertion about a
    // rendered thread rather than about a component that had not loaded yet.
    await screen.findByText("Discussion");
    expect(screen.queryByTestId("entity-thread-conversation-swap")).toBeNull();
  });
});

describe("EntityThreadPanel — proposal slot (mt#3368)", () => {
  const proposalReply = block({
    id: "t#2",
    type: "assistant-text",
    rawJsonlType: "assistant",
    content:
      "You should hold off.\n\n```" +
      RESOLVE_PROPOSAL_FENCE +
      '\n{"optionLetter": "B", "rationale": "the branch is stale"}\n```',
  });

  function stubThread(blocks: SessionContextSnapshotBlock[]): void {
    stubFetch({ localId: THREAD_LOCAL_ID, entityType: "ask", entityId: ENTITY_ID, blocks });
  }

  test("hands the agent's proposal to the slot", async () => {
    stubThread([block({ id: "t#1" }), proposalReply]);
    renderPanel({
      proposalSlot: (proposal) => (
        <p data-testid="slot">
          proposed {proposal.optionLetter}: {proposal.rationale}
        </p>
      ),
    });

    await waitFor(() => {
      expect(screen.getByTestId("slot").textContent).toBe("proposed B: the branch is stale");
    });
  });

  test("does not invoke the slot when the agent made no proposal", async () => {
    stubThread([block({ id: "t#1" }), block({ id: "t#2", type: "assistant-text", content: "no." })]);
    renderPanel({ proposalSlot: () => <p data-testid="slot">should not render</p> });

    await waitFor(() => {
      expect(screen.getByLabelText(/Ask a question about this ask/i)).toBeDefined();
    });
    expect(screen.queryByTestId("slot")).toBeNull();
  });

  test("a proposal renders as plain prose when no slot is supplied", async () => {
    // The mt#3366 entity kinds mount this panel without a slot. A marker must
    // not produce a control there, and must not crash the render either.
    stubThread([proposalReply]);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/Ask a question about this ask/i)).toBeDefined();
    });
    expect(screen.queryByTestId("slot")).toBeNull();
  });
});
