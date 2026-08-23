/**
 * BINDING-level tests for the dispatch-intent write gate.
 *
 * The DECISION tests — the allow/deny acceptance matrix, the declaration
 * matching, and the denial text — moved to
 * `packages/domain/src/detectors/dispatch-intent-gate.test.ts` with the
 * decision itself (mt#4374 SC4).
 *
 * What is left is what the binding owns: which tools are gated, whether the
 * caller is a subagent, and how a session id is resolved from the payload. The
 * last two blocks deliberately still call the decision — they walk payload →
 * decision end-to-end, which is the seam this module exists to be, and is
 * mt#4374 AT3's replay for this guard.
 */
import { describe, expect, it } from "bun:test";
import {
  isSubagentContext,
  resolveSessionIdFromInput,
  GATED_TOOL_NAMES,
  cloneSessionDirRegex,
} from "./dispatch-intent-write-gate";
import { decideDispatchIntentGate } from "@minsky/domain/detectors/dispatch-intent-gate";
import { SESSION_DIR_RE } from "./check-guessed-session-path";
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
// cloneSessionDirRegex (PR #2033 R1 BLOCKING #1 — regex-clone flag bug)
// ---------------------------------------------------------------------------

describe("cloneSessionDirRegex", () => {
  it("clones SESSION_DIR_RE with its exact flags, not a hardcoded subset", () => {
    const cloned = cloneSessionDirRegex();
    expect(cloned.flags).toBe(SESSION_DIR_RE.flags);
    expect(cloned.source).toBe(SESSION_DIR_RE.source);
  });

  it("global flag matters: repeated exec() on the SAME clone instance walks through DISTINCT matches", () => {
    // Demonstrates why deriving flags from the source constant (rather than
    // a hardcoded literal) is load-bearing: a properly `g`-flagged clone
    // advances `lastIndex` across exec() calls on the same instance,
    // finding the SECOND session path on the second call. A clone that
    // dropped the `g` flag would ignore `lastIndex` and return the FIRST
    // match again on every call — silently resolving the wrong session id
    // if this pattern were ever reused for multi-match scanning.
    const cwd = "/a/state/minsky/sessions/session-A/foo /b/state/minsky/sessions/session-B/bar";
    const clone = cloneSessionDirRegex();
    const first = clone.exec(cwd);
    const second = clone.exec(cwd);
    expect(first?.[2]).toBe("session-A");
    expect(second?.[2]).toBe("session-B");
  });

  it("negative control: a clone WITHOUT the global flag repeats the first match instead of walking forward", () => {
    const cwd = "/a/state/minsky/sessions/session-A/foo /b/state/minsky/sessions/session-B/bar";
    const nonGlobalClone = new RegExp(SESSION_DIR_RE.source); // no flags — the shape of the original bug
    const first = nonGlobalClone.exec(cwd);
    const second = nonGlobalClone.exec(cwd);
    expect(first?.[2]).toBe("session-A");
    expect(second?.[2]).toBe("session-A"); // repeats — proves the flag is load-bearing
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

// ---------------------------------------------------------------------------
// Agent-identity independence (mt#2865 core finding: session-scoped, not
// agent_id-scoped — a fork with a DIFFERENT agent_id than its parent is
// still covered as long as it operates against the declared session)
// ---------------------------------------------------------------------------

describe("agent-identity independence", () => {
  it("denies a call whose agent_id differs from whatever agent_id issued the declaration", () => {
    // The declaration schema carries no agentId field at all — matching is
    // purely session-scoped. A fork's own distinct agent_id is irrelevant.
    const declarations = [makeDeclaration({ issuedBy: "session.generate_prompt:mt#2865" })];
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
// Acceptance walk (mt#2865): the incident fork's session_pr_edit
// ---------------------------------------------------------------------------

describe("acceptance walk — the mt#2865 incident fork's session_pr_edit", () => {
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
        issuedBy: "session.generate_prompt:mt#2865",
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
