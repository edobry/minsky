/**
 * Decision tests for the nested-fork dispatch gate (mt#3045).
 *
 * Moved here from `.minsky/hooks/block-nested-fork-dispatch.test.ts` by mt#4374
 * (SC4). The acceptance matrix used to build a `ToolHookInput` for every case
 * and pass a fake `env` object as a fourth argument; both are gone. The
 * decision now takes the ANSWERS — is this a fork, is it nested, is the
 * override on — because establishing those is the binding's job (mt#4374 AT2).
 */
import { describe, expect, it } from "bun:test";
import type { DispatchIntentDeclaration } from "./dispatch-intent-gate";
import {
  DENY_REASON_PREFIX,
  OVERRIDE_ENV_VAR,
  buildNestedForkDenialMessage,
  decideNestedForkDispatchGate,
  type NestedForkDispatchGateInput,
} from "./nested-fork-dispatch-gate";

const NOW = Date.parse("2026-07-21T20:00:00.000Z");
const SESSION_ID = "9b470647-0c8e-4543-8347-3c3ade427e71";

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

/** A nested fork dispatch with no override and no declarations — the denied base case. */
function makeInput(
  overrides: Partial<NestedForkDispatchGateInput> = {}
): NestedForkDispatchGateInput {
  return {
    isForkDispatch: true,
    isSubagentContext: true,
    overrideActive: false,
    sessionId: SESSION_ID,
    declarations: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe("decideNestedForkDispatchGate — acceptance matrix", () => {
  it("ALLOW: not a fork dispatch (e.g. general-purpose) — unaffected regardless of nesting", () => {
    expect(decideNestedForkDispatchGate(makeInput({ isForkDispatch: false })).decision).toBe(
      "allow"
    );
  });

  it("ALLOW: top-level fork dispatch (not nested)", () => {
    expect(decideNestedForkDispatchGate(makeInput({ isSubagentContext: false })).decision).toBe(
      "allow"
    );
  });

  it("DENY: nested fork dispatch, no live declaration — the mem#665 reproduction", () => {
    // Reconstructed from memory bed551ef / mem#665: mt#3014's implementer
    // subagent dispatched a fork via the raw Agent tool for a bounded
    // read-only lookup, WITHOUT calling session.generate_prompt with
    // intent: "read-only" first. No declaration exists in the store.
    const decision = decideNestedForkDispatchGate(makeInput());
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(DENY_REASON_PREFIX);
  });

  it("ALLOW: nested fork dispatch WITH a live read-only declaration (the sanctioned path)", () => {
    const decision = decideNestedForkDispatchGate(
      makeInput({
        declarations: [makeDeclaration({ issuedBy: "session.generate_prompt:mt#3014" })],
        nowMs: NOW + 1000,
      })
    );
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: nested fork dispatch with an explicit implementation-intent declaration", () => {
    const decision = decideNestedForkDispatchGate(
      makeInput({
        declarations: [makeDeclaration({ intent: "implementation" })],
        nowMs: NOW + 1000,
      })
    );
    expect(decision.decision).toBe("allow");
  });

  it("ALLOW: the override is active", () => {
    const decision = decideNestedForkDispatchGate(makeInput({ overrideActive: true }));
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });

  it("DENY: an expired declaration does not unblock a nested fork dispatch", () => {
    const decision = decideNestedForkDispatchGate(
      makeInput({ declarations: [makeDeclaration({ ttlMs: 60_000 })], nowMs: NOW + 61_000 })
    );
    expect(decision.decision).toBe("deny");
  });

  it("DENY: a declaration for a DIFFERENT session does not unblock this session's dispatch", () => {
    const decision = decideNestedForkDispatchGate(
      makeInput({ declarations: [makeDeclaration({ sessionId: "unrelated-session-id" })] })
    );
    expect(decision.decision).toBe("deny");
  });

  it("DENY: an unresolvable session id cannot be covered by any declaration", () => {
    const decision = decideNestedForkDispatchGate(
      makeInput({ sessionId: null, declarations: [makeDeclaration()], nowMs: NOW + 1000 })
    );
    expect(decision.decision).toBe("deny");
  });

  it("the override short-circuits ahead of the declaration lookup", () => {
    // Ordering matters: an active override allows even when a lookup would
    // also have allowed, and the reason names the override rather than a
    // declaration — so the fire-log records why the call went through.
    const decision = decideNestedForkDispatchGate(
      makeInput({ overrideActive: true, declarations: [makeDeclaration()], nowMs: NOW + 1000 })
    );
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });
});

describe("buildNestedForkDenialMessage", () => {
  it("includes the resolved session id", () => {
    expect(buildNestedForkDenialMessage(SESSION_ID)).toContain(SESSION_ID);
  });

  it("names the sanctioned alternatives (Explore/general-purpose, or declare read-only intent first)", () => {
    const message = buildNestedForkDenialMessage(SESSION_ID);
    expect(message).toMatch(/Explore/);
    expect(message).toMatch(/general-purpose/);
    expect(message).toMatch(/read-only/);
  });

  it("handles a null (unresolvable) session id gracefully", () => {
    expect(buildNestedForkDenialMessage(null)).toContain("this session");
  });
});
