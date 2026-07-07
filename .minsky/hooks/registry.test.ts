import { describe, test, expect } from "bun:test";
import {
  getGuardsForEvent,
  findDuplicateRegistrations,
  GUARD_REGISTRY,
  type GuardRegistration,
  type LifecycleEvent,
} from "./registry";

/** Representative non-tool-scoped event, used across the matcher-less-registration tests. */
const NON_TOOL_EVENT: LifecycleEvent = "UserPromptSubmit";

function makeReg(overrides: Partial<GuardRegistration> = {}): GuardRegistration {
  return {
    name: "test-guard",
    event: "PreToolUse",
    module: () => Promise.resolve({ run: () => null }),
    timeoutMs: 5000,
    denyCapable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getGuardsForEvent
// ---------------------------------------------------------------------------

describe("getGuardsForEvent", () => {
  test("matches by event and matcher regex", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash|mcp__minsky__session_exec" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|Write" }),
    ];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash").map((r) => r.name)).toEqual(["a"]);
    expect(getGuardsForEvent(regs, "PreToolUse", "Edit").map((r) => r.name)).toEqual(["b"]);
    expect(getGuardsForEvent(regs, "PreToolUse", "Read")).toEqual([]);
  });

  test("registration with no matcher always matches once event matches (no toolName needed)", () => {
    const regs = [makeReg({ name: "always", event: NON_TOOL_EVENT, matcher: undefined })];
    expect(getGuardsForEvent(regs, NON_TOOL_EVENT).map((r) => r.name)).toEqual(["always"]);
  });

  test("registration WITH a matcher but no toolName supplied does not match", () => {
    const regs = [makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" })];
    expect(getGuardsForEvent(regs, "PreToolUse")).toEqual([]);
  });

  test("non-matching event is excluded", () => {
    const regs = [makeReg({ name: "a", event: "PostToolUse", matcher: "Bash" })];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash")).toEqual([]);
  });

  test("malformed matcher regex is treated as non-matching, not a crash", () => {
    const regs = [makeReg({ name: "a", event: "PreToolUse", matcher: "(unterminated" })];
    expect(() => getGuardsForEvent(regs, "PreToolUse", "Bash")).not.toThrow();
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash")).toEqual([]);
  });

  test("multiple guards match the same event+tool independently", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Bash|Edit" }),
    ];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash").map((r) => r.name)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateRegistrations
// ---------------------------------------------------------------------------

describe("findDuplicateRegistrations", () => {
  test("two guards, same event, overlapping matcher token -> flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Edit|Write|NotebookEdit" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|mcp__minsky__session_edit_file" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.a).toBe("a");
    expect(dupes[0]?.b).toBe("b");
    expect(dupes[0]?.sharedTokens).toContain("Edit");
  });

  test("two guards, same event, disjoint matcher tokens -> not flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|Write" }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("two guards, different events, same matcher -> not flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PostToolUse", matcher: "Bash" }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("two matcher-less registrations at the same event are NOT flagged (Phase 2a, mt#2652)", () => {
    // Matcher-less-at-the-same-event is the NORMAL shape for non-tool-scoped
    // events (UserPromptSubmit et al.) with multiple independent guards —
    // e.g. the six UserPromptSubmit guidance detectors migrated in Phase 2a.
    // Flagging every such pair would make the check impossible to satisfy.
    const regs = [
      makeReg({ name: "a", event: NON_TOOL_EVENT, matcher: undefined }),
      makeReg({ name: "b", event: NON_TOOL_EVENT, matcher: undefined }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("a matcher-less registration still overlaps a registration WITH a matcher", () => {
    // The genuine-overlap-risk case remains flagged: a matcher-less guard
    // fires on every tool, including whatever the matchered guard names.
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: undefined }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Bash" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.sharedTokens).toContain("<matches everything>");
  });

  test("current GUARD_REGISTRY has no duplicate registrations (regression guard)", () => {
    expect(findDuplicateRegistrations(GUARD_REGISTRY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GUARD_REGISTRY sanity
// ---------------------------------------------------------------------------

describe("GUARD_REGISTRY", () => {
  test("pilot guard (check-guessed-session-path) is registered on PreToolUse", () => {
    const pilot = GUARD_REGISTRY.find((r) => r.name === "check-guessed-session-path");
    expect(pilot).toBeDefined();
    expect(pilot?.event).toBe("PreToolUse");
    expect(pilot?.denyCapable).toBe(true);
  });

  test("every registration's module() resolves to an object with a run function", async () => {
    for (const reg of GUARD_REGISTRY) {
      const mod = await reg.module();
      expect(typeof mod.run).toBe("function");
    }
  });

  test("Phase 2a UserPromptSubmit family (mt#2652) is registered, no duplicates, correct calibration wiring", () => {
    const expectedCalibrationLogs: Record<string, string | undefined> = {
      "substrate-bypass-detector": undefined,
      "retrospective-trigger-scanner": "retrospective-trigger",
      "pre-narration-detector": "pre-narration",
      "causal-premise-detector": "causal-premise",
      "code-mechanism-assertion-detector": "code-mechanism-assertion",
      "ask-routing-deferral-detector": "ask-routing-deferral",
    };
    for (const [name, calibrationLog] of Object.entries(expectedCalibrationLogs)) {
      const reg = GUARD_REGISTRY.find((r) => r.name === name);
      expect(reg).toBeDefined();
      expect(reg?.event).toBe("UserPromptSubmit");
      expect(reg?.matcher).toBeUndefined();
      expect(reg?.denyCapable).toBe(false);
      expect(reg?.needsTranscript).toBe(true);
      expect(reg?.calibrationLog).toBe(calibrationLog);
    }
    // policy-coverage-detector is NOT part of this family — it is registered
    // on PreToolUse in .claude/settings.json (ground truth), not
    // UserPromptSubmit. See the mt#2652 spec's recorded discrepancy.
    expect(GUARD_REGISTRY.find((r) => r.name === "policy-coverage-detector")).toBeUndefined();
  });
});
