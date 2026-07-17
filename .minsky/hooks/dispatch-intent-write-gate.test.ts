import { describe, expect, it } from "bun:test";
import {
  isSubagentContext,
  resolveSessionIdFromInput,
  decideDispatchIntentGate,
  buildDenialMessage,
  GATED_TOOL_NAMES,
} from "./dispatch-intent-write-gate";
import type { DispatchIntentDeclaration } from "./dispatch-intent-store";
import type { ToolHookInput } from "./types";

const NOW = Date.parse("2026-07-17T20:00:00.000Z");
const SESSION_ID = "6b71e8fb-0c8e-4543-8347-3c3ade427e71";
/** Shared tool-name fixture — satisfies custom/no-magic-string-duplication. */
const SESSION_PR_EDIT_TOOL = "mcp__minsky__session_pr_edit";

function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: "/some/repo",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__minsky__session_commit",
    tool_input: {},
    ...overrides,
  };
}

function makeDeclaration(
  overrides: Partial<DispatchIntentDeclaration> = {}
): DispatchIntentDeclaration {
  return {
    sessionId: SESSION_ID,
    intent: "read-only",
    issuedAt: new Date(NOW).toISOString(),
    ttlMs: 30 * 60 * 1000,
    reason: "search memory for reviewer-empty-findings context, report back under 300 words",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GATED_TOOL_NAMES
// ---------------------------------------------------------------------------

describe("GATED_TOOL_NAMES", () => {
  it("covers exactly the six session-mutating/PR-mutating tools named in the spec", () => {
    expect([...GATED_TOOL_NAMES].sort()).toEqual(
      [
        "mcp__minsky__session_commit",
        "mcp__minsky__session_edit_file",
        "mcp__minsky__session_write_file",
        "mcp__minsky__session_search_replace",
        "mcp__minsky__session_pr_create",
        "mcp__minsky__session_pr_edit",
      ].sort()
    );
  });

  it("deliberately excludes session_pr_merge (already D5-covered)", () => {
    expect(GATED_TOOL_NAMES.has("mcp__minsky__session_pr_merge")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSubagentContext
// ---------------------------------------------------------------------------

describe("isSubagentContext", () => {
  it("returns true when agent_id is a non-empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "agent-abc-123" }))).toBe(true);
  });

  it("returns false when agent_id is undefined (main agent / main-thread)", () => {
    expect(isSubagentContext(makeInput({ agent_id: undefined }))).toBe(false);
  });

  it("returns false when agent_id is empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "" }))).toBe(false);
  });

  it("returns false when agent_id is absent from the input object entirely", () => {
    const input = makeInput();
    delete (input as Partial<ToolHookInput>).agent_id;
    expect(isSubagentContext(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionIdFromInput
// ---------------------------------------------------------------------------

describe("resolveSessionIdFromInput", () => {
  it("prefers tool_input.sessionId when present", () => {
    const input = makeInput({ tool_input: { sessionId: SESSION_ID } });
    expect(resolveSessionIdFromInput(input)).toBe(SESSION_ID);
  });

  it("trims whitespace from tool_input.sessionId", () => {
    const input = makeInput({ tool_input: { sessionId: `  ${SESSION_ID}  ` } });
    expect(resolveSessionIdFromInput(input)).toBe(SESSION_ID);
  });

  it("ignores a non-string tool_input.sessionId and falls through to cwd resolution", () => {
    const input = makeInput({
      tool_input: { sessionId: 12345 },
      cwd: `/Users/edobry/.local/state/minsky/sessions/${SESSION_ID}`,
    });
    expect(resolveSessionIdFromInput(input)).toBe(SESSION_ID);
  });

  it("falls back to parsing cwd's .../sessions/<id> segment", () => {
    const input = makeInput({
      tool_input: {},
      cwd: `/Users/edobry/.local/state/minsky/sessions/${SESSION_ID}`,
    });
    expect(resolveSessionIdFromInput(input)).toBe(SESSION_ID);
  });

  it("falls back to cwd resolution for a subdirectory inside the session workspace", () => {
    const input = makeInput({
      tool_input: {},
      cwd: `/Users/edobry/.local/state/minsky/sessions/${SESSION_ID}/services/reviewer`,
    });
    expect(resolveSessionIdFromInput(input)).toBe(SESSION_ID);
  });

  it("returns null when neither tool_input.sessionId nor cwd resolve to a session path", () => {
    const input = makeInput({ tool_input: {}, cwd: "/Users/edobry/Projects/minsky" });
    expect(resolveSessionIdFromInput(input)).toBeNull();
  });

  it("returns null when cwd is empty", () => {
    const input = makeInput({ tool_input: {}, cwd: "" });
    expect(resolveSessionIdFromInput(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideDispatchIntentGate — the deny / allow / expired / wrong-session matrix
// ---------------------------------------------------------------------------

describe("decideDispatchIntentGate — acceptance matrix", () => {
  it("ALLOW: no declarations at all (regression: no declaration -> no denial)", () => {
    const decision = decideDispatchIntentGate(SESSION_ID, [], NOW);
    expect(decision.decision).toBe("allow");
  });

  it("DENY: a live read-only declaration covers the target session", () => {
    const declarations = [makeDeclaration()];
    const decision = decideDispatchIntentGate(SESSION_ID, declarations, NOW + 1000);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/read-only/);
  });

  it("ALLOW: declaration exists but is expired", () => {
    const declarations = [makeDeclaration({ ttlMs: 60_000 })];
    const later = NOW + 61_000; // past the 60s TTL
    const decision = decideDispatchIntentGate(SESSION_ID, declarations, later);
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: declaration exists for a different session (wrong session)", () => {
    const declarations = [makeDeclaration({ sessionId: "some-other-session" })];
    const decision = decideDispatchIntentGate(SESSION_ID, declarations, NOW);
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: declaration exists but its intent is 'implementation', not 'read-only'", () => {
    const declarations = [makeDeclaration({ intent: "implementation" })];
    const decision = decideDispatchIntentGate(SESSION_ID, declarations, NOW);
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: session id unresolvable (null), even with a declaration present for some session", () => {
    const declarations = [makeDeclaration()];
    const decision = decideDispatchIntentGate(null, declarations, NOW);
    expect(decision.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Agent-identity independence (mt#2865 core finding: session-scoped, not
// agent_id-scoped — a fork with a DIFFERENT agent_id than its parent is
// still covered as long as it operates against the declared session)
// ---------------------------------------------------------------------------

describe("agent-identity independence", () => {
  it("denies a call whose agent_id differs from whatever agent_id issued the declaration", () => {
    // The declaration schema carries no agentId field at all — matching is
    // purely session-scoped. A fork's own distinct agent_id is irrelevant.
    const declarations = [makeDeclaration({ issuedBy: "session.generate_prompt:mt#2828" })];
    const forkInput = makeInput({
      agent_id: "agent-fork-xyz-completely-different-from-parent",
      tool_name: SESSION_PR_EDIT_TOOL,
      tool_input: { sessionId: SESSION_ID },
    });
    const sessionId = resolveSessionIdFromInput(forkInput);
    const decision = decideDispatchIntentGate(sessionId, declarations, NOW + 1000);
    expect(decision.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// buildDenialMessage
// ---------------------------------------------------------------------------

describe("buildDenialMessage", () => {
  it("includes the resolved session id", () => {
    expect(buildDenialMessage(SESSION_ID, makeDeclaration())).toContain(SESSION_ID);
  });

  it("names the declared reason when present", () => {
    const message = buildDenialMessage(SESSION_ID, makeDeclaration({ reason: "custom reason" }));
    expect(message).toContain("custom reason");
  });

  it("names the sanctioned alternative (report back to the parent)", () => {
    expect(buildDenialMessage(SESSION_ID, makeDeclaration())).toMatch(/[Rr]eport your findings/);
  });

  it("handles a null (unresolvable) session id gracefully", () => {
    expect(buildDenialMessage(null, makeDeclaration())).toMatch(/this session/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance walk (mt#2865): the incident fork's session_pr_edit
// ---------------------------------------------------------------------------

describe("acceptance walk — the mt#2828 incident fork's session_pr_edit", () => {
  it("would have been denied had the orchestrator declared read-only intent before forking", () => {
    // Reconstructed from the mt#2865 spec's "Incident reconstruction" section:
    // the fork operated with cwd inside the shared session workspace
    // (6b71e8fb-0c8e-4543-8347-3c3ade427e71) and, per its own transcript,
    // called session_pr_edit to rewrite PR #1964's body with a false
    // test-count claim. Simulating: the orchestrator had called
    // session_generate_prompt(intent: "read-only") before dispatching the
    // fork, writing a declaration BEFORE the fork's first write attempt.
    const declarations = [
      makeDeclaration({
        reason: "search memory for reviewer-empty-findings context, report back under 300 words",
        issuedBy: "session.generate_prompt:mt#2828",
      }),
    ];
    const forkPrEditCall = makeInput({
      agent_id: "agent-aa133221d6c16d677", // the fork's own, distinct agent_id
      tool_name: SESSION_PR_EDIT_TOOL,
      tool_input: {},
      cwd: `/Users/edobry/.local/state/minsky/sessions/${SESSION_ID}`,
    });

    expect(GATED_TOOL_NAMES.has(forkPrEditCall.tool_name)).toBe(true);
    expect(isSubagentContext(forkPrEditCall)).toBe(true);

    const sessionId = resolveSessionIdFromInput(forkPrEditCall);
    expect(sessionId).toBe(SESSION_ID);

    // The fork's directive was issued ~00:24:15Z; a write attempt shortly
    // after (well inside the 30-minute TTL) is denied.
    const shortlyAfterDirective = NOW + 5 * 60 * 1000; // 5 minutes later
    const decision = decideDispatchIntentGate(sessionId, declarations, shortlyAfterDirective);
    expect(decision.decision).toBe("deny");
  });
});
