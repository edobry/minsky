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

  test("inbox close: responder = some-inbox-agent maps to subagent transport", () => {
    // Non-magic-string AgentId → subagent bucket
    const input: AttentionCostInput = {
      responder: "inbox:session:abc",
      tokenCost: 0,
    };
    const cost = buildAttentionCost(input);
    expect(cost.transport).toBe("subagent");
    expect(cost.resolvedIn).toBe("subagent");
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
// Integration: buildAttentionCost + getRollupForTask
// ---------------------------------------------------------------------------

describe("integration: close path fills in attentionCost, rollup reads it", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    idCounter = 0;
    repo = new FakeAskRepository();
  });

  test("3 closed Asks on same task produce correct rollup", async () => {
    const asks: Ask[] = [
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_OPERATOR,
          payload: {},
          attentionCost: buildAttentionCost({
            responder: RESPONDER_OPERATOR,
            operatorCost: { kind: "deep" },
          }),
        },
      }),
      makeAsk({
        kind: KIND_QUALITY_REVIEW,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_POLICY,
          payload: {},
          attentionCost: buildAttentionCost({ responder: RESPONDER_POLICY }),
        },
      }),
      makeAsk({
        kind: KIND_CAPABILITY_ESCALATE,
        parentTaskId: TASK_A,
        state: STATE_CLOSED,
        response: {
          responder: RESPONDER_SUBAGENT,
          payload: {},
          attentionCost: buildAttentionCost({ responder: RESPONDER_SUBAGENT, tokenCost: 800 }),
        },
      }),
    ];

    for (const ask of asks) {
      repo._seedAtState(ask);
    }

    const rollup = await getRollupForTask(repo, TASK_A);

    expect(rollup.total).toBe(3);
    expect(rollup.kindCounts[KIND_DIRECTION_DECIDE]).toBe(1);
    expect(rollup.kindCounts[KIND_QUALITY_REVIEW]).toBe(1);
    expect(rollup.kindCounts[KIND_CAPABILITY_ESCALATE]).toBe(1);
    // Only the operator close has operatorCost
    expect(rollup.operatorCostDistribution).toEqual({ quick: 0, medium: 0, deep: 1 });
  });
});
