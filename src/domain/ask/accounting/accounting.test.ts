/**
 * Tests for the attention-accounting module — mt#1071, ADR-008 §Attention accounting.
 *
 * Uses FakeAskRepository for hermetic testing per testing-guide.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "../repository";
import {
  buildAttentionCost,
  getRollupForTask,
  getRollupForKind,
  type AttentionCostInput,
} from "./index";
import type { Ask, AskKind, AttentionCost } from "../types";
import { closeWithPolicy } from "../transports/policy-resolver";
import { dispatchToSubagent } from "../transports/subagent";
import type { SubagentDispatcher, SubagentRequest, SubagentResponse } from "../transports/subagent";
import { reconcile } from "../reconciler";
import type { GithubReviewClient, GithubReview } from "../reconciler";
import type { OperatorNotify } from "../../notify/operator-notify";
import type { RoutedAsk, AskPayload, TransportBinding } from "../router";

// ---------------------------------------------------------------------------
// Constants to avoid magic strings
// ---------------------------------------------------------------------------

const KIND_QUALITY_REVIEW: AskKind = "quality.review";
const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";
const KIND_AUTHORIZATION_APPROVE: AskKind = "authorization.approve";
const KIND_CAPABILITY_ESCALATE: AskKind = "capability.escalate";

const STATE_CLOSED = "closed" as const;
const STATE_CANCELLED = "cancelled" as const;
const STATE_EXPIRED = "expired" as const;

const RESPONDER_POLICY = "policy";
const RESPONDER_OPERATOR = "operator";
const RESPONDER_TIMEOUT = "timeout";
const RESPONDER_SUBAGENT = "subagent:task:abc123";

const TASK_A = "mt#100";
const TASK_B = "mt#200";

const CLASSIFIER_VERSION = "v1";

// ---------------------------------------------------------------------------
// Test helper: build a closed Ask with a given attentionCost
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeAsk(overrides: Partial<Ask> & { kind: AskKind }): Ask {
  return {
    id: `ask-${++idCounter}`,
    classifierVersion: CLASSIFIER_VERSION,
    state: STATE_CLOSED,
    requestor: "agent:task:test",
    title: "Test ask",
    question: "What should I do?",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAttentionCost tests
// ---------------------------------------------------------------------------

describe("buildAttentionCost", () => {
  test("policy close: tokenCost = 0, resolvedIn = policy, no operatorCost", () => {
    const input: AttentionCostInput = { responder: RESPONDER_POLICY };
    const cost = buildAttentionCost(input);

    expect(cost.tokenCost).toBe(0);
    expect(cost.resolvedIn).toBe("policy");
    expect(cost.transport).toBe("policy");
    expect(cost.operatorCost).toBeUndefined();
  });

  test("policy close: operatorCost input is ignored", () => {
    const input: AttentionCostInput = {
      responder: RESPONDER_POLICY,
      operatorCost: { kind: "quick" },
    };
    const cost = buildAttentionCost(input);

    // Policy close must NOT include operatorCost even if caller provided one
    expect(cost.operatorCost).toBeUndefined();
    expect(cost.tokenCost).toBe(0);
  });

  test("operator close: transport = inbox, resolvedIn = inbox", () => {
    const input: AttentionCostInput = {
      responder: RESPONDER_OPERATOR,
      operatorCost: { kind: "medium", wallClockSec: 120 },
    };
    const cost = buildAttentionCost(input);

    expect(cost.transport).toBe("inbox");
    expect(cost.resolvedIn).toBe("inbox");
    expect(cost.operatorCost).toEqual({ kind: "medium", wallClockSec: 120 });
    expect(cost.tokenCost).toBeUndefined();
  });

  test("timeout close: transport = timeout, resolvedIn = timeout", () => {
    const input: AttentionCostInput = { responder: RESPONDER_TIMEOUT };
    const cost = buildAttentionCost(input);

    expect(cost.transport).toBe("timeout");
    expect(cost.resolvedIn).toBe("timeout");
    expect(cost.operatorCost).toBeUndefined();
  });

  test("subagent close: transport = subagent, resolvedIn = subagent", () => {
    const input: AttentionCostInput = {
      responder: RESPONDER_SUBAGENT,
      tokenCost: 1500,
    };
    const cost = buildAttentionCost(input);

    expect(cost.transport).toBe("subagent");
    expect(cost.resolvedIn).toBe("subagent");
    expect(cost.tokenCost).toBe(1500);
    expect(cost.operatorCost).toBeUndefined();
  });

  test("subagent close without tokenCost: tokenCost is absent", () => {
    const input: AttentionCostInput = { responder: RESPONDER_SUBAGENT };
    const cost = buildAttentionCost(input);

    expect(cost.tokenCost).toBeUndefined();
  });

  // AgentId-prefixed responder tests (ADR-008: prefix encodes the wire transport)

  test("agui: prefix maps to agui transport and resolvedIn", () => {
    const input: AttentionCostInput = { responder: "agui:session:foo123" };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("agui");
    expect(cost.resolvedIn).toBe("agui");
  });

  test("mesh: prefix maps to mesh transport and resolvedIn", () => {
    const input: AttentionCostInput = { responder: "mesh:broadcast:abc" };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("mesh");
    expect(cost.resolvedIn).toBe("mesh");
  });

  test("inbox: prefix maps to inbox transport and resolvedIn", () => {
    const input: AttentionCostInput = { responder: "inbox:session:abc", tokenCost: 0 };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("inbox");
    expect(cost.resolvedIn).toBe("inbox");
  });

  // mt#1498 finding 1: retriever: prefix must map to retriever transport
  // (not silently fall through to subagent). mt#1448 added "retriever" to
  // TransportKind; this test pins the corresponding accounting branch.
  test("retriever: prefix maps to retriever transport and resolvedIn", () => {
    const input: AttentionCostInput = { responder: "retriever:docs:search", tokenCost: 50 };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("retriever");
    expect(cost.resolvedIn).toBe("retriever");
    expect(cost.tokenCost).toBe(50);
  });

  test("retriever: prefix without tokenCost still maps to retriever transport", () => {
    const input: AttentionCostInput = { responder: "retriever:foo:bar" };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("retriever");
    expect(cost.resolvedIn).toBe("retriever");
    expect(cost.tokenCost).toBeUndefined();
  });

  test("bare AgentId (no recognized prefix) maps to subagent transport", () => {
    // e.g. a reviewer bot ID that doesn't carry a transport prefix
    const input: AttentionCostInput = { responder: "reviewer:service:minsky-reviewer-bot" };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("subagent");
    expect(cost.resolvedIn).toBe("subagent");
  });

  test("agui: prefix with tokenCost: tokenCost is preserved", () => {
    const input: AttentionCostInput = { responder: "agui:proc:xyz", tokenCost: 200 };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("agui");
    expect(cost.resolvedIn).toBe("agui");
    expect(cost.tokenCost).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getRollupForTask tests
// ---------------------------------------------------------------------------

describe("getRollupForTask", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    idCounter = 0;
    repo = new FakeAskRepository();
  });

  test("empty task: total = 0, all kind counts = 0", async () => {
    const rollup = await getRollupForTask(repo, TASK_A);

    expect(rollup.taskId).toBe(TASK_A);
    expect(rollup.total).toBe(0);
    expect(rollup.kindCounts[KIND_QUALITY_REVIEW]).toBe(0);
    expect(rollup.operatorCostDistribution).toEqual({ quick: 0, medium: 0, deep: 0 });
  });

  test("3 closed Asks: total = 3, kind counts correct", async () => {
    repo._seedAtState(
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_OPERATOR,
          payload: {},
          attentionCost: buildAttentionCost({ responder: RESPONDER_OPERATOR }),
        },
      })
    );
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_OPERATOR,
          payload: {},
          attentionCost: buildAttentionCost({ responder: RESPONDER_OPERATOR }),
        },
      })
    );
    repo._seedAtState(
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_POLICY,
          payload: {},
          attentionCost: buildAttentionCost({ responder: RESPONDER_POLICY }),
        },
      })
    );

    const rollup = await getRollupForTask(repo, TASK_A);

    expect(rollup.total).toBe(3);
    expect(rollup.kindCounts[KIND_QUALITY_REVIEW]).toBe(2);
    expect(rollup.kindCounts[KIND_DIRECTION_DECIDE]).toBe(1);
    expect(rollup.kindCounts[KIND_AUTHORIZATION_APPROVE]).toBe(0);
  });

  test("pre-routing cancelled Ask is excluded from denominator", async () => {
    // Pre-routing cancelled: no routedAt
    repo._seedAtState(
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_A,
        state: STATE_CANCELLED,
        routedAt: undefined, // not yet routed
      })
    );
    // Post-routing cancelled: has routedAt — should be included
    repo._seedAtState(
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_A,
        state: STATE_CANCELLED,
        routedAt: new Date().toISOString(),
      })
    );

    const rollup = await getRollupForTask(repo, TASK_A);

    // Only the post-routing cancelled Ask counts
    expect(rollup.total).toBe(1);
  });

  test("pre-routing expired Ask is excluded from denominator", async () => {
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_EXPIRED,
        routedAt: undefined,
      })
    );

    const rollup = await getRollupForTask(repo, TASK_A);
    expect(rollup.total).toBe(0);
  });

  test("operatorCost distribution only counts Asks with operatorCost populated", async () => {
    const withOperatorCost: AttentionCost = {
      transport: "inbox",
      resolvedIn: "inbox",
      operatorCost: { kind: "deep" },
    };
    const withoutOperatorCost: AttentionCost = {
      tokenCost: 0,
      transport: "policy",
      resolvedIn: "policy",
    };

    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: { responder: RESPONDER_OPERATOR, payload: {}, attentionCost: withOperatorCost },
      })
    );
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_POLICY,
          payload: {},
          attentionCost: withoutOperatorCost,
        },
      })
    );
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_OPERATOR,
          payload: {},
          attentionCost: {
            transport: "inbox",
            resolvedIn: "inbox",
            operatorCost: { kind: "quick" },
          },
        },
      })
    );

    const rollup = await getRollupForTask(repo, TASK_A);

    expect(rollup.total).toBe(3);
    expect(rollup.operatorCostDistribution).toEqual({ quick: 1, medium: 0, deep: 1 });
  });

  test("Asks for other tasks do not pollute this task's rollup", async () => {
    repo._seedAtState(
      makeAsk({ kind: KIND_QUALITY_REVIEW, parentTaskId: TASK_B, state: STATE_CLOSED })
    );
    repo._seedAtState(
      makeAsk({ kind: KIND_QUALITY_REVIEW, parentTaskId: TASK_A, state: STATE_CLOSED })
    );

    const rollup = await getRollupForTask(repo, TASK_A);
    expect(rollup.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getRollupForKind tests
// ---------------------------------------------------------------------------

describe("getRollupForKind", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    idCounter = 0;
    repo = new FakeAskRepository();
  });

  test("no Asks of this kind: topTasks is empty", async () => {
    repo._seedAtState(
      makeAsk({ kind: KIND_QUALITY_REVIEW, parentTaskId: TASK_A, state: STATE_CLOSED })
    );

    const rollup = await getRollupForKind(repo, KIND_DIRECTION_DECIDE);
    expect(rollup.kind).toBe(KIND_DIRECTION_DECIDE);
    expect(rollup.topTasks).toHaveLength(0);
  });

  test("Asks grouped by task, sorted by operatorCostWeight desc", async () => {
    // TASK_A: 1 direction.decide with quick (weight=1)
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_OPERATOR,
          payload: {},
          attentionCost: {
            transport: "inbox",
            resolvedIn: "inbox",
            operatorCost: { kind: "quick" },
          },
        },
      })
    );

    // TASK_B: 2 direction.decide asks with deep (weight=6 total)
    for (let i = 0; i < 2; i++) {
      repo._seedAtState(
        makeAsk({
          kind: KIND_DIRECTION_DECIDE,
          parentTaskId: TASK_B,
          state: STATE_CLOSED,
          response: {
            responder: RESPONDER_OPERATOR,
            payload: {},
            attentionCost: {
              transport: "inbox",
              resolvedIn: "inbox",
              operatorCost: { kind: "deep" },
            },
          },
        })
      );
    }

    const rollup = await getRollupForKind(repo, KIND_DIRECTION_DECIDE);

    expect(rollup.topTasks).toHaveLength(2);
    // TASK_B should be first (weight=6 > weight=1)
    expect(rollup.topTasks[0]?.taskId).toBe(TASK_B);
    expect(rollup.topTasks[0]?.operatorCostWeight).toBe(6);
    expect(rollup.topTasks[0]?.askCount).toBe(2);
    expect(rollup.topTasks[1]?.taskId).toBe(TASK_A);
    expect(rollup.topTasks[1]?.operatorCostWeight).toBe(1);
  });

  test("ties broken by askCount desc", async () => {
    // TASK_A: 3 asks with no operator cost (weight=0)
    for (let i = 0; i < 3; i++) {
      repo._seedAtState(
        makeAsk({
          kind: KIND_QUALITY_REVIEW,
          parentTaskId: TASK_A,
          state: STATE_CLOSED,
          response: {
            responder: RESPONDER_POLICY,
            payload: {},
            attentionCost: { transport: "policy", resolvedIn: "policy", tokenCost: 0 },
          },
        })
      );
    }
    // TASK_B: 1 ask with no operator cost (weight=0)
    repo._seedAtState(
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_B,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_POLICY,
          payload: {},
          attentionCost: { transport: "policy", resolvedIn: "policy", tokenCost: 0 },
        },
      })
    );

    const rollup = await getRollupForKind(repo, KIND_QUALITY_REVIEW);
    // Both have weight=0; TASK_A has more asks so comes first
    expect(rollup.topTasks[0]?.taskId).toBe(TASK_A);
    expect(rollup.topTasks[0]?.askCount).toBe(3);
  });

  test("top 10 limit: only 10 tasks returned when more exist", async () => {
    // Create 12 tasks each with 1 Ask
    for (let i = 0; i < 12; i++) {
      repo._seedAtState(
        makeAsk({
          kind: KIND_QUALITY_REVIEW,
          parentTaskId: `mt#${1000 + i}`,
          state: STATE_CLOSED,
        })
      );
    }

    const rollup = await getRollupForKind(repo, KIND_QUALITY_REVIEW);
    expect(rollup.topTasks).toHaveLength(10);
  });

  test("pre-routing cancelled Asks excluded from kind rollup", async () => {
    // Pre-routing cancelled — should be excluded
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CANCELLED,
        routedAt: undefined,
      })
    );
    // Normal closed Ask — should be included
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
      })
    );

    const rollup = await getRollupForKind(repo, KIND_DIRECTION_DECIDE);
    expect(rollup.topTasks).toHaveLength(1);
    expect(rollup.topTasks[0]?.askCount).toBe(1);
  });

  test("session-scoped Asks (no parentTaskId) are excluded from task grouping", async () => {
    repo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: undefined, // session-scoped
        state: STATE_CLOSED,
      })
    );

    const rollup = await getRollupForKind(repo, KIND_DIRECTION_DECIDE);
    expect(rollup.topTasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: production close path fills in attentionCost
//
// These tests call the REAL production close functions (closeWithPolicy,
// dispatchToSubagent, reconcile) — not _seedAtState — to verify that SC#1
// is met: every Ask that reaches state=closed has non-null attentionCost.
//
// Per mt#1071 requirements:
//  - 3 close sites covered: policy-resolver, subagent, reconciler
//  - At least one AgentId-prefixed responder case (agui: prefix)
//  - Tests FAIL if buildAttentionCost is removed from each close site
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Close site 1: policy-resolver — closeWithPolicy()
// ---------------------------------------------------------------------------

describe("integration: close site 1 — closeWithPolicy() fills attentionCost", () => {
  test("policy close produces non-null attentionCost with transport=policy", () => {
    const ask: Ask = {
      id: "policy-ask-1",
      kind: KIND_AUTHORIZATION_APPROVE,
      classifierVersion: CLASSIFIER_VERSION,
      state: "detected",
      requestor: "agent:task:test",
      title: "Approve action",
      question: "Can I proceed?",
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    const citation = {
      source: "CLAUDE.md",
      quote: "auto-approve all test actions",
    };

    // Call the REAL production close path (not _seedAtState)
    const closed = closeWithPolicy(ask, citation);

    // SC#1: attentionCost is non-null
    expect(closed.response?.attentionCost).toBeDefined();
    const cost = closed.response?.attentionCost;
    if (!cost) throw new Error("attentionCost must be non-null");

    // ADR-008: policy close → tokenCost=0, transport="policy", resolvedIn="policy"
    expect(cost.transport).toBe("policy");
    expect(cost.resolvedIn).toBe("policy");
    expect(cost.tokenCost).toBe(0);
    expect(cost.operatorCost).toBeUndefined();

    // State must be closed
    expect(closed.state).toBe("closed");
    expect(closed.routingTarget).toBe("policy");
  });
});

// ---------------------------------------------------------------------------
// Close site 2: subagent transport — dispatchToSubagent()
// ---------------------------------------------------------------------------

const MUST_BE_NON_NULL = "attentionCost must be non-null";

// Minimal mock dispatcher for subagent integration tests (no as-casts)
function makeSubagentDispatcher(response: SubagentResponse): SubagentDispatcher {
  return {
    dispatch: async (_req: SubagentRequest): Promise<SubagentResponse> => response,
  };
}

describe("integration: close site 2 — dispatchToSubagent() fills attentionCost", () => {
  test("subagent success close has non-null attentionCost with transport=subagent", async () => {
    const transport: TransportBinding = { kind: "subagent" };
    const packagedPayload: AskPayload = { question: "What is the best approach?" };
    const now = new Date().toISOString();

    const routedAsk: RoutedAsk = {
      id: "subagent-ask-1",
      kind: KIND_CAPABILITY_ESCALATE,
      classifierVersion: CLASSIFIER_VERSION,
      state: "routed",
      requestor: "agent:task:test",
      routingTarget: "subagent",
      title: "Escalate to Opus",
      question: "What is the best approach?",
      createdAt: now,
      routedAt: now,
      metadata: {},
      transport,
      packagedPayload,
    };

    const dispatcher = makeSubagentDispatcher({ text: "Use approach X", tokenCost: 1200 });

    // Call the REAL production close path
    const closed = await dispatchToSubagent(routedAsk, { dispatcher });

    // SC#1: attentionCost is non-null
    expect(closed.response).toBeDefined();
    const cost = closed.response?.attentionCost;
    expect(cost).toBeDefined();
    if (!cost) throw new Error(MUST_BE_NON_NULL);

    // ADR-008: subagent close → transport="subagent", resolvedIn="subagent"
    expect(cost.transport).toBe("subagent");
    expect(cost.resolvedIn).toBe("subagent");
    expect(cost.tokenCost).toBe(1200);
    expect(cost.operatorCost).toBeUndefined();

    expect(closed.state).toBe("closed");
  });

  test("subagent close with agui: responderId maps to agui transport", async () => {
    // Covers the new AgentId-prefix mapping branch (agui:)
    const transport: TransportBinding = { kind: "subagent" };
    const packagedPayload: AskPayload = { question: "Review this output" };
    const now = new Date().toISOString();

    const routedAsk: RoutedAsk = {
      id: "agui-ask-1",
      kind: KIND_CAPABILITY_ESCALATE,
      classifierVersion: CLASSIFIER_VERSION,
      state: "routed",
      requestor: "agent:task:test",
      routingTarget: "subagent",
      title: "AG-UI escalation",
      question: "Review this output",
      createdAt: now,
      routedAt: now,
      metadata: {},
      transport,
      packagedPayload,
    };

    // Dispatcher returns an agui:-prefixed responderId
    const dispatcher = makeSubagentDispatcher({
      text: "Reviewed via AG-UI",
      tokenCost: 500,
      responderId: "agui:session:sess123",
    });

    const closed = await dispatchToSubagent(routedAsk, { dispatcher });

    const cost = closed.response?.attentionCost;
    expect(cost).toBeDefined();
    if (!cost) throw new Error(MUST_BE_NON_NULL);

    // agui: prefix → transport="agui", resolvedIn="agui"
    expect(cost.transport).toBe("agui");
    expect(cost.resolvedIn).toBe("agui");
    expect(cost.tokenCost).toBe(500);

    expect(closed.state).toBe("closed");
  });

  test("subagent error close has non-null attentionCost with transport=timeout", async () => {
    const transport: TransportBinding = { kind: "subagent" };
    const packagedPayload: AskPayload = { question: "Unblock me" };
    const now = new Date().toISOString();

    const routedAsk: RoutedAsk = {
      id: "subagent-err-ask-1",
      kind: "stuck.unblock",
      classifierVersion: CLASSIFIER_VERSION,
      state: "routed",
      requestor: "agent:task:test",
      routingTarget: "subagent",
      title: "Unblock issue",
      question: "Unblock me",
      createdAt: now,
      routedAt: now,
      metadata: {},
      transport,
      packagedPayload,
    };

    // Dispatcher that always fails
    const failingDispatcher: SubagentDispatcher = {
      dispatch: async (_req: SubagentRequest): Promise<SubagentResponse> => {
        throw new Error("Opus dispatch failed: quota exceeded");
      },
    };

    const closed = await dispatchToSubagent(routedAsk, { dispatcher: failingDispatcher });

    const cost = closed.response?.attentionCost;
    expect(cost).toBeDefined();
    if (!cost) throw new Error(MUST_BE_NON_NULL);

    // Error close: responder="timeout" → transport="timeout", resolvedIn="timeout"
    expect(cost.transport).toBe("timeout");
    expect(cost.resolvedIn).toBe("timeout");

    expect(closed.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Close site 3: reconciler — reconcile() fills attentionCost on respond()
// ---------------------------------------------------------------------------

function makeFakeNotify(): OperatorNotify {
  return {
    bell(): void {},
    notify(_title: string, _body: string): void {},
  };
}

function makeFakeGithubClient(reviews: GithubReview[]): GithubReviewClient {
  return {
    async listReviews(): Promise<GithubReview[]> {
      return reviews;
    },
  };
}

describe("integration: close site 3 — reconcile() fills attentionCost on respond()", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    idCounter = 0;
    repo = new FakeAskRepository();
  });

  test("reconciler respond() sets non-null attentionCost on quality.review Ask", async () => {
    // Seed a quality.review Ask at detected state (forces walkToSuspended path)
    const ask: Ask = {
      id: "reconciler-ask-1",
      kind: KIND_QUALITY_REVIEW,
      classifierVersion: CLASSIFIER_VERSION,
      state: "detected",
      requestor: "agent:task:test",
      title: "Review PR #10",
      question: "Please review PR #10",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/10" }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const review: GithubReview = {
      reviewId: 9001,
      state: "APPROVED",
      reviewerLogin: "minsky-reviewer[bot]",
      body: "LGTM",
    };

    // Call the REAL production reconcile path (not _seedAtState on a closed Ask)
    const result = await reconcile(repo, makeFakeGithubClient([review]), makeFakeNotify());

    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);

    // Verify the persisted Ask has non-null attentionCost
    const responded = await repo.getById("reconciler-ask-1");
    expect(responded?.state).toBe("responded");
    expect(responded?.response).toBeDefined();

    const cost = responded?.response?.attentionCost;
    expect(cost).toBeDefined();
    if (!cost) throw new Error("attentionCost must be non-null after reconcile respond()");

    // The reviewer agent ID has no recognized prefix → subagent transport
    expect(cost.transport).toBe("subagent");
    expect(cost.resolvedIn).toBe("subagent");
    // operatorCost is absent: reviewer agent is not a human operator
    expect(cost.operatorCost).toBeUndefined();
  });

  test("reconciler attentionCost is absent when no new reviews (no close occurs)", async () => {
    // No-op case: ensure we don't write attentionCost on unchanged asks
    const ask: Ask = {
      id: "reconciler-ask-2",
      kind: KIND_QUALITY_REVIEW,
      classifierVersion: CLASSIFIER_VERSION,
      state: "suspended",
      requestor: "agent:task:test",
      title: "Review PR #11",
      question: "Please review PR #11",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/11" }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const result = await reconcile(repo, makeFakeGithubClient([]), makeFakeNotify());

    expect(result.unchanged).toBe(1);
    expect(result.responded).toBe(0);

    // Ask state must remain suspended with no response written
    const unchanged = await repo.getById("reconciler-ask-2");
    expect(unchanged?.state).toBe("suspended");
    expect(unchanged?.response).toBeUndefined();
  });
});
