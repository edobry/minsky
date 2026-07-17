// Write-isolation regression test — mt#2875.
//
// mt#2812 shipped the guard-health tracker's default (real, unmocked)
// recordGuardError write path with test isolation that pointed
// MINSKY_STATE_DIR at an assumed-unwritable LITERAL path
// ("/nonexistent/...") and relied on the OS rejecting the write — not a
// real, guaranteed-safe scratch directory. That reliance is the mt#2875
// root-cause candidate for the fixture rows (guardName "throws", message
// "boom", sessionId "sess-1" — exactly `.minsky/hooks/dispatcher.test.ts`'s
// "default recordGuardErrorFn" test fixture shape, using its `baseInput()`
// default session id) found in the operator's live
// ~/.local/state/minsky/guard-health-log.jsonl on 2026-07-16, with
// timestamps landing inside that exact test's development window (see the
// mt#2875 PR body for the full timestamp-correlation evidence). An
// assumed-unwritable path is an environment assumption, not a guarantee —
// it depends on OS permissions, sandboxing, and execution user that don't
// hold universally (e.g. a root/CI process, or an interim uncommitted
// edit during iteration, could make the write silently succeed for real).
//
// This test proves the FIXED pattern (a real mkdtemp scratch directory,
// per mt#2875's changes to dispatcher.test.ts and
// guard-health-escalation-detector.test.ts) actually isolates writes: a
// pre-seeded "live store" canary file, in a directory MINSKY_STATE_DIR is
// never pointed at during the exercised write, remains byte-identical.
//
// @see mt#2875 — this task
// @see mt#2812 — the guard-health tracker task whose test isolation this fixes

/* eslint-disable custom/no-real-fs-in-tests -- this test exercises the real
   on-disk guard-health write path (the same default recordGuardError wiring
   dispatcher.test.ts's "default recordGuardErrorFn" test exercises) against
   a real mkdtemp scratch directory, and separately seeds + reads a second
   real scratch file standing in for "the operator's live store" to prove it
   is never touched — a real-fs round-trip is the point of this regression
   test, mirroring guard-health-dispatcher-integration.test.ts's rationale. */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatcher } from "./dispatcher";
import type { GuardRegistration } from "./registry";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

describe("guard-health write isolation regression (mt#2875)", () => {
  test("a pre-seeded 'live store' canary is byte-identical after the real default recordGuardError write path fires against a separate MINSKY_STATE_DIR", async () => {
    // A scratch dir standing in for the operator's real ~/.local/state/minsky
    // — pre-seeded with a canary line, the way a real operator's store
    // already has content before any test suite runs. This directory is
    // NEVER assigned to MINSKY_STATE_DIR during the exercised write below.
    const liveDir = makeTmpDir("mt2875-simulated-live-store-");
    const liveStorePath = join(liveDir, "guard-health-log.jsonl");
    const canary = `${JSON.stringify({
      timestamp: "2020-01-01T00:00:00.000Z",
      guardName: "canary",
      event: "PreToolUse",
      kind: "error",
      message: "pre-seeded — must remain untouched by any test write",
    })}\n`;
    writeFileSync(liveStorePath, canary);

    // A SEPARATE scratch dir is what MINSKY_STATE_DIR points at while the
    // real default write path fires — mirrors the mt#2875-fixed
    // dispatcher.test.ts pattern (real mkdtemp dir, not an assumed-
    // unwritable literal path).
    const isolatedDir = makeTmpDir("mt2875-isolated-write-target-");
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = isolatedDir;
    try {
      const throwingGuardRegistrations: GuardRegistration[] = [
        {
          name: "throws",
          event: "PreToolUse",
          matcher: "Bash",
          module: () =>
            Promise.resolve({
              run: () => {
                throw new Error("boom");
              },
            }),
          timeoutMs: 1000,
          denyCapable: true,
        },
      ];
      await runDispatcher("PreToolUse", {
        hookFilename: "dispatch-pretooluse.ts",
        registrations: throwingGuardRegistrations,
        readInputFn: () =>
          Promise.resolve({
            session_id: "sess-1",
            cwd: "/repo",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: {},
          }),
        writeOutputFn: () => {},
        stderrWrite: () => {},
        resolveDispatchContextFn: () => stubContext(),
        // No recordGuardErrorFn override — exercises the real default write
        // path, same shape as the fixture data found in the live store.
      });
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }

    // The write landed in the isolated dir, not the "live" one — proves the
    // real default recordGuardError path honors MINSKY_STATE_DIR scoping.
    const isolatedLogPath = join(isolatedDir, "guard-health-log.jsonl");
    const isolatedContent = readFileSync(isolatedLogPath, "utf-8");
    expect(isolatedContent).toContain('"guardName":"throws"');
    expect(isolatedContent).toContain('"message":"boom"');

    // The pre-seeded "live store" canary is byte-identical — untouched by
    // the write above, demonstrating the isolation the mt#2875 fix relies on.
    expect(readFileSync(liveStorePath, "utf-8")).toBe(canary);
  });
});
