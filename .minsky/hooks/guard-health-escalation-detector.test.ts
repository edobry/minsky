// Tests for .minsky/hooks/guard-health-escalation-detector.ts — mt#2812.

/* eslint-disable custom/no-real-fs-in-tests -- the "returns null when the
   real guard-health log has no critical guards" test below exercises the
   real (unmocked) getGuardHealthSummary read path against a real, empty
   mkdtemp scratch directory (mt#2875 fix), replacing the prior reliance on
   an assumed-unwritable literal path ("/nonexistent/..."). */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Shared fixture for the mt#3072 tests below — the standalone-duplicate-
// matcher incident shape (guardName + message extracted once to avoid
// custom/no-magic-string-duplication noise across several fixtures in this
// file that all reproduce the same incident).
const SUSTAINED_INCIDENT_GUARD_NAME = "standalone-duplicate-matcher";
const SUSTAINED_INCIDENT_MESSAGE =
  "in-process tasks search failed — probe SKIPPED for this create: ECONNREFUSED";

/** A real guard-health log with a 3-consecutive-check-skip critical streak. */
function writeSustainedCriticalLog(scratchDir: string): void {
  const now = Date.now();
  const lines = [0, 1, 2]
    .map((i) =>
      JSON.stringify({
        timestamp: new Date(now - (2 - i) * 60_000).toISOString(),
        guardName: SUSTAINED_INCIDENT_GUARD_NAME,
        event: "PreToolUse",
        kind: "check-skip",
        message: SUSTAINED_INCIDENT_MESSAGE,
        causeClass: "infra",
      })
    )
    .join("\n");
  writeFileSync(join(scratchDir, "guard-health-log.jsonl"), `${lines}\n`);
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

  test("appends the causeClass tag when the last event carries one (mt#3072 SC2)", () => {
    const guardName = SUSTAINED_INCIDENT_GUARD_NAME;
    const infraSummary: GuardHealthSummary = {
      byGuard: {
        [guardName]: {
          failureCount24h: 14,
          failureCount7d: 14,
          consecutiveStreak: 14,
          lastEvent: {
            timestamp: "2026-07-21T07:36:39.722Z",
            guardName,
            event: "PreToolUse",
            kind: "check-skip",
            message: "in-process tasks search failed — probe SKIPPED for this create: ECONNREFUSED",
            causeClass: "infra",
          },
          escalation: "critical",
        },
      },
      criticalGuards: [guardName],
      attentionGuards: [],
      escalation: "critical",
    };
    expect(buildCriticalWarning(infraSummary)).toContain("[infra]");

    const logicSummary: GuardHealthSummary = {
      byGuard: {
        [guardName]: {
          failureCount24h: 14,
          failureCount7d: 14,
          consecutiveStreak: 14,
          lastEvent: {
            timestamp: "2026-07-21T07:36:39.722Z",
            guardName,
            event: "PreToolUse",
            kind: "check-skip",
            message: "probe rejected: Cannot read properties of undefined (reading 'id')",
            causeClass: "logic",
          },
          escalation: "critical",
        },
      },
      criticalGuards: [guardName],
      attentionGuards: [],
      escalation: "critical",
    };
    expect(buildCriticalWarning(logicSummary)).toContain("[logic]");
  });

  test("omits the causeClass tag when the last event has none (older/unclassified events)", () => {
    const guardName = "some-other-guard";
    const summary: GuardHealthSummary = {
      byGuard: {
        [guardName]: {
          failureCount24h: 3,
          failureCount7d: 3,
          consecutiveStreak: 3,
          lastEvent: {
            timestamp: "2026-07-21T07:36:39.722Z",
            guardName,
            event: "PreToolUse",
            kind: "error",
            message: "boom",
          },
          escalation: "critical",
        },
      },
      criticalGuards: [guardName],
      attentionGuards: [],
      escalation: "critical",
    };
    const warning = buildCriticalWarning(summary) as string;
    expect(warning).not.toContain("[infra]");
    expect(warning).not.toContain("[logic]");
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

  test("de-alarms a stale-only critical escalation (mt#2969)", () => {
    const guardName = SUSTAINED_INCIDENT_GUARD_NAME;
    const summary: GuardHealthSummary = {
      byGuard: {
        [guardName]: {
          failureCount24h: 1,
          failureCount7d: 9,
          consecutiveStreak: 9,
          lastEvent: {
            timestamp: "2026-07-20T01:51:00.000Z",
            guardName,
            event: "PreToolUse",
            kind: "check-skip",
            message: "tasks_search failed",
          },
          escalation: "critical",
          lastFailureAgeMs: 19 * 60 * 60 * 1000,
          stale: true,
        },
      },
      criticalGuards: [guardName],
      attentionGuards: [],
      escalation: "critical",
    };
    const warning = buildCriticalWarning(summary) as string;
    expect(warning).not.toBeNull();
    expect(warning).toContain("likely stale");
    expect(warning).toContain(guardName);
    expect(warning).toContain("19h");
    // De-alarmed: the active-incident "cannot currently be trusted" framing must NOT appear.
    expect(warning).not.toContain("cannot currently be trusted");
  });

  test("keeps active CRITICAL framing for a live critical guard while listing a stale sibling separately (mt#2969)", () => {
    const summary: GuardHealthSummary = {
      byGuard: {
        "live-guard": {
          failureCount24h: 5,
          failureCount7d: 5,
          consecutiveStreak: 5,
          lastEvent: {
            timestamp: "2026-07-20T20:00:00.000Z",
            guardName: "live-guard",
            event: "PreToolUse",
            kind: "error",
            message: "boom",
          },
          escalation: "critical",
          lastFailureAgeMs: 3 * 60 * 1000,
          stale: false,
        },
        "stale-guard": {
          failureCount24h: 3,
          failureCount7d: 3,
          consecutiveStreak: 3,
          lastEvent: {
            timestamp: "2026-07-20T01:00:00.000Z",
            guardName: "stale-guard",
            event: "PreToolUse",
            kind: "check-skip",
            message: "quiet",
          },
          escalation: "critical",
          lastFailureAgeMs: 19 * 60 * 60 * 1000,
          stale: true,
        },
      },
      criticalGuards: ["live-guard", "stale-guard"],
      attentionGuards: [],
      escalation: "critical",
    };
    const warning = buildCriticalWarning(summary) as string;
    expect(warning).toContain("cannot currently be trusted");
    expect(warning).toContain("live-guard");
    expect(warning).toContain("5 consecutive failures");
    expect(warning).toContain("likely stale");
    expect(warning).toContain("stale-guard");
  });
});

describe("run (guard-dispatcher entry point)", () => {
  test("returns null when the real guard-health log has no critical guards (fail-safe empty-log path)", () => {
    // Points MINSKY_STATE_DIR at a real, empty mkdtemp scratch directory
    // (mt#2875 fix) so getGuardHealthSummary reads no real log — exercises
    // the true default wiring end-to-end without relying on an assumed-
    // unwritable literal path ("/nonexistent/..."). This test only reads
    // (run() -> getGuardHealthSummary() never writes), but a genuinely
    // empty scratch dir is a stronger and more portable "no log" fixture
    // than a hardcoded absolute path whose non-existence/unwritability is
    // an environment assumption rather than a guarantee — see mt#2875,
    // which migrated every guard-health test off that assumption.
    const scratchDir = mkdtempSync(join(tmpdir(), "mt2875-escalation-detector-test-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      const outcome = run(baseInput(), stubContext());
      expect(outcome).toBeNull();
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("mt#3072 SC3: a sustained critical streak surfaces once per session, not on every turn", () => {
    // Reproduces the incident shape: a real guard-health log with a
    // standalone-duplicate-matcher check-skip streak (3+ consecutive ->
    // critical), then `run()` called repeatedly for the SAME session — as
    // the escalation detector fires on every UserPromptSubmit turn. Without
    // the mt#3072 cooldown, every one of these calls would surface
    // (the 385/697-turn incident); with it, only the first should.
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3072-escalation-cooldown-test-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      writeSustainedCriticalLog(scratchDir);

      const input: ClaudeHookInput = { ...baseInput(), session_id: "mt3072-sustained-session" };
      const ctx = stubContext();

      const first = run(input, ctx);
      expect(first).not.toBeNull();
      expect(first?.additionalContext).toContain(SUSTAINED_INCIDENT_GUARD_NAME);

      // Simulate several more turns in the SAME session, same log state
      // (nothing new failed) — every one of these must be suppressed.
      let surfacedAfterFirst = 0;
      for (let i = 0; i < 10; i++) {
        if (run(input, ctx) !== null) surfacedAfterFirst++;
      }
      expect(surfacedAfterFirst).toBe(0);
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("mt#3072 SC3: a DIFFERENT session still sees the same critical streak at least once", () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3072-escalation-cooldown-newsession-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      writeSustainedCriticalLog(scratchDir);
      const ctx = stubContext();

      const sessionA: ClaudeHookInput = { ...baseInput(), session_id: "mt3072-session-a" };
      expect(run(sessionA, ctx)).not.toBeNull();
      expect(run(sessionA, ctx)).toBeNull(); // A's cooldown is now running

      const sessionB: ClaudeHookInput = { ...baseInput(), session_id: "mt3072-session-b" };
      expect(run(sessionB, ctx)).not.toBeNull(); // B has never seen it
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
