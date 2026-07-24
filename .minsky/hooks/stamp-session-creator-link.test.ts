/**
 * Tests for the stamp-session-creator-link hook's id resolvers.
 *
 * The hook proper (entry point under `import.meta.main`) reads stdin and
 * writes to Postgres; the DB path is covered by
 * `scripts/verify-session-creator-link.ts` against the live schema. What is
 * tested here is the part that had the bug in every prior instance of this
 * family: WHICH id comes from WHERE.
 *
 * Mirrors stamp-pr-author-link.test.ts's shape and case list.
 *
 * Reference: mt#3120
 */

import { describe, it, expect } from "bun:test";
import { resolveConversationId, resolveWorkspaceSessionId } from "./stamp-session-creator-link";
import type { ToolHookInput } from "./types";

const CONVERSATION_ID = "a1b2c3d4-1111-4222-8333-000000000001";
const WORKSPACE_ID = "e5f6a7b8-2222-4333-8444-000000000002";

function makeInput(overrides: Partial<ToolHookInput>): ToolHookInput {
  return {
    session_id: CONVERSATION_ID,
    cwd: "/tmp/repo",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__session_start",
    tool_input: {},
    ...overrides,
  };
}

describe("resolveConversationId", () => {
  it("reads the harness-supplied session_id", () => {
    expect(resolveConversationId(makeInput({}))).toBe(CONVERSATION_ID);
  });

  it("never takes the workspace id from the tool payload", () => {
    // The bug this whole task family exists to prevent: the workspace id is
    // right there in the payload and is the wrong keyspace.
    const r = resolveConversationId(makeInput({ tool_input: { sessionId: WORKSPACE_ID } }));
    expect(r).toBe(CONVERSATION_ID);
    expect(r).not.toBe(WORKSPACE_ID);
  });

  it("returns null when the harness supplied no session_id", () => {
    expect(
      resolveConversationId(makeInput({ session_id: undefined as unknown as string }))
    ).toBeNull();
  });

  it("returns null for an empty session_id rather than linking on an empty key", () => {
    expect(resolveConversationId(makeInput({ session_id: "" }))).toBeNull();
  });
});

describe("resolveWorkspaceSessionId", () => {
  it("reads tool_input.sessionId (explicit caller-supplied id)", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_input.session", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { session: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_result.session.sessionId — the common case (no explicit id)", () => {
    const r = resolveWorkspaceSessionId(
      makeInput({
        tool_input: { task: "mt#3120" },
        tool_result: { success: true, session: { sessionId: WORKSPACE_ID, taskId: "mt#3120" } },
      })
    );
    expect(r).toBe(WORKSPACE_ID);
  });

  it("falls back to a top-level tool_result.sessionId", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_result: { sessionId: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("never returns the conversation id", () => {
    // The mirror of the check above: the harness id must not leak into the
    // workspace slot either, or the link would point a workspace at itself.
    const r = resolveWorkspaceSessionId(makeInput({ tool_input: {} }));
    expect(r).not.toBe(CONVERSATION_ID);
    expect(r).toBeNull();
  });

  it("ignores non-string and empty payload values", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: 42 } }))).toBeNull();
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: "" } }))).toBeNull();
    expect(
      resolveWorkspaceSessionId(makeInput({ tool_result: { session: "not-an-object" } }))
    ).toBeNull();
  });

  it("returns null for a failed call whose result carries no session", () => {
    // A failed session_start has no workspace to link — skipping is correct,
    // but it must be a NAMED skip (the hook logs the reason), not silent.
    const r = resolveWorkspaceSessionId(
      makeInput({ tool_input: { task: "mt#3120" }, tool_result: { success: false } })
    );
    expect(r).toBeNull();
  });
});
