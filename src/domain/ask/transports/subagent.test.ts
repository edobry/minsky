/**
 * Tests for the subagent-dispatch transport (ADR-008 §Transport-binding matrix).
 *
 * Tests capability.escalate and stuck.unblock dispatch via the SubagentDispatcher
 * DI interface. All tests inject a mock dispatcher — no real subagent calls.
 *
 * Reference: src/domain/ask/transports/subagent.ts
 */

import { describe, test, expect, mock } from "bun:test";
import {
  dispatchToSubagent,
  StubSubagentDispatcher,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
} from "./subagent";
import type { SubagentDispatcher, SubagentRequest, SubagentResponse } from "./subagent";
import type { RoutedAsk, AskPayload, TransportBinding } from "../router";

// ---------------------------------------------------------------------------
// Shared constants (avoid magic-string-duplication warnings)
// ---------------------------------------------------------------------------

const KIND_CAPABILITY_ESCALATE: RoutedAsk["kind"] = "capability.escalate";
const KIND_STUCK_UNBLOCK: RoutedAsk["kind"] = "stuck.unblock";
const KIND_DIR_DECIDE: RoutedAsk["kind"] = "direction.decide";
const KIND_QUALITY_REVIEW: RoutedAsk["kind"] = "quality.review";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * MockSubagentDispatcher — a testable SubagentDispatcher implementation.
 *
 * Avoids `as` casts: the mock struct satisfies `SubagentDispatcher` by type.
 */
interface MockDispatcherState {
  calls: SubagentRequest[];
  response: SubagentResponse | null;
  error: Error | null;
  /** If set, dispatch waits this many ms before resolving/rejecting. */
  delayMs: number;
}

function createMockDispatcher(
  initialResponse?: SubagentResponse
): SubagentDispatcher & { state: MockDispatcherState } {
  const state: MockDispatcherState = {
    calls: [],
    response: initialResponse ?? { text: "mock response", tokenCost: 500 },
    error: null,
    delayMs: 0,
  };

  const dispatcher: SubagentDispatcher & { state: MockDispatcherState } = {
    state,
    dispatch: mock(async (request: SubagentRequest): Promise<SubagentResponse> => {
      state.calls.push(request);
      if (state.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, state.delayMs));
      }
      if (state.error) {
        throw state.error;
      }
      if (!state.response) {
        throw new Error("MockDispatcher: no response configured");
      }
      return state.response;
    }),
  };

  return dispatcher;
}

/**
 * Build a minimal valid RoutedAsk for testing.
 */
function makeRoutedAsk(kind: RoutedAsk["kind"], overrides: Partial<RoutedAsk> = {}): RoutedAsk {
  const now = new Date().toISOString();

  const transport: TransportBinding = { kind: "subagent" };
  const packagedPayload: AskPayload = {
    question: overrides.question ?? "Test question",
  };

  return {
    id: "test-ask-id-001",
    kind,
    classifierVersion: "v1",
    requestor: "com.anthropic.claude-code:proc:test123",
    routingTarget: "subagent",
    state: "routed",
    title: "Test Ask",
    question: "Test question",
    createdAt: now,
    routedAt: now,
    metadata: {},
    transport,
    packagedPayload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// capability.escalate tests
// ---------------------------------------------------------------------------

describe("dispatchToSubagent — capability.escalate", () => {
  test("dispatches and returns a closed Ask with the dispatcher reply in payload", async () => {
    const dispatcher = createMockDispatcher({
      text: "Escalation result: use approach X",
      tokenCost: 750,
    });

    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE, {
      metadata: { model: "opus", agentType: "reviewer" },
    });

    const result = await dispatchToSubagent(routedAsk, { dispatcher });

    // State assertions
    expect(result.state).toBe("closed");
    expect(result.routingTarget).toBe("subagent");
    expect(result.closedAt).toBeDefined();

    // Payload content
    const payload = result.response?.payload as Record<string, unknown>;
    expect(typeof payload?.text).toBe("string");
    expect(payload?.text).toContain("Escalation result");

    // Attention cost recorded — canonical response.attentionCost only.
    // The legacy payload.attentionCost field was removed in mt#1498 — the
    // shape diverged from the canonical AttentionCost (it carried
    // {tokenCost, kind} instead of {tokenCost?, operatorCost?, transport,
    // resolvedIn}) and no production callsite consumed it.
    const attentionCost = result.response?.attentionCost;
    expect(attentionCost?.tokenCost).toBe(750);
    expect(attentionCost?.transport).toBe("subagent");
    expect(attentionCost?.resolvedIn).toBe("subagent");
    expect(payload?.attentionCost).toBeUndefined();

    // Dispatcher called once with correct model
    expect(dispatcher.state.calls).toHaveLength(1);
    const firstCall = dispatcher.state.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.model).toBe("opus");
    expect(firstCall?.type).toBe("reviewer");
  });

  test("uses opus/general-purpose defaults when metadata is absent", async () => {
    const dispatcher = createMockDispatcher();
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE); // no metadata overrides

    await dispatchToSubagent(routedAsk, { dispatcher });

    const defaultsCall = dispatcher.state.calls[0];
    expect(defaultsCall).toBeDefined();
    expect(defaultsCall?.model).toBe("opus");
    expect(defaultsCall?.type).toBe("general-purpose");
  });

  test("includes question in the prompt sent to the dispatcher", async () => {
    const dispatcher = createMockDispatcher();
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE, {
      question: "What is the best approach for X?",
    });

    await dispatchToSubagent(routedAsk, { dispatcher });

    const questionCall = dispatcher.state.calls[0];
    expect(questionCall).toBeDefined();
    expect(questionCall?.prompt).toContain("What is the best approach for X?");
  });

  test("includes contextRefs in the prompt when present", async () => {
    const dispatcher = createMockDispatcher();
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE, {
      contextRefs: [{ kind: "file", ref: "src/foo.ts", description: "the main file" }],
    });

    await dispatchToSubagent(routedAsk, { dispatcher });

    const refsCall = dispatcher.state.calls[0];
    expect(refsCall).toBeDefined();
    const prompt = refsCall?.prompt;
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("the main file");
  });
});

// ---------------------------------------------------------------------------
// stuck.unblock tests
// ---------------------------------------------------------------------------

describe("dispatchToSubagent — stuck.unblock", () => {
  test("dispatches chain step 1 (Opus) and returns closed Ask with its response", async () => {
    const dispatcher = createMockDispatcher({
      text: "Fresh perspective: the issue is in the config",
      tokenCost: 2000,
    });

    const routedAsk = makeRoutedAsk(KIND_STUCK_UNBLOCK);

    const result = await dispatchToSubagent(routedAsk, { dispatcher });

    expect(result.state).toBe("closed");
    expect(result.routingTarget).toBe("subagent");

    const payload = result.response?.payload as Record<string, unknown>;
    expect(payload?.text).toContain("Fresh perspective");

    // Chain step 1 must use Opus
    const opusCall = dispatcher.state.calls[0];
    expect(opusCall).toBeDefined();
    expect(opusCall?.model).toBe("opus");
    expect(opusCall?.type).toBe("general-purpose");
  });

  test("returns error close with chain-step-1 failure message when Opus fails", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.state.error = new Error("Opus dispatch failed: quota exceeded");

    const routedAsk = makeRoutedAsk(KIND_STUCK_UNBLOCK);

    const result = await dispatchToSubagent(routedAsk, { dispatcher });

    expect(result.state).toBe("closed");
    expect(result.routingTarget).toBe("subagent");

    const payload = result.response?.payload as Record<string, unknown>;
    expect(typeof payload?.error).toBe("string");
    // Must reference the blocking tasks in the error
    expect(payload?.error as string).toContain("mt#1001");
    expect(payload?.error as string).toContain("mt#454");
    expect(payload?.errorDetail as string).toContain("quota exceeded");

    // Responder is "timeout" for failure paths
    expect(result.response?.responder).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Timeout tests
// ---------------------------------------------------------------------------

describe("dispatchToSubagent — timeout", () => {
  test("rejects with a timeout error when dispatcher hangs", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.state.delayMs = 500; // hangs for 500ms

    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE);

    // Use a very short timeout (50ms) to trigger before the 500ms delay
    const result = await dispatchToSubagent(routedAsk, {
      dispatcher,
      timeoutMs: 50,
    });

    // Should close with error, not throw
    expect(result.state).toBe("closed");
    const payload = result.response?.payload as Record<string, unknown>;
    expect(typeof payload?.error).toBe("string");
    expect(payload?.errorDetail as string).toContain("timed out");
  }, 5000);

  test("does not fire timeout when dispatcher responds within limit", async () => {
    const dispatcher = createMockDispatcher({ text: "fast response", tokenCost: 100 });
    dispatcher.state.delayMs = 0;

    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE);

    const result = await dispatchToSubagent(routedAsk, {
      dispatcher,
      timeoutMs: 5000,
    });

    expect(result.state).toBe("closed");
    expect(result.routingTarget).toBe("subagent");
    const payload = result.response?.payload as Record<string, unknown>;
    expect(payload?.text).toBe("fast response");
  });
});

// ---------------------------------------------------------------------------
// Token cost recording
// ---------------------------------------------------------------------------

describe("dispatchToSubagent — token cost recording", () => {
  test("records tokenCost in attentionCost when dispatcher returns a token count", async () => {
    const dispatcher = createMockDispatcher({ text: "done", tokenCost: 3500 });
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE);

    const result = await dispatchToSubagent(routedAsk, { dispatcher });

    // Canonical response.attentionCost is the single source of truth for
    // token cost (mt#1498 removed the redundant payload.attentionCost field).
    expect(result.response?.attentionCost?.tokenCost).toBe(3500);
  });

  test("records undefined tokenCost when dispatcher omits token count", async () => {
    const dispatcher = createMockDispatcher({ text: "done" }); // no tokenCost
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE);

    const result = await dispatchToSubagent(routedAsk, { dispatcher });

    expect(result.response?.attentionCost?.tokenCost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wrong kind guard
// ---------------------------------------------------------------------------

describe("dispatchToSubagent — kind guard", () => {
  test("throws for a non-subagent kind (direction.decide)", async () => {
    const dispatcher = createMockDispatcher();
    const routedAsk = makeRoutedAsk(KIND_DIR_DECIDE);

    await expect(dispatchToSubagent(routedAsk, { dispatcher })).rejects.toThrow("unsupported kind");
  });

  test("throws for a non-subagent kind (quality.review)", async () => {
    const dispatcher = createMockDispatcher();
    const routedAsk = makeRoutedAsk(KIND_QUALITY_REVIEW);

    await expect(dispatchToSubagent(routedAsk, { dispatcher })).rejects.toThrow("unsupported kind");
  });
});

// ---------------------------------------------------------------------------
// StubSubagentDispatcher
// ---------------------------------------------------------------------------

describe("StubSubagentDispatcher", () => {
  test("rejects with a 'not yet available' error", async () => {
    const stub = new StubSubagentDispatcher();

    await expect(
      stub.dispatch({ model: "opus", type: "general-purpose", prompt: "test" })
    ).rejects.toThrow("SubagentDispatcher not yet available");
  });

  test("is used as the default dispatcher when none is provided", async () => {
    const routedAsk = makeRoutedAsk(KIND_CAPABILITY_ESCALATE);

    // No dispatcher injected — should use StubSubagentDispatcher and close with error
    const result = await dispatchToSubagent(routedAsk);

    expect(result.state).toBe("closed");
    const payload = result.response?.payload as Record<string, unknown>;
    expect(typeof payload?.error).toBe("string");
    expect(payload?.errorDetail as string).toContain("SubagentDispatcher not yet available");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SUBAGENT_TIMEOUT_MS export
// ---------------------------------------------------------------------------

describe("DEFAULT_SUBAGENT_TIMEOUT_MS", () => {
  test("is 60 000 ms", () => {
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(60_000);
  });
});
