/**
 * Tests for entity-thread seeding and reply capture (mt#3364).
 *
 * Every test here is against the PURE functions plus the subscriber factory —
 * no `claude` binary is spawned. Per ./driven-session-host.ts's module
 * docblock, spawning the genuine binary in a test spends real credit and runs
 * a headless skip-permissions agent, so tests never do it.
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so these launches need a real directory as their cwd — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

// mt#3397 — the host preflights the spawn cwd, so these spawns need a cwd that
// actually exists or they'd take the missing-cwd branch instead.
const TEST_CWD = mkdtempSync(join(tmpdir(), "entity-thread-launch-"));

import {
  DEFAULT_PERMISSION_MODE,
  DrivenSessionRegistry,
  hasLiveSessionDriver,
  resumeDrivenSession,
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
import { pendingReplyBuffer, stopPendingDrain } from "./entity-thread-reply-buffer";
import { getLoggableErrorSummary, MAX_LOGGED_ERROR_CHARS } from "@minsky/domain/errors/index";

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

  /**
   * mt#4036 — a failed write must not silently discard the reply.
   *
   * The test above only asserts the recorder doesn't THROW, which was already
   * true on 2026-08-11 while four replies were lost. Not-throwing and
   * not-losing are independent properties; this covers the second one.
   */
  describe("a failed write is buffered rather than dropped (mt#4036)", () => {
    afterEach(() => {
      stopPendingDrain();
      pendingReplyBuffer.reset();
    });

    test("the reply text survives the failure and is reported as pending", async () => {
      pendingReplyBuffer.reset();
      const failingDb = {
        execute: async () => {
          throw new Error("CONNECTION_CLOSED");
        },
      };
      const recorder = createEntityThreadReplyRecorder(failingDb as never, RECORDER_THREAD_ID);
      recorder.onEvent({
        seq: 1,
        receivedAt: "2026-08-11T03:29:35Z",
        payload: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Both filed. mt#4030 and mt#4028." }] },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const report = pendingReplyBuffer.report(RECORDER_THREAD_ID);
      expect(report.pending).toBe(1);
      expect(report.oldestFailedAt).not.toBeNull();
    });

    test("a successful write buffers nothing", async () => {
      pendingReplyBuffer.reset();
      const cap = capturingDb();
      const recorder = createEntityThreadReplyRecorder(cap.db as never, RECORDER_THREAD_ID);
      recorder.onEvent({
        seq: 1,
        receivedAt: "2026-08-11T03:29:35Z",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pendingReplyBuffer.report(RECORDER_THREAD_ID).pending).toBe(0);
    });
  });

  /**
   * mt#4036 AT4 — the failure log must name the cause and must not emit the
   * whole reply body.
   *
   * Asserted against the formatter the recorder passes its error to, given the
   * REAL error shape the 2026-08-11 failures had: a Drizzle wrapper whose
   * message is the full INSERT with the reply text interpolated as a parameter,
   * wrapping the Postgres error that actually explains the failure. Reading
   * `err.message` — what the recorder used to do — keeps the body and loses the
   * cause; this checks the inversion.
   */
  test("the failure formatter keeps the cause and bounds the reply body (mt#4036)", () => {
    const replyBody = "x".repeat(MAX_LOGGED_ERROR_CHARS * 2);
    const drizzleError = new Error(
      `Failed query: INSERT INTO entity_thread_turns ...\nparams: ${RECORDER_THREAD_ID},agent,${replyBody}`,
      { cause: new Error("write CONNECTION_CLOSED aws-0-us-west-2.pooler.supabase.com:6543") }
    );

    const summary = getLoggableErrorSummary(drizzleError);

    // The cause — absent from `err.message` entirely — is what makes the line
    // diagnosable. Its absence is why the real incident's four log lines never
    // said why the write failed.
    expect(summary).toContain("CONNECTION_CLOSED aws-0-us-west-2.pooler.supabase.com");
    // The body is bounded, not emitted whole.
    expect(summary).not.toContain(replyBody);
    expect(summary.length).toBeLessThan(replyBody.length);
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

  test("a seeded spawn appends NO operator-input frame", async () => {
    const registry = new DrivenSessionRegistry();
    const session = await startEntityThreadSession({
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

  test("the seed text specifically never appears as operator-attributed content", async () => {
    // Stronger than the count above: even a future change that appends some
    // other operator frame must not put the SEED's words in the operator's
    // mouth.
    const registry = new DrivenSessionRegistry();
    const session = await startEntityThreadSession({
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

  test("the spawn drives the durable-persistence observer with the thread's localId", async () => {
    // mt#3402: this callsite previously passed NO observers, so no
    // `driven_sessions` row was ever written and the deterministic localId's
    // restart-survival property silently never held. The observer's ARGUMENT
    // is what matters — a row keyed by anything other than the entity's
    // localId would not satisfy the one-row-per-entity contract.
    const registry = new DrivenSessionRegistry();
    const seen: string[] = [];
    const session = await startEntityThreadSession({
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

  test("an operator message on the SAME session DOES append exactly one frame", async () => {
    // The contrast that makes the assertions above meaningful: the opt-out is
    // scoped to the seed, not a blanket disabling of operator attribution.
    // Without this, a bug that suppressed every echo would pass the tests above.
    const registry = new DrivenSessionRegistry();
    const session = await startEntityThreadSession({
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

/**
 * mt#3550 — a thread whose agent has exited must get a new one.
 *
 * The reuse branch used to fire on `registry.get(localId)` being truthy, and an
 * exited child's record stays registered with a terminal status. So every later
 * message was stored as an operator turn and then refused by
 * `sendDrivenSessionInput`'s dead-stdin guard — permanently, since nothing
 * re-spawned. These tests pin the two halves of the fix: the guard now asks
 * `hasLiveSessionDriver` (the same question the liveness report asks), and the
 * replacement prefers a RESUME so the agent still has the thread's earlier
 * turns.
 */
describe("re-spawn after the agent exits (mt#3550)", () => {
  const HARNESS_ID = "3550aaaa-0000-4000-8000-000000000000";
  const SEED_MARKER = "You are answering the principal's questions";
  const SEED_BODY = "Approve the migration?";

  /** ProcessLike double that keeps what was written to its stdin. */
  class RecordingProcess extends EventEmitter implements ProcessLike {
    readonly pid = 5150;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new PassThrough();
    readonly written: string[] = [];
    constructor() {
      super();
      this.stdin.on("data", (chunk: Buffer | string) => this.written.push(String(chunk)));
    }
    kill(): boolean {
      return true;
    }
  }

  interface Spawn {
    argv: string[];
    proc: RecordingProcess;
  }

  function recordingSpawn(spawns: Spawn[]): SpawnFn {
    return (_command: string, argv: string[]) => {
      const proc = new RecordingProcess();
      spawns.push({ argv, proc });
      return proc;
    };
  }

  function seed(entityId: string): EntitySeedContext {
    return { entityType: "ask", entityId, title: "ask#7", body: SEED_BODY };
  }

  /** The resume seam's answer when there is nothing to resume. */
  const nothingToResume = async () => ({ outcome: "not-found" }) as const;

  /**
   * Spawn a thread session and then drive the host's real exit wiring, so the
   * record reaches a terminal status the way production does rather than by
   * being hand-mutated.
   */
  async function spawnThenExit(entityId: string, registry: DrivenSessionRegistry, spawns: Spawn[]) {
    const session = await startEntityThreadSession({
      seed: seed(entityId),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      resumeSession: nothingToResume,
      onStateChange: () => {},
      onResultSummary: () => {},
    });
    spawns[spawns.length - 1]?.proc.emit("exit", 0, null);
    return session;
  }

  test("a LIVE record is still reused — no rival child against one conversation", async () => {
    // The regression guard for the fix: mt#3095's DAG-fork protection depends
    // on this branch staying put.
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    const opts = {
      seed: seed("live-reuse"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      resumeSession: nothingToResume,
      onStateChange: () => {},
      onResultSummary: () => {},
    };

    const first = await startEntityThreadSession(opts);
    const second = await startEntityThreadSession(opts);

    expect(first.spawned).toBe(true);
    expect(second.spawned).toBe(false);
    expect(second.record).toBe(first.record);
    expect(spawns).toHaveLength(1);
  });

  test("a record whose child has exited is replaced, not reused", async () => {
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    const first = await spawnThenExit("dead-replaced", registry, spawns);

    expect(hasLiveSessionDriver(first.record)).toBe(false);
    expect(registry.get(first.localId)).toBe(first.record);

    const second = await startEntityThreadSession({
      seed: seed("dead-replaced"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      resumeSession: nothingToResume,
      onStateChange: () => {},
      onResultSummary: () => {},
    });

    expect(second.spawned).toBe(true);
    expect(second.record).not.toBe(first.record);
    expect(spawns).toHaveLength(2);
    expect(registry.get(second.localId)).toBe(second.record);
    // The whole point: a message can now be delivered again.
    expect(sendDrivenSessionInput(second.record, "well?")).toBe(true);
  });

  test("a resumable thread is RESUMED — the earlier turns survive the swap", async () => {
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    const first = await spawnThenExit("resumable", registry, spawns);
    // What the child's `system/init` frame would have linked in production.
    first.record.harnessSessionId = HARNESS_ID;

    const second = await startEntityThreadSession({
      seed: seed("resumable"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      // Stands in for the persisted-row lookup + advisory lock only; the actual
      // respawn below is the REAL one, so the argv and the swap are the
      // production article rather than a fixture.
      resumeSession: async (localId: string) => {
        const { record } = resumeDrivenSession({
          previous: {
            localId,
            cwd: TEST_CWD,
            permissionMode: DEFAULT_PERMISSION_MODE,
            harnessSessionId: HARNESS_ID,
            taskId: null,
            minskySessionId: null,
            startedAt: first.record.startedAt,
            driverGeneration: first.record.driverGeneration,
          },
          registry,
          spawnFn: recordingSpawn(spawns),
          command: "fake-claude",
          mcpConfig: null,
        });
        return { outcome: "resumed", record } as const;
      },
    });

    expect(second.spawned).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.argv).toContain("--resume");
    expect(spawns[1]?.argv).toContain(HARNESS_ID);
    expect(second.record.driverGeneration).toBe(first.record.driverGeneration + 1);
    expect(registry.get(second.localId)).toBe(second.record);
    // The resumed conversation was seeded the first time round; re-sending the
    // scoping prompt would repeat it to an agent that already has it.
    expect(spawns[1]?.proc.written.join("")).not.toContain(SEED_MARKER);
  });

  test("a thread with nothing to resume gets a fresh child AND the seed prompt again", async () => {
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    await spawnThenExit("unresumable", registry, spawns);

    const second = await startEntityThreadSession({
      seed: seed("unresumable"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      // The child died before `init`, so there is no conversation to resume.
      resumeSession: async () => ({ outcome: "unrecoverable", reason: "spawn-died-before-init" }),
      onStateChange: () => {},
      onResultSummary: () => {},
    });

    expect(second.spawned).toBe(true);
    expect(second.seeded).toBe(true);
    const written = spawns[1]?.proc.written.join("") ?? "";
    expect(written).toContain(SEED_MARKER);
    expect(written).toContain(SEED_BODY);
  });

  test("a conversation another process is resuming is not restarted underneath it", async () => {
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    const first = await spawnThenExit("locked", registry, spawns);

    const second = await startEntityThreadSession({
      seed: seed("locked"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      resumeSession: async () => ({ outcome: "locked" }) as const,
      onStateChange: () => {},
      onResultSummary: () => {},
    });

    // Honest rather than convenient: the dead record comes back, the send
    // reports itself undelivered, and the lock clears in seconds.
    expect(second.spawned).toBe(false);
    expect(second.record).toBe(first.record);
    expect(spawns).toHaveLength(1);
    expect(sendDrivenSessionInput(second.record, "well?")).toBe(false);
    // PR #2601 R1 BLOCKING — `seeded` claims a reachable scoped agent, and
    // there is none here. Reporting true would mask exactly the stuck thread
    // this task exists to end.
    expect(second.seeded).toBe(false);
  });

  test("the dead record's subscribers are told to swap exactly once", async () => {
    const registry = new DrivenSessionRegistry();
    const spawns: Spawn[] = [];
    const first = await spawnThenExit("swap-notice", registry, spawns);

    let swaps = 0;
    first.record.subscribers.add({
      onEvent: () => {},
      onSwap: () => {
        swaps += 1;
      },
    });

    await startEntityThreadSession({
      seed: seed("swap-notice"),
      cwd: TEST_CWD,
      spawnFn: recordingSpawn(spawns),
      registry,
      command: "fake-claude",
      resumeSession: nothingToResume,
      onStateChange: () => {},
      onResultSummary: () => {},
    });

    expect(swaps).toBe(1);
  });

  /**
   * mt#4093 — the ABSENT record, which mt#3550 above never covered.
   *
   * Every test in the parent block starts by spawning, so a registry record
   * always exists by the time the second call runs. Production's common case
   * after a daemon restart is the opposite: the registry is EMPTY, because boot
   * reconciliation loads only non-terminal rows and may not have run at all.
   * The guard read `if (existing)` before consulting the resume path, so that
   * case fell straight through to a fresh spawn — none of the three resume
   * branches ran, which is why the 2026-08-12 incident logs carried no trace of
   * a declined resume. The thread continued under an agent that had never seen
   * a word of it while the panel kept rendering the whole history.
   */
  describe("the registry is EMPTY — the post-restart state (mt#4093)", () => {
    /** The persisted row's conversation, as boot reconciliation never loaded it. */
    const PERSISTED_ID = "4093bbbb-0000-4000-8000-000000000000";

    test("a thread with a persisted conversation RESUMES it, with nothing in the registry", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];
      const localId = entityThreadLocalId("ask", "empty-registry-resume");
      expect(registry.get(localId)).toBeUndefined();

      let consulted = 0;
      const session = await startEntityThreadSession({
        seed: seed("empty-registry-resume"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        onStateChange: () => {},
        onResultSummary: () => {},
        // Stands in for the persisted-row lookup + advisory lock only. The
        // respawn below is the REAL one, so the argv asserted afterwards is
        // the production article — this is what makes the test a check on
        // `--resume` actually being passed rather than on a fixture.
        resumeSession: async (id: string) => {
          consulted += 1;
          const { record } = resumeDrivenSession({
            previous: {
              localId: id,
              cwd: TEST_CWD,
              permissionMode: DEFAULT_PERMISSION_MODE,
              harnessSessionId: PERSISTED_ID,
              taskId: null,
              minskySessionId: null,
              startedAt: new Date().toISOString(),
              driverGeneration: 0,
            },
            registry,
            spawnFn: recordingSpawn(spawns),
            command: "fake-claude",
            mcpConfig: null,
          });
          return { outcome: "resumed", record } as const;
        },
      });

      // The load-bearing assertion: the resume path was REACHED. Before the
      // fix this was 0 and the assertions below all failed on a fresh spawn.
      expect(consulted).toBe(1);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.argv).toContain("--resume");
      expect(spawns[0]?.argv).toContain(PERSISTED_ID);
      // AT4: a resume continues the SAME conversation rather than minting one.
      expect(session.record.harnessSessionId).toBe(PERSISTED_ID);
      // Already scoped — re-seeding would repeat the whole prompt to an agent
      // that has it, and would be the tell that this was really a fresh spawn.
      expect(spawns[0]?.proc.written.join("")).not.toContain(SEED_MARKER);
      expect(session.replacedConversationId).toBeUndefined();
      expect(session.freshSpawnReason).toBeUndefined();
    });

    test("a fresh spawn over an unresumable conversation REPORTS which one it replaced", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];

      const session = await startEntityThreadSession({
        seed: seed("empty-registry-swap"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        // The row names a conversation, and it cannot be resumed — a deleted
        // workspace is the production shape (mt#3397).
        resumeSession: async () =>
          ({
            outcome: "unrecoverable",
            reason: "deleted cwd",
            harnessSessionId: PERSISTED_ID,
          }) as const,
        onStateChange: () => {},
        onResultSummary: () => {},
      });

      expect(session.spawned).toBe(true);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.argv).not.toContain("--resume");
      // The disclosure the panel renders. Reported HERE because this is the
      // last moment it is knowable: the spawn just upserted `driven_sessions`
      // on this localId, overwriting `harness_session_id` with the new
      // conversation.
      expect(session.replacedConversationId).toBe(PERSISTED_ID);
      expect(session.freshSpawnReason).toBe("prior-conversation-unrecoverable");
      // A fresh child knows nothing about the entity until it is seeded.
      expect(spawns[0]?.proc.written.join("")).toContain(SEED_MARKER);
    });

    test("a row that never linked a conversation replaces nothing, and says so", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];

      const session = await startEntityThreadSession({
        seed: seed("empty-registry-never-linked"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        // spawn-died-before-init: a row exists but no conversation was ever
        // linked to it.
        resumeSession: async () =>
          ({ outcome: "unrecoverable", reason: "spawn-died-before-init" }) as const,
        onStateChange: () => {},
        onResultSummary: () => {},
      });

      expect(session.spawned).toBe(true);
      // Distinct from the case above, and the distinction is the point: there
      // is no earlier exchange the operator can be reading, so claiming a swap
      // would put a notice on screen about a conversation that never existed.
      expect(session.replacedConversationId).toBeUndefined();
      expect(session.freshSpawnReason).toBe("prior-spawn-never-linked");
    });

    test("a first-ever launch names its reason too, and replaces nothing", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];

      const session = await startEntityThreadSession({
        seed: seed("empty-registry-first-launch"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        resumeSession: nothingToResume,
        onStateChange: () => {},
        onResultSummary: () => {},
      });

      expect(session.spawned).toBe(true);
      expect(session.freshSpawnReason).toBe("no-prior-conversation");
      expect(session.replacedConversationId).toBeUndefined();
    });

    test("a resume that THREW still spawns, and does not claim to know why", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];

      const session = await startEntityThreadSession({
        seed: seed("empty-registry-resume-threw"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        resumeSession: async () => {
          throw new Error("store unreachable");
        },
        onStateChange: () => {},
        onResultSummary: () => {},
      });

      expect(session.spawned).toBe(true);
      expect(session.freshSpawnReason).toBe("resume-attempt-failed");
      // A throw says nothing about whether a conversation existed, so nothing
      // is asserted about one — an invented swap notice would be worse than
      // none.
      expect(session.replacedConversationId).toBeUndefined();
    });

    test("a lock held elsewhere does not spawn a rival, even with an empty registry", async () => {
      const registry = new DrivenSessionRegistry();
      const spawns: Spawn[] = [];

      const session = await startEntityThreadSession({
        seed: seed("empty-registry-locked"),
        cwd: TEST_CWD,
        spawnFn: recordingSpawn(spawns),
        registry,
        command: "fake-claude",
        resumeSession: async () => ({ outcome: "locked" }) as const,
        onStateChange: () => {},
        onResultSummary: () => {},
      });

      // The lock exists to stop a second child against one conversation, and
      // that does not weaken just because THIS daemon never loaded the record.
      // With nothing in the registry to hand back, a placeholder stands in.
      expect(spawns).toHaveLength(0);
      expect(session.spawned).toBe(false);
      expect(session.seeded).toBe(false);
      expect(session.record.localId).toBe(session.localId);
      expect(sendDrivenSessionInput(session.record, "well?")).toBe(false);
    });
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});
