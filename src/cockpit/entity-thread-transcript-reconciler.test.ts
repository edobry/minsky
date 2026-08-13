/**
 * Tests for the entity-thread transcript reconciler (mt#4073).
 *
 * The store is injected, so a thread whose transcript holds a reply the table
 * is missing — the exact state a daemon restart leaves behind, and one no real
 * Postgres will produce on demand — is directly constructible here.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EntityThreadTurn } from "@minsky/domain/transcripts/entity-thread-store";
import type { TranscriptAssistantTurn } from "@minsky/domain/transcripts/entity-thread-reconcile";
import {
  reconcileThreadFromTranscript,
  type ThreadReconcileStore,
} from "./entity-thread-transcript-reconciler";

const LOCAL_ID = "entity-thread:ask:a902cba7-fd37-464a-842f-96fe38fe8bcc";
const CONVERSATION = "64f990d3-b298-4281-b141-23019d5f6fb5";
const REPLACED_CONVERSATION = "1b355295-0000-4000-8000-000000000000";
const T0 = Date.parse("2026-08-12T21:00:00.000Z");
/** The reply the 2026-08-12 incident lost — the case this module exists for. */
const LOST_REPLY = "the substantive answer that never persisted";

/** The injected db is never dereferenced — every read goes through the store. */
const DB = {} as PostgresJsDatabase;

function storedTurn(overrides: Partial<EntityThreadTurn> = {}): EntityThreadTurn {
  return {
    id: `${LOCAL_ID}#1`,
    localId: LOCAL_ID,
    seq: 1,
    role: "agent",
    content: "an earlier reply that landed",
    createdAt: new Date(T0),
    ...overrides,
  };
}

interface FakeStoreState {
  conversationIds: string[];
  transcript: Record<string, TranscriptAssistantTurn[]>;
  turns: EntityThreadTurn[];
  threadStartedAtMs?: number;
  appended: Array<{
    content: string;
    recoveredFromConversationId?: string;
    originallySentAt?: Date;
  }>;
}

function fakeStore(init: Partial<FakeStoreState> = {}): {
  store: ThreadReconcileStore;
  state: FakeStoreState;
} {
  const state: FakeStoreState = {
    conversationIds: init.conversationIds ?? [CONVERSATION],
    transcript: init.transcript ?? {},
    turns: init.turns ?? [storedTurn()],
    ...(init.threadStartedAtMs === undefined ? {} : { threadStartedAtMs: init.threadStartedAtMs }),
    appended: [],
  };

  const store: ThreadReconcileStore = {
    resolveConversationIds: async () => state.conversationIds,
    readTranscriptTurns: async (_db, conversationId) => state.transcript[conversationId] ?? [],
    listTurns: async () => state.turns,
    readThreadStartedAtMs: async () => state.threadStartedAtMs,
    appendTurn: async (_db, input) => {
      state.appended.push({
        content: input.content,
        ...(input.recoveredFromConversationId
          ? { recoveredFromConversationId: input.recoveredFromConversationId }
          : {}),
        ...(input.originallySentAt ? { originallySentAt: input.originallySentAt } : {}),
      });
      const turn = storedTurn({
        id: `${LOCAL_ID}#${state.turns.length + 1}`,
        seq: state.turns.length + 1,
        content: input.content,
        createdAt: new Date(),
        ...(input.recoveredFromConversationId
          ? { recoveredFromConversationId: input.recoveredFromConversationId }
          : {}),
        ...(input.originallySentAt ? { originallySentAt: input.originallySentAt } : {}),
      });
      // Mirror the real append: the row is now part of the thread, so a second
      // pass over the same thread sees it.
      state.turns = [...state.turns, turn];
      return turn;
    },
  };

  return { store, state };
}

describe("reconcileThreadFromTranscript", () => {
  /** Acceptance test 1 — the reply the restart lost comes back, marked. */
  test("appends a transcript reply missing from the thread, carrying its original instant", async () => {
    const originallySentAt = T0 + 5 * 60_000;
    const { store, state } = fakeStore({
      transcript: {
        [CONVERSATION]: [
          {
            conversationId: CONVERSATION,
            turnIndex: 25,
            text: LOST_REPLY,
            endedAtMs: originallySentAt,
          },
        ],
      },
    });

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(outcome.recovered).toBe(1);
    expect(outcome.unresolvable).toBe(false);
    expect(state.appended).toEqual([
      {
        content: LOST_REPLY,
        recoveredFromConversationId: CONVERSATION,
        originallySentAt: new Date(originallySentAt),
      },
    ]);
  });

  /** Acceptance test 2 — idempotence, which is what criterion 3 protects. */
  test("a second pass over the same thread appends nothing", async () => {
    const { store, state } = fakeStore({
      transcript: {
        [CONVERSATION]: [
          {
            conversationId: CONVERSATION,
            turnIndex: 25,
            text: LOST_REPLY,
            endedAtMs: T0 + 5 * 60_000,
          },
        ],
      },
    });

    const first = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);
    const second = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(state.appended).toHaveLength(1);
  });

  /** Acceptance test 5 — a reply stranded in the REPLACED conversation. */
  test("recovers from the replaced conversation, not only the current one", async () => {
    const { store, state } = fakeStore({
      conversationIds: [CONVERSATION, REPLACED_CONVERSATION],
      transcript: {
        [CONVERSATION]: [],
        [REPLACED_CONVERSATION]: [
          {
            conversationId: REPLACED_CONVERSATION,
            turnIndex: 12,
            text: "said by the agent that was swapped out",
            endedAtMs: T0 + 60_000,
          },
        ],
      },
    });

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(outcome.recovered).toBe(1);
    expect(outcome.conversationsConsidered).toBe(2);
    expect(state.appended[0]?.recoveredFromConversationId).toBe(REPLACED_CONVERSATION);
  });

  /**
   * Regression for PR #2971 R1.
   *
   * A thread with ZERO stored turns is exactly the case where every reply is
   * missing — reachable because the operator's own message goes through the same
   * failing append path as the agent's. Anchoring the window on `turns[0]` left
   * that thread with no anchor, so nothing was ever eligible and the first
   * missing reply could never be recovered.
   */
  test("recovers into an empty thread, anchored on the thread's own start", async () => {
    const threadStartedAtMs = T0;
    const { store, state } = fakeStore({
      turns: [],
      threadStartedAtMs,
      transcript: {
        [CONVERSATION]: [
          {
            conversationId: CONVERSATION,
            turnIndex: 3,
            text: "the only reply, and it never persisted",
            endedAtMs: threadStartedAtMs + 60_000,
          },
          {
            conversationId: CONVERSATION,
            turnIndex: 1,
            text: "from before this thread existed",
            endedAtMs: threadStartedAtMs - 60 * 60_000,
          },
        ],
      },
    });

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(outcome.recovered).toBe(1);
    expect(state.appended.map((a) => a.content)).toEqual([
      "the only reply, and it never persisted",
    ]);
  });

  test("reports a thread with no conversation as unresolvable rather than clean", async () => {
    // Distinct from "nothing was missing": there is no conversation to search,
    // so a gap — if there is one — cannot be closed from here, and the route
    // needs to be able to tell those apart.
    const { store } = fakeStore({ conversationIds: [] });

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(outcome).toEqual({ recovered: 0, conversationsConsidered: 0, unresolvable: true });
  });

  test("does not append anything when the thread is already complete", async () => {
    const { store, state } = fakeStore({
      transcript: {
        [CONVERSATION]: [
          {
            conversationId: CONVERSATION,
            turnIndex: 1,
            text: "an earlier reply that landed",
            endedAtMs: T0,
          },
        ],
      },
    });

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, store);

    expect(outcome.recovered).toBe(0);
    expect(state.appended).toEqual([]);
  });

  test("degrades to an empty outcome when the store throws, rather than propagating", async () => {
    // This runs at daemon boot; an escaping rejection there is a boot-time
    // crash, and a reconcile that cannot read is the degraded case the module
    // exists for rather than an error to raise.
    const { store } = fakeStore();
    const failing: ThreadReconcileStore = {
      ...store,
      listTurns: async () => {
        throw new Error("pool is unreachable");
      },
    };

    const outcome = await reconcileThreadFromTranscript(DB, LOCAL_ID, failing);

    expect(outcome).toEqual({ recovered: 0, conversationsConsidered: 0, unresolvable: true });
  });
});
