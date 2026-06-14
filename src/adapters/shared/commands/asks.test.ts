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

import { createAsk, respondToAsk, validateAsksCreateParams, formatAskWaitMessage } from "./asks";
import type { AskWaitForResponseResult } from "@minsky/domain/ask/wait-for-response";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import {
  getServiceWindowDefault,
  SERVICE_WINDOW_DEFAULTS,
} from "@minsky/domain/ask/service-window-defaults";
import { ValidationError } from "@minsky/domain/errors/index";

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
const KIND_QUALITY_REVIEW = "quality.review" as const;
const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;
const KIND_STUCK_UNBLOCK = "stuck.unblock" as const;
const KIND_INFORMATION_RETRIEVE = "information.retrieve" as const;

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
    // direction.decide defaults to serviceStrategy="scheduled" (mt#1488).
    // createAsk walks the row to "suspended" immediately (mt#1490 R1 B1 fix).
    expect(persisted.state).toBe("suspended");
  });

  test("returns a SuspendedAsk for direction.decide (scheduled default, no policy match)", async () => {
    // direction.decide defaults to serviceStrategy="scheduled" (mt#1488),
    // so the router suspends it in Phase 3. The Ask waits for the reaper
    // to dispatch it when the service window opens (mt#1490).
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "X",
        question: "Y",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // Phase 3 suspends direction.decide (scheduled strategy).
    expect(result.state).toBe("suspended");
    // Transport binding is still computed in Phase 2 before suspension.
    expect(result.routingTarget).toBe("operator");
    expect(result.transport.kind).toBe("inbox");
    expect(result.packagedPayload.question).toBe("Y");
    // No policy citation when no policy source covers the Ask.
    expect(result.packagedPayload.citation).toBeUndefined();
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
    // direction.decide defaults to scheduled; use forceImmediate=true to
    // bypass windowing and exercise the elicitation transport path.
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
        // forceImmediate bypasses Phase 3 windowing so the elicitation transport
        // path is exercised (mt#1490: scheduled strategy would otherwise suspend).
        forceImmediate: true,
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
// Service-window defaults — mt#1411 spine (mt#1488)
// ---------------------------------------------------------------------------

describe("service-window-defaults module", () => {
  test("covers all 7 AskKind values (completeness)", () => {
    const kinds = [
      KIND_DIRECTION_DECIDE,
      KIND_QUALITY_REVIEW,
      KIND_AUTHORIZATION_APPROVE,
      KIND_STUCK_UNBLOCK,
      KIND_COORDINATION_NOTIFY,
      KIND_CAPABILITY_ESCALATE,
      KIND_INFORMATION_RETRIEVE,
    ] as const;
    for (const kind of kinds) {
      const def = SERVICE_WINDOW_DEFAULTS[kind];
      expect(def).toBeDefined();
      expect(["asap", "scheduled", "deadline-bound"]).toContain(def.serviceStrategy);
    }
  });

  test("direction.decide defaults to scheduled/ask-hours", () => {
    const def = getServiceWindowDefault(KIND_DIRECTION_DECIDE);
    expect(def.serviceStrategy).toBe("scheduled");
    expect(def.windowKey).toBe("ask-hours");
  });

  test("quality.review defaults to scheduled/ask-hours", () => {
    const def = getServiceWindowDefault(KIND_QUALITY_REVIEW);
    expect(def.serviceStrategy).toBe("scheduled");
    expect(def.windowKey).toBe("ask-hours");
  });

  test("authorization.approve defaults to deadline-bound with no windowKey", () => {
    const def = getServiceWindowDefault(KIND_AUTHORIZATION_APPROVE);
    expect(def.serviceStrategy).toBe("deadline-bound");
    expect(def.windowKey).toBeUndefined();
  });

  test("stuck.unblock defaults to asap with no windowKey", () => {
    const def = getServiceWindowDefault(KIND_STUCK_UNBLOCK);
    expect(def.serviceStrategy).toBe("asap");
    expect(def.windowKey).toBeUndefined();
  });

  test("coordination.notify defaults to asap", () => {
    const def = getServiceWindowDefault(KIND_COORDINATION_NOTIFY);
    expect(def.serviceStrategy).toBe("asap");
  });

  test("capability.escalate defaults to asap", () => {
    const def = getServiceWindowDefault(KIND_CAPABILITY_ESCALATE);
    expect(def.serviceStrategy).toBe("asap");
  });

  test("information.retrieve defaults to asap", () => {
    const def = getServiceWindowDefault(KIND_INFORMATION_RETRIEVE);
    expect(def.serviceStrategy).toBe("asap");
  });
});

// ---------------------------------------------------------------------------
// createAsk service-window wiring — mt#1488 acceptance tests
// ---------------------------------------------------------------------------

describe("createAsk — service-window defaults and overrides", () => {
  test("direction.decide with no service-window args gets scheduled/ask-hours", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Choose direction",
        question: "Which approach should we take?",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("scheduled");
    expect(persisted.windowKey).toBe("ask-hours");
  });

  test("stuck.unblock with no service-window args gets asap/null windowKey", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_STUCK_UNBLOCK,
        title: "Stuck",
        question: "Help me unblock",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("asap");
    expect(persisted.windowKey).toBeUndefined();
  });

  test("explicit serviceStrategy overrides per-kind default", async () => {
    const repo = new FakeAskRepository();

    // direction.decide default is "scheduled", but requestor explicitly passes "asap"
    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Urgent decision",
        question: "Must decide now",
        serviceStrategy: "asap",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("asap");
    // windowKey should not be set when strategy is explicitly asap
    expect(persisted.windowKey).toBeUndefined();
  });

  test("forceImmediate=true round-trips through FakeAskRepository", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Critical path decision",
        question: "Must decide now, no time to wait",
        forceImmediate: true,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.forceImmediate).toBe(true);
  });

  test("forceImmediate defaults to false when not provided", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_STUCK_UNBLOCK,
        title: "Blocked",
        question: "Help",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.forceImmediate).toBe(false);
  });

  test("windowMissedCount defaults to 0 on create", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.windowMissedCount).toBe(0);
  });

  test("explicit windowKey overrides per-kind default when strategy is scheduled", async () => {
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
        serviceStrategy: "scheduled",
        windowKey: "custom-window",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("scheduled");
    expect(persisted.windowKey).toBe("custom-window");
  });

  test("absent serviceStrategy + windowKey for scheduled-default kind persists custom windowKey", async () => {
    // R4 fix: absent serviceStrategy is legitimate when kind defaults to scheduled.
    // direction.decide defaults to scheduled/ask-hours; caller may supply a custom windowKey
    // to override just the window name without specifying the strategy explicitly.
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
        // serviceStrategy intentionally absent — should resolve to "scheduled" via kind default
        windowKey: "custom-window",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    // Kind default resolves strategy to "scheduled"
    expect(persisted.serviceStrategy).toBe("scheduled");
    // Caller's windowKey overrides the kind default ("ask-hours")
    expect(persisted.windowKey).toBe("custom-window");
  });

  test("absent serviceStrategy + windowKey for asap-default kind silently drops windowKey", async () => {
    // R4 fix: absent serviceStrategy + windowKey for a kind whose default is asap.
    // stuck.unblock defaults to asap; windowKey is meaningless for asap and must be dropped
    // (R1 fix #3 silent-drop logic in createAsk).
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_STUCK_UNBLOCK,
        title: "Blocked",
        question: "Help me unblock",
        // serviceStrategy intentionally absent — resolves to "asap" via kind default
        windowKey: "ask-hours", // Caller provides windowKey; should be silently dropped
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    // Kind default resolves strategy to "asap"
    expect(persisted.serviceStrategy).toBe("asap");
    // windowKey is not valid for asap — must be undefined
    expect(persisted.windowKey).toBeUndefined();
  });

  test("windowKey is cleared when caller supplies non-scheduled strategy alongside a windowKey", async () => {
    // Finding #3 (R1 review): windowKey must only be persisted when strategy is
    // 'scheduled'. If a caller passes serviceStrategy='asap' and windowKey='ask-hours',
    // the windowKey must be ignored — storing it would contradict the documented
    // semantics in types.ts ("Only meaningful when serviceStrategy is 'scheduled'").
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Urgent decision",
        question: "Must decide now",
        serviceStrategy: "asap",
        windowKey: "ask-hours", // Caller incorrectly passes a windowKey with asap strategy
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("asap");
    // windowKey must be null/undefined — it should not be stored for non-scheduled strategies
    expect(persisted.windowKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateAsksCreateParams — boundary-time enforcement (R2 review feedback)
// ---------------------------------------------------------------------------

describe("validateAsksCreateParams", () => {
  test("rejects windowKey when serviceStrategy is 'asap'", () => {
    expect(() =>
      validateAsksCreateParams({ serviceStrategy: "asap", windowKey: "ask-hours" })
    ).toThrow(ValidationError);
  });

  test("rejects windowKey when serviceStrategy is 'deadline-bound'", () => {
    expect(() =>
      validateAsksCreateParams({ serviceStrategy: "deadline-bound", windowKey: "ask-hours" })
    ).toThrow(ValidationError);
  });

  test("allows windowKey when serviceStrategy is absent (per-kind default handles coherence)", () => {
    // When serviceStrategy is absent, per-kind defaults in createAsk resolve the strategy.
    // For scheduled-default kinds (e.g. direction.decide), the caller's windowKey overrides
    // the default window name. The validation must not block this legitimate usage.
    expect(() => validateAsksCreateParams({ windowKey: "ask-hours" })).not.toThrow();
  });

  test("error message is actionable and includes the explicit strategy value", () => {
    let caught: unknown;
    try {
      validateAsksCreateParams({ serviceStrategy: "asap", windowKey: "ask-hours" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.message).toContain("windowKey is only valid when serviceStrategy='scheduled'");
    expect(error.message).toContain("serviceStrategy='asap'");
    expect(error.message).toContain("omit serviceStrategy to use the kind's default");
  });

  test("accepts windowKey when serviceStrategy is 'scheduled'", () => {
    // Should not throw
    expect(() =>
      validateAsksCreateParams({ serviceStrategy: "scheduled", windowKey: "ask-hours" })
    ).not.toThrow();
  });

  test("accepts absent windowKey with any serviceStrategy", () => {
    expect(() => validateAsksCreateParams({ serviceStrategy: "asap" })).not.toThrow();
    expect(() => validateAsksCreateParams({ serviceStrategy: "scheduled" })).not.toThrow();
    expect(() => validateAsksCreateParams({ serviceStrategy: "deadline-bound" })).not.toThrow();
    expect(() => validateAsksCreateParams({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createAsk — window-deferred suspended state persistence (R1 fix, mt#1490)
// ---------------------------------------------------------------------------

describe("createAsk — scheduled ask lands with state=suspended (R1 fix)", () => {
  test("direction.decide with default service-window args lands at state=suspended in the repo", async () => {
    // Production path: no seeded state, no explicit serviceStrategy override.
    // direction.decide defaults to scheduled/ask-hours via getServiceWindowDefault.
    // The router (policyFirstRoute) returns a SuspendedAsk in memory; createAsk
    // must persist state="suspended" on the DB row (R1 B1 fix).
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Which direction should we take?",
        question: "A or B?",
        // No serviceStrategy — defaults to scheduled via getServiceWindowDefault.
        // No capabilityRegistry — no elicitation capability available.
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // Router returns suspended for direction.decide/scheduled.
    expect(result.state).toBe("suspended");

    // The persisted row must also be suspended, not "detected".
    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
  });

  test("explicit scheduled serviceStrategy also lands at state=suspended in the repo", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Scheduled decision",
        question: "Pick X or Y?",
        serviceStrategy: "scheduled",
        windowKey: "ask-hours",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(result.state).toBe("suspended");

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    // Row should reflect the window key used for scheduling.
    expect(persisted?.windowKey).toBe("ask-hours");
  });

  test("asap strategy returns routed result (not suspended)", async () => {
    // Verify the fix doesn't affect asap-path Asks — they must return routed.
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_STUCK_UNBLOCK,
        title: "Urgent",
        question: "Help me now",
        // stuck.unblock defaults to asap
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // asap Asks are immediately routed, not suspended (in the returned object).
    expect(result.state).toBe("routed");

    // mt#2265: the route outcome is now PERSISTED at create. stuck.unblock
    // routes to the subagent transport (no delivery loop yet), so the row
    // lands as "routed" with the target recorded — previously it stayed at
    // "detected" forever (the write-only-graveyard root cause).
    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("routed");
    expect(persisted?.routingTarget).toBe("subagent");
    expect(persisted?.routedAt).toBeDefined();
  });

  test("inbox-routed asap ask persists as suspended/operator at create (mt#2265)", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Decision for the operator",
        question: "Pick X or Y?",
        forceImmediate: true, // bypass the direction.decide scheduled-window default
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // The returned object reflects the PERSISTED state — suspended (waiting
    // on the operator surface), never a narrated-but-unpersisted "routed".
    expect(result.state).toBe("suspended");

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.routingTarget).toBe("operator");
    expect(persisted?.suspendedAt).toBeDefined();
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
    // PR #924 R1 BLOCKING: attentionCost is present on the closed Ask
    // (filled on close per the Ask.response contract in types.ts).
    expect(result.ask.response?.attentionCost?.transport).toBe("inbox");
    expect(result.ask.response?.attentionCost?.resolvedIn).toBe("inbox");

    // Persisted matches return — single coherent state.
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("closed");
    expect(persisted?.response?.payload).toEqual({ message: "go with X" });
  });

  test("attentionCost is attached on close(), NOT on respond() — Ask.response contract", async () => {
    // PR #924 R1 BLOCKING regression test: enforce that the respond-stage
    // payload does NOT carry attentionCost. We probe this by intercepting
    // repo.respondAndClose (the atomic combined op respondToAsk now calls)
    // and asserting the respondInput has no attentionCost.
    const realRepo = new FakeAskRepository();
    const respondInputs: Array<{
      responder: string;
      payload: unknown;
      attentionCost?: unknown;
    }> = [];

    const originalRespondAndClose = realRepo.respondAndClose.bind(realRepo);
    realRepo.respondAndClose = async (id, respondInput, closeInput) => {
      respondInputs.push(respondInput.response);
      return await originalRespondAndClose(id, respondInput, closeInput);
    };

    const ask = await seedAskInState(realRepo, "suspended");
    await respondToAsk(realRepo, { id: ask.id, message: "ok" });

    expect(respondInputs).toHaveLength(1);
    const captured = respondInputs[0];
    expect(captured).toBeDefined();
    if (!captured) return;
    // Per Ask.response contract: attentionCost is "filled on close" only.
    expect(captured.attentionCost).toBeUndefined();
    expect(captured.responder).toBe("operator");
    expect(captured.payload).toEqual({ message: "ok" });
  });

  // -------------------------------------------------------------------------
  // PR #924 R2 BLOCKING — atomicity + input validation
  // -------------------------------------------------------------------------

  test("atomicity: throws ConcurrentTransitionError when Ask cancelled mid-call", async () => {
    // Simulate a concurrent transition between getById and respondAndClose:
    // wrap getById to return a fresh suspended Ask (passing the state check),
    // then transition the underlying row to "cancelled" before respondAndClose
    // runs. The atomic check inside respondAndClose surfaces the race.
    const realRepo = new FakeAskRepository();
    const ask = await seedAskInState(realRepo, "suspended");

    // Hook: after the state-check getById returns, race the row to cancelled.
    let raceArmed = true;
    const originalGetById = realRepo.getById.bind(realRepo);
    realRepo.getById = async (id: string) => {
      const result = await originalGetById(id);
      if (raceArmed && result?.state === "suspended") {
        raceArmed = false; // Only race once.
        // Use the test seam to force the underlying row to cancelled,
        // simulating a concurrent actor.
        if (result) {
          realRepo._seedAtState({ ...result, state: "cancelled" });
        }
      }
      return result;
    };

    // PR #924 R3 BLOCKING #2: race-path error is now normalized to the same
    // friendly not-suspended message as the pre-check path. Single error
    // shape for "Ask is not in suspended state" regardless of cause.
    await expect(respondToAsk(realRepo, { id: ask.id, message: "ok" })).rejects.toThrow(
      /Ask is in "cancelled" state.*only "suspended" Asks can be responded to.*Concurrent actor/s
    );

    // Assert the Ask is NOT stuck in responded — race should leave it cancelled.
    const persisted = await originalGetById(ask.id);
    expect(persisted?.state).toBe("cancelled");
    expect(persisted?.response).toBeUndefined();
  });

  test("validation: rejects empty message", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    await expect(respondToAsk(repo, { id: ask.id, message: "" })).rejects.toThrow(
      /message is required/
    );
  });

  test("validation: rejects whitespace-only message", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    await expect(respondToAsk(repo, { id: ask.id, message: "   " })).rejects.toThrow(
      /message is required/
    );
  });

  test("validation: rejects empty id", async () => {
    const repo = new FakeAskRepository();

    await expect(respondToAsk(repo, { id: "", message: "ok" })).rejects.toThrow(/id is required/);
  });

  test("validation: rejects empty responder if explicitly provided", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedAskInState(repo, "suspended");

    await expect(respondToAsk(repo, { id: ask.id, message: "ok", responder: "" })).rejects.toThrow(
      /responder.*must not be empty/
    );
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

  // Note: routingTarget gating is intentionally not enforced at v1.
  // See respondToAsk's doc comment for the full rationale + mt#454-impl
  // follow-up. When a non-operator transport starts using suspended state,
  // add a gate AND a test asserting it rejects non-operator routingTargets.

  test("integrates end-to-end with createAsk: produce → suspend → respond → close", async () => {
    const repo = new FakeAskRepository();

    // Producer (mt#1456): createAsk with direction.decide defaults to scheduled/
    // ask-hours (mt#1488). With mt#1490 R1 fix, createAsk persists state=suspended
    // immediately — no manual transition walk needed.
    const suspended = await createAsk(
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

    // direction.decide is scheduled by default → lands at suspended.
    expect(suspended.state).toBe("suspended");
    expect(suspended.transport.kind).toBe("inbox");
    expect(suspended.routingTarget).toBe("operator");

    // Consumer (mt#1458): respondToAsk closes the loop.
    const result = await respondToAsk(repo, {
      id: suspended.id,
      message: "go with the first option",
    });

    expect(result.ask.state).toBe("closed");
    expect(result.ask.response?.payload).toEqual({
      message: "go with the first option",
    });

    const persisted = await repo.getById(suspended.id);
    expect(persisted?.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// formatAskWaitMessage (mt#2266) — text-mode render contract
// ---------------------------------------------------------------------------

describe("formatAskWaitMessage", () => {
  test("resolved result renders the responder, state, and payload", () => {
    const result: AskWaitForResponseResult = {
      resolved: true,
      ask: {} as never, // not read by the formatter
      response: { responder: "operator", payload: { chosen: "A" } },
      state: "closed",
      elapsedMs: 1500,
      pollCount: 2,
    };
    const msg = formatAskWaitMessage(result);
    expect(msg).toContain("✓ Ask resolved (closed) by operator");
    expect(msg).toContain("2 poll(s)");
    // Object payloads are pretty-printed.
    expect(msg).toContain('"chosen": "A"');
  });

  test("resolved result with a string payload renders it verbatim (no JSON quoting)", () => {
    const result: AskWaitForResponseResult = {
      resolved: true,
      ask: {} as never,
      response: { responder: "operator", payload: "proceed with option B" },
      state: "responded",
      elapsedMs: 500,
      pollCount: 1,
    };
    const msg = formatAskWaitMessage(result);
    expect(msg).toContain("proceed with option B");
    expect(msg).not.toContain('"proceed with option B"');
  });

  test("terminal-without-response result names the terminal state", () => {
    const result: AskWaitForResponseResult = {
      resolved: false,
      terminal: true,
      lastState: "cancelled",
      elapsedMs: 0,
      pollCount: 1,
    };
    const msg = formatAskWaitMessage(result);
    expect(msg).toContain('terminal state "cancelled" without a response');
    expect(msg).toContain("can no longer be answered");
  });

  test("timeout result names the still-pending state", () => {
    const result: AskWaitForResponseResult = {
      resolved: false,
      terminal: false,
      lastState: "suspended",
      elapsedMs: 30_000,
      pollCount: 6,
    };
    const msg = formatAskWaitMessage(result);
    expect(msg).toContain('Ask still pending (state "suspended")');
    expect(msg).toContain("Timeout reached");
  });
});
