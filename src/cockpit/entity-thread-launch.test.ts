/**
 * Tests for entity-thread seeding and reply capture (mt#3364).
 *
 * Every test here is against the PURE functions plus the subscriber factory —
 * no `claude` binary is spawned. Per ./driven-session-host.ts's module
 * docblock, spawning the genuine binary in a test spends real credit and runs
 * a headless skip-permissions agent, so tests never do it.
 */

import { describe, expect, test } from "bun:test";

import {
  askToEntitySeed,
  buildEntityThreadSeedPrompt,
  createEntityThreadReplyRecorder,
  extractAssistantTextFromEvent,
  type EntitySeedContext,
} from "./entity-thread-launch";

const ASK_ID = "38b1c0de-0000-4000-8000-000000000000";
const ASK_QUESTION = "Approve the schema change?";
const RECORDER_THREAD_ID = "entity-thread:ask:x";

describe("askToEntitySeed", () => {
  test("carries the ask's question as the body the agent reasons over", () => {
    const seed = askToEntitySeed({
      id: ASK_ID,
      question: ASK_QUESTION,
      title: "Schema change approval",
    });
    expect(seed.entityType).toBe("ask");
    expect(seed.entityId).toBe(ASK_ID);
    expect(seed.body).toBe(ASK_QUESTION);
  });

  test("prefers the short id over the uuid as a label when there is no title", () => {
    // ask#N is what the principal reads in the cockpit; a raw uuid in the
    // prompt would make the agent echo an id the principal doesn't recognize.
    const seed = askToEntitySeed({ id: ASK_ID, question: "q", shortId: "ask#6512" });
    expect(seed.title).toBe("ask#6512");
  });

  test("falls back to the uuid only when neither title nor short id exists", () => {
    expect(askToEntitySeed({ id: ASK_ID, question: "q" }).title).toBe(ASK_ID);
  });

  test("treats a whitespace-only title as absent", () => {
    const seed = askToEntitySeed({ id: ASK_ID, question: "q", title: "   ", shortId: "ask#1" });
    expect(seed.title).toBe("ask#1");
  });

  test("collects the parent task and context refs so the agent can follow them", () => {
    const seed = askToEntitySeed({
      id: ASK_ID,
      question: "q",
      parentTaskId: "mt#3360",
      kind: "authorization.approve",
      contextRefs: [{ kind: "task", ref: "mt#3363" }],
    });
    const values = (seed.refs ?? []).map((r) => r.value);
    expect(values).toContain("mt#3360");
    expect(values).toContain("mt#3363");
    expect(values).toContain("authorization.approve");
  });

  test("omits the refs key entirely when the ask carries none", () => {
    expect(askToEntitySeed({ id: ASK_ID, question: "q" }).refs).toBeUndefined();
  });
});

describe("buildEntityThreadSeedPrompt", () => {
  const seed: EntitySeedContext = {
    entityType: "ask",
    entityId: ASK_ID,
    title: "ask#6512",
    body: ASK_QUESTION,
    refs: [{ label: "parent task", value: "mt#3360" }],
  };

  test("includes the entity's id, title, and body", () => {
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain(ASK_ID);
    expect(prompt).toContain("ask#6512");
    expect(prompt).toContain(ASK_QUESTION);
  });

  test("includes the refs so the agent has somewhere to start investigating", () => {
    expect(buildEntityThreadSeedPrompt(seed)).toContain("mt#3360");
  });

  test("instructs the agent to investigate rather than restate", () => {
    // Without this the likely failure is a fluent paraphrase of text the
    // principal already read and found unclear — the exact degenerate behavior
    // the driven-session mechanism was chosen over a completion call to avoid.
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain("Investigate before answering");
    expect(prompt).toMatch(/rather than restating/);
  });

  test("forbids acting on the entity", () => {
    // The agent has live MCP tools; discussing an ask must never resolve it as
    // a side effect. Resolution is operator-confirmed and owned by mt#3368.
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain("Do NOT take action on this entity");
    expect(prompt).toMatch(/resolve, close, edit, or respond/);
  });

  test("omits the references block when there are none", () => {
    const bare = buildEntityThreadSeedPrompt({ ...seed, refs: [] as EntitySeedContext["refs"] });
    expect(bare).not.toContain("References it carries");
  });
});

describe("extractAssistantTextFromEvent", () => {
  test("pulls the visible text out of an assistant message", () => {
    const text = extractAssistantTextFromEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "the ask needs your approval" }] },
    });
    expect(text).toBe("the ask needs your approval");
  });

  test("concatenates multiple text blocks in order", () => {
    const text = extractAssistantTextFromEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(text).toBe("first second");
  });

  test("ignores tool traffic — only prose becomes a durable turn", () => {
    const text = extractAssistantTextFromEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "tasks_get", input: {} },
          { type: "text", text: "reading the parent task" },
        ],
      },
    });
    expect(text).toBe("reading the parent task");
  });

  test("returns null for a message with no text blocks at all", () => {
    expect(
      extractAssistantTextFromEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "tasks_get", input: {} }] },
      })
    ).toBeNull();
  });

  test("returns null for non-assistant events", () => {
    expect(extractAssistantTextFromEvent({ type: "system", subtype: "init" })).toBeNull();
    expect(extractAssistantTextFromEvent({ type: "result", is_error: false })).toBeNull();
    expect(extractAssistantTextFromEvent({ type: "minsky_exit", code: 0 })).toBeNull();
  });

  test("survives every malformed shape the thin upstream schema permits", () => {
    // The upstream stream-json schema is under-specified (see the host module's
    // docblock); a shape change must degrade to null, never throw on the live
    // session's event path.
    expect(extractAssistantTextFromEvent({ type: "assistant" })).toBeNull();
    expect(extractAssistantTextFromEvent({ type: "assistant", message: null })).toBeNull();
    expect(extractAssistantTextFromEvent({ type: "assistant", message: "oops" })).toBeNull();
    expect(
      extractAssistantTextFromEvent({ type: "assistant", message: { content: "oops" } })
    ).toBeNull();
    expect(
      extractAssistantTextFromEvent({ type: "assistant", message: { content: [null, 42] } })
    ).toBeNull();
    expect(
      extractAssistantTextFromEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: 42 }] },
      })
    ).toBeNull();
  });

  test("treats whitespace-only prose as no turn", () => {
    expect(
      extractAssistantTextFromEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "   \n  " }] },
      })
    ).toBeNull();
  });
});

describe("createEntityThreadReplyRecorder", () => {
  /** Captures the rows a recorder would write, without a database. */
  function capturingDb(): {
    db: { execute: (q: unknown) => Promise<unknown> };
    calls: number;
  } {
    const state = { calls: 0 };
    return {
      db: {
        execute: async () => {
          state.calls += 1;
          return [
            {
              id: "entity-thread:ask:x#1",
              local_id: "entity-thread:ask:x",
              seq: 1,
              role: "agent",
              content: "persisted",
              created_at: new Date("2026-07-30T18:00:00Z"),
            },
          ];
        },
      },
      get calls() {
        return state.calls;
      },
    };
  }

  test("persists assistant prose as an agent turn", async () => {
    const cap = capturingDb();
    const recorder = createEntityThreadReplyRecorder(cap.db as never, RECORDER_THREAD_ID);
    recorder.onEvent({
      seq: 1,
      receivedAt: "2026-07-30T18:00:00Z",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    });
    await Promise.resolve();
    expect(cap.calls).toBe(1);
  });

  test("writes nothing for events that carry no prose", async () => {
    const cap = capturingDb();
    const recorder = createEntityThreadReplyRecorder(cap.db as never, RECORDER_THREAD_ID);
    recorder.onEvent({
      seq: 1,
      receivedAt: "2026-07-30T18:00:00Z",
      payload: { type: "system", subtype: "init" },
    });
    await Promise.resolve();
    expect(cap.calls).toBe(0);
  });

  test("a write failure never throws back onto the live session's event path", async () => {
    const failingDb = {
      execute: async () => {
        throw new Error("connection lost");
      },
    };
    const recorder = createEntityThreadReplyRecorder(failingDb as never, RECORDER_THREAD_ID);
    expect(() =>
      recorder.onEvent({
        seq: 1,
        receivedAt: "2026-07-30T18:00:00Z",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      })
    ).not.toThrow();
    // Let the swallowed rejection settle so it cannot surface as an unhandled
    // rejection after the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("onSwap is a no-op — the thread is keyed by localId and survives the swap", () => {
    const recorder = createEntityThreadReplyRecorder(capturingDb().db as never, "t");
    expect(() => recorder.onSwap()).not.toThrow();
  });
});
