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
import { resolveConversationId, resolveSessionContext } from "./post-merge-unasked-direction-scan";
import type { ToolHookInput } from "./types";

function makeInput(overrides: Partial<ToolHookInput>): ToolHookInput {
  return {
    session_id: "abc",
    cwd: "/tmp/repo",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__session_pr_merge",
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
