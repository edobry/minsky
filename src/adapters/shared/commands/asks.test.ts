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

import { createAsk } from "./asks";
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
        requestor: "com.anthropic.claude-code:proc:abc123",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.requestor).toBe("com.anthropic.claude-code:proc:abc123");
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
});
