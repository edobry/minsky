/**
 * Tests for the `asks.create` producer surface (mt#1456).
 *
 * Exercises the `createAsk` helper end-to-end with a `FakeAskRepository`,
 * verifying:
 *   1. The Ask is persisted via `repo.create`.
 *   2. mt#1069's `policyFirstRoute` semantics are preserved (no router
 *      behavior change beyond surfacing it via MCP).
 *   3. Default-value handling for `requestor` and `classifierVersion`.
 *
 * Tests pass `workspaceRoot` to a non-existent path so policy loaders
 * (which fail-and-return-empty on missing files/globs) yield an empty
 * source set; the router falls through to its kind-based binding matrix.
 * No real filesystem operations occur in this test.
 *
 * Reference: mt#1456 spec.
 */

import { describe, expect, test } from "bun:test";

import { createAsk, respondToAsk } from "./asks";
import { FakeAskRepository } from "../../../domain/ask/repository";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Workspace root for tests. Points at a non-existent directory so:
 *   - `loadClaudeMd` returns [] (readFile throws ENOENT, swallowed).
 *   - `loadProjectRules` returns [] (glob returns [] on no matches).
 *   - `loadTaskSpec` returns [] when specContent is null/undefined.
 *   - `loadMemories` returns [] (v1 placeholder).
 *
 * Net effect: the policy-coverage check sees no sources, the router
 * falls through to the kind-based binding matrix.
 */
const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_asks_create__";

// Centralized AskKind literal references — extracting these defangs the
// custom/no-magic-string-duplication lint rule and keeps the kind names
// in one place if the taxonomy ever evolves.
const KIND_DIRECTION_DECIDE = "direction.decide" as const;
const KIND_CAPABILITY_ESCALATE = "capability.escalate" as const;
const KIND_COORDINATION_NOTIFY = "coordination.notify" as const;

// Centralized fixture for the agent-id format used in multiple tests.
const FIXTURE_RESPONDER_ID = "com.anthropic.claude-code:proc:abc123";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAsk", () => {
  test("persists the Ask via the repository", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Choose A or B",
        question: "Which approach should we ship?",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(repo.all).toHaveLength(1);
    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.kind).toBe(KIND_DIRECTION_DECIDE);
    expect(persisted.title).toBe("Choose A or B");
    expect(persisted.question).toBe("Which approach should we ship?");
    expect(persisted.options).toEqual([
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ]);
    // Newly-persisted Asks land in "detected" state per the FakeAskRepository
    // contract; the routed/closed transitions are not yet persisted (mt#1456
    // §Persistence semantics).
    expect(persisted.state).toBe("detected");
  });

  test("returns a RoutedAsk with kind-based fallback for direction.decide (no policy match)", async () => {
    const repo = new FakeAskRepository();

    const routed = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // mt#1069's transport-binding matrix: direction.decide → operator/inbox.
    expect(routed.state).toBe("routed");
    expect(routed.routingTarget).toBe("operator");
    expect(routed.transport.kind).toBe("inbox");
    expect(routed.packagedPayload.question).toBe("Y");
    // No policy citation when no policy source covers the Ask.
    expect(routed.packagedPayload.citation).toBeUndefined();
  });

  test("returns a RoutedAsk with subagent transport for capability.escalate", async () => {
    const repo = new FakeAskRepository();

    const routed = await createAsk(
      repo,
      {
        kind: KIND_CAPABILITY_ESCALATE,
        title: "Need bigger model",
        question: "Please reason about this corner case",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(routed.state).toBe("routed");
    expect(routed.routingTarget).toBe("subagent");
    expect(routed.transport.kind).toBe("subagent");
  });

  test("returns a RoutedAsk with mesh transport for coordination.notify", async () => {
    const repo = new FakeAskRepository();

    const routed = await createAsk(
      repo,
      {
        kind: KIND_COORDINATION_NOTIFY,
        title: "Heads up",
        question: "Sibling agent should know about this event",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(routed.state).toBe("routed");
    expect(routed.routingTarget).toBe("peer");
    expect(routed.transport.kind).toBe("mesh");
  });

  test("defaults classifierVersion to v1.0.0 when omitted", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.classifierVersion).toBe("v1.0.0");
  });

  test("defaults requestor to minsky.agent:unknown when omitted", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.requestor).toBe("minsky.agent:unknown");
  });

  test("forwards explicit requestor through to the persisted Ask", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
        requestor: FIXTURE_RESPONDER_ID,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.requestor).toBe(FIXTURE_RESPONDER_ID);
  });

  test("forwards parentTaskId and parentSessionId through to the persisted Ask", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
        parentTaskId: "mt#1456",
        parentSessionId: "session-abc",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.parentTaskId).toBe("mt#1456");
    expect(persisted.parentSessionId).toBe("session-abc");
  });

  test("forwards metadata through to the persisted Ask", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_CAPABILITY_ESCALATE,
        title: "X",
        question: "Y",
        metadata: { model: "opus", agentType: "general-purpose" },
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.metadata).toEqual({
      model: "opus",
      agentType: "general-purpose",
    });
  });

  // -------------------------------------------------------------------------
  // capability-aware routing wiring (mt#1457)
  // -------------------------------------------------------------------------

  test("routes direction.decide to elicitation when capabilityRegistry reports hasElicitation=true", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Test",
        question: "Pick X or Y",
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => true,
          activeElicitationServer: () => null,
        },
      }
    );

    expect(result.transport.kind).toBe("elicitation");
    expect(result.routingTarget).toBe("operator");
  });

  test("falls back to inbox when capabilityRegistry reports hasElicitation=false", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => false,
          activeElicitationServer: () => null,
        },
      }
    );

    expect(result.transport.kind).toBe("inbox");
  });

  // -------------------------------------------------------------------------
  // PR #919 R3 — single producer surface, end-to-end dispatch
  // -------------------------------------------------------------------------

  test("dispatches end-to-end through elicitation when an active server is present", async () => {
    const repo = new FakeAskRepository();

    // Fake server that accepts the elicitation with a chosen value.
    const fakeServer = {
      elicitInput: async (_params: unknown, _options?: unknown) => ({
        action: "accept" as const,
        content: { chosen: "x" },
      }),
    };

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Pick X",
        question: "Pick X or Y",
        options: [
          { label: "X", value: "x" },
          { label: "Y", value: "y" },
        ],
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => true,
          activeElicitationServer: () => fakeServer,
        },
      }
    );

    expect(result.state).toBe("closed");
    expect(result.transport.kind).toBe("elicitation");
    expect(result.response?.payload).toEqual({ chosen: "x" });

    // The repo state matches the return — single coherent producer path.
    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("closed");
  });

  test("walks Ask to suspended when registry reports elicitation but no active server (strand recovery)", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => true,
          // Disconnect mid-call: capability said yes, but no server now.
          activeElicitationServer: () => null,
        },
      }
    );

    expect(result.state).toBe("suspended");
    expect(result.transport.kind).toBe("elicitation");
    expect(result.routingTarget).toBe("operator");
    // PR #919 R3 BLOCKING: cancelled/suspended objects do not include a
    // `response` field — that field is for responded/closed only.
    expect(result.response).toBeUndefined();

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.response).toBeUndefined();
  });

  test("returns routed Ask unchanged for non-elicitation transports (subagent)", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_CAPABILITY_ESCALATE,
        title: "Need bigger model",
        question: "Q",
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => true, // Even when capable, async kinds bypass elicitation.
          activeElicitationServer: () => ({
            elicitInput: async () => ({ action: "accept" as const }),
          }),
        },
      }
    );

    // Subagent transport — never touches elicitation regardless of registry state.
    expect(result.transport.kind).toBe("subagent");
    expect(result.state).toBe("routed");
  });
});

// ---------------------------------------------------------------------------
// respondToAsk (mt#1458)
// ---------------------------------------------------------------------------

/**
 * Helper: seed a FakeAskRepository with an Ask in the requested terminal-or-
 * suspended state. Walks the state machine forward via repo.transition so the
 * Ask has all the timestamps a real-flow Ask would have.
 */
async function seedAskInState(
  repo: FakeAskRepository,
  state:
    | "detected"
    | "classified"
    | "routed"
    | "suspended"
    | "responded"
    | "closed"
    | "cancelled"
    | "expired",
  routingTarget: "operator" | "subagent" | "policy" | "peer" = "operator"
) {
  const ask = await repo.create({
    kind: KIND_DIRECTION_DECIDE,
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: "T",
    question: "Q",
    metadata: {},
  });

  // FakeAskRepository.create doesn't accept routingTarget, so we use the
  // _seedAtState test seam to overwrite the state and routingTarget atomically.
  // (Per src/domain/ask/repository.ts: _seedAtState is the test-only bypass.)
  if (state === "detected" && routingTarget === "operator") {
    return ask; // Already in the target state with default routing.
  }

  // Walk through valid transitions for the simple cases.
  if (state === "suspended") {
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
  } else if (state === "responded" || state === "closed") {
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    await repo.transition(ask.id, "responded");
    if (state === "closed") {
      await repo.transition(ask.id, "closed");
    }
  } else if (state === "cancelled") {
    await repo.transition(ask.id, "cancelled");
  } else if (state === "expired") {
    await repo.transition(ask.id, "expired");
  } else if (state === "classified") {
    await repo.transition(ask.id, "classified");
  } else if (state === "routed") {
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
  }

  // Override routingTarget via the seed seam if the caller asked for non-operator.
  // The FakeAskRepository.create doesn't take routingTarget, but we can set it
  // by re-seeding. For now, the only test that uses non-operator overrides this
  // explicitly via _seedAtState below (kept narrow to avoid scope creep).
  if (routingTarget !== "operator") {
    const current = await repo.getById(ask.id);
    if (current) {
      // _seedAtState bypasses guards — used here ONLY because we need to override
      // routingTarget which isn't on the create() input shape. The state field is
      // preserved from the walk above. This is the pattern docstring of
      // _seedAtState in src/domain/ask/repository.ts.
      repo._seedAtState({ ...current, routingTarget });
    }
  }

  return ask;
}

describe("respondToAsk", () => {
  test("walks suspended → responded → closed and writes the response payload", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    const result = await respondToAsk(repo, {
      id: ask.id,
      message: "go with X",
    });

    expect(result.ask.state).toBe("closed");
    expect(result.ask.response?.responder).toBe("operator");
    expect(result.ask.response?.payload).toEqual({ message: "go with X" });
    expect(result.ask.response?.attentionCost?.transport).toBe("inbox");
    expect(result.ask.response?.attentionCost?.resolvedIn).toBe("inbox");

    // Persisted matches return — single coherent state.
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("closed");
    expect(persisted?.response?.payload).toEqual({ message: "go with X" });
  });

  test("uses 'operator' as default responder when not provided", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    const result = await respondToAsk(repo, { id: ask.id, message: "ok" });

    expect(result.ask.response?.responder).toBe("operator");
  });

  test("forwards explicit responder identifier through to the response payload", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    const result = await respondToAsk(repo, {
      id: ask.id,
      message: "ok",
      responder: FIXTURE_RESPONDER_ID,
    });

    expect(result.ask.response?.responder).toBe(FIXTURE_RESPONDER_ID);
  });

  test("throws when Ask does not exist", async () => {
    const repo = new FakeAskRepository();

    await expect(respondToAsk(repo, { id: "nonexistent-ask-id", message: "ok" })).rejects.toThrow(
      /Ask not found/
    );
  });

  test("rejects responding to an Ask in pre-suspended state ('detected')", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "detected");

    await expect(respondToAsk(repo, { id: ask.id, message: "ok" })).rejects.toThrow(
      /only "suspended" Asks can be responded to/
    );
  });

  test("rejects responding to an Ask in pre-suspended state ('routed')", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "routed");

    await expect(respondToAsk(repo, { id: ask.id, message: "ok" })).rejects.toThrow(
      /only "suspended" Asks can be responded to/
    );
  });

  test("rejects responding to a terminal Ask ('closed')", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "closed");

    await expect(respondToAsk(repo, { id: ask.id, message: "ok" })).rejects.toThrow(
      /only "suspended" Asks can be responded to/
    );
  });

  test("rejects responding to a cancelled Ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "cancelled");

    await expect(respondToAsk(repo, { id: ask.id, message: "ok" })).rejects.toThrow(
      /only "suspended" Asks can be responded to/
    );
  });

  // The routingTarget check that would gate this case lives behind the
  // mt#454-impl follow-up — see the inline note in src/adapters/shared/
  // commands/asks.ts:respondToAsk. At v1, every suspended Ask is an
  // operator-target by elimination, so we don't gate on routingTarget.
  // When a non-operator transport starts using suspended state, re-introduce
  // the gate AND this test.
  test("v1 placeholder: routingTarget gating deferred to mt#454-impl", () => {
    // Documented in the respondToAsk doc comment + the inline note. This
    // test slot exists to keep the future test's name reserved.
    expect(true).toBe(true);
  });

  test("integrates end-to-end with createAsk: produce → suspend → respond → close", async () => {
    const repo = new FakeAskRepository();

    // Producer (mt#1456): createAsk with no elicitation capable, routes to inbox.
    const routed = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Test integration",
        question: "Pick something",
      },
      {
        workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
        capabilityRegistry: {
          hasElicitation: () => false,
          activeElicitationServer: () => null,
        },
      }
    );

    // Per createAsk's contract: async transports stay at "routed" in the
    // returned object, but the *persisted* row is at "detected" (the router
    // doesn't write state). mt#454-impl will own the inbox transport's
    // walk-to-suspended; for the v1 operator CLI integration test we walk
    // it manually here through the valid transition chain.
    expect(routed.state).toBe("routed");
    expect(routed.transport.kind).toBe("inbox");
    expect(routed.routingTarget).toBe("operator");
    await repo.transition(routed.id, "classified");
    await repo.transition(routed.id, "routed");
    await repo.transition(routed.id, "suspended");

    // Consumer (mt#1458): respondToAsk closes the loop.
    const result = await respondToAsk(repo, {
      id: routed.id,
      message: "go with the first option",
    });

    expect(result.ask.state).toBe("closed");
    expect(result.ask.response?.payload).toEqual({
      message: "go with the first option",
    });

    const persisted = await repo.getById(routed.id);
    expect(persisted?.state).toBe("closed");
  });
});
