/**
 * Tests for the post-merge-unasked-direction-scan hook helpers.
 *
 * The hook proper (entry point under `import.meta.main`) reads stdin,
 * loads transcripts from Postgres, and invokes the AI provider — none of
 * which are easily testable here. We test the pure session-context
 * resolver, which decides what session/task to analyze.
 *
 * Reference: mt#1543 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import {
  describeToolResultShape,
  MAX_DESCRIBED_KEYS,
  resolveConversationId,
  resolveSessionContext,
} from "./post-merge-unasked-direction-scan";
import type { ToolHookInput } from "./types";
import capturedPayloads from "./fixtures/session-pr-merge-payloads.json";

const MERGE_TOOL_NAME = "mcp__minsky__session_pr_merge";

function makeInput(overrides: Partial<ToolHookInput>): ToolHookInput {
  return {
    session_id: "abc",
    cwd: "/tmp/repo",
    hook_event_name: "PostToolUse",
    tool_name: MERGE_TOOL_NAME,
    tool_input: {},
    ...overrides,
  };
}

describe("resolveSessionContext", () => {
  it("returns null when neither input nor response yields a sessionId", () => {
    const r = resolveSessionContext(makeInput({}));
    expect(r).toBeNull();
  });

  it("reads sessionId from tool_input.sessionId", () => {
    const r = resolveSessionContext(makeInput({ tool_input: { sessionId: "S1" } }));
    expect(r).toEqual({ sessionId: "S1" });
  });

  it("reads sessionId from tool_input.session as fallback", () => {
    const r = resolveSessionContext(makeInput({ tool_input: { session: "S2" } }));
    expect(r).toEqual({ sessionId: "S2" });
  });

  it("reads sessionId from tool_result.session.sessionId", () => {
    const r = resolveSessionContext(
      makeInput({
        tool_input: {},
        tool_result: { session: { sessionId: "S3" } },
      })
    );
    expect(r).toEqual({ sessionId: "S3" });
  });

  it("reads taskId from tool_input.task", () => {
    const r = resolveSessionContext(
      makeInput({ tool_input: { sessionId: "S1", task: "mt#1543" } })
    );
    expect(r).toEqual({ sessionId: "S1", taskId: "mt#1543" });
  });

  it("reads taskId from tool_result.session.taskId when input lacks it", () => {
    const r = resolveSessionContext(
      makeInput({
        tool_input: { sessionId: "S1" },
        tool_result: { session: { sessionId: "S1", taskId: "mt#1543" } },
      })
    );
    expect(r).toEqual({ sessionId: "S1", taskId: "mt#1543" });
  });

  it("ignores non-string param values", () => {
    const r = resolveSessionContext(
      makeInput({
        tool_input: { sessionId: 42 as unknown as string },
        tool_result: { session: { sessionId: "S5" } },
      })
    );
    // Falls through to tool_result
    expect(r).toEqual({ sessionId: "S5" });
  });

  it("ignores tool_result.session if it isn't an object", () => {
    const r = resolveSessionContext(
      makeInput({
        tool_input: {},
        tool_result: { session: "not-an-object" },
      })
    );
    expect(r).toBeNull();
  });
});

describe("resolveConversationId", () => {
  it("reads the harness-supplied session_id", () => {
    const r = resolveConversationId(makeInput({ session_id: "conv-1" }));
    expect(r).toBe("conv-1");
  });

  it("does NOT read the workspace session id out of the tool payload", () => {
    // mt#3066: the bug. `tool_input.sessionId` is a Minsky WORKSPACE id and
    // never appears in `agent_transcripts.agent_session_id`, so using it as the
    // transcript key made the scan no-op on every merge. The conversation id
    // must come from the harness field, independent of the payload.
    const r = resolveConversationId(
      makeInput({ session_id: "conv-1", tool_input: { sessionId: "workspace-1" } })
    );
    expect(r).toBe("conv-1");
    expect(r).not.toBe("workspace-1");
  });

  it("returns null when the harness supplied no session_id", () => {
    const r = resolveConversationId(makeInput({ session_id: undefined as unknown as string }));
    expect(r).toBeNull();
  });

  it("returns null for an empty session_id rather than querying on an empty key", () => {
    const r = resolveConversationId(makeInput({ session_id: "" }));
    expect(r).toBeNull();
  });

  it("resolves independently of the workspace context — both ids are available", () => {
    const input = makeInput({
      session_id: "conv-1",
      tool_input: { sessionId: "workspace-1", task: "mt#3066" },
    });

    // The workspace id stays the findings-file key and analyzer label; only the
    // transcript lookup moved to the conversation id.
    expect(resolveSessionContext(input)).toEqual({ sessionId: "workspace-1", taskId: "mt#3066" });
    expect(resolveConversationId(input)).toBe("conv-1");
  });
});

describe("resolveSessionContext against CAPTURED real payloads (mt#3127)", () => {
  // These fixtures are copied from actual `session_pr_merge` returns, not
  // authored to match the resolver. The distinction is the whole point: the
  // previous verification invented `tool_result.session.sessionId`, which the
  // tool does not return, and passed while production skipped every merge.
  const cases = [
    ["task-invoked (the form that never resolved)", capturedPayloads.taskInvoked],
    ["sessionId-invoked", capturedPayloads.sessionIdInvoked],
  ] as const;

  for (const [name, fixture] of cases) {
    it(`resolves the real ${name} payload`, () => {
      const input = {
        session_id: "00000000-0000-4000-8000-0000000000ff",
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        tool_name: fixture.toolName,
        tool_input: fixture.toolInput,
        tool_result: fixture.toolResult,
      } as unknown as ToolHookInput;

      expect(resolveSessionContext(input)).toEqual({
        sessionId: fixture.expected.sessionId,
        taskId: fixture.expected.taskId,
      });
    });
  }

  it("reads the session id from tool_result.result.session — the location production uses", () => {
    // Pinning the specific accessor that was missing. If a refactor drops it,
    // the task-invoked case above fails too, but this test names the cause.
    const fixture = capturedPayloads.taskInvoked;
    expect(fixture.toolResult.result.session).toBe(fixture.expected.sessionId);
    expect(typeof fixture.toolResult.result.session).toBe("string");
  });
});

describe("unresolvable payload diagnostics (mt#3127)", () => {
  it("names the keys present and the shapes tried", () => {
    const input = {
      session_id: "conv-1",
      cwd: "/tmp/repo",
      hook_event_name: "PostToolUse",
      tool_name: MERGE_TOOL_NAME,
      tool_input: { task: "mt#3127" },
      tool_result: { success: true, result: { unexpectedKey: "x" } },
    } as unknown as ToolHookInput;

    expect(resolveSessionContext(input)).toBeNull();

    const described = describeToolResultShape(input);
    expect(described).toContain("tool_input keys=[task]");
    expect(described).toContain("tool_result keys=[success,result]");
    expect(described).toContain("tool_result.result keys=[unexpectedKey]");
    expect(described).toContain("tool_result.result.session");
  });

  it("does not leak values, only key names", () => {
    const input = {
      session_id: "conv-1",
      cwd: "/tmp/repo",
      hook_event_name: "PostToolUse",
      tool_name: MERGE_TOOL_NAME,
      tool_input: { task: "mt#3127" },
      tool_result: { success: true, result: { secretPath: "/Users/someone/private" } },
    } as unknown as ToolHookInput;

    expect(describeToolResultShape(input)).not.toContain("/Users/someone/private");
  });

  it("bounds the description for a payload with many keys (PR #2246 R1)", () => {
    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < MAX_DESCRIBED_KEYS + 20; i++) manyKeys[`k${i}`] = i;

    const input = {
      session_id: "conv-1",
      cwd: "/tmp/repo",
      hook_event_name: "PostToolUse",
      tool_name: MERGE_TOOL_NAME,
      tool_input: { task: "mt#3127" },
      tool_result: { success: true, result: manyKeys },
    } as unknown as ToolHookInput;

    const described = describeToolResultShape(input);
    expect(described).toContain(`+20 more`);
    // The elided keys must not appear in full.
    expect(described).not.toContain(`k${MAX_DESCRIBED_KEYS + 19}`);
  });
});
