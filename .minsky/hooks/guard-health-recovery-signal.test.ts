// mt#3892 — guard-health's clean-run (recovery) signal.
//
// The behavior under test is a JOIN across two stores: failures from
// guard-health-log.jsonl, clean runs from fire-log.jsonl. The interesting cases
// are all about which fire-log records are ALLOWED to count as clean runs, so
// most of these tests are about what does NOT count.
//
// @see .minsky/hooks/guard-health.ts — the computation
// @see .minsky/hooks/fire-log.ts — `guardOutcome`, the marker this rests on
// @see src/mcp/guard-health-tracker.ts — the hand-synced copy the parity test pins

import { describe, expect, test } from "bun:test";
import {
  computeGuardHealthSummary,
  readCleanGuardInvocations,
  type GuardHealthEvent,
  type GuardInvocation,
} from "./guard-health";
import { computeGuardHealthSummary as computeSrcSide } from "../../src/mcp/guard-health-tracker";

const GUARD = "test-recovery-guard";
const EVENT = "PreToolUse";

// A fixed clock, so nothing here depends on when it runs. All offsets are
// minutes from this instant, well inside the 24h STREAK_RESET_GAP_MS age-out —
// the point of every test below is that recovery does NOT require waiting that
// window out.
const NOW = new Date("2026-08-10T12:00:00.000Z");

function minutesBeforeNow(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

function failure(minutesAgo: number): GuardHealthEvent {
  return {
    timestamp: minutesBeforeNow(minutesAgo),
    guardName: GUARD,
    event: EVENT,
    kind: "check-skip",
    message: "probe skipped — persistence provider unavailable",
  };
}

function cleanRun(minutesAgo: number): GuardInvocation {
  return { guardName: GUARD, timestamp: minutesBeforeNow(minutesAgo) };
}

/** Three failures in the last hour — a critical streak by any reading. */
const THREE_FAILURES = [failure(60), failure(45), failure(30)];

describe("recovery resets the streak without waiting out the 24h window (AT1)", () => {
  test("negative control: three failures and no clean run stay critical", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, []);

    expect(summary.byGuard[GUARD]?.consecutiveStreak).toBe(3);
    expect(summary.byGuard[GUARD]?.escalation).toBe("critical");
    expect(summary.criticalGuards).toContain(GUARD);
  });

  test("one clean run after the last failure clears the streak immediately", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, [cleanRun(10)]);

    expect(summary.byGuard[GUARD]?.consecutiveStreak).toBe(0);
    expect(summary.byGuard[GUARD]?.escalation).toBe("none");
    expect(summary.criticalGuards).not.toContain(GUARD);
    // The failures are still on the record — this clears the INCIDENT, not the
    // history. A consumer asking "has this guard been failing?" still gets yes.
    expect(summary.byGuard[GUARD]?.failureCount24h).toBe(3);
  });

  test("`liveness` is the field an acceptance test can name (mt#3879's AT2)", () => {
    const recovered = computeGuardHealthSummary(THREE_FAILURES, NOW, [cleanRun(10)]);
    expect(recovered.byGuard[GUARD]?.liveness).toBe("recovered");
    expect(recovered.byGuard[GUARD]?.lastCleanRunAt).toBe(minutesBeforeNow(10));
  });
});

describe("the three states are distinguishable (AT2)", () => {
  test("no clean-run evidence at all reads dormant, not recovered", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, []);
    expect(summary.byGuard[GUARD]?.liveness).toBe("dormant");
    expect(summary.byGuard[GUARD]?.lastCleanRunAt).toBeNull();
  });

  test("a clean run BEFORE the last failure reads failing, not recovered", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, [cleanRun(90)]);
    expect(summary.byGuard[GUARD]?.liveness).toBe("failing");
    // Still critical: the guard worked once, then broke and has not worked since.
    expect(summary.byGuard[GUARD]?.escalation).toBe("critical");
  });

  test("a clean run AFTER the last failure reads recovered", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, [cleanRun(5)]);
    expect(summary.byGuard[GUARD]?.liveness).toBe("recovered");
  });

  test("the latest clean run wins, not the first one seen", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, [
      cleanRun(90),
      cleanRun(5),
      cleanRun(70),
    ]);
    expect(summary.byGuard[GUARD]?.liveness).toBe("recovered");
    expect(summary.byGuard[GUARD]?.lastCleanRunAt).toBe(minutesBeforeNow(5));
  });
});

describe("the fire-log reader admits only clean runs", () => {
  const FIRE_LOG_PATH = "/mock/state/fire-log.jsonl";

  /**
   * In-memory fs seam. `readFireLogEntries` already accepts one, so no test
   * here touches the real filesystem — which matters beyond the lint rule: this
   * guard's production writer now appends to the REAL fire-log, and a test that
   * pointed the reader at a real state dir is one env leak away from the mt#3756
   * incident (fixture records landing in the operator's production corpus).
   */
  function fireLogFs(contents: string | null) {
    return {
      existsSync: (p: string) => p === FIRE_LOG_PATH && contents !== null,
      readFileSync: () => contents ?? "",
      appendFileSync: () => undefined,
      mkdirSync: () => undefined,
    };
  }

  function readWith(contents: string | null): GuardInvocation[] {
    return readCleanGuardInvocations({ fs: fireLogFs(contents), logPath: FIRE_LOG_PATH });
  }

  function record(guardOutcome: string | null, minutesAgo: number): string {
    const base: Record<string, unknown> = {
      timestamp: minutesBeforeNow(minutesAgo),
      guardName: GUARD,
      event: EVENT,
      decision: "allow",
      durationMs: 12,
    };
    if (guardOutcome !== null) base.guardOutcome = guardOutcome;
    return `${JSON.stringify(base)}\n`;
  }

  test("a `decided` record is admitted", () => {
    expect(readWith(record("decided", 10))).toEqual([
      { guardName: GUARD, timestamp: minutesBeforeNow(10) },
    ]);
  });

  test("a `crashed` record is NOT admitted — this is the fail-open trap", () => {
    // The regression this whole marker exists for. A crashed guard fails open,
    // so the dispatcher writes decision:"allow" for it, microseconds AFTER the
    // guard-health failure event. Admitting it would make a CONTINUOUSLY
    // CRASHING guard report itself recovered on every single crash — the
    // failure inverts the signal exactly when it matters (mem#638), which is
    // worse than having no signal.
    expect(readWith(record("crashed", 10))).toEqual([]);
  });

  test("a legacy record with no marker is NOT admitted", () => {
    // Absence cannot be read as "decided": records written before the marker
    // existed cannot distinguish a clean decision from a crashed fail-open, so
    // they are no evidence at all. Reading them as clean would apply a false
    // all-clear to exactly the historical corpus we know least about.
    expect(readWith(record(null, 10))).toEqual([]);
  });

  test("end to end: a crashed record after the last failure still reads failing", () => {
    const summary = computeGuardHealthSummary(THREE_FAILURES, NOW, readWith(record("crashed", 5)));
    expect(summary.byGuard[GUARD]?.liveness).toBe("dormant");
    expect(summary.byGuard[GUARD]?.escalation).toBe("critical");
  });

  test("a missing fire-log yields no clean runs rather than throwing", () => {
    expect(readWith(null)).toEqual([]);
  });
});

describe("the two hand-synced copies agree (AT5)", () => {
  // .minsky/hooks/guard-health.ts and src/mcp/guard-health-tracker.ts duplicate
  // this computation deliberately — the hooks tree is outside the root
  // tsconfig's program, so the cross-import is impossible and both headers say
  // the copies are "kept in sync manually". Nothing checked that until now;
  // this is what makes the next edit to either one fail loudly instead of
  // silently diverging debug_systemInfo from the hook surface.
  const CASES: ReadonlyArray<{
    name: string;
    events: readonly GuardHealthEvent[];
    invocations: readonly GuardInvocation[];
  }> = [
    { name: "failing, no clean runs", events: THREE_FAILURES, invocations: [] },
    { name: "recovered", events: THREE_FAILURES, invocations: [cleanRun(5)] },
    {
      name: "clean run predates the failures",
      events: THREE_FAILURES,
      invocations: [cleanRun(90)],
    },
    { name: "no events at all", events: [], invocations: [cleanRun(5)] },
    { name: "single failure", events: [failure(30)], invocations: [] },
  ];

  for (const { name, events, invocations } of CASES) {
    test(`identical summaries: ${name}`, () => {
      expect(computeSrcSide(events, NOW, invocations)).toEqual(
        computeGuardHealthSummary(events, NOW, invocations)
      );
    });
  }
});
