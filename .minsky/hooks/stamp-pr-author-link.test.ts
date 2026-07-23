/**
 * Tests for the stamp-pr-author-link hook's id resolvers.
 *
 * The hook proper (entry point under `import.meta.main`) reads stdin and
 * writes to Postgres; the DB path is covered by
 * `scripts/verify-pr-author-link.ts` against the live schema. What is tested
 * here is the part that had the bug in every prior instance of this family:
 * WHICH id comes from WHERE.
 *
 * Reference: mt#3101 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import { resolveConversationId, resolveWorkspaceSessionId } from "./stamp-pr-author-link";
import type { ToolHookInput } from "./types";

const CONVERSATION_ID = "f00dfb7d-17e6-42ce-b0d9-00716e2fa10b";
const WORKSPACE_ID = "1ae085d7-7415-4bd1-b71b-e099558f6588";

function makeInput(overrides: Partial<ToolHookInput>): ToolHookInput {
  return {
    session_id: CONVERSATION_ID,
    cwd: "/tmp/repo",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__session_pr_create",
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
  it("reads tool_input.sessionId", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_input.session", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { session: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_result.session.sessionId", () => {
    const r = resolveWorkspaceSessionId(
      makeInput({ tool_result: { session: { sessionId: WORKSPACE_ID } } })
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

  it("resolves a task-only call via the tool result (PR #2232 R1)", () => {
    // `session_pr_create` accepts `task` INSTEAD of `sessionId`, and a task id
    // is not a workspace id — it cannot be mapped without a DB lookup. It does
    // not need one: the successful result carries the session record. This PR
    // is the live instance — created with `task: "mt#3101"` and no `sessionId`.
    const r = resolveWorkspaceSessionId(
      makeInput({
        tool_input: { task: "mt#3101" },
        tool_result: { session: { sessionId: WORKSPACE_ID, taskId: "mt#3101" } },
      })
    );
    expect(r).toBe(WORKSPACE_ID);
  });

  it("returns null for a task-only call whose result carries no session", () => {
    // A failed `session_pr_create` has no PR to attribute, so skipping is
    // correct — but it must be a NAMED skip, not a silent one (the hook logs
    // the reason).
    const r = resolveWorkspaceSessionId(makeInput({ tool_input: { task: "mt#3101" } }));
    expect(r).toBeNull();
  });
});
