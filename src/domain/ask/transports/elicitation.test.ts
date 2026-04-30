/**
 * Tests for the elicitation transport (mt#1457).
 *
 * Coverage:
 *   - Kind support: direction.decide accepted; all other kinds throw.
 *   - State-machine walk: detected → classified → routed → suspended → ...
 *     transitions are persisted via the repository.
 *   - Accept path: response payload + state="closed".
 *   - Decline / cancel: state="cancelled".
 *   - Error path (timeout, host disconnect): state="suspended" with
 *     transport.kind: "elicitation" recorded.
 *   - requestedSchema shape: enum-narrowed when options are present;
 *     free-text fallback when not.
 *   - Prompt construction: question + contextRefs.
 *
 * Reference: mt#1457 spec.
 */

import { describe, expect, test } from "bun:test";

import { dispatchToElicitation, _testOnly } from "./elicitation";
import { FakeAskRepository } from "../repository";
import { policyFirstRoute } from "../router";
import type {
  ElicitationCapableServer,
  ElicitInputResult,
  ElicitInputParams,
  ElicitInputOptions,
} from "../../../mcp/client-capabilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Workspace root for tests — non-existent dir so policy loaders return [].
const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_elicitation__";

const KIND_DIRECTION_DECIDE = "direction.decide" as const;
const KIND_CAPABILITY_ESCALATE = "capability.escalate" as const;
const KIND_QUALITY_REVIEW = "quality.review" as const;

// ---------------------------------------------------------------------------
// Fake elicitation server
// ---------------------------------------------------------------------------

/**
 * Fake `ElicitationCapableServer` for tests. Records calls and returns a
 * configurable result (or throws to simulate dispatch error).
 */
class FakeElicitationServer implements ElicitationCapableServer {
  calls: Array<{ params: ElicitInputParams; options: ElicitInputOptions | undefined }> = [];

  private nextResult: ElicitInputResult | (() => never) | (() => Promise<any>) = {
    action: "accept",
    content: {},
  };

  setResult(result: ElicitInputResult): void {
    this.nextResult = result;
  }

  setReject(error: Error | string): void {
    const err = typeof error === "string" ? new Error(error) : error;
    this.nextResult = () => {
      throw err;
    };
  }

  setHang(): void {
    // Simulate a hung dispatch (e.g. host disconnect mid-elicitation). The
    // transport's timeout option should reject before this resolves.
    this.nextResult = () => new Promise(() => {});
  }

  async elicitInput(
    params: ElicitInputParams,
    options?: ElicitInputOptions
  ): Promise<ElicitInputResult> {
    this.calls.push({ params, options });
    if (typeof this.nextResult === "function") {
      return await this.nextResult();
    }
    return this.nextResult;
  }
}

// ---------------------------------------------------------------------------
// Helpers — build a RoutedAsk via the actual router so the state field and
// shape match real production usage.
// ---------------------------------------------------------------------------

interface BuildArgs {
  kind: typeof KIND_DIRECTION_DECIDE | typeof KIND_CAPABILITY_ESCALATE | typeof KIND_QUALITY_REVIEW;
  options?: { label: string; value: unknown; description?: string }[];
  question?: string;
}

async function buildRoutedAsk(repo: FakeAskRepository, args: BuildArgs) {
  const created = await repo.create({
    kind: args.kind,
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: "Test ask",
    question: args.question ?? "Test question",
    options: args.options,
    metadata: {},
  });

  return policyFirstRoute(created, { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT });
}

// ---------------------------------------------------------------------------
// Kind support
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — kind support", () => {
  test("direction.decide is supported", () => {
    expect(_testOnly.isElicitationSupported(KIND_DIRECTION_DECIDE)).toBe(true);
  });

  test("capability.escalate / quality.review / async kinds are not supported", () => {
    expect(_testOnly.isElicitationSupported(KIND_CAPABILITY_ESCALATE)).toBe(false);
    expect(_testOnly.isElicitationSupported(KIND_QUALITY_REVIEW)).toBe(false);
    expect(_testOnly.isElicitationSupported("authorization.approve")).toBe(false);
    expect(_testOnly.isElicitationSupported("information.retrieve")).toBe(false);
    expect(_testOnly.isElicitationSupported("coordination.notify")).toBe(false);
    expect(_testOnly.isElicitationSupported("stuck.unblock")).toBe(false);
  });

  test("dispatching an unsupported kind throws", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_CAPABILITY_ESCALATE });
    const server = new FakeElicitationServer();

    await expect(dispatchToElicitation(routed, { server, repo })).rejects.toThrow(
      /unsupported kind/
    );
  });
});

// ---------------------------------------------------------------------------
// requestedSchema shape
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — requestedSchema", () => {
  test("direction.decide with no options yields a free-text chosen schema", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });

    const schema = _testOnly.buildRequestedSchema(KIND_DIRECTION_DECIDE, routed);
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.chosen?.type).toBe("string");
    expect(properties.chosen?.enum).toBeUndefined();
    expect(properties.rationale?.type).toBe("string");
    expect(schema.required).toEqual(["chosen"]);
  });

  test("direction.decide with options yields an enum-narrowed chosen schema", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, {
      kind: KIND_DIRECTION_DECIDE,
      options: [
        { label: "Apple", value: "a" },
        { label: "Banana", value: "b" },
      ],
    });

    const schema = _testOnly.buildRequestedSchema(KIND_DIRECTION_DECIDE, routed);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.chosen?.enum).toEqual(["a", "b"]);
    expect(properties.chosen?.enumNames).toEqual(["Apple", "Banana"]);
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — buildPrompt", () => {
  test("includes the question", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, {
      kind: KIND_DIRECTION_DECIDE,
      question: "Apple or banana?",
    });
    expect(_testOnly.buildPrompt(routed)).toContain("Apple or banana?");
  });

  test("appends contextRefs as bullets when present", async () => {
    const repo = new FakeAskRepository();
    const created = await repo.create({
      kind: "direction.decide",
      classifierVersion: "v1.0.0",
      requestor: "minsky.agent:test",
      title: "T",
      question: "Q?",
      contextRefs: [
        { kind: "diff", ref: "abc/def", description: "the diff" },
        { kind: "file", ref: "src/foo.ts" },
      ],
      metadata: {},
    });
    const routed = await policyFirstRoute(created, {
      workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
    });
    const prompt = _testOnly.buildPrompt(routed);
    expect(prompt).toContain("Q?");
    expect(prompt).toContain("Context:");
    expect(prompt).toContain("- diff: abc/def — the diff");
    expect(prompt).toContain("- file: src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// Accept path
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — accept path", () => {
  test("walks the state machine and returns a closed Ask with the response payload", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });
    const server = new FakeElicitationServer();
    server.setResult({
      action: "accept",
      content: { chosen: "a", rationale: "reasoning" },
    });

    const result = await dispatchToElicitation(routed, { server, repo });

    expect(result.state).toBe("closed");
    expect(result.routingTarget).toBe("operator");
    expect(result.transport.kind).toBe("elicitation");
    expect(result.response?.responder).toBe("operator");
    expect(result.response?.payload).toEqual({ chosen: "a", rationale: "reasoning" });
    expect(result.response?.attentionCost?.transport).toBe("elicitation");
    expect(result.response?.attentionCost?.resolvedIn).toBe("elicitation");

    // Verify state walked through suspended → responded → closed via the repo.
    const persisted = await repo.getById(routed.id);
    expect(persisted?.state).toBe("closed");
  });

  test("issues elicitInput with the constructed message and requestedSchema", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, {
      kind: KIND_DIRECTION_DECIDE,
      question: "Pick X or Y",
      options: [
        { label: "X", value: "x" },
        { label: "Y", value: "y" },
      ],
    });
    const server = new FakeElicitationServer();
    server.setResult({ action: "accept", content: { chosen: "x" } });

    await dispatchToElicitation(routed, { server, repo });

    expect(server.calls).toHaveLength(1);
    const call = server.calls[0];
    expect(call?.params.message).toContain("Pick X or Y");
    const props = call?.params.requestedSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.chosen?.enum).toEqual(["x", "y"]);
  });

  test("forwards the timeout to elicitInput", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });
    const server = new FakeElicitationServer();

    await dispatchToElicitation(routed, { server, repo, timeoutMs: 12345 });

    expect(server.calls[0]?.options?.timeout).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Decline / cancel paths
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — decline / cancel", () => {
  test("decline action transitions Ask to cancelled", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });
    const server = new FakeElicitationServer();
    server.setResult({ action: "decline" });

    const result = await dispatchToElicitation(routed, { server, repo });

    expect(result.state).toBe("cancelled");
    expect(result.transport.kind).toBe("elicitation");

    const persisted = await repo.getById(routed.id);
    expect(persisted?.state).toBe("cancelled");
  });

  test("cancel action transitions Ask to cancelled", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });
    const server = new FakeElicitationServer();
    server.setResult({ action: "cancel" });

    const result = await dispatchToElicitation(routed, { server, repo });

    expect(result.state).toBe("cancelled");
    const persisted = await repo.getById(routed.id);
    expect(persisted?.state).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Error path — host disconnect / timeout
// ---------------------------------------------------------------------------

describe("dispatchToElicitation — error path", () => {
  test("dispatch error leaves Ask in suspended state with transport=elicitation", async () => {
    const repo = new FakeAskRepository();
    const routed = await buildRoutedAsk(repo, { kind: KIND_DIRECTION_DECIDE });
    const server = new FakeElicitationServer();
    server.setReject(new Error("host disconnected"));

    const result = await dispatchToElicitation(routed, { server, repo });

    expect(result.state).toBe("suspended");
    expect(result.routingTarget).toBe("operator");
    expect(result.transport.kind).toBe("elicitation");
    const errorPayload = result.response?.payload as { error?: string };
    expect(errorPayload.error).toContain("host disconnected");

    // Repo state matches: walked to suspended, never advanced past it.
    const persisted = await repo.getById(routed.id);
    expect(persisted?.state).toBe("suspended");
  });
});
