// Tests for .minsky/hooks/guard-health-escalation-detector.ts — mt#2812.

import { describe, test, expect } from "bun:test";
import { buildCriticalWarning, run } from "./guard-health-escalation-detector";
import type { GuardHealthSummary } from "./guard-health";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

function stubContext(): DispatchContext {
  return {
    event: "UserPromptSubmit",
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: [],
    transcriptLines: [],
  };
}

function baseInput(): ClaudeHookInput {
  return {
    session_id: "sess-1",
    cwd: "/repo",
    hook_event_name: "UserPromptSubmit",
  };
}

function emptySummary(): GuardHealthSummary {
  return { byGuard: {}, criticalGuards: [], attentionGuards: [], escalation: "none" };
}

describe("buildCriticalWarning", () => {
  test("returns null when escalation is none", () => {
    expect(buildCriticalWarning(emptySummary())).toBeNull();
  });

  test("returns null when escalation is attention (not yet critical)", () => {
    const summary: GuardHealthSummary = {
      byGuard: {
        "some-guard": {
          failureCount24h: 2,
          failureCount7d: 2,
          consecutiveStreak: 2,
          lastEvent: null,
          escalation: "attention",
        },
      },
      criticalGuards: [],
      attentionGuards: ["some-guard"],
      escalation: "attention",
    };
    expect(buildCriticalWarning(summary)).toBeNull();
  });

  test("names every critical guard with its streak count and last error message", () => {
    const guardName = "require-deploy-verification-before-merge";
    const summary: GuardHealthSummary = {
      byGuard: {
        [guardName]: {
          failureCount24h: 18,
          failureCount7d: 18,
          consecutiveStreak: 18,
          lastEvent: {
            timestamp: "2026-07-14T10:00:00.000Z",
            guardName,
            event: "PreToolUse",
            kind: "error",
            errorClass: "TypeError",
            message: "Cannot read properties of undefined (reading 'deployConfig')",
          },
          escalation: "critical",
        },
      },
      criticalGuards: [guardName],
      attentionGuards: [],
      escalation: "critical",
    };
    const warning = buildCriticalWarning(summary);
    expect(warning).not.toBeNull();
    expect(warning).toContain("CRITICAL");
    expect(warning).toContain(guardName);
    expect(warning).toContain("18 consecutive failures");
    expect(warning).toContain("Cannot read properties of undefined (reading 'deployConfig')");
  });

  test("names multiple critical guards on separate lines", () => {
    const summary: GuardHealthSummary = {
      byGuard: {
        "guard-a": {
          failureCount24h: 3,
          failureCount7d: 3,
          consecutiveStreak: 3,
          lastEvent: null,
          escalation: "critical",
        },
        "guard-b": {
          failureCount24h: 4,
          failureCount7d: 4,
          consecutiveStreak: 4,
          lastEvent: null,
          escalation: "critical",
        },
      },
      criticalGuards: ["guard-a", "guard-b"],
      attentionGuards: [],
      escalation: "critical",
    };
    const warning = buildCriticalWarning(summary) as string;
    expect(warning).toContain("guard-a");
    expect(warning).toContain("guard-b");
  });
});

describe("run (guard-dispatcher entry point)", () => {
  test("returns null when the real guard-health log has no critical guards (fail-safe empty-log path)", () => {
    // Points MINSKY_STATE_DIR at a nonexistent path so getGuardHealthSummary
    // reads no real log — exercises the true default wiring end-to-end.
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = "/nonexistent/mt2812-escalation-detector-test";
    try {
      const outcome = run(baseInput(), stubContext());
      expect(outcome).toBeNull();
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }
  });
});
