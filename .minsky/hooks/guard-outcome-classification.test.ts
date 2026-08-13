// mt#3920 — the `guardOutcome` split, asserted against what a converted guard ACTUALLY
// did, and carried end to end into guard-health's `liveness`.
//
// `merge-gate-fire-log.test.ts` pins the factory's default (UNSET unless an exit names
// it) and `guard-health-recovery-signal.test.ts` pins the join. Neither answers the
// question this task turns on: does a converted guard emit the RIGHT one of the three?
// That is not checkable by asserting the field is present — a guard that marked every
// exit `decided` would pass such a test and would be exactly the regression mt#3892's R2
// lesson warns about.
//
// `tasks-status-set-guard` is the subject because it has all three cases in one pure,
// dependency-injected function, and because its degraded case is the dangerous one: a
// failed `minsky tasks get` read fails OPEN, so every call allows while the guard checks
// nothing.
//
// @see .minsky/hooks/tasks-status-set-guard.ts — `CheckResult.outcome`
// @see .minsky/hooks/guard-health.ts — the recovery join this feeds
// @see .minsky/hooks/merge-gate-fire-log.ts — `MergeGateOutcome`, the same three states

import { describe, expect, test } from "bun:test";
import { checkTransition, type CurrentTaskFields } from "./tasks-status-set-guard";
import {
  computeGuardHealthSummary,
  readCleanGuardInvocations,
  type GuardHealthEvent,
  type GuardInvocation,
} from "./guard-health";

const GUARD = "tasks-status-set-guard";
const TARGET_TOOL = "mcp__minsky__tasks_status_set";
const EVENT = "PreToolUse";

/** A `readCurrentTask` that succeeds, returning the given status. */
function reads(status: string, kind: string | null = "implementation") {
  return { readCurrentTask: (): CurrentTaskFields => ({ status, kind }) };
}

/** A `readCurrentTask` that is DEGRADED — the CLI read failed. The guard fails open. */
const readFails = { readCurrentTask: (): CurrentTaskFields | null => null };

describe("AT2: the three-way split matches what the guard actually did", () => {
  test("UNSET when the guard did not run", () => {
    // A different tool entirely.
    expect(checkTransition("Bash", { command: "ls" }, reads("TODO")).outcome).toBeUndefined();
    // The right tool, but nothing to check against.
    expect(checkTransition(TARGET_TOOL, {}, reads("TODO")).outcome).toBeUndefined();
    expect(checkTransition(TARGET_TOOL, { taskId: "mt#1" }, reads("TODO")).outcome).toBeUndefined();
    // The read SUCCEEDED but returned a status outside the canonical enum, so there was
    // nothing to validate the transition against. Nothing broke — that is why this is
    // UNSET rather than `crashed`.
    expect(
      checkTransition(TARGET_TOOL, { taskId: "mt#1", status: "DONE" }, reads("NONSENSE")).outcome
    ).toBeUndefined();
  });

  test("`crashed` when the live task read failed — the fail-open that must not count", () => {
    const result = checkTransition(TARGET_TOOL, { taskId: "mt#1", status: "DONE" }, readFails);

    // The decision is `allow`, which is the whole problem: it is indistinguishable from a
    // validated allow without the marker.
    expect(result.decision).toBe("allow");
    expect(result.outcome).toBe("crashed");
  });

  test("`decided` when the transition was actually validated", () => {
    // A legal transition: allowed, and the validator ran. (READY -> IN-PROGRESS would
    // NOT do — that one is `session_start`-only and denies.)
    const allowed = checkTransition(
      TARGET_TOOL,
      { taskId: "mt#1", status: "READY" },
      reads("PLANNING")
    );
    expect(allowed.decision).toBe("allow");
    expect(allowed.outcome).toBe("decided");

    // An illegal transition: denied, and the validator ran. Same evidence class.
    const denied = checkTransition(TARGET_TOOL, { taskId: "mt#1", status: "DONE" }, reads("TODO"));
    expect(denied.decision).toBe("deny");
    expect(denied.outcome).toBe("decided");

    // A malformed requested status is rejected without needing the read at all — still a
    // verdict the guard reached.
    const invalid = checkTransition(
      TARGET_TOOL,
      { taskId: "mt#1", status: "NOT-A-STATUS" },
      readFails
    );
    expect(invalid.decision).toBe("deny");
    expect(invalid.outcome).toBe("decided");
  });

  test("the split is not merely present — the three cases differ from each other", () => {
    // The guard against the degenerate implementation this test exists to rule out: a
    // conversion that marks everything `decided` would satisfy any presence check.
    const outcomes = new Set([
      checkTransition("Bash", { command: "ls" }, reads("TODO")).outcome,
      checkTransition(TARGET_TOOL, { taskId: "mt#1", status: "DONE" }, readFails).outcome,
      checkTransition(TARGET_TOOL, { taskId: "mt#1", status: "READY" }, reads("PLANNING")).outcome,
    ]);
    expect(outcomes).toEqual(new Set([undefined, "crashed", "decided"]));
  });
});

describe("criterion 2: a converted guard that fails and then runs cleanly reads recovered", () => {
  // Fixed clock — the point is that recovery does not require waiting out the 24h
  // streak age-out.
  const NOW = new Date("2026-08-11T12:00:00.000Z");
  const FIRE_LOG_PATH = "/mock/state/fire-log.jsonl";

  function minutesBeforeNow(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
  }

  function failure(minutesAgo: number): GuardHealthEvent {
    return {
      timestamp: minutesBeforeNow(minutesAgo),
      guardName: GUARD,
      event: EVENT,
      kind: "check-skip",
      message: "probe skipped — task read unavailable",
    };
  }

  /**
   * The record this guard's entry point writes for a given invocation — built the same
   * way the production code does, from `checkTransition`'s own outcome, so the test
   * cannot drift from the guard by asserting a hand-picked marker.
   */
  function recordFor(
    toolInput: Record<string, unknown>,
    deps: Parameters<typeof checkTransition>[2],
    minutesAgo: number
  ): string {
    const result = checkTransition(TARGET_TOOL, toolInput, deps);
    return `${JSON.stringify({
      timestamp: minutesBeforeNow(minutesAgo),
      guardName: GUARD,
      event: EVENT,
      decision: result.decision,
      ...(result.outcome !== undefined ? { guardOutcome: result.outcome } : {}),
      durationMs: 12,
      toolName: TARGET_TOOL,
    })}\n`;
  }

  /** In-memory fs seam — no test here touches the real fire log (mt#3756). */
  function readWith(contents: string): GuardInvocation[] {
    return readCleanGuardInvocations({
      fs: {
        existsSync: (p: string) => p === FIRE_LOG_PATH,
        readFileSync: () => contents,
        appendFileSync: () => undefined,
        mkdirSync: () => undefined,
      },
      logPath: FIRE_LOG_PATH,
    });
  }

  const FAILURES = [failure(60), failure(45), failure(30)];

  test("before this task: no marker means the entry pins at dormant forever", () => {
    // The pre-conversion record, byte for byte: everything the guard used to write, with
    // no `guardOutcome`. This is the defect — a guard running fine on every invocation,
    // reported as no-evidence-either-way.
    const legacy = `${JSON.stringify({
      timestamp: minutesBeforeNow(5),
      guardName: GUARD,
      event: EVENT,
      decision: "allow",
      durationMs: 12,
      toolName: TARGET_TOOL,
    })}\n`;

    const summary = computeGuardHealthSummary(FAILURES, NOW, readWith(legacy));
    expect(summary.byGuard[GUARD]?.liveness).toBe("dormant");
    expect(summary.byGuard[GUARD]?.escalation).toBe("critical");
  });

  test("after this task: a validated transition clears the streak and reads recovered", () => {
    const summary = computeGuardHealthSummary(
      FAILURES,
      NOW,
      readWith(recordFor({ taskId: "mt#1", status: "READY" }, reads("PLANNING"), 5))
    );

    expect(summary.byGuard[GUARD]?.liveness).toBe("recovered");
    expect(summary.byGuard[GUARD]?.consecutiveStreak).toBe(0);
    // The failures are still on the record — this clears the incident, not the history.
    expect(summary.byGuard[GUARD]?.failureCount24h).toBe(3);
  });

  test("negative control: the degraded read keeps reading dormant, not recovered", () => {
    // The invariant that makes the split worth having. If the CLI read stays broken, the
    // guard keeps allowing every call while checking nothing — and must NOT report itself
    // recovered off that traffic. Marking these `decided` would invert the signal exactly
    // when it matters.
    const summary = computeGuardHealthSummary(
      FAILURES,
      NOW,
      readWith(recordFor({ taskId: "mt#1", status: "DONE" }, readFails, 5))
    );

    expect(summary.byGuard[GUARD]?.liveness).toBe("dormant");
    expect(summary.byGuard[GUARD]?.escalation).toBe("critical");
  });

  test("negative control: an unrelated tool contributes no evidence either", () => {
    const summary = computeGuardHealthSummary(
      FAILURES,
      NOW,
      readWith(recordFor({ command: "ls" }, reads("TODO"), 5))
    );

    expect(summary.byGuard[GUARD]?.liveness).toBe("dormant");
  });
});
