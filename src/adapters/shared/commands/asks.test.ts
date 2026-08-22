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

import {
  createAsk,
  createAskWithFormLint,
  respondToAsk,
  validateAsksCreateParams,
  validateAsksEditParams,
  validateAuthorizationApproveOptions,
  formatAskWaitMessage,
  toAskSummary,
  getAskByResolvedId,
  resolveAskIdInput,
  listAsksFiltered,
  askOptionSchema,
  asksCreateParams,
} from "./asks";
import { APPROVAL_TOKEN } from "@minsky/shared/ask-approval";
// The REAL production normalization function both the CLI and MCP dispatch
// paths run raw caller input through BEFORE `command.validate()` is called
// (see command-generator-core.ts:165-175 and shared-command-integration.ts:
// 571-601) — used below to empirically pin that validateAuthorizationApproveOptions
// observes POST-transform params (mt#3203 review R1), not a claim taken on
// the type signature's word.
import { normalizeCliParameters } from "../bridges/parameter-mapper";
// Cross-boundary parity import (mt#3203): the redemption-time verifier this
// authoring-time guard must agree with. A pure function import from a test
// file — the compiled `.claude/hooks/*` runtime output never includes
// `*.test.ts`, so this does not violate the hook's "self-contained, no
// src/ import at runtime" constraint (that constraint binds the SOURCE
// script, not its test suite).
import { isApprovingPayload } from "../../../../.minsky/hooks/ask-verification";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { CreateAskInput } from "@minsky/domain/ask/repository";
import type { AskWaitForResponseResult } from "@minsky/domain/ask/wait-for-response";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";
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

// Centralized fixture question text — extracted to defang
// custom/no-magic-string-duplication now that it's reused across the
// original asks.create tests and the mt#2748 toAskSummary/asks.get tests.
const FIXTURE_QUESTION = "Which approach should we ship?";

// mt#3203 fixture labels — extracted to defang custom/no-magic-string-duplication
// across the validateAuthorizationApproveOptions describe block, which reuses
// the originating incident's exact option labels in several tests.
const FIXTURE_APPROVE_LABEL = "Approve the override and merge";
const FIXTURE_DECLINE_LABEL = "Leave it blocked — I'll look at the PR myself";

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
        question: FIXTURE_QUESTION,
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
    expect(persisted.question).toBe(FIXTURE_QUESTION);
    expect(persisted.options).toEqual([
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ]);
    // mt#4421: still "suspended", but by a DIFFERENT route than when this was
    // written. It used to be Phase 3 windowing (scheduled/ask-hours); now the
    // kind defaults to asap, routes to operator/inbox, and inbox maps to
    // suspended. Same assertion, different path.
    expect(persisted.state).toBe("suspended");
  });

  test("returns a SuspendedAsk for direction.decide (operator inbox, no policy match)", async () => {
    // mt#4421: direction.decide defaults to asap now, so Phase 3 windowing does
    // NOT fire. It reaches suspended via the operator/inbox binding — for the
    // inbox transport, "dispatch" IS landing on the operator surface. Nothing
    // waits for a reaper; that runtime is retired (mt#4410).
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

    // Suspended via the inbox binding, not Phase 3 windowing (mt#4421).
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

  test("threads projectId param into the persisted Ask (mt#2563)", async () => {
    const repo = new FakeAskRepository();
    const PROJECT_ID = "33333333-3333-3333-3333-333333333333";

    await createAsk(
      repo,
      {
        kind: KIND_COORDINATION_NOTIFY,
        title: "Heads up",
        question: "Sibling agent should know",
        projectId: PROJECT_ID,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // Production-wiring assertion (memory dcc77564 — "static helper completeness
    // != production wiring"): verify the resolved project actually reached
    // persistence through createAsk -> CreateAskInput -> repo.create, not just
    // that the field exists on the input type.
    expect(repo.all).toHaveLength(1);
    expect(repo.all[0]?.projectId).toBe(PROJECT_ID);
  });

  test("create -> default-scoped list round-trip: project P sees the ask, project Q does not (mt#2563)", async () => {
    const repo = new FakeAskRepository();
    const PROJECT_P = "44444444-4444-4444-4444-444444444444";
    const PROJECT_Q = "55555555-5555-5555-5555-555555555555";

    // Create through the production producer surface (the same path asks.create
    // execute uses), stamping project P — the spec's acceptance-test #1 shape.
    const created = await createAsk(
      repo,
      {
        kind: KIND_COORDINATION_NOTIFY,
        title: "Heads up",
        question: "Sibling agent should know",
        projectId: PROJECT_P,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );
    // coordination.notify routes to mesh and persists as "routed".
    expect(created.state).toBe("routed");

    // Default-scoped read for P returns the ask — the regression this fixes: it
    // used to be invisible to the project-scoped list because project_id was NULL.
    const inP = await repo.listByState("routed", PROJECT_P);
    expect(inP).toHaveLength(1);
    expect(inP[0]?.projectId).toBe(PROJECT_P);

    // A different project's scope does NOT see it (cross-project exclusion).
    const inQ = await repo.listByState("routed", PROJECT_Q);
    expect(inQ).toHaveLength(0);
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
    // forceImmediate is retained deliberately. It was needed to bypass Phase 3
    // windowing when direction.decide defaulted to scheduled; after mt#4421 it
    // is not, but keeping it holds this test on the elicitation transport
    // rather than on whichever branch the per-kind default happens to take.
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
        // See the note above: no longer load-bearing after mt#4421, retained so
        // this test does not depend on the per-kind default at all.
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
// createAskWithFormLint — asks.create's form-lint wrapper (mt#2798)
// ---------------------------------------------------------------------------

describe("createAskWithFormLint", () => {
  test(
    "synthetic bad ask (mcp__ tool id, 200 words, authorization.approve + 'settings' + no URL) " +
      "-> 3 formWarnings; ask still created",
    async () => {
      const repo = new FakeAskRepository();
      const badWord = "word";
      // ~200-word body: opens with justification, then names an mcp__ tool
      // call and a "settings" portal reference with no URL — matches the
      // Acceptance Tests' synthetic-bad-ask description exactly.
      const question =
        `${Array.from({ length: 170 }, () => badWord).join(" ")} ` +
        "I'll run mcp__minsky__setup_github-app to update the app settings and grant this permission.";

      const { ask, formWarnings, formLintMatches } = await createAskWithFormLint(
        repo,
        {
          kind: KIND_AUTHORIZATION_APPROVE,
          title: "Grant a permission",
          question,
        },
        { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
      );

      // Ask is still created — form-lint never blocks creation.
      expect(ask.id).toBeTruthy();
      const persisted = await repo.getById(ask.id);
      expect(persisted).not.toBeNull();

      expect(formWarnings).toHaveLength(3);
      const expectedChecks: Array<"internal-tool-id" | "over-word-budget" | "portal-no-link"> = [
        "internal-tool-id",
        "over-word-budget",
        "portal-no-link",
      ];
      expect(formLintMatches.map((m) => m.check).sort()).toEqual(expectedChecks.sort());
    }
  );

  test("well-formed ask (action-first, direct link, <120 words) -> zero warnings", async () => {
    const repo = new FakeAskRepository();
    const question =
      "Open https://github.com/settings/apps/minsky-ai/permissions and set Actions to " +
      "Read and write, then save. This unblocks the CI-rerun tool.";

    const { ask, formWarnings, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Approve one GitHub App permission",
        question,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(ask.id).toBeTruthy();
    expect(formWarnings).toEqual([]);
    expect(formLintMatches).toEqual([]);
  });

  // Option-label checks reaching this seam (mt#3253) live in
  // ./asks.form-lint-options.test.ts — this file is at its max-lines ceiling.
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

  test("mt#4421: direction.decide defaults to asap with NO window", () => {
    // Was scheduled/ask-hours. The window runtime is retired (mt#4410), so a
    // default naming one recorded a batching policy that no longer exists —
    // on the kind agents file principal escalations as.
    const def = getServiceWindowDefault(KIND_DIRECTION_DECIDE);
    expect(def.serviceStrategy).toBe("asap");
    expect(def.windowKey).toBeUndefined();
  });

  test("mt#4421: quality.review defaults to asap with NO window", () => {
    const def = getServiceWindowDefault(KIND_QUALITY_REVIEW);
    expect(def.serviceStrategy).toBe("asap");
    expect(def.windowKey).toBeUndefined();
  });

  test("mt#4421: NO kind default produces a windowKey any more", () => {
    // The class assertion, not the two instances: a future kind added with a
    // window default fails here rather than silently reintroducing the retired
    // concept through a door the two tests above do not watch.
    for (const [kind, def] of Object.entries(SERVICE_WINDOW_DEFAULTS)) {
      expect({ kind, windowKey: def.windowKey }).toEqual({ kind, windowKey: undefined });
      expect({ kind, strategy: def.serviceStrategy }).not.toEqual({
        kind,
        strategy: "scheduled",
      });
    }
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
  test("mt#4421: direction.decide with no service-window args gets asap and NO window", async () => {
    // End-to-end through createAsk, not just the matrix: this is the path that
    // produced ask#9750 with `windowKey: "ask-hours"` and
    // `suspendedForWindowKey: "ask-hours"` on 2026-08-22, against a runtime
    // mt#4410 had already retired.
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
    expect(persisted.serviceStrategy).toBe("asap");
    // `suspendedForWindowKey` — the field that made ask#9750's record actively
    // misleading — is not asserted here because it lives on `SuspendedAsk`, not
    // the base `Ask` this repository returns. It is derived: the router's
    // scheduled branch sets it from `ask.windowKey`, and that branch is now
    // unreachable by default, so `windowKey` being unset above is what closes it.
    expect(persisted.windowKey).toBeUndefined();
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

    // mt#4421: the kind default is "asap" too now, so this pins the override
    // MECHANISM rather than a change of value — an explicit strategy is honoured.
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

  test("mt#4421: direction.decide now behaves as an asap-default kind — a bare windowKey is dropped", async () => {
    // This test used to assert the OPPOSITE, and the change of expectation is
    // the point rather than a repair. R4's scenario was "absent serviceStrategy
    // is legitimate when the KIND defaults to scheduled, so a caller may name a
    // custom window without naming the strategy". After mt#4421 no kind defaults
    // to scheduled, so that scenario has no kind left to exercise — reaching it
    // now requires an explicit `serviceStrategy: "scheduled"`, which the test
    // directly above this one already covers.
    //
    // What remains true, and is what this asserts: `direction.decide` now falls
    // into the same branch as every other asap-default kind, so a windowKey with
    // no strategy is silently dropped rather than honoured.
    const repo = new FakeAskRepository();

    await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "T",
        question: "Q",
        // serviceStrategy intentionally absent — resolves to "asap" via kind default
        windowKey: "custom-window",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = repo.all[0];
    expect(persisted).toBeDefined();
    if (!persisted) return;
    expect(persisted.serviceStrategy).toBe("asap");
    expect(persisted.windowKey).toBeUndefined();
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
// validateAuthorizationApproveOptions — mt#3203: reject an authorization.approve
// Ask whose options can never satisfy the redemption-time approval verifier.
// ---------------------------------------------------------------------------

describe("validateAuthorizationApproveOptions (mt#3203)", () => {
  test("rejects an authorization.approve Ask whose options carry only descriptive labels", () => {
    // The originating incident's exact shape: both options' `value` defaulted
    // to their `label` (asks_create's mt#3181 defaulting), so neither could
    // ever satisfy the verifier's APPROVAL_TOKEN.
    expect(() =>
      validateAuthorizationApproveOptions({
        kind: KIND_AUTHORIZATION_APPROVE,
        options: [
          { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
          { label: FIXTURE_DECLINE_LABEL, value: FIXTURE_DECLINE_LABEL },
        ],
      })
    ).toThrow(ValidationError);
  });

  test("error message names the accepted tokens and echoes the offending labels", () => {
    let caught: unknown;
    try {
      validateAuthorizationApproveOptions({
        kind: KIND_AUTHORIZATION_APPROVE,
        options: [{ label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.message).toContain("approve");
    expect(error.message).toContain(FIXTURE_APPROVE_LABEL);
  });

  test("passes when an explicit approve-shaped value accompanies an arbitrary descriptive label", () => {
    // The label stays fully descriptive; only the value is constrained.
    expect(() =>
      validateAuthorizationApproveOptions({
        kind: KIND_AUTHORIZATION_APPROVE,
        options: [
          { label: FIXTURE_APPROVE_LABEL, value: "approve" },
          { label: FIXTURE_DECLINE_LABEL, value: "decline" },
        ],
      })
    ).not.toThrow();
  });

  test("passes for any of the accepted tokens (approve/approved/yes, case-insensitive)", () => {
    for (const value of ["approve", "approved", "Approved", "yes", "YES"]) {
      expect(() =>
        validateAuthorizationApproveOptions({
          kind: KIND_AUTHORIZATION_APPROVE,
          options: [{ label: "Go ahead", value }],
        })
      ).not.toThrow();
    }
  });

  test("does not fire for other ask kinds, regardless of option shape", () => {
    // Out of scope per spec: only authorization.approve feeds the grant verifier.
    for (const kind of [
      KIND_DIRECTION_DECIDE,
      KIND_CAPABILITY_ESCALATE,
      KIND_COORDINATION_NOTIFY,
      KIND_QUALITY_REVIEW,
      KIND_STUCK_UNBLOCK,
      KIND_INFORMATION_RETRIEVE,
    ]) {
      expect(() =>
        validateAuthorizationApproveOptions({
          kind,
          options: [{ label: "Use Postgres", value: "Use Postgres" }],
        })
      ).not.toThrow();
    }
  });

  test("does not fire when options are absent (free-text authorization asks are out of scope)", () => {
    expect(() =>
      validateAuthorizationApproveOptions({ kind: KIND_AUTHORIZATION_APPROVE, options: undefined })
    ).not.toThrow();
    expect(() =>
      validateAuthorizationApproveOptions({ kind: KIND_AUTHORIZATION_APPROVE, options: [] })
    ).not.toThrow();
  });

  test("vocabulary parity with the redemption-time verifier's APPROVAL_TOKEN (drift guard)", () => {
    // Both this authoring-time guard and .minsky/hooks/ask-verification.ts's
    // isApprovingPayload import APPROVAL_TOKEN from the SAME
    // @minsky/shared/ask-approval module. This test proves the authoring
    // guard's accept/reject boundary tracks that shared regex directly,
    // rather than a second, independently-maintained copy that could drift.
    const acceptedTokens = ["approve", "approved", "yes", "Approve", "YES"];
    const rejectedTokens = ["ok", "sure", "affirmative", FIXTURE_APPROVE_LABEL];

    for (const token of acceptedTokens) {
      expect(APPROVAL_TOKEN.test(token)).toBe(true);
      expect(() =>
        validateAuthorizationApproveOptions({
          kind: KIND_AUTHORIZATION_APPROVE,
          options: [{ label: "whatever label", value: token }],
        })
      ).not.toThrow();
    }
    for (const token of rejectedTokens) {
      expect(APPROVAL_TOKEN.test(token)).toBe(false);
      expect(() =>
        validateAuthorizationApproveOptions({
          kind: KIND_AUTHORIZATION_APPROVE,
          options: [{ label: "whatever label", value: token }],
        })
      ).toThrow(ValidationError);
    }
  });

  test("end-to-end: an option that passes this guard also verifies as approved at redemption time", () => {
    // Closes the loop the spec's acceptance tests describe: an option shaped
    // like {label: "Approve the override and merge", value: "approve"} both
    // (a) passes asks_create's authoring-time guard, and (b) verifies as
    // approved when .minsky/hooks/ask-verification.ts's isApprovingPayload
    // evaluates the response payload an operator's selection would produce.
    const option = askOptionSchema.parse({
      label: FIXTURE_APPROVE_LABEL,
      value: "approve",
    });

    expect(() =>
      validateAuthorizationApproveOptions({
        kind: KIND_AUTHORIZATION_APPROVE,
        options: [option],
      })
    ).not.toThrow();

    // Simulate the inbox response shape (mt#3007): {chosen, option} carrying
    // the SELECTED option's value.
    expect(isApprovingPayload({ chosen: option.value, option: option.value })).toBe(true);
  });

  test("end-to-end: the ORIGINATING incident's malformed ask fails both the guard and the verifier", () => {
    const option = askOptionSchema.parse({ label: FIXTURE_APPROVE_LABEL });

    expect(() =>
      validateAuthorizationApproveOptions({
        kind: KIND_AUTHORIZATION_APPROVE,
        options: [option],
      })
    ).toThrow(ValidationError);

    // Had the guard not fired, this is the exact payload shape that produced
    // the confusing "not approved" error after the operator already approved.
    expect(isApprovingPayload({ chosen: option.value, option: option.value })).toBe(false);
  });

  describe("validate() observes POST-transform params, not raw input (mt#3203 review R1)", () => {
    // This guard's correctness depends on `askOptionSchema`'s value-defaults-
    // to-label transform having ALREADY run by the time
    // validateAuthorizationApproveOptions sees `params.options`. If the
    // command-registry's validate→execute pipeline ran `validate` on RAW
    // caller input instead, an option with only a `label` would arrive with
    // `value: undefined` — which `isApproveShapedToken` also treats as
    // non-approving, so a pre-parse guard would happen to reject the same
    // input for the WRONG reason, and would silently stop working the
    // moment someone reordered the pipeline.
    //
    // Verified empirically (not asserted from the type signature) by
    // tracing both dispatch paths' source:
    //   - CLI: command-generator-core.ts:165 calls
    //     `normalizeCliParameters(commandDef.parameters, rawParameters)`
    //     BEFORE line 175's `commandDef.validate(normalizedParams, context)`.
    //   - MCP: shared-command-integration.ts:571 calls
    //     `convertMcpArgsToParameters(filteredArgs, command.parameters)`
    //     BEFORE line 601's `command.validate(parameters, context)`.
    // Both normalization functions assign the Zod `.parse()` OUTPUT (see
    // parameter-mapper.ts:356 and shared-command-integration.ts:164), so
    // `askOptionSchema`'s `.transform()` has already run by the time
    // `validate` sees `params.options`.
    //
    // This test pins that behavior using the REAL production function
    // (`normalizeCliParameters`) and the REAL parameter map `asks.create`
    // is registered with (`asksCreateParams`) — not a hand-rolled
    // substitute — so a future change to either would break this test
    // rather than silently drifting.
    test("an option with a label and NO explicit value passes normalization with value=label, then correctly fails the guard", () => {
      const rawParameters = {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Override needed",
        question: FIXTURE_QUESTION,
        options: [{ label: FIXTURE_APPROVE_LABEL }, { label: FIXTURE_DECLINE_LABEL }],
      };

      const normalized = normalizeCliParameters(asksCreateParams, rawParameters);
      const options = normalized.options as Array<{ label: string; value: unknown }>;

      // Pin the transform: value defaulted to label, NOT left undefined.
      expect(options[0]?.value).toBe(FIXTURE_APPROVE_LABEL);
      expect(options[0]?.value).not.toBeUndefined();
      expect(options[1]?.value).toBe(FIXTURE_DECLINE_LABEL);

      // And the guard, given what validate() actually receives, rejects —
      // correctly, because neither defaulted value is approve-shaped.
      expect(() =>
        validateAuthorizationApproveOptions({
          kind: normalized.kind as typeof KIND_AUTHORIZATION_APPROVE,
          options,
        })
      ).toThrow(ValidationError);
    });

    test("an option with an explicit approve-shaped value survives normalization unchanged, then passes the guard", () => {
      const rawParameters = {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Override needed",
        question: FIXTURE_QUESTION,
        options: [{ label: FIXTURE_APPROVE_LABEL, value: "approve" }],
      };

      const normalized = normalizeCliParameters(asksCreateParams, rawParameters);
      const options = normalized.options as Array<{ label: string; value: unknown }>;

      expect(options[0]?.value).toBe("approve");

      expect(() =>
        validateAuthorizationApproveOptions({
          kind: normalized.kind as typeof KIND_AUTHORIZATION_APPROVE,
          options,
        })
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// createAsk — window-deferred suspended state persistence (R1 fix, mt#1490)
// ---------------------------------------------------------------------------

describe("createAsk — scheduled ask lands with state=suspended (R1 fix)", () => {
  test("direction.decide with default service-window args lands at state=suspended in the repo", async () => {
    // Production path: no seeded state, no explicit serviceStrategy override.
    // mt#4421: direction.decide defaults to asap. The router still returns a
    // SuspendedAsk — via the operator/inbox binding rather than Phase 3
    // windowing — and createAsk must persist state="suspended" on the DB row
    // (R1 B1 fix). The persistence assertion is what this test is about.
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Which direction should we take?",
        question: "A or B?",
        // No serviceStrategy — defaults to asap via getServiceWindowDefault (mt#4421).
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

    // Producer (mt#1456): createAsk with direction.decide defaults to asap
    // (mt#4421, was scheduled/ask-hours). With the mt#1490 R1 fix, createAsk
    // persists state=suspended immediately — via the inbox binding — so no
    // manual transition walk is needed.
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

  test("a system-auto-closed result (mt#3215) is NOT rendered as an operator response", () => {
    const result: AskWaitForResponseResult = {
      resolved: true,
      ask: {} as never,
      response: {
        responder: "system:parent-task-terminal",
        payload: { sweep: "stale-suspended-close", task: "mt#3001" },
      },
      state: "closed",
      elapsedMs: 1000,
      pollCount: 1,
    };
    const msg = formatAskWaitMessage(result);
    expect(msg).toContain("⚠ Ask auto-closed (closed) by system:parent-task-terminal");
    expect(msg).toContain("NOT an operator response");
    expect(msg).not.toContain("✓ Ask resolved");
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

// ---------------------------------------------------------------------------
// validateAsksEditParams (mt#2668)
// ---------------------------------------------------------------------------

describe("validateAsksEditParams", () => {
  test("throws ValidationError when no editable field is provided", () => {
    expect(() => validateAsksEditParams({})).toThrow(ValidationError);
    expect(() => validateAsksEditParams({})).toThrow("at least one editable field");
  });

  test("passes when a single editable field is provided", () => {
    expect(() => validateAsksEditParams({ question: "refreshed" })).not.toThrow();
    expect(() => validateAsksEditParams({ metadata: { note: "x" } })).not.toThrow();
  });

  test("passes when multiple editable fields are provided", () => {
    expect(() =>
      validateAsksEditParams({
        title: "t",
        options: [{ label: "A", value: "a" }],
        contextRefs: [{ kind: "task", ref: "mt#2668" }],
      })
    ).not.toThrow();
  });

  test("rejects metadata containing forbidden keys (prototype-pollution hardening)", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<
      string,
      unknown
    >;
    expect(() => validateAsksEditParams({ metadata: hostile })).toThrow(ValidationError);
    expect(() => validateAsksEditParams({ metadata: hostile })).toThrow("forbidden key");
    expect(() => validateAsksEditParams({ metadata: { constructor: "x" } })).toThrow(
      ValidationError
    );
  });

  test("passes metadata with only safe keys", () => {
    expect(() =>
      validateAsksEditParams({ metadata: { refreshedFrom: "docs/research/x.md" } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toAskSummary / asks.list summary projection (mt#2748)
// ---------------------------------------------------------------------------

/**
 * Build a full fixture `Ask` with every "body" field populated, so tests can
 * assert `toAskSummary` actually strips them (not just that it happens to
 * omit fields that were never present).
 */
function buildFixtureAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "d8591800-823b-410b-a5cc-209fb0b7eb6d",
    kind: KIND_DIRECTION_DECIDE,
    classifierVersion: "v1.0.0",
    requestor: FIXTURE_RESPONDER_ID,
    routingTarget: "operator",
    parentTaskId: "mt#2748",
    title: "Choose A or B",
    question: `${FIXTURE_QUESTION} `.repeat(50),
    options: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
    contextRefs: [{ kind: "task", ref: "mt#2748" }],
    state: "suspended",
    createdAt: "2026-07-13T18:00:00.000Z",
    routedAt: "2026-07-13T18:00:05.000Z",
    metadata: {
      editHistory: [
        { editor: "test", timestamp: "2026-07-13T18:00:10.000Z", touchedFields: ["question"] },
      ],
      note: "arbitrary metadata",
    },
    ...overrides,
  };
}

describe("toAskSummary", () => {
  test("includes only the documented summary columns", () => {
    const ask = buildFixtureAsk();
    const summary = toAskSummary(ask);

    expect(summary).toEqual({
      id: ask.id,
      kind: ask.kind,
      state: ask.state,
      title: ask.title,
      routingTarget: ask.routingTarget,
      parentTaskId: ask.parentTaskId,
      createdAt: ask.createdAt,
      routedAt: ask.routedAt,
    });
  });

  test("omits the multi-KB body fields (question/options/contextRefs/metadata)", () => {
    const ask = buildFixtureAsk();
    const summary = toAskSummary(ask) as unknown as Record<string, unknown>;

    expect(summary.question).toBeUndefined();
    expect(summary.options).toBeUndefined();
    expect(summary.contextRefs).toBeUndefined();
    expect(summary.metadata).toBeUndefined();
    // metadata.editHistory specifically — the spec calls this out by name.
    expect(JSON.stringify(summary)).not.toContain("editHistory");
    expect(JSON.stringify(summary)).not.toContain(FIXTURE_QUESTION);
  });

  test("a summary listing of 100 rows is well under the tool-result token cap", () => {
    const asks = Array.from({ length: 100 }, (_, i) =>
      buildFixtureAsk({ id: `d8591800-823b-410b-a5cc-209fb0b7eb${String(i).padStart(4, "0")}` })
    );
    const summaries = asks.map(toAskSummary);
    const bytes = new TextEncoder().encode(JSON.stringify(summaries)).length;

    // The mt#2748 incident measured avg ~2.9 KB/ask (max 7.5 KB/ask) for full
    // records — 100 full rows reliably exceeds the tool-result cap. A summary
    // row is a handful of short scalar fields; 100 of them should land in the
    // low tens of KB, nowhere near the cap that truncated the original
    // 297 KB / 2,540-line asks_list dump.
    expect(bytes).toBeLessThan(50_000);
  });
});

// ---------------------------------------------------------------------------
// getAskByResolvedId / asks.get (mt#2748)
// ---------------------------------------------------------------------------

describe("getAskByResolvedId", () => {
  test("returns the full ask record when found", async () => {
    const repo = new FakeAskRepository();
    const created = await createAsk(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: "Choose A or B",
        question: FIXTURE_QUESTION,
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const result = await getAskByResolvedId(repo, created.id, created.id);

    expect(result.id).toBe(created.id);
    expect(result.title).toBe("Choose A or B");
    expect(result.question).toBe(FIXTURE_QUESTION);
  });

  test("throws a clean not-found error for a full-UUID id that doesn't exist", async () => {
    const repo = new FakeAskRepository();
    const missingId = "ffffffff-1111-2222-3333-444444444444";

    await expect(getAskByResolvedId(repo, missingId, missingId)).rejects.toThrow(
      `Ask not found with id "${missingId}"`
    );
  });

  test("names the prefix in the not-found message when the input was a prefix", async () => {
    const repo = new FakeAskRepository();
    const rawPrefix = "ffffffff";
    // Simulates the post-resolution state when a prefix had no matching row:
    // resolveAskIdInput's underlying resolveIdPrefixOrThrow throws before
    // getAskByResolvedId is ever reached in that case, so this test instead
    // exercises the "prefix resolved to some id, but that id is now gone"
    // path (e.g. the row was deleted between resolution and this read).
    const resolvedId = "ffffffff-1111-2222-3333-444444444444";

    await expect(getAskByResolvedId(repo, rawPrefix, resolvedId)).rejects.toThrow(
      `Ask not found for id prefix "${rawPrefix}" (resolved to "${resolvedId}")`
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAskIdInput — ask#N short id resolution (mt#2965)
// ---------------------------------------------------------------------------

describe("resolveAskIdInput (mt#2965)", () => {
  const ASK_UUID = "483dbcb0-0000-0000-0000-000000000099";

  /**
   * Fake container satisfying `getAskDb`'s narrow usage
   * (`container.has("persistence")` + `container.get("persistence")
   * .getDatabaseConnection()`), backed by a fake db whose `.select().from()
   * .where()` resolves the given rows regardless of the query condition —
   * each test pre-seeds exactly the rows the real query would have matched.
   */
  function fakeContainer(rows: Array<{ id: string; label?: string }>): AppContainerInterface {
    const fakeDb = {
      select(_fields?: unknown) {
        return {
          from(_table: unknown) {
            return {
              where(_cond: unknown) {
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    };
    return {
      has: (key: string) => key === "persistence",
      get: (_key: string) => ({ getDatabaseConnection: async () => fakeDb }),
    } as unknown as AppContainerInterface;
  }

  test("passes a full uuid through unchanged", async () => {
    const container = fakeContainer([]);
    const id = await resolveAskIdInput(ASK_UUID, container);
    expect(id).toBe(ASK_UUID);
  });

  test("resolves ask#7 to the row's uuid via the short_id column", async () => {
    const container = fakeContainer([{ id: ASK_UUID, label: "my ask" }]);
    const id = await resolveAskIdInput("ask#7", container);
    expect(id).toBe(ASK_UUID);
  });

  test("REGRESSION (mt#2696 unchanged): an unambiguous 8-char hex prefix still resolves", async () => {
    const container = fakeContainer([{ id: ASK_UUID, label: "my ask" }]);
    const id = await resolveAskIdInput(ASK_UUID.slice(0, 8), container);
    expect(id).toBe(ASK_UUID);
  });

  test("rejects a mismatched-entity short id (e.g. mem#3) without querying the DB", async () => {
    let queried = false;
    const container = {
      has: (key: string) => key === "persistence",
      get: (_key: string) => ({
        getDatabaseConnection: async () => ({
          select() {
            queried = true;
            return { from: () => ({ where: () => Promise.resolve([]) }) };
          },
        }),
      }),
    } as unknown as AppContainerInterface;

    await expect(resolveAskIdInput("mem#3", container)).rejects.toThrow(
      /short id prefix mismatch/i
    );
    expect(queried).toBe(false);
  });

  test("throws a clean not-found error for an ask#N with no matching row", async () => {
    const container = fakeContainer([]);
    await expect(resolveAskIdInput("ask#999", container)).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// listAsksFiltered — asks.list id filter (mt#2965 R1, PR #2110 review round)
// ---------------------------------------------------------------------------

describe("listAsksFiltered — asks.list id filter (mt#2965 R1)", () => {
  /** Minimal valid CreateAskInput for this describe block's fixtures. */
  function makeAskInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
    return {
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: FIXTURE_RESPONDER_ID,
      title: "Fixture ask",
      question: "does this filter correctly?",
      metadata: {},
      ...overrides,
    };
  }

  test("filters to the single Ask matching a resolved ask#N id", async () => {
    const repo = new FakeAskRepository();
    const target = await repo.create(makeAskInput({ title: "Target" }));
    await repo.create(makeAskInput({ title: "Other" }));

    // Injected resolver mirrors resolveAskIdInput's ask#N -> uuid contract;
    // resolveAskIdInput's OWN resolution correctness is covered separately
    // above (the "resolveAskIdInput (mt#2965)" describe block).
    const resolveId = async (id: string) => (id === "ask#7" ? target.id : id);

    const result = await listAsksFiltered(repo, resolveId, { id: "ask#7" });

    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.asks).toHaveLength(1);
    expect(result.asks[0]?.id).toBe(target.id);
    expect(result.asks[0]?.title).toBe("Target");
  });

  test("filters to the single Ask matching a resolved full uuid (regression: raw uuid unaffected)", async () => {
    const repo = new FakeAskRepository();
    const target = await repo.create(makeAskInput({ title: "Target" }));
    await repo.create(makeAskInput({ title: "Other" }));

    const resolveId = async (id: string) => id; // uuid passthrough, matching resolveAskIdInput
    const result = await listAsksFiltered(repo, resolveId, { id: target.id });

    expect(result.total).toBe(1);
    expect(result.asks[0]?.id).toBe(target.id);
  });

  test("returns the full unfiltered list when no id filter is supplied", async () => {
    const repo = new FakeAskRepository();
    await repo.create(makeAskInput({ title: "A" }));
    await repo.create(makeAskInput({ title: "B" }));

    const resolveId = async (id: string) => id;
    const result = await listAsksFiltered(repo, resolveId, {});

    expect(result.total).toBe(2);
  });

  test("combines the id filter with state/kind as an AND — no match yields an empty (not erroring) result", async () => {
    const repo = new FakeAskRepository();
    const target = await repo.create(makeAskInput({ title: "Target", kind: "quality.review" }));

    const resolveId = async (_id: string) => target.id;
    // target is in state "detected" (fresh create) — filtering by "closed" must exclude it.
    const result = await listAsksFiltered(repo, resolveId, { id: "ask#anything", state: "closed" });

    expect(result.total).toBe(0);
    expect(result.asks).toHaveLength(0);
  });

  test("propagates a resolution error (e.g. not-found ask#N) instead of silently returning empty", async () => {
    const repo = new FakeAskRepository();
    const resolveId = async (_id: string): Promise<string> => {
      throw new Error("Ask not found: ask#999");
    };

    await expect(listAsksFiltered(repo, resolveId, { id: "ask#999" })).rejects.toThrow(
      /not found/i
    );
  });
});

// ---------------------------------------------------------------------------
// askOptionSchema — decision-frame option normalization (mt#3181)
// ---------------------------------------------------------------------------

describe("askOptionSchema value normalization (mt#3181)", () => {
  test("an option with no `value` gets `label` as its value", () => {
    // The originating shape: `{label, description}`, which is what
    // `humility.mdc §Escalation packaging` describes and what agents write.
    // Under the previous bare `z.unknown()` declaration this parsed cleanly
    // with `value` ABSENT from the output — every response writer then
    // stringified `undefined`/`""` and the operator's selection was lost.
    const label = "B - scope stays paths";
    const description = "Non-breaking; the bad input fails loudly.";
    const parsed = askOptionSchema.parse({ label, description });

    expect(parsed.value).toBe(label);
    expect(parsed.label).toBe(label);
    expect(parsed.description).toBe(description);
  });

  test("an explicit `value` is preserved, not overwritten by `label`", () => {
    const parsed = askOptionSchema.parse({ label: "Use Postgres", value: "postgres" });

    expect(parsed.value).toBe("postgres");
    expect(parsed.label).toBe("Use Postgres");
  });

  test("a falsy-but-present `value` is preserved (not treated as absent)", () => {
    // `null`, `false`, `0`, and `""` are legitimate machine values. Only
    // `undefined` means "the caller omitted it", so the normalization keys
    // off `=== undefined` rather than falsiness.
    expect(askOptionSchema.parse({ label: "No", value: false }).value).toBe(false);
    expect(askOptionSchema.parse({ label: "Zero", value: 0 }).value).toBe(0);
    expect(askOptionSchema.parse({ label: "Null", value: null }).value).toBe(null);
    expect(askOptionSchema.parse({ label: "Empty", value: "" }).value).toBe("");
  });

  test("`label` is still required", () => {
    expect(askOptionSchema.safeParse({ value: "orphan" }).success).toBe(false);
  });
});
