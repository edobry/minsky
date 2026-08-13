import { describe, expect, it } from "bun:test";

import { exec } from "child_process";

import {
  classifyExecFailure,
  executeCommand,
  isTimeoutAttributableKill,
  markKilledByTimeout,
} from "./exec";

// ---------------------------------------------------------------------------
// Pure classification (mt#3909)
//
// These pin the DECISION. They cannot pin that Node's real errors have the
// shapes assumed here — that is what the spawning tests below are for, and the
// split is deliberate: a pure test over an invented error object would pass
// just as happily if Node's shape were something else entirely.
// ---------------------------------------------------------------------------

describe("classifyExecFailure", () => {
  it("reads a numeric code as the command's own exit", () => {
    expect(classifyExecFailure({ code: 3 })).toEqual({ kind: "exit", exitCode: 3 });
  });

  // mt#3923: `killed` says the parent sent a signal, never why. Reporting that
  // as a timeout is a guess, and it is wrong for any caller that kills for a
  // different reason (operator cancellation, a pre-timeout abort).
  it("reads an unexplained parent kill as killed, not as a timeout", () => {
    expect(classifyExecFailure({ killed: true, code: null, signal: "SIGTERM" })).toEqual({
      kind: "killed",
      signal: "SIGTERM",
    });
  });

  it("reads a parent kill as a timeout when the caller reports the reason", () => {
    expect(
      classifyExecFailure(
        { killed: true, code: null, signal: "SIGTERM" },
        { killedDueToTimeout: true }
      )
    ).toEqual({ kind: "timeout", signal: "SIGTERM" });
  });

  it("reads a parent kill as a timeout when the error carries the stamp", () => {
    const error = markKilledByTimeout({ killed: true, code: null, signal: "SIGTERM" });
    expect(classifyExecFailure(error)).toEqual({ kind: "timeout", signal: "SIGTERM" });
  });

  // The caller's explicit word beats the stamp — a caller that knows the kill
  // was NOT a timeout can say so even on a stamped error.
  it("lets an explicit reason override the stamp", () => {
    const error = markKilledByTimeout({ killed: true, code: null, signal: "SIGTERM" });
    expect(classifyExecFailure(error, { killedDueToTimeout: false })).toEqual({
      kind: "killed",
      signal: "SIGTERM",
    });
  });

  // The distinction `killed` alone cannot make: Node sets `killed: true` for
  // BOTH a timeout and a maxBuffer overrun, and only the string code separates
  // them. They need different remedies — wait longer vs. capture less output.
  it("separates a maxBuffer overrun from a timeout, though both are killed", () => {
    expect(
      classifyExecFailure({
        killed: true,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        signal: "SIGTERM",
      })
    ).toEqual({ kind: "maxbuffer", signal: "SIGTERM" });
  });

  // Guards the latent bug this task found in the caller: `code ?? 1` would put
  // this STRING into a field declared as a number.
  it("never reports a string code as an exit code", () => {
    const result = classifyExecFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(result.exitCode).toBeUndefined();
  });

  it("reads an external signal with no code as a signal kill, not a timeout", () => {
    expect(classifyExecFailure({ killed: false, code: null, signal: "SIGKILL" })).toEqual({
      kind: "signal",
      signal: "SIGKILL",
    });
  });

  it("prefers a numeric exit code over a reported signal", () => {
    expect(classifyExecFailure({ code: 2, signal: "SIGPIPE" })).toEqual({
      kind: "exit",
      exitCode: 2,
      signal: "SIGPIPE",
    });
  });

  it("degrades to unknown rather than guessing", () => {
    expect(classifyExecFailure(null)).toEqual({ kind: "unknown" });
    expect(classifyExecFailure("a string")).toEqual({ kind: "unknown" });
    expect(classifyExecFailure({})).toEqual({ kind: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// Timeout attribution (PR #2817 R1)
//
// Setting a timeout is not the same fact as the timeout firing. These pin the
// difference at the millisecond, which a real-process test cannot do reliably.
// ---------------------------------------------------------------------------

describe("isTimeoutAttributableKill", () => {
  const KILLED_AT_BUDGET = { killed: true, timeoutMs: 100, elapsedMs: 100, aborted: false };

  it("attributes a kill once the budget has actually run out", () => {
    expect(isTimeoutAttributableKill(KILLED_AT_BUDGET)).toBe(true);
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, elapsedMs: 5_000 })).toBe(true);
  });

  // The finding: a kill under a budget that had not yet run out was being
  // called a timeout purely because a timeout was configured.
  it("refuses a kill that landed before the budget ran out", () => {
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, elapsedMs: 99 })).toBe(false);
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, elapsedMs: 0 })).toBe(false);
  });

  it("yields to an abort even when the budget has run out", () => {
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, aborted: true })).toBe(false);
  });

  it("claims nothing when no budget was set", () => {
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, timeoutMs: undefined })).toBe(false);
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, timeoutMs: 0 })).toBe(false);
  });

  it("claims nothing when the parent did not kill the child", () => {
    expect(isTimeoutAttributableKill({ ...KILLED_AT_BUDGET, killed: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real spawns — pin Node's ACTUAL error shapes (mt#3909)
//
// The half the pure tests cannot establish. If a Node upgrade changes the shape
// of a timeout error, these fail and the pure tests above do not.
// ---------------------------------------------------------------------------

describe("classifyExecFailure against real child_process errors", () => {
  it("classifies a genuine non-zero exit by its code", async () => {
    let caught: unknown;
    try {
      await executeCommand("exit 3");
    } catch (error) {
      caught = error;
    }
    expect(classifyExecFailure(caught)).toMatchObject({ kind: "exit", exitCode: 3 });
  });

  it("classifies a real timeout kill as a timeout, not as exit 1", async () => {
    let caught: unknown;
    try {
      await executeCommand("sleep 5", { timeout: 150 });
    } catch (error) {
      caught = error;
    }
    const failure = classifyExecFailure(caught);
    expect(failure.kind).toBe("timeout");
    // The load-bearing contrast: before mt#3909 this case and the one above
    // were indistinguishable to a caller, because both surfaced as exit 1.
    expect(failure.exitCode).toBeUndefined();
  });

  // Criterion 4: determine whether captured output survives a timeout kill,
  // rather than assuming it is lost. It is not — Node attaches what it read.
  it("preserves output printed before a timeout kill", async () => {
    let caught: unknown;
    try {
      await executeCommand("echo before-the-kill; sleep 5", { timeout: 300 });
    } catch (error) {
      caught = error;
    }
    const withStdout = caught as { stdout?: string };
    expect(withStdout.stdout ?? "").toContain("before-the-kill");
  });

  // mt#3923's negative control, and the case the mt#3909 tests never covered:
  // a REAL parent-initiated kill with no timeout involved. Node reports it
  // identically to a timeout kill (`killed: true`, no code, SIGTERM), which is
  // exactly why the reason cannot be recovered from the error.
  it("does not call a real non-timeout parent kill a timeout", async () => {
    const caught = await new Promise<unknown>((resolve) => {
      const child = exec("sleep 5", (error) => resolve(error));
      setTimeout(() => child.kill("SIGTERM"), 100);
    });

    // Pin the premise this whole task rests on: the shape really is
    // indistinguishable from the timeout case above.
    expect((caught as { killed?: boolean }).killed).toBe(true);
    expect((caught as { code?: unknown }).code).toBeNull();

    const failure = classifyExecFailure(caught);
    expect(failure.kind).toBe("killed");
    expect(failure.kind).not.toBe("timeout");
  });

  // A caller cancels at ~100ms under a 30s budget. This does NOT pass because
  // of the `aborted` guard in isTimeoutAttributableKill — it passes because
  // Node's abort path never produces a killed error at all. Asserted here
  // rather than assumed, since the guard was written on the assumption that it
  // did, and the assumption was wrong.
  it("surfaces an abort as ABORT_ERR, never as a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    let caught: unknown;
    try {
      await executeCommand("sleep 5", { timeout: 30_000, signal: controller.signal });
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: unknown }).code).toBe("ABORT_ERR");
    expect((caught as { killed?: unknown }).killed).toBeUndefined();
    expect(classifyExecFailure(caught).kind).not.toBe("timeout");
  });

  it("leaves a successful command untouched", async () => {
    const { stdout } = await executeCommand("echo ok");
    expect(stdout.trim()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The timeout ENFORCES (mt#3418)
//
// Before this, `executeCommand` handed Node the `timeout` option and trusted
// it. Node sends `killSignal` once and then goes back to waiting: a child that
// ignores it ran to completion and the call RESOLVED, so a gate built on
// `execAsync` could report a pass for a command that blew its budget by 12x.
// These pin the two-stage kill that replaced that.
// ---------------------------------------------------------------------------

describe("executeCommand enforces its timeout (mt#3418)", () => {
  // A shell that ignores SIGTERM and busy-loops, with no long-lived grandchild
  // to orphan — `trap '' TERM` is POSIX sh's "ignore this signal" form, and the
  // loop keeps the work inside the process we are signalling.
  const ignoresSigterm = (marker: string) => `trap '' TERM; while :; do :; done # ${marker}`;

  /**
   * Is any process still running with `marker` in its command line?
   *
   * argv form deliberately: no shell means no second process carrying the
   * marker, and `pgrep` never matches itself.
   *
   * Returns `null` where `pgrep` is unavailable rather than guessing (PR #2957
   * R1). It is POSIX-standard and present on both platforms this repo runs on,
   * but an external binary is still an external binary: a missing one must not
   * turn into a false "the process is gone", and must not fail a suite over an
   * environment gap that has nothing to do with the behavior under test. The
   * rest of the assertions in this test are unaffected either way.
   */
  const anyProcessMatching = (marker: string): boolean | null => {
    const probe = Bun.spawnSync(["pgrep", "-f", marker]);
    // exit 0 = matched, 1 = no match; anything else (127 / spawn failure) means
    // the question was not answered.
    if (probe.exitCode !== 0 && probe.exitCode !== 1) return null;
    return probe.exitCode === 0;
  };

  // AT1 — the defect itself. The child cannot be stopped by SIGTERM, so the
  // budget is only real if something escalates.
  it("kills a SIGTERM-ignoring child with SIGKILL, and rejects", async () => {
    const marker = "minsky-exec-mt3418-at1";
    let caught: unknown;
    // Monotonic, per `scripts/spawn-with-watchdog.ts`: `Date.now()` can step
    // backwards (NTP, a manual clock change) and would misreport the very
    // duration this test exists to bound.
    const startedAt = performance.now();
    try {
      await executeCommand(ignoresSigterm(marker), { timeout: 200, killGraceMs: 300 });
    } catch (error) {
      caught = error;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(caught).toBeDefined();

    // These three are what fail before the fix, measured against the
    // unmodified helper with this exact child: it rejected at 5627ms — 28x its
    // 200ms budget — and classified as `exit`, i.e. the command's own non-zero
    // status. Not merely a lost timeout: a failure attributed to a command that
    // did not fail. (The sibling shape, a `bun` child ignoring SIGTERM,
    // RESOLVED successfully with empty stdout at 6016ms instead. Same defect,
    // and which misreport you get depends on the child.)
    const failure = classifyExecFailure(caught);
    expect(failure.kind).toBe("timeout");
    // "we tried to kill it and it did not die", not merely "we killed it".
    expect(failure.escalated).toBe(true);
    expect(failure.signal).toBe("SIGKILL");

    // Bounded by budget + grace with margin, nowhere near the child's own
    // lifetime — which is unbounded, since it loops forever.
    expect(elapsedMs).toBeLessThan(5_000);

    // AT1's other half: the process is actually gone, not merely abandoned.
    // `null` means pgrep could not answer — asserted as "not still running"
    // rather than skipped silently, so the two outcomes stay distinguishable.
    expect(anyProcessMatching(marker)).not.toBe(true);
  });

  // AT2 — the ordinary case must still be handled at stage one. If this ever
  // reports `escalated`, the SIGTERM path has silently stopped working and
  // every timeout is paying the grace period.
  it("reaps a well-behaved child at stage one, without escalating", async () => {
    let caught: unknown;
    try {
      await executeCommand("sleep 5", { timeout: 150, killGraceMs: 2_000 });
    } catch (error) {
      caught = error;
    }

    const failure = classifyExecFailure(caught);
    expect(failure.kind).toBe("timeout");
    expect(failure.signal).toBe("SIGTERM");
    expect(failure.escalated).toBeUndefined();
  });

  // AT3 — happy path unchanged. Same resolved shape, same stdout handling, and
  // no interference from a watchdog that was armed but never fired.
  it("leaves a command that finishes inside its budget alone", async () => {
    const { stdout, stderr } = await executeCommand("echo inside-budget", { timeout: 30_000 });
    expect(stdout.trim()).toBe("inside-budget");
    expect(stderr).toBe("");
  });

  // AT4 — no budget, no watchdog. A command with no `timeout` must be able to
  // outlive any budget this module knows about without being touched.
  it("arms nothing when no timeout is given", async () => {
    const { stdout } = await executeCommand("sleep 1; echo survived-unbounded");
    expect(stdout.trim()).toBe("survived-unbounded");
  });

  // The maxBuffer-override invariant from PR #1694 R1, re-pinned here because
  // this change rewrote the options handling that carries it: defaults go
  // before the spread, so a caller's value wins.
  it("still lets a caller override maxBuffer", async () => {
    const { stdout } = await executeCommand("printf 'xxxxxxxxxx'", { maxBuffer: 1024 });
    expect(stdout).toBe("xxxxxxxxxx");
  });

  // The negative control for that override: a value the output genuinely
  // exceeds must still kill the command, or the assertion above would pass just
  // as happily against an option that is being ignored.
  it("still honours a maxBuffer the output exceeds", async () => {
    let caught: unknown;
    try {
      await executeCommand("printf 'xxxxxxxxxxxxxxxxxxxx'", { maxBuffer: 2 });
    } catch (error) {
      caught = error;
    }
    expect(classifyExecFailure(caught).kind).toBe("maxbuffer");
  });
});
