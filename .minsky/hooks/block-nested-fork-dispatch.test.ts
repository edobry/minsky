import { describe, expect, it } from "bun:test";
import {
  GATED_SUBAGENT_TYPE,
  OVERRIDE_ENV_VAR,
  isForkDispatch,
  isOverrideActive,
  hasLiveDeclaration,
  buildDenialMessage,
  decideNestedForkDispatchGate,
  DENY_REASON_PREFIX,
} from "./block-nested-fork-dispatch";
import type { DispatchIntentDeclaration } from "./dispatch-intent-store";
import type { ToolHookInput } from "./types";

const NOW = Date.parse("2026-07-21T20:00:00.000Z");
const SESSION_ID = "9b470647-0c8e-4543-8347-3c3ade427e71";
/** Shared fixture agent_id — satisfies custom/no-magic-string-duplication. */
const IMPLEMENTER_AGENT_ID = "agent-implementer-mt3014";

function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: `/Users/edobry/.local/state/minsky/sessions/${SESSION_ID}`,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: GATED_SUBAGENT_TYPE, prompt: "check if this test flake is known" },
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
    reason: "check if session.test.ts flake is known",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isForkDispatch
// ---------------------------------------------------------------------------

describe("isForkDispatch", () => {
  it("returns true when tool_input.subagent_type is 'fork'", () => {
    expect(isForkDispatch(makeInput())).toBe(true);
  });

  it("returns false for a non-fork subagent_type (e.g. general-purpose)", () => {
    expect(isForkDispatch(makeInput({ tool_input: { subagent_type: "general-purpose" } }))).toBe(
      false
    );
  });

  it("returns false when subagent_type is absent", () => {
    expect(isForkDispatch(makeInput({ tool_input: { prompt: "x" } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isOverrideActive
// ---------------------------------------------------------------------------

describe("isOverrideActive", () => {
  it("returns true only when the override env var is exactly '1'", () => {
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "1" })).toBe(true);
  });

  it("returns false when unset", () => {
    expect(isOverrideActive({})).toBe(false);
  });

  it("returns false for a truthy-looking but non-'1' value (strict match, no 'true'/'yes')", () => {
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "true" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasLiveDeclaration — intent-agnostic (unlike the sibling write gate)
// ---------------------------------------------------------------------------

describe("hasLiveDeclaration", () => {
  it("true for a live read-only declaration", () => {
    expect(hasLiveDeclaration([makeDeclaration()], SESSION_ID, NOW + 1000)).toBe(true);
  });

  it("true for a live implementation declaration (intent-agnostic)", () => {
    expect(
      hasLiveDeclaration([makeDeclaration({ intent: "implementation" })], SESSION_ID, NOW + 1000)
    ).toBe(true);
  });

  it("false when the declaration is expired", () => {
    const declarations = [makeDeclaration({ ttlMs: 60_000 })];
    expect(hasLiveDeclaration(declarations, SESSION_ID, NOW + 61_000)).toBe(false);
  });

  it("false when the declaration is for a different session", () => {
    const declarations = [makeDeclaration({ sessionId: "some-other-session" })];
    expect(hasLiveDeclaration(declarations, SESSION_ID, NOW)).toBe(false);
  });

  it("false when there are no declarations at all", () => {
    expect(hasLiveDeclaration([], SESSION_ID, NOW)).toBe(false);
  });

  it("false when sessionId is unresolvable (null)", () => {
    expect(hasLiveDeclaration([makeDeclaration()], null, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideNestedForkDispatchGate — the full acceptance matrix
// ---------------------------------------------------------------------------

describe("decideNestedForkDispatchGate — acceptance matrix", () => {
  it("ALLOW: not a fork dispatch (e.g. general-purpose) — unaffected regardless of nesting", () => {
    const input = makeInput({
      agent_id: "agent-implementer-abc",
      tool_input: { subagent_type: "general-purpose" },
    });
    const decision = decideNestedForkDispatchGate(input, [], NOW, {});
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: top-level fork dispatch (agent_id absent — not nested)", () => {
    const input = makeInput({ agent_id: undefined });
    const decision = decideNestedForkDispatchGate(input, [], NOW, {});
    expect(decision.decision).toBe("allow");
  });

  it("DENY: nested fork dispatch, no live declaration — the mem#665 reproduction", () => {
    // Reconstructed from memory bed551ef / mem#665: mt#3014's implementer
    // subagent (agent_id set) dispatched a fork via the raw Agent tool for a
    // bounded read-only lookup, WITHOUT calling session.generate_prompt with
    // intent: "read-only" first. No declaration exists in the store.
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const decision = decideNestedForkDispatchGate(input, [], NOW, {});
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(DENY_REASON_PREFIX);
  });

  it("ALLOW: nested fork dispatch WITH a live read-only declaration (the sanctioned path)", () => {
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const declarations = [makeDeclaration({ issuedBy: "session.generate_prompt:mt#3014" })];
    const decision = decideNestedForkDispatchGate(input, declarations, NOW + 1000, {});
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: nested fork dispatch with an explicit implementation-intent declaration (non-read-only override)", () => {
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const declarations = [makeDeclaration({ intent: "implementation" })];
    const decision = decideNestedForkDispatchGate(input, declarations, NOW + 1000, {});
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: nested fork dispatch with the MINSKY_ALLOW_NESTED_FORK override active", () => {
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const decision = decideNestedForkDispatchGate(input, [], NOW, {
      [OVERRIDE_ENV_VAR]: "1",
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });

  it("DENY: an expired declaration does not unblock a nested fork dispatch", () => {
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const declarations = [makeDeclaration({ ttlMs: 60_000 })];
    const decision = decideNestedForkDispatchGate(input, declarations, NOW + 61_000, {});
    expect(decision.decision).toBe("deny");
  });

  it("DENY: a declaration for a DIFFERENT session does not unblock this session's nested fork dispatch", () => {
    const input = makeInput({ agent_id: IMPLEMENTER_AGENT_ID });
    const declarations = [makeDeclaration({ sessionId: "unrelated-session-id" })];
    const decision = decideNestedForkDispatchGate(input, declarations, NOW, {});
    expect(decision.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// buildDenialMessage
// ---------------------------------------------------------------------------

describe("buildDenialMessage", () => {
  it("includes the resolved session id", () => {
    expect(buildDenialMessage(SESSION_ID)).toContain(SESSION_ID);
  });

  it("names the sanctioned alternatives (Explore/general-purpose, or declare read-only intent first)", () => {
    const message = buildDenialMessage(SESSION_ID);
    expect(message).toMatch(/Explore/);
    expect(message).toMatch(/general-purpose/);
    expect(message).toMatch(/read-only/);
  });

  it("handles a null (unresolvable) session id gracefully", () => {
    expect(buildDenialMessage(null)).toContain("this session");
  });
});
