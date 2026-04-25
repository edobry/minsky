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
 *   - close convenience wrapper: response attached, terminal state set
 *   - getById: returns null for unknown id
 */

import { describe, it, expect, beforeEach } from "bun:test";

import type { AskKind } from "./types";
import { FakeAskRepository } from "./repository";
import type { CreateAskInput } from "./repository";
import { InvalidAskTransitionError } from "./state-machine";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Kind used when testing a non-default AskKind value. */
const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";

/** Minimal valid CreateAskInput with every required field. */
function makeInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    requestor: "com.anthropic.claude-code:proc:test-agent",
    title: "Review this output",
    question: "Does this implementation satisfy the spec?",
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

  it("defaults state to 'detected' when not supplied", async () => {
    const ask = await repo.create(makeInput());
    expect(ask.state).toBe("detected");
  });

  it("accepts an explicit initial state", async () => {
    const ask = await repo.create(makeInput({ state: "classified" }));
    expect(ask.state).toBe("classified");
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

  it("allows cancellation from routed", async () => {
    const ask = await repo.create(makeInput({ state: "routed" }));
    const cancelled = await repo.transition(ask.id, "cancelled");
    expect(cancelled.state).toBe("cancelled");
  });

  it("allows expiry from suspended", async () => {
    const ask = await repo.create(makeInput({ state: "suspended" }));
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
    const ask = await repo.create(makeInput({ state: "closed" }));
    await expect(repo.transition(ask.id, "responded")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on responded → detected", async () => {
    const ask = await repo.create(makeInput({ state: "responded" }));
    await expect(repo.transition(ask.id, "detected")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on expired → closed", async () => {
    const ask = await repo.create(makeInput({ state: "expired" }));
    await expect(repo.transition(ask.id, "closed")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("throws InvalidAskTransitionError on cancelled → responded", async () => {
    const ask = await repo.create(makeInput({ state: "cancelled" }));
    await expect(repo.transition(ask.id, "responded")).rejects.toBeInstanceOf(
      InvalidAskTransitionError
    );
  });

  it("error message names both states clearly", async () => {
    const ask = await repo.create(makeInput({ state: "closed" }));
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
    await repo.create(makeInput({ state: "detected" }));
    await repo.create(makeInput({ state: "detected" }));
    await repo.create(makeInput({ state: "classified" }));
    await repo.create(makeInput({ state: "suspended" }));

    const suspended = await repo.listByState("suspended");
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.state).toBe("suspended");

    const detected = await repo.listByState("detected");
    expect(detected).toHaveLength(2);
  });

  it("returns an empty array when no Asks match the state", async () => {
    await repo.create(makeInput({ state: "detected" }));
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

// ---------------------------------------------------------------------------
// close convenience wrapper
// ---------------------------------------------------------------------------

describe("close", () => {
  it("transitions to closed and attaches the response payload", async () => {
    const ask = await repo.create(makeInput({ state: "responded" }));

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
    const ask = await repo.create(makeInput({ state: "closed" }));
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
    const ask = await repo.create(makeInput({ state: "responded" }));
    const payload = { decision: "approved" };
    await repo.close(ask.id, { response: { responder: "operator", payload } });

    const fetched = await repo.getById(ask.id);
    expect(fetched?.state).toBe("closed");
    expect((fetched?.response?.payload as typeof payload)?.decision).toBe("approved");
  });
});
