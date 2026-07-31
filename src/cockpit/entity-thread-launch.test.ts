/**
 * Tests for entity-thread seeding and reply capture (mt#3364).
 *
 * Every test here is against the PURE functions plus the subscriber factory —
 * no `claude` binary is spawned. Per ./driven-session-host.ts's module
 * docblock, spawning the genuine binary in a test spends real credit and runs
 * a headless skip-permissions agent, so tests never do it.
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so these launches need a real directory as their cwd — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, expect, test, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

// mt#3397 — the host preflights the spawn cwd, so these spawns need a cwd that
// actually exists or they'd take the missing-cwd branch instead.
const TEST_CWD = mkdtempSync(join(tmpdir(), "entity-thread-launch-"));

import {
  DrivenSessionRegistry,
  sendDrivenSessionInput,
  DRIVEN_OPERATOR_INPUT_EVENT_TYPE,
  type ProcessLike,
  type SpawnFn,
} from "./driven-session-host";
import { RESOLVE_PROPOSAL_FENCE } from "@minsky/shared/resolve-proposal";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { entityThreadLocalId } from "@minsky/domain/transcripts/entity-thread-store";
import {
  askToEntitySeed,
  resolveOriginConversationId,
  buildEntityThreadSeedPrompt,
  createEntityThreadReplyRecorder,
  extractAssistantTextFromEvent,
  startEntityThreadSession,
  taskToEntitySeed,
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

describe("resolveOriginConversationId (mt#3367)", () => {
  /** Minimal `db.execute` stand-in — the resolver only needs that one method. */
  function fakeDb(behavior: (query: unknown) => unknown): PostgresJsDatabase {
    return { execute: async (q: unknown) => behavior(q) } as unknown as PostgresJsDatabase;
  }

  test("returns the linked conversation id", async () => {
    const db = fakeDb(() => [{ agent_session_id: "conv-1" }]);
    expect(await resolveOriginConversationId(db, "ws-1")).toBe("conv-1");
  });

  test("returns null when no link row matches", async () => {
    // The MAJORITY case — measured reachability is 46.2%. Not an error path.
    const db = fakeDb(() => []);
    expect(await resolveOriginConversationId(db, "ws-1")).toBeNull();
  });

  test("returns null for a null or absent parentSessionId WITHOUT querying", async () => {
    let queried = false;
    const db = fakeDb(() => {
      queried = true;
      return [];
    });
    expect(await resolveOriginConversationId(db, null)).toBeNull();
    expect(await resolveOriginConversationId(db, undefined)).toBeNull();
    expect(await resolveOriginConversationId(db, "")).toBeNull();
    expect(queried).toBe(false);
  });

  test("degrades to null when the lookup throws, rather than propagating", async () => {
    // A thread that works without origin context beats one that 500s because a
    // best-effort enrichment lookup failed.
    const db = fakeDb(() => {
      throw new Error("connection reset");
    });
    expect(await resolveOriginConversationId(db, "ws-1")).toBeNull();
  });

  test("gates on confidence = 1 in the query it issues", async () => {
    // The gate is the whole point (mt#3367): a sub-1.0 link can name the WRONG
    // conversation, and answering "why did you ask me this?" from it would be
    // confidently wrong. Asserted against the emitted SQL because the filter
    // lives in the query, not in post-filtering.
    let captured = "";
    const db = fakeDb((q) => {
      captured = JSON.stringify(q);
      return [];
    });
    await resolveOriginConversationId(db, "ws-1");
    expect(captured).toContain("confidence");
  });
});

describe("taskToEntitySeed (mt#3366)", () => {
  test("carries the spec body and the task's own refs", () => {
    const seed = taskToEntitySeed({
      id: "mt#1234",
      title: "Do the thing",
      status: "READY",
      kind: "implementation",
      parentTaskId: "mt#1000",
      spec: "## Summary\n\nDo the thing properly.",
      tags: ["cockpit", "ui"],
    });

    expect(seed.entityType).toBe("task");
    expect(seed.entityId).toBe("mt#1234");
    expect(seed.title).toBe("Do the thing");
    expect(seed.body).toContain("Do the thing properly");
    expect(seed.refs).toEqual([
      { label: "status", value: "READY" },
      { label: "task kind", value: "implementation" },
      { label: "parent task", value: "mt#1000" },
      { label: "tags", value: "cockpit, ui" },
    ]);
  });

  test("names an absent spec instead of seeding an empty body", () => {
    // A task with no spec still EXISTS, so the route cannot 404 it. Seeding an
    // empty body would produce an agent confidently discussing nothing; naming
    // the gap lets it tell the principal the spec is empty.
    const seed = taskToEntitySeed({ id: "mt#1", title: "Bare", spec: "   " });
    expect(seed.body).toContain("no spec body");
    expect(seed.body.trim().length).toBeGreaterThan(0);
  });

  test("falls back to the id when the title is missing or blank", () => {
    expect(taskToEntitySeed({ id: "mt#7" }).title).toBe("mt#7");
    expect(taskToEntitySeed({ id: "mt#7", title: "  " }).title).toBe("mt#7");
  });

  test("omits refs entirely when the task carries none", () => {
    expect(taskToEntitySeed({ id: "mt#7", spec: "body" }).refs).toBeUndefined();
    expect(taskToEntitySeed({ id: "mt#7", spec: "body", tags: [] }).refs).toBeUndefined();
  });

  test("a task thread's key cannot collide with an ask thread's", () => {
    // Both id-spaces are opaque strings; only the entity TYPE separates them.
    expect(entityThreadLocalId("task", "X")).not.toBe(entityThreadLocalId("ask", "X"));
  });
});

/** The action prohibition several tests assert survives unchanged. */
const ACTION_PROHIBITION = "Do NOT take action on this entity";
/** The investigate-don't-paraphrase instruction several tests assert survives. */
const INVESTIGATE_INSTRUCTION = "Investigate before answering";

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
    expect(prompt).toContain(INVESTIGATE_INSTRUCTION);
    // `\s+` not a literal space: the prompt is hand-wrapped, so the phrase can
    // straddle a line break. Matching a literal space made this assertion
    // sensitive to rewrapping rather than to the instruction it checks for.
    expect(prompt).toMatch(/rather than\s+restating/);
  });

  test("forbids acting on the entity", () => {
    // The agent has live MCP tools; discussing an ask must never resolve it as
    // a side effect. Resolution is operator-confirmed and owned by mt#3368.
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain(ACTION_PROHIBITION);
    expect(prompt).toMatch(/resolve, close, edit, or respond/);
  });

  test("carries the origin as a distinct field, NOT as another ref (mt#3367)", () => {
    // Kept out of `refs` on purpose: the origin is a tool TARGET the prompt
    // gives reading instructions for, and keeping it distinct is what lets the
    // route report `originSeeded` without pattern-matching a ref label.
    const withOrigin = askToEntitySeed({
      id: ASK_ID,
      question: "q",
      originConversationId: "conv-abc",
    });
    expect(withOrigin.originConversationId).toBe("conv-abc");
    expect(JSON.stringify(withOrigin.refs ?? [])).not.toContain("conv-abc");
  });

  test("leaves originConversationId undefined when unreachable (mt#3367)", () => {
    expect(askToEntitySeed({ id: ASK_ID, question: "q" }).originConversationId).toBeUndefined();
    expect(
      askToEntitySeed({ id: ASK_ID, question: "q", originConversationId: null })
        .originConversationId
    ).toBeUndefined();
  });

  test("treats a blank origin id as ABSENT, not as an origin (PR #2493 R1)", () => {
    // An empty or whitespace-only id cannot be read by any tool. Carrying it
    // would tell the agent to read "" and tell the principal the thread is
    // origin-grounded — both false.
    for (const blank of ["", "   ", "\n\t"]) {
      expect(
        askToEntitySeed({ id: ASK_ID, question: "q", originConversationId: blank })
          .originConversationId
      ).toBeUndefined();
    }
  });

  test("trims a padded origin id rather than passing whitespace through", () => {
    expect(
      askToEntitySeed({ id: ASK_ID, question: "q", originConversationId: "  conv-abc  " })
        .originConversationId
    ).toBe("conv-abc");
  });

  test("omits the references block when there are none", () => {
    const bare = buildEntityThreadSeedPrompt({ ...seed, refs: [] as EntitySeedContext["refs"] });
    expect(bare).not.toContain("References it carries");
  });

  test("teaches the proposal marker using the SHARED fence constant (mt#3368)", () => {
    // The fence is a cross-process contract: this prompt is written by the
    // daemon and parsed in the browser. Asserting against the shared constant
    // rather than a literal is what makes a rename a compile/test failure
    // instead of proposals silently ceasing to appear.
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain(`\`\`\`${RESOLVE_PROPOSAL_FENCE}`);
    expect(prompt).toContain("optionLetter");
  });

  test("frames proposing as distinct from acting, and keeps the action ban", () => {
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toContain("Proposing is not acting");
    // The proposal contract must not have loosened the existing prohibition.
    expect(prompt).toContain(ACTION_PROHIBITION);
  });

  test("names the origin conversation and how to read it, when reachable (mt#3367)", () => {
    const prompt = buildEntityThreadSeedPrompt({
      ...seed,
      originConversationId: "conv-abc",
    });
    expect(prompt).toContain("conv-abc");
    expect(prompt).toContain("transcripts_get");
    // Selective reading, not a reflexive full pull — the tool's own options.
    expect(prompt).toContain("turnRange");
  });

  test("STATES that the origin is unavailable rather than omitting it (mt#3367)", () => {
    // Silence would read to the agent as "no originating conversation exists",
    // and it would answer WHY-questions from the entity text without telling
    // the principal its grounding was thinner than it could have been. This is
    // the majority case (reachability ~46%), so it has to be first-class.
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toMatch(/could NOT be resolved/);
    expect(prompt).not.toContain("transcripts_get");
  });

  test("instructs the agent to DECLINE on a malformed or ungroundable ask", () => {
    // SC5. This is prompt-level, not enforced — the panel's own range check is
    // the enforced half (see resolveProposalOption).
    const prompt = buildEntityThreadSeedPrompt(seed);
    expect(prompt).toMatch(/DECLINE to propose/);
    expect(prompt).toMatch(/Never propose an option the ask does not list/);
  });

  test("a NON-ask entity gets no proposal contract", () => {
    // mt#3366 mounted the task route. A task has no options to resolve, so
    // teaching it the marker would invite a proposal no surface can render.
    // Built from the REAL adapter rather than a hand-edited ask seed, so this
    // asserts what the task route will actually send (mt#3366 AT).
    const prompt = buildEntityThreadSeedPrompt(
      taskToEntitySeed({ id: "mt#1", title: "A task", spec: "## Summary\n\nDo it." })
    );
    expect(prompt).not.toContain(RESOLVE_PROPOSAL_FENCE);
    expect(prompt).toContain(ACTION_PROHIBITION);
    // The generic scoping still applies — a task thread is still told to
    // investigate rather than paraphrase.
    expect(prompt).toContain(INVESTIGATE_INSTRUCTION);
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

/**
 * mt#3388 — the seed prompt is HOST-authored and must not be attributed to the
 * operator.
 *
 * mt#3372 made `sendDrivenSessionInput` append a `minsky_operator_input` frame
 * on every send unless the caller opts out. The seed prompt is the whole
 * scoping instruction; echoed, the conversation view renders it as a wall of
 * text the principal appears to have typed.
 */
describe("seed prompt attribution", () => {
  /** Minimal ProcessLike double — captures stdin, emits nothing. */
  class FakeProcess extends EventEmitter implements ProcessLike {
    readonly pid = 4242;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new PassThrough();
    kill(): boolean {
      return true;
    }
  }

  function fakeSpawn(): SpawnFn {
    return () => new FakeProcess();
  }

  function seed(): EntitySeedContext {
    return {
      entityType: "ask",
      entityId: "seed-attribution-test",
      title: "ask#1",
      body: "Approve the thing?",
    };
  }

  test("a seeded spawn appends NO operator-input frame", () => {
    const registry = new DrivenSessionRegistry();
    const session = startEntityThreadSession({
      seed: seed(),
      cwd: TEST_CWD,
      spawnFn: fakeSpawn(),
      registry,
    });

    expect(session.spawned).toBe(true);
    expect(session.seeded).toBe(true);

    const operatorFrames = session.record.eventLog.filter(
      (e) => e.payload["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE
    );
    expect(operatorFrames).toHaveLength(0);
  });

  test("the seed text specifically never appears as operator-attributed content", () => {
    // Stronger than the count above: even a future change that appends some
    // other operator frame must not put the SEED's words in the operator's
    // mouth.
    const registry = new DrivenSessionRegistry();
    const session = startEntityThreadSession({
      seed: seed(),
      cwd: TEST_CWD,
      spawnFn: fakeSpawn(),
      registry,
    });

    const operatorText = session.record.eventLog
      .filter((e) => e.payload["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE)
      .map((e) => String(e.payload["text"] ?? ""))
      .join("\n");
    expect(operatorText).not.toContain(INVESTIGATE_INSTRUCTION);
    expect(operatorText).not.toContain("Approve the thing?");
  });

  test("the spawn drives the durable-persistence observer with the thread's localId", () => {
    // mt#3402: this callsite previously passed NO observers, so no
    // `driven_sessions` row was ever written and the deterministic localId's
    // restart-survival property silently never held. The observer's ARGUMENT
    // is what matters — a row keyed by anything other than the entity's
    // localId would not satisfy the one-row-per-entity contract.
    const registry = new DrivenSessionRegistry();
    const seen: string[] = [];
    const session = startEntityThreadSession({
      seed: seed(),
      cwd: "/tmp/x",
      spawnFn: fakeSpawn(),
      registry,
      onStateChange: (record) => seen.push(record.localId),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([session.localId]));
    expect(session.localId).toBe("entity-thread:ask:seed-attribution-test");
  });

  test("an operator message on the SAME session DOES append exactly one frame", () => {
    // The contrast that makes the assertions above meaningful: the opt-out is
    // scoped to the seed, not a blanket disabling of operator attribution.
    // Without this, a bug that suppressed every echo would pass the tests above.
    const registry = new DrivenSessionRegistry();
    const session = startEntityThreadSession({
      seed: seed(),
      cwd: TEST_CWD,
      spawnFn: fakeSpawn(),
      registry,
    });

    expect(sendDrivenSessionInput(session.record, "what is this asking me?")).toBe(true);

    const operatorFrames = session.record.eventLog.filter(
      (e) => e.payload["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE
    );
    expect(operatorFrames).toHaveLength(1);
    expect(operatorFrames[0]?.payload["text"]).toBe("what is this asking me?");
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});
