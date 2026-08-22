/**
 * BINDING-level tests for the nested-fork dispatch guard.
 *
 * The DECISION tests — the allow/deny acceptance matrix, the declaration
 * lookup, and the denial text — moved to
 * `packages/domain/src/detectors/nested-fork-dispatch-gate.test.ts` with the
 * decision itself (mt#4374 SC4).
 *
 * What is left is what the binding owns: reading `subagent_type` out of the
 * payload, and reading the override out of the environment. The last block
 * walks payload → decision end-to-end, which is mt#4374 AT3's replay for this
 * guard: the mem#665 fixture that DENIED before the extraction still denies,
 * and the sanctioned-path fixture that allowed still allows.
 */
import { describe, expect, it } from "bun:test";
import {
  GATED_SUBAGENT_TYPE,
  OVERRIDE_ENV_VAR,
  isForkDispatch,
  isOverrideActive,
  decideFromPayload,
} from "./block-nested-fork-dispatch";
import { DENY_REASON_PREFIX } from "@minsky/domain/detectors/nested-fork-dispatch-gate";
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
// isForkDispatch — payload parsing
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
// isOverrideActive — environment read
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
// decideFromPayload — the parse → decide walk
// ---------------------------------------------------------------------------

describe("decideFromPayload — payload and environment reach the decision", () => {
  it("DENY: nested fork dispatch, no live declaration — the mem#665 reproduction", () => {
    // Reconstructed from memory bed551ef / mem#665: mt#3014's implementer
    // subagent (agent_id set) dispatched a fork via the raw Agent tool for a
    // bounded read-only lookup, WITHOUT calling session.generate_prompt with
    // intent: "read-only" first. No declaration exists in the store.
    const decision = decideFromPayload(makeInput({ agent_id: IMPLEMENTER_AGENT_ID }), [], NOW, {});
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(DENY_REASON_PREFIX);
  });

  it("ALLOW: nested fork dispatch WITH a live read-only declaration (the sanctioned path)", () => {
    const declarations = [makeDeclaration({ issuedBy: "session.generate_prompt:mt#3014" })];
    const decision = decideFromPayload(
      makeInput({ agent_id: IMPLEMENTER_AGENT_ID }),
      declarations,
      NOW + 1000,
      {}
    );
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: a non-fork subagent_type in the payload reaches the decision as isForkDispatch=false", () => {
    const decision = decideFromPayload(
      makeInput({
        agent_id: IMPLEMENTER_AGENT_ID,
        tool_input: { subagent_type: "general-purpose" },
      }),
      [],
      NOW,
      {}
    );
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: an absent agent_id reaches the decision as isSubagentContext=false (top-level)", () => {
    const decision = decideFromPayload(makeInput({ agent_id: undefined }), [], NOW, {});
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: the override env var reaches the decision", () => {
    const decision = decideFromPayload(makeInput({ agent_id: IMPLEMENTER_AGENT_ID }), [], NOW, {
      [OVERRIDE_ENV_VAR]: "1",
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });

  it("resolves the session id from cwd, so a declaration for that session matches", () => {
    // The binding's only non-trivial parse: a subagent's cwd IS the session
    // directory. If that resolution broke, the declaration below would not
    // match and this would deny.
    const decision = decideFromPayload(
      makeInput({ agent_id: IMPLEMENTER_AGENT_ID, tool_input: { subagent_type: "fork" } }),
      [makeDeclaration()],
      NOW + 1000,
      {}
    );
    expect(decision.decision).toBe("allow");
  });
});
