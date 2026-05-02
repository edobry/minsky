/**
 * AskRepository unit tests — hermetic, no real DB.
 *
 * All tests run against `FakeAskRepository`, which implements the full
 * `AskRepository` interface using in-memory state and the same
 * `guardTransition` call as the production Drizzle implementation.
 *
 * Coverage goals (per mt#1237 spec):
 *   - create round-trip (all fields preserved)
 *   - kind exhaustiveness (every AskKind can be stored and retrieved)
 *   - state-machine valid transitions (full happy path)
 *   - state-machine invalid transitions (throws with clear error)
 *   - list filters: listByParentTask, listByParentSession, listByState,
 *     listByClassifierVersion
 *   - respond convenience wrapper: response attached, respondedAt set
 *   - close convenience wrapper: response attached, terminal state set
 *   - getById: returns null for unknown id
 */

import { describe, it, expect, beforeEach } from "bun:test";

import type { Ask, AskKind } from "./types";
import { FakeAskRepository, toAsk } from "./repository";
import type { CreateAskInput } from "./repository";
import type { AskRecord } from "../storage/schemas/ask-schema";
import { InvalidAskTransitionError } from "./state-machine";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Kind used when testing a non-default AskKind value. */
const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";

/** Default requestor used across test fixtures (extracted to a constant per
 *  custom/no-magic-string-duplication). */
const TEST_REQUESTOR = "com.anthropic.claude-code:proc:test-agent";

/** Minimal valid CreateAskInput with every required field. */
function makeInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    requestor: TEST_REQUESTOR,
    title: "Review this output",
    question: "Does this implementation satisfy the spec?",
    metadata: {},
    ...overrides,
  };
}

/** Build a minimal Ask object for use with _seedAtState. */
function makeSeedAsk(overrides: Partial<Ask>): Ask {
  return {
    id: overrides.id ?? `seed-${Math.random().toString(36).slice(2)}`,
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    state: "detected",
    requestor: TEST_REQUESTOR,
    title: "Review this output",
    question: "Does this implementation satisfy the spec?",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let repo: FakeAskRepository;

beforeEach(() => {
  repo = new FakeAskRepository();
});

// ---------------------------------------------------------------------------
// create + getById round-trip
// ---------------------------------------------------------------------------

describe("create", () => {
  it("returns an Ask with the supplied fields", async () => {
    const input = makeInput({
      kind: KIND_DIRECTION_DECIDE,
      classifierVersion: "v2.0.0",
      parentTaskId: "mt#123",
      parentSessionId: "session-abc",
      title: "Choose a framework",
      question: "React or Svelte?",
      metadata: { hint: "prefer minimal" },
    });

    const ask = await repo.create(input);

    expect(ask.id).toBeDefined();
    expect(ask.kind).toBe(KIND_DIRECTION_DECIDE);
    expect(ask.classifierVersion).toBe("v2.0.0");
    expect(ask.state).toBe("detected");
    expect(ask.requestor).toBe("com.anthropic.claude-code:proc:test-agent");
    expect(ask.parentTaskId).toBe("mt#123");
    expect(ask.parentSessionId).toBe("session-abc");
    expect(ask.title).toBe("Choose a framework");
    expect(ask.question).toBe("React or Svelte?");
    expect(ask.metadata).toEqual({ hint: "prefer minimal" });
    expect(ask.createdAt).toBeDefined();
  });

  it("always starts state at 'detected'", async () => {
    const ask = await repo.create(makeInput());
    expect(ask.state).toBe("detected");
  });

  it("assigns a unique id per Ask", async () => {
    const a = await repo.create(makeInput());
    const b = await repo.create(makeInput());
    expect(a.id).not.toBe(b.id);
  });
});

describe("getById", () => {
  it("returns the Ask matching the given id", async () => {
    const created = await repo.create(makeInput());
    const fetched = await repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe(created.title);
  });

  it("returns null for an unknown id", async () => {
    const result = await repo.getById("non-existent-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AskKind exhaustiveness
// ---------------------------------------------------------------------------

describe("AskKind exhaustiveness", () => {
  const allKinds: AskKind[] = [
    "capability.escalate",
    "information.retrieve",
    "authorization.approve",
    "direction.decide",
    "coordination.notify",
    "quality.review",
    "stuck.unblock",
  ];

  for (const kind of allKinds) {
    it(`stores and retrieves kind="${kind}"`, async () => {
      const ask = await repo.create(makeInput({ kind }));
      const fetched = await repo.getById(ask.id);
      expect(fetched?.kind).toBe(kind);
    });
  }
});

// ---------------------------------------------------------------------------
// State-machine: valid transitions (full happy path per acceptance test)
// ---------------------------------------------------------------------------

describe("transition — valid moves", () => {
  it("walks detected → classified → routed → suspended → responded → closed", async () => {
    const ask = await repo.create(makeInput({ kind: "quality.review" }));
    expect(ask.state).toBe("detected");

    const classified = await repo.transition(ask.id, "classified");
    expect(classified.state).toBe("classified");

    const routed = await repo.transition(ask.id, "routed");
    expect(routed.state).toBe("routed");
    expect(routed.routedAt).toBeDefined();

    const suspended = await repo.transition(ask.id, "suspended");
    expect(suspended.state).toBe("suspended");
    expect(suspended.suspendedAt).toBeDefined();

    const responded = await repo.transition(ask.id, "responded");
    expect(responded.state).toBe("responded");
    expect(responded.respondedAt).toBeDefined();

    const closed = await repo.transition(ask.id, "closed");
    expect(closed.state).toBe("closed");
    expect(closed.closedAt).toBeDefined();
  });

  it("allows cancellation from detected", async () => {
    const ask = await repo.create(makeInput());
    const cancelled = await repo.transition(ask.id, "cancelled");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.closedAt).toBeDefined();
  });

  it("allows cancellation from routed (walk to routed first)", async () => {
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    const cancelled = await repo.transition(ask.id, "cancelled");
    expect(cancelled.state).toBe("cancelled");
  });

  it("allows expiry from suspended (walk to suspended first)", async () => {
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    const expired = await repo.transition(ask.id, "expired");
    expect(expired.state).toBe("expired");
    expect(expired.closedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// State-machine: invalid transitions (acceptance test: throw with clear error)
// ---------------------------------------------------------------------------

describe("transition — invalid moves", () => {
  it("throws InvalidAskTransitionError on closed → responded", async () => {
    const ask = await repo.create(makeInput());
    // Walk to closed via full happy path
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.transition(ask.id, "responded");
    await repo.transition(ask.id, "closed");
    await expect(repo.transition(ask.id, "responded")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on responded → detected", async () => {
    // Seed at responded state for invalid-transition test
    const seeded = makeSeedAsk({ id: "seed-responded-1", state: "responded" });
    repo._seedAtState(seeded);
    await expect(repo.transition(seeded.id, "detected")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on expired → closed", async () => {
    // Seed at expired state for invalid-transition test
    const seeded = makeSeedAsk({ id: "seed-expired-1", state: "expired" });
    repo._seedAtState(seeded);
    await expect(repo.transition(seeded.id, "closed")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on cancelled → responded", async () => {
    // Seed at cancelled state for invalid-transition test
    const seeded = makeSeedAsk({ id: "seed-cancelled-1", state: "cancelled" });
    repo._seedAtState(seeded);
    await expect(repo.transition(seeded.id, "responded")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("error message names both states clearly", async () => {
    // Walk to closed, then attempt invalid transition
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.transition(ask.id, "responded");
    await repo.transition(ask.id, "closed");
    let caught: unknown;
    try {
      await repo.transition(ask.id, "responded");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidAskTransitionError);
    const err = caught as InvalidAskTransitionError;
    expect(err.from).toBe("closed");
    expect(err.to).toBe("responded");
    expect(err.message).toContain("closed");
    expect(err.message).toContain("responded");
  });

  it("throws Error (not InvalidAskTransitionError) for unknown id", async () => {
    await expect(repo.transition("no-such-id", "classified")).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------------

describe("listByParentTask", () => {
  it("returns only Asks whose parentTaskId matches", async () => {
    await repo.create(makeInput({ parentTaskId: "mt#100" }));
    await repo.create(makeInput({ parentTaskId: "mt#100" }));
    await repo.create(makeInput({ parentTaskId: "mt#999" }));

    const results = await repo.listByParentTask("mt#100");
    expect(results).toHaveLength(2);
    for (const ask of results) {
      expect(ask.parentTaskId).toBe("mt#100");
    }
  });

  it("returns an empty array when no Asks match", async () => {
    await repo.create(makeInput({ parentTaskId: "mt#001" }));
    const results = await repo.listByParentTask("mt#999");
    expect(results).toHaveLength(0);
  });
});

describe("listByParentSession", () => {
  it("returns only Asks whose parentSessionId matches", async () => {
    await repo.create(makeInput({ parentSessionId: "session-a" }));
    await repo.create(makeInput({ parentSessionId: "session-a" }));
    await repo.create(makeInput({ parentSessionId: "session-b" }));

    const results = await repo.listByParentSession("session-a");
    expect(results).toHaveLength(2);
    for (const ask of results) {
      expect(ask.parentSessionId).toBe("session-a");
    }
  });
});

describe("listByState", () => {
  it("returns only Asks in the given state", async () => {
    // Create detected Asks
    await repo.create(makeInput());
    await repo.create(makeInput());
    // Create a classified Ask by walking
    const a3 = await repo.create(makeInput());
    await repo.transition(a3.id, "classified");
    // Create a suspended Ask by walking
    const a4 = await repo.create(makeInput());
    await repo.transition(a4.id, "classified");
    await repo.transition(a4.id, "routed");
    await repo.transition(a4.id, "suspended");

    const suspended = await repo.listByState("suspended");
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.state).toBe("suspended");

    const detected = await repo.listByState("detected");
    expect(detected).toHaveLength(2);
  });

  it("returns an empty array when no Asks match the state", async () => {
    await repo.create(makeInput());
    const results = await repo.listByState("expired");
    expect(results).toHaveLength(0);
  });
});

describe("listByClassifierVersion", () => {
  it("returns only Asks with the matching classifierVersion", async () => {
    await repo.create(makeInput({ classifierVersion: "v1.0.0" }));
    await repo.create(makeInput({ classifierVersion: "v1.0.0" }));
    await repo.create(makeInput({ classifierVersion: "v2.0.0" }));

    const v1 = await repo.listByClassifierVersion("v1.0.0");
    expect(v1).toHaveLength(2);
    for (const ask of v1) {
      expect(ask.classifierVersion).toBe("v1.0.0");
    }

    const v2 = await repo.listByClassifierVersion("v2.0.0");
    expect(v2).toHaveLength(1);
  });
});

describe("findOpenByTaskIds", () => {
  it("returns an empty array when taskIds is empty", async () => {
    await repo.create(makeInput({ parentTaskId: "mt#100" }));
    const results = await repo.findOpenByTaskIds([]);
    expect(results).toHaveLength(0);
  });

  it("returns Asks whose parentTaskId is in the input set", async () => {
    await repo.create(makeInput({ parentTaskId: "mt#100" }));
    await repo.create(makeInput({ parentTaskId: "mt#200" }));
    await repo.create(makeInput({ parentTaskId: "mt#300" }));

    const results = await repo.findOpenByTaskIds(["mt#100", "mt#300"]);
    expect(results).toHaveLength(2);
    const ids = results.map((a) => a.parentTaskId).sort();
    expect(ids).toEqual(["mt#100", "mt#300"]);
  });

  it("excludes terminal-state Asks (closed / cancelled / expired)", async () => {
    repo._seedAtState(makeSeedAsk({ id: "ask-closed", parentTaskId: "mt#100", state: "closed" }));
    repo._seedAtState(
      makeSeedAsk({ id: "ask-cancelled", parentTaskId: "mt#100", state: "cancelled" })
    );
    repo._seedAtState(makeSeedAsk({ id: "ask-expired", parentTaskId: "mt#100", state: "expired" }));
    repo._seedAtState(makeSeedAsk({ id: "ask-open", parentTaskId: "mt#100", state: "detected" }));

    const results = await repo.findOpenByTaskIds(["mt#100"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("ask-open");
  });

  it("includes non-terminal states (detected, classified, routed, suspended, responded)", async () => {
    const openStates = ["detected", "classified", "routed", "suspended", "responded"] as const;
    for (const state of openStates) {
      repo._seedAtState(makeSeedAsk({ id: `ask-${state}`, parentTaskId: "mt#100", state }));
    }

    const results = await repo.findOpenByTaskIds(["mt#100"]);
    expect(results).toHaveLength(openStates.length);
  });

  it("returns rows ordered by createdAt descending", async () => {
    repo._seedAtState(
      makeSeedAsk({
        id: "ask-old",
        parentTaskId: "mt#100",
        state: "detected",
        createdAt: new Date(2025, 0, 1).toISOString(),
      })
    );
    repo._seedAtState(
      makeSeedAsk({
        id: "ask-new",
        parentTaskId: "mt#100",
        state: "routed",
        createdAt: new Date(2025, 6, 1).toISOString(),
      })
    );
    repo._seedAtState(
      makeSeedAsk({
        id: "ask-mid",
        parentTaskId: "mt#100",
        state: "classified",
        createdAt: new Date(2025, 3, 1).toISOString(),
      })
    );

    const results = await repo.findOpenByTaskIds(["mt#100"]);
    expect(results.map((a) => a.id)).toEqual(["ask-new", "ask-mid", "ask-old"]);
  });

  it("returns rows for multiple tasks, all sorted in one stream", async () => {
    repo._seedAtState(
      makeSeedAsk({
        id: "task100-newer",
        parentTaskId: "mt#100",
        state: "detected",
        createdAt: new Date(2025, 6, 1).toISOString(),
      })
    );
    repo._seedAtState(
      makeSeedAsk({
        id: "task200-older",
        parentTaskId: "mt#200",
        state: "detected",
        createdAt: new Date(2025, 0, 1).toISOString(),
      })
    );

    const results = await repo.findOpenByTaskIds(["mt#100", "mt#200"]);
    expect(results.map((a) => a.id)).toEqual(["task100-newer", "task200-older"]);
  });

  it("ignores Asks whose parentTaskId is not in the input set", async () => {
    await repo.create(makeInput({ parentTaskId: "mt#100" }));
    await repo.create(makeInput({ parentTaskId: "mt#200" }));

    const results = await repo.findOpenByTaskIds(["mt#999"]);
    expect(results).toHaveLength(0);
  });

  it("ignores Asks with no parentTaskId", async () => {
    repo._seedAtState(makeSeedAsk({ id: "no-task", parentTaskId: undefined, state: "detected" }));
    await repo.create(makeInput({ parentTaskId: "mt#100" }));

    const results = await repo.findOpenByTaskIds(["mt#100"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.parentTaskId).toBe("mt#100");
  });
});

// ---------------------------------------------------------------------------
// respond convenience wrapper
// ---------------------------------------------------------------------------

describe("respond", () => {
  it("transitions to responded, attaches response payload, and sets respondedAt", async () => {
    // Walk to suspended first
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");

    const response: NonNullable<import("./types").Ask["response"]> = {
      responder: "operator",
      payload: { approved: true },
      attentionCost: undefined,
    };

    const responded = await repo.respond(ask.id, { response });

    expect(responded.state).toBe("responded");
    expect(responded.response).toEqual(response);
    expect(responded.respondedAt).toBeDefined();
  });

  it("throws InvalidAskTransitionError when responding from 'closed'", async () => {
    // Walk to closed
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.transition(ask.id, "responded");
    await repo.transition(ask.id, "closed");
    await expect(
      repo.respond(ask.id, { response: { responder: "operator", payload: {} } })
    ).rejects.toBeInstanceOf(InvalidAskTransitionError);
  });

  it("throws when the Ask id is not found", async () => {
    await expect(
      repo.respond("no-such-id", { response: { responder: "operator", payload: {} } })
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// close convenience wrapper
// ---------------------------------------------------------------------------

describe("close", () => {
  it("transitions to closed and attaches the response payload", async () => {
    // Walk to responded using the respond() method, then close
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.respond(ask.id, {
      response: { responder: "operator", payload: { approved: true } },
    });

    const response: NonNullable<import("./types").Ask["response"]> = {
      responder: "operator",
      payload: { approved: true },
      attentionCost: undefined,
    };

    const closed = await repo.close(ask.id, { response });

    expect(closed.state).toBe("closed");
    expect(closed.response).toEqual(response);
    expect(closed.closedAt).toBeDefined();
  });

  it("throws InvalidAskTransitionError when closing from 'closed'", async () => {
    // Walk to closed, then try to close again
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.transition(ask.id, "responded");
    await repo.transition(ask.id, "closed");
    await expect(
      repo.close(ask.id, { response: { responder: "operator", payload: {} } })
    ).rejects.toBeInstanceOf(InvalidAskTransitionError);
  });

  it("throws when the Ask id is not found", async () => {
    await expect(
      repo.close("no-such-id", { response: { responder: "operator", payload: {} } })
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// Persistence verification: transition state persists through getById
// ---------------------------------------------------------------------------

describe("state persistence across operations", () => {
  it("getById reflects state after transition", async () => {
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");

    const fetched = await repo.getById(ask.id);
    expect(fetched?.state).toBe("classified");
  });

  it("getById reflects response after close", async () => {
    // Walk to responded via respond(), then close
    const ask = await repo.create(makeInput());
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    const payload = { decision: "approved" };
    await repo.respond(ask.id, { response: { responder: "operator", payload } });
    await repo.close(ask.id, { response: { responder: "operator", payload } });

    const fetched = await repo.getById(ask.id);
    expect(fetched?.state).toBe("closed");
    expect((fetched?.response?.payload as typeof payload)?.decision).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// toAsk: documented defaults for legacy rows with NULL service-window fields
// ---------------------------------------------------------------------------

describe("toAsk — service-window NULL coalescing (B2, mt#1488 R3)", () => {
  /**
   * Build a minimal AskRecord with the given overrides.
   *
   * Simulates a legacy DB row where PostgreSQL ADD COLUMN DEFAULT did not
   * backfill existing rows, so window_missed_count and force_immediate are NULL.
   */
  function makeLegacyRow(overrides: Partial<AskRecord> = {}): AskRecord {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      state: "detected",
      requestor: TEST_REQUESTOR,
      routingTarget: null,
      parentTaskId: null,
      parentSessionId: null,
      title: "Legacy row",
      question: "Does this work?",
      options: null,
      contextRefs: null,
      response: null,
      deadline: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      routedAt: null,
      suspendedAt: null,
      respondedAt: null,
      closedAt: null,
      serviceStrategy: null,
      windowKey: null,
      windowMissedCount: null,
      forceImmediate: null,
      metadata: {},
      ...overrides,
    };
  }

  it("coalesces NULL window_missed_count to 0 (documented default)", () => {
    const row = makeLegacyRow({ windowMissedCount: null });
    const ask = toAsk(row);
    expect(ask.windowMissedCount).toBe(0);
  });

  it("coalesces NULL force_immediate to false (documented default)", () => {
    const row = makeLegacyRow({ forceImmediate: null });
    const ask = toAsk(row);
    expect(ask.forceImmediate).toBe(false);
  });

  it("preserves explicit windowMissedCount when set", () => {
    const row = makeLegacyRow({ windowMissedCount: 3 });
    const ask = toAsk(row);
    expect(ask.windowMissedCount).toBe(3);
  });

  it("preserves explicit forceImmediate=true when set", () => {
    const row = makeLegacyRow({ forceImmediate: true });
    const ask = toAsk(row);
    expect(ask.forceImmediate).toBe(true);
  });
});
