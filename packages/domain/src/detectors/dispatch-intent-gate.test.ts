/**
 * Decision tests for the dispatch-intent write gate (mt#2865).
 *
 * Moved here by mt#4374 (SC4) from two places, which is itself the finding:
 * the gate's acceptance matrix and denial text came from
 * `.minsky/hooks/dispatch-intent-write-gate.test.ts`, and the declaration
 * matching underneath it came from `.minsky/hooks/dispatch-intent-store.test.ts`
 * — the store's test file was where half this decision's coverage lived.
 *
 * No `ToolHookInput` is constructed anywhere in this file (mt#4374 AT2). The
 * binding's own tests, including the two that walk parse → decide end-to-end,
 * stayed with the hook.
 */
import { describe, expect, it } from "bun:test";
import {
  buildDispatchIntentDenialMessage,
  decideDispatchIntentGate,
  findLiveReadOnlyDeclaration,
  hasLiveDeclaration,
  isDeclarationValid,
  normalizeSessionId,
  type DispatchIntentDeclaration,
} from "./dispatch-intent-gate";

const NOW = Date.parse("2026-07-17T20:00:00.000Z");
const SESSION_ID = "6b71e8fb-0c8e-4543-8347-3c3ade427e71";
const OTHER_SESSION = "some-other-session";

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

describe("normalizeSessionId", () => {
  it("lowercases and trims", () => {
    expect(normalizeSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID.toLowerCase());
    expect(normalizeSessionId(`  ${SESSION_ID}  `)).toBe(SESSION_ID);
  });
});

describe("isDeclarationValid", () => {
  it("matches on exact sessionId, within TTL", () => {
    expect(isDeclarationValid(makeDeclaration(), { sessionId: SESSION_ID }, NOW + 1000)).toBe(true);
  });

  it("matches case-insensitively and ignoring whitespace in sessionId", () => {
    const declaration = makeDeclaration({ sessionId: SESSION_ID.toUpperCase() });
    expect(isDeclarationValid(declaration, { sessionId: `  ${SESSION_ID}  ` }, NOW + 1000)).toBe(
      true
    );
  });

  it("does not match a different sessionId", () => {
    expect(isDeclarationValid(makeDeclaration(), { sessionId: OTHER_SESSION }, NOW + 1000)).toBe(
      false
    );
  });

  it("does not match a null (unresolvable) sessionId", () => {
    expect(isDeclarationValid(makeDeclaration(), { sessionId: null }, NOW + 1000)).toBe(false);
  });

  it("expires exactly at issuedAt + ttlMs (boundary is expired, not valid)", () => {
    const declaration = makeDeclaration();
    const expiryMs = NOW + declaration.ttlMs;
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, expiryMs)).toBe(false);
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, expiryMs - 1)).toBe(true);
  });

  it("treats an unparseable issuedAt as invalid", () => {
    const declaration = makeDeclaration({ issuedAt: "not-a-date" });
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, NOW)).toBe(false);
  });
});

describe("findLiveReadOnlyDeclaration", () => {
  it("returns the first live read-only declaration matching the session", () => {
    const declarations = [
      makeDeclaration({ sessionId: "other-session" }),
      makeDeclaration({ reason: "the real match" }),
    ];
    const match = findLiveReadOnlyDeclaration(declarations, { sessionId: SESSION_ID }, NOW + 1000);
    expect(match?.reason).toBe("the real match");
  });

  it("does NOT match an 'implementation' declaration for the same session", () => {
    const declarations = [makeDeclaration({ intent: "implementation" })];
    expect(
      findLiveReadOnlyDeclaration(declarations, { sessionId: SESSION_ID }, NOW + 1000)
    ).toBeNull();
  });

  it("returns null when no declaration matches the session", () => {
    expect(
      findLiveReadOnlyDeclaration([makeDeclaration()], { sessionId: OTHER_SESSION }, NOW + 1000)
    ).toBeNull();
  });

  it("returns null when the only match is expired", () => {
    const declaration = makeDeclaration();
    expect(
      findLiveReadOnlyDeclaration(
        [declaration],
        { sessionId: SESSION_ID },
        NOW + declaration.ttlMs + 1
      )
    ).toBeNull();
  });
});

describe("hasLiveDeclaration — intent-agnostic (unlike findLiveReadOnlyDeclaration)", () => {
  it("true for a live read-only declaration", () => {
    expect(hasLiveDeclaration([makeDeclaration()], SESSION_ID, NOW + 1000)).toBe(true);
  });

  it("true for a live implementation declaration (intent-agnostic)", () => {
    expect(
      hasLiveDeclaration([makeDeclaration({ intent: "implementation" })], SESSION_ID, NOW + 1000)
    ).toBe(true);
  });

  it("false when the declaration is expired", () => {
    expect(hasLiveDeclaration([makeDeclaration({ ttlMs: 60_000 })], SESSION_ID, NOW + 61_000)).toBe(
      false
    );
  });

  it("false when the declaration is for a different session", () => {
    expect(
      hasLiveDeclaration([makeDeclaration({ sessionId: OTHER_SESSION })], SESSION_ID, NOW)
    ).toBe(false);
  });

  it("false when there are no declarations at all", () => {
    expect(hasLiveDeclaration([], SESSION_ID, NOW)).toBe(false);
  });

  it("false when sessionId is unresolvable (null)", () => {
    expect(hasLiveDeclaration([makeDeclaration()], null, NOW)).toBe(false);
  });
});

describe("decideDispatchIntentGate — acceptance matrix", () => {
  it("ALLOW: no declarations at all (regression: no declaration -> no denial)", () => {
    expect(decideDispatchIntentGate(SESSION_ID, [], NOW).decision).toBe("allow");
  });

  it("DENY: a live read-only declaration covers the target session", () => {
    const decision = decideDispatchIntentGate(SESSION_ID, [makeDeclaration()], NOW + 1000);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/read-only/);
  });

  it("ALLOW: declaration exists but is expired", () => {
    const declarations = [makeDeclaration({ ttlMs: 60_000 })];
    expect(decideDispatchIntentGate(SESSION_ID, declarations, NOW + 61_000).decision).toBe("allow");
  });

  it("ALLOW: declaration exists for a different session (wrong session)", () => {
    const declarations = [makeDeclaration({ sessionId: OTHER_SESSION })];
    expect(decideDispatchIntentGate(SESSION_ID, declarations, NOW).decision).toBe("allow");
  });

  it("ALLOW: declaration exists but its intent is 'implementation', not 'read-only'", () => {
    const declarations = [makeDeclaration({ intent: "implementation" })];
    expect(decideDispatchIntentGate(SESSION_ID, declarations, NOW).decision).toBe("allow");
  });

  it("ALLOW: session id unresolvable (null), even with a declaration present for some session", () => {
    expect(decideDispatchIntentGate(null, [makeDeclaration()], NOW).decision).toBe("allow");
  });

  it("DENY: matching is session-scoped, so the declaration carries no agent identity to match against", () => {
    // mt#2865's core finding: a fork with a DIFFERENT agent_id than its parent
    // is still covered, because the declaration schema has no agentId field at
    // all. Asserted here on the decision; the binding's own test walks the same
    // case through payload resolution.
    const declarations = [makeDeclaration({ issuedBy: "session.generate_prompt:mt#2865" })];
    expect(decideDispatchIntentGate(SESSION_ID, declarations, NOW + 1000).decision).toBe("deny");
  });
});

describe("buildDispatchIntentDenialMessage", () => {
  it("includes the resolved session id", () => {
    expect(buildDispatchIntentDenialMessage(SESSION_ID, makeDeclaration())).toContain(SESSION_ID);
  });

  it("names the declared reason when present", () => {
    const message = buildDispatchIntentDenialMessage(
      SESSION_ID,
      makeDeclaration({ reason: "custom reason" })
    );
    expect(message).toContain("custom reason");
  });

  it("names the sanctioned alternative (report back to the parent)", () => {
    expect(buildDispatchIntentDenialMessage(SESSION_ID, makeDeclaration())).toMatch(
      /[Rr]eport your findings/
    );
  });

  it("handles a null (unresolvable) session id gracefully", () => {
    expect(buildDispatchIntentDenialMessage(null, makeDeclaration())).toMatch(/this session/);
  });
});
