// Full-path integration test — mt#2812 acceptance tests, exercised literally:
//
//   "Fault-inject a throwing guard in a synthetic registry -> record written
//   + aggregate reflects it + escalation after N consecutive"
//
//   "The deploy-surface crash payload from Jul 14 replayed 3x -> tracker
//   escalates; UserPromptSubmit line appears on next turn"
//
// Unlike dispatcher.test.ts's "recordGuardErrorFn" tests (which inject a
// spy in place of the real recording function to assert call arguments) and
// guard-health.test.ts's unit tests (which exercise computeGuardHealthSummary
// directly), THIS test uses the REAL default wiring end-to-end: the real
// dispatcher catch block, the real recordGuardError (writing to a real temp
// JSONL file), and the real getGuardHealthSummary/computeGuardHealthSummary
// read path — then verifies the guard-health-escalation-detector guard's
// buildCriticalWarning() actually surfaces the warning from that same file.
//
// @see mt#2812 — this task

/* eslint-disable custom/no-real-fs-in-tests -- this test exercises the real
   on-disk JSONL round-trip through the real dispatcher + guard-health
   default wiring; a temp file is the fixture under test, not a mock target */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatcher } from "./dispatcher";
import type { GuardRegistration } from "./registry";
import { getGuardHealthSummary } from "./guard-health";
import { buildCriticalWarning } from "./guard-health-escalation-detector";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mt2812-guard-health-integration-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function stubContext() {
  return {
    event: "PreToolUse" as const,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: [],
    transcriptLines: [],
  };
}

/** The Jul 14 deploy-surface crash payload's error shape, replayed by this test. */
function deploySurfaceCrashError(): Error {
  return new TypeError("Cannot read properties of undefined (reading 'deployConfig')");
}

const DEPLOY_VERIFICATION_GUARD_NAME = "require-deploy-verification-before-merge";
const DISPATCH_PRETOOLUSE_HOOK_FILENAME = "dispatch-pretooluse.ts";

describe("guard-health end-to-end: real dispatcher -> real recording -> real aggregation", () => {
  test("fault-inject a throwing guard 3x via the real dispatcher -> log written, aggregate reflects it, escalation critical after 3 consecutive", async () => {
    const stateDir = makeTmpDir();
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = stateDir;
    try {
      const throwingGuardRegistrations: GuardRegistration[] = [
        {
          name: DEPLOY_VERIFICATION_GUARD_NAME,
          event: "PreToolUse",
          matcher: "session_pr_merge",
          module: () =>
            Promise.resolve({
              run: () => {
                throw deploySurfaceCrashError();
              },
            }),
          timeoutMs: 5000,
          denyCapable: true,
        },
      ];

      // Replay the crash 3 times — one dispatcher invocation per "fire",
      // matching how each real session_pr_merge attempt would independently
      // spawn the dispatcher process.
      for (let i = 0; i < 3; i++) {
        await runDispatcher("PreToolUse", {
          hookFilename: DISPATCH_PRETOOLUSE_HOOK_FILENAME,
          registrations: throwingGuardRegistrations,
          readInputFn: () =>
            Promise.resolve({
              session_id: "sess-integration",
              cwd: "/repo",
              hook_event_name: "PreToolUse",
              tool_name: "session_pr_merge",
              tool_input: {},
            }),
          writeOutputFn: () => {},
          stderrWrite: () => {},
          resolveDispatchContextFn: () => stubContext(),
        });
      }

      const summary = getGuardHealthSummary();
      expect(summary.byGuard[DEPLOY_VERIFICATION_GUARD_NAME]?.consecutiveStreak).toBe(3);
      expect(summary.escalation).toBe("critical");
      expect(summary.criticalGuards).toEqual([DEPLOY_VERIFICATION_GUARD_NAME]);

      // The UserPromptSubmit guard reads the SAME log and surfaces the warning.
      const warning = buildCriticalWarning(summary);
      expect(warning).not.toBeNull();
      expect(warning).toContain(DEPLOY_VERIFICATION_GUARD_NAME);
      expect(warning).toContain("3 consecutive failures");
      expect(warning).toContain("Cannot read properties of undefined (reading 'deployConfig')");
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }
  });

  test("1-2 fires do not yet escalate to critical (below the 3-consecutive threshold)", async () => {
    const stateDir = makeTmpDir();
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = stateDir;
    try {
      const throwingGuardRegistrations: GuardRegistration[] = [
        {
          name: "some-other-guard",
          event: "PreToolUse",
          matcher: "Bash",
          module: () =>
            Promise.resolve({
              run: () => {
                throw new Error("transient");
              },
            }),
          timeoutMs: 5000,
          denyCapable: false,
        },
      ];

      for (let i = 0; i < 2; i++) {
        await runDispatcher("PreToolUse", {
          hookFilename: DISPATCH_PRETOOLUSE_HOOK_FILENAME,
          registrations: throwingGuardRegistrations,
          readInputFn: () =>
            Promise.resolve({
              session_id: "sess-integration-2",
              cwd: "/repo",
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: {},
            }),
          writeOutputFn: () => {},
          stderrWrite: () => {},
          resolveDispatchContextFn: () => stubContext(),
        });
      }

      const summary = getGuardHealthSummary();
      expect(summary.escalation).toBe("attention");
      expect(buildCriticalWarning(summary)).toBeNull();
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }
  });

  test("tracker/log unavailable (unwritable MINSKY_STATE_DIR) -> guards still run normally end-to-end", async () => {
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    // A path under a file (not a directory) makes mkdirSync fail reliably
    // cross-platform, simulating a genuinely broken state directory.
    const blockerFile = join(makeTmpDir(), "blocker-file");
    await Bun.write(blockerFile, "not a directory");
    process.env.MINSKY_STATE_DIR = join(blockerFile, "unreachable-subdir");
    try {
      let guardRan = false;
      const registrations: GuardRegistration[] = [
        {
          name: "throws",
          event: "PreToolUse",
          matcher: "Bash",
          module: () =>
            Promise.resolve({
              run: () => {
                guardRan = true;
                throw new Error("boom");
              },
            }),
          timeoutMs: 5000,
          denyCapable: false,
        },
      ];
      await expect(
        runDispatcher("PreToolUse", {
          hookFilename: DISPATCH_PRETOOLUSE_HOOK_FILENAME,
          registrations,
          readInputFn: () =>
            Promise.resolve({
              session_id: "sess-broken-state-dir",
              cwd: "/repo",
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: {},
            }),
          writeOutputFn: () => {},
          stderrWrite: () => {},
          resolveDispatchContextFn: () => stubContext(),
        })
      ).resolves.toBeUndefined();
      expect(guardRan).toBe(true);

      // Reading from the broken state dir degrades to the zero-filled summary.
      expect(() => getGuardHealthSummary()).not.toThrow();
      expect(getGuardHealthSummary().escalation).toBe("none");
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }
  });
});
