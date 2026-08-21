/**
 * Per-guard deadline enforcement in the dispatcher loop (mt#3757).
 *
 * A SEPARATE file rather than an extension of `dispatcher.test.ts`, which is
 * already 1809 lines and sits against the 1500-line `max-lines` error cap —
 * appending here is what pushed it over, so the tests move rather than the cap.
 */
import { describe, test, expect } from "bun:test";
import {
  runDispatcher,
  composeAdditionalContext,
  computeHardDeadlineMs,
  nextSlackMs,
  runWithDeadline,
  DEADLINE_NOTICE_PRIORITY,
  DEFAULT_CONTEXT_PRIORITY,
  type DeadlineTimers,
} from "./dispatcher";
import type { GuardRegistration, GuardEffectDeclaration } from "./registry";
import type { HookOutput } from "./types";
import { readFireLogEntries } from "./fire-log";
import {
  DISPATCH_HOOK_FILENAME,
  baseInput,
  stubContext,
  useIsolatedStateDir,
} from "./test-support/dispatcher-harness";

/** See `dispatcher.test.ts` — mechanics fixtures, not posture semantics. */
const FIXTURE_EFFECTS: [GuardEffectDeclaration, ...GuardEffectDeclaration[]] = [
  {
    effect: "deny",
    verdictShape: "validator",
    failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
  },
];

// The two phrases the assertions below key on. Named because they appear in
// several tests and the lint rule is right that a drifting copy is how an
// assertion quietly stops checking what it says it checks.
const BEHIND_FRAGMENT = "fragment from the guard behind it";
const MISSING_NOTICE = "MISSING from this turn";

describe("per-guard deadline arithmetic (mt#3757)", () => {
  test("the hard deadline is the declared budget plus accrued slack", () => {
    expect(computeHardDeadlineMs(10_000, 0)).toBe(10_000);
    expect(computeHardDeadlineMs(10_000, 195_000)).toBe(205_000);
  });

  test("negative slack can never SHORTEN a guard's own declared budget", () => {
    // The clamp is the invariant: a guard is entitled to what it declared,
    // whatever bookkeeping happened before it.
    expect(computeHardDeadlineMs(5_000, -9_999)).toBe(5_000);
  });

  test("unspent budget accrues; an overrun draws it down", () => {
    expect(nextSlackMs(0, 10_000, 400)).toBe(9_600);
    expect(nextSlackMs(9_600, 5_000, 500)).toBe(14_100);
    // memory-search's real shape: 10s declared, 122s spent, against slack the
    // fast guards left behind. It finishes, and it consumes most of the pool.
    expect(nextSlackMs(195_000, 10_000, 122_000)).toBe(83_000);
  });

  test("slack floors at zero rather than going negative", () => {
    expect(nextSlackMs(1_000, 5_000, 50_000)).toBe(0);
  });
});

describe("runWithDeadline (mt#3757)", () => {
  test("work that settles first wins, and reports its value", async () => {
    const result = await runWithDeadline(Promise.resolve("done"), 5_000);
    expect(result.timedOut).toBe(false);
    if (!result.timedOut) expect(result.value).toBe("done");
  });

  test("an ASYNC never-settling promise times out instead of hanging", async () => {
    const never = new Promise<string>(() => {});
    const result = await runWithDeadline(never, 20);
    expect(result.timedOut).toBe(true);
  });

  test("the timer is cleared on BOTH paths, so no hook process is held open", async () => {
    // Not a style point: a pending setTimeout keeps the runtime alive, so a
    // leak here would delay EVERY hook process's exit by up to its slowest
    // guard's deadline. Asserting on the fast path is the half that regresses.
    let cleared = 0;
    const timers: DeadlineTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        cleared += 1;
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    };
    await runWithDeadline(Promise.resolve(1), 5_000, timers);
    expect(cleared).toBe(1);
    await runWithDeadline(new Promise<number>(() => {}), 10, timers);
    expect(cleared).toBe(2);
  });
});

/** A synthetic registration. Module-scoped so the PR #3213 R1 blocks reach it too. */
function reg(name: string, timeoutMs: number, run: () => unknown): GuardRegistration {
  return {
    name,
    event: "PreToolUse",
    matcher: "Bash",
    module: () => Promise.resolve({ run: run as never }),
    timeoutMs,
    denyCapable: false,
    effects: FIXTURE_EFFECTS,
  };
}

describe("the dispatcher loop enforces per-guard deadlines (mt#3757)", () => {
  test("AT1 — an async never-settling guard is skipped; the guards behind it are still delivered", async () => {
    // Pre-mt#3757 this test does not FAIL, it HANGS: the bare `await mod.run()`
    // never returns, so runDispatcher never resolves and the case is reached by
    // the runner's timeout rather than by an assertion. That is the negative
    // control for this whole block — the hang IS the defect.
    const written: HookOutput[] = [];
    const stderr: string[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        reg("hangs", 20, () => new Promise(() => {})),
        reg("answers", 1_000, () => ({ additionalContext: BEHIND_FRAGMENT })),
      ],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: () => {},
      recordGuardErrorFn: () => {},
    });

    const ctx = written[0]?.hookSpecificOutput?.additionalContext ?? "";
    // The whole point of the task: the later guard's work is NOT lost.
    expect(ctx).toContain(BEHIND_FRAGMENT);
    // NAMED, not silent.
    expect(ctx).toContain("hangs");
    expect(ctx).toContain(MISSING_NOTICE);
    // The notice outranks ordinary reminders, so it leads the block.
    expect(ctx.indexOf(MISSING_NOTICE)).toBeLessThan(ctx.indexOf(BEHIND_FRAGMENT));
    expect(stderr.join("")).toContain("was SKIPPED");
  });

  test("AT1b — the skip is recorded to guard-health AND the fire log, not just printed", async () => {
    const fireLog: Array<Record<string, unknown>> = [];
    const health: Array<Record<string, unknown>> = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [reg("hangs", 20, () => new Promise(() => {}))],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: (e) => fireLog.push(e as never),
      recordGuardErrorFn: (e) => health.push(e as never),
    });

    expect(fireLog.length).toBe(1);
    expect(fireLog[0]?.guardOutcome).toBe("deadline-skipped");
    // ABSENT, and this pins the semantics rather than the implementation
    // (PR #3213 R3): `budgetExceededMs` means "crossed the budget and FINISHED
    // ANYWAY". A skipped guard did not finish, so a present value here would
    // make the field mean two different things to every reader.
    expect(fireLog[0]?.budgetExceededMs).toBeUndefined();
    // A skipped guard is a FAILURE for streak purposes — it produced no verdict.
    expect(health.length).toBe(1);
    expect(health[0]?.guardName).toBe("hangs");
  });

  test("AT2 — with every guard fast, the output is exactly what it was before", async () => {
    const written: HookOutput[] = [];
    const stderr: string[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        reg("a", 1_000, () => ({ additionalContext: "fragment A" })),
        reg("b", 1_000, () => ({ additionalContext: "fragment B" })),
      ],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: () => {},
    });
    // Byte-identical to `dispatcher.test.ts`'s pre-change assertion in
    // "multiple guards contribute additionalContext" — no notice, no extra
    // separator, nothing.
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("fragment A\n\nfragment B");
    expect(stderr).toEqual([]);
  });

  test("AT3 — a guard past its DECLARED budget but inside the slack runs to completion", async () => {
    // This is the memory-search case, and it is the criterion a naive
    // implementation fails: cut at the declared value and this guard dies.
    const fireLog: Array<Record<string, unknown>> = [];
    const written: HookOutput[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        // Returns immediately, leaving ~1000ms of slack behind it.
        reg("fast", 1_000, () => ({ additionalContext: "from fast" })),
        // Declares 10ms, takes ~60ms. Dies under a flat cut; survives on slack.
        reg("slow", 10, async () => {
          await new Promise((r) => setTimeout(r, 60));
          return { additionalContext: "from slow" };
        }),
      ],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: (e) => fireLog.push(e as never),
    });

    const ctx = written[0]?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("from slow");
    expect(ctx).not.toContain(MISSING_NOTICE);

    const slow = fireLog.find((e) => e.guardName === "slow");
    // It DECIDED — the overrun must not reclassify it, or guard-health's
    // clean-run join stops counting a guard that worked.
    expect(slow?.guardOutcome).toBe("decided");
    expect(slow?.budgetExceededMs).toBe(10);
    // And the guard that stayed inside its budget carries no overrun marker.
    expect(fireLog.find((e) => e.guardName === "fast")?.budgetExceededMs).toBeUndefined();
  });

  test("AT4 regression — a guard that THROWS still fails open, unchanged", async () => {
    const written: HookOutput[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        reg("boom", 1_000, () => {
          throw new Error("kaboom");
        }),
        reg("after", 1_000, () => ({ additionalContext: "still ran" })),
      ],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: () => {},
      recordGuardErrorFn: () => {},
    });
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("still ran");
  });

  test("the skip notice outranks ordinary reminders when the budget forces a drop", () => {
    // Asserted through composeAdditionalContext rather than only via the
    // constant, so the ordering it buys is what is pinned, not the number.
    expect(DEADLINE_NOTICE_PRIORITY).toBeGreaterThan(DEFAULT_CONTEXT_PRIORITY);
    const merged = composeAdditionalContext([
      { guardName: "ordinary", priority: DEFAULT_CONTEXT_PRIORITY, text: "an ordinary reminder" },
      { guardName: "skipped", priority: DEADLINE_NOTICE_PRIORITY, text: MISSING_NOTICE },
    ]);
    expect(merged?.indexOf(MISSING_NOTICE)).toBeLessThan(
      merged?.indexOf("an ordinary reminder") ?? -1
    );
  });
});

// ---------------------------------------------------------------------------
// PR #3213 R1 — the host-budget bound, and the timestamp the reviewer asked
// for evidence of
// ---------------------------------------------------------------------------

describe("the deadline is bounded by the event's remaining host budget (PR #3213 R1)", () => {
  test("the host budget CAPS declared + slack", () => {
    // Slack says what the guards left; it says nothing about what the host will
    // still wait for. The smaller of the two wins.
    expect(computeHardDeadlineMs(10_000, 195_000, 5_000)).toBe(5_000);
    // ...and when there is budget to spare, the cap is inert.
    expect(computeHardDeadlineMs(10_000, 195_000, 900_000)).toBe(205_000);
  });

  test("an exhausted budget yields a zero deadline, deliberately", () => {
    // Terminal behaviour, not an edge case to soften: a guard skipped WITH a
    // notice beats a process SIGKILLed without one.
    expect(computeHardDeadlineMs(10_000, 195_000, 0)).toBe(0);
    expect(computeHardDeadlineMs(10_000, 0, -50)).toBe(0);
  });

  test("omitting the bound leaves the pre-R1 behaviour, so the cap only ever SHORTENS", () => {
    expect(computeHardDeadlineMs(10_000, 5_000)).toBe(15_000);
  });

  test("a guard is cut at the host budget even when slack would allow more", async () => {
    const written: HookOutput[] = [];
    const stderr: string[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        // Declares 30s and would inherit slack besides — but the event budget
        // below is 40ms, so it is cut there and skipped.
        reg("greedy", 30_000, () => new Promise(() => {})),
        reg("after", 1_000, () => ({ additionalContext: "ran anyway" })),
      ],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => ({
        ...stubContext(),
        budgets: { overallBudgetMs: 40, fetchTimeoutMs: 20, gitTimeoutMs: 10 },
      }),
      recordFireLogFn: () => {},
      recordGuardErrorFn: () => {},
    });

    // Without the R1 bound this test does not fail, it HANGS: a 30s declared
    // budget against a 40ms event budget is exactly the case the cap exists for.
    expect(stderr.join("")).toContain("was SKIPPED");
    expect(written[0]?.hookSpecificOutput?.additionalContext ?? "").toContain("ran anyway");
  });
});

describe("the fire-log record carries a timestamp (PR #3213 R1 evidence)", () => {
  // The R1 review flagged the new recordFireLog calls for omitting `timestamp`,
  // noting it could not tell whether recordFireLogEntry injects one. It does —
  // `RecordFireLogInput` has no `timestamp` field at all, so a caller CANNOT
  // pass one, and every pre-existing call site omits it identically. Rather
  // than answer that in prose, this exercises the REAL default writer end to
  // end and reads the emitted line back off disk.
  const getStateDir = useIsolatedStateDir("mt3757-firelog-");

  test("a deadline-skipped record written by the real writer has an ISO timestamp", async () => {
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [reg("hangs", 20, () => new Promise(() => {}))],
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      // NOTE: recordFireLogFn is deliberately NOT injected — this is the real
      // recordFireLogEntry default, which is the thing under question.
      recordGuardErrorFn: () => {},
    });

    const entries = readFireLogEntries().filter((e) => e.guardName === "hangs");
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry?.guardOutcome).toBe("deadline-skipped");
    expect(typeof entry?.timestamp).toBe("string");
    // ISO-8601, per docs/architecture/evaluation-loop-fire-log.md's schema.
    expect(Number.isNaN(Date.parse(entry?.timestamp ?? ""))).toBe(false);
    expect(entry?.budgetExceededMs).toBeUndefined();
    // And the record parsed at all — readFireLogEntries drops lines failing its
    // validator, so a returned entry proves the widened union accepts the new
    // value rather than silently discarding the record.
    expect(getStateDir()).toContain("mt3757-firelog-");
  });
});
