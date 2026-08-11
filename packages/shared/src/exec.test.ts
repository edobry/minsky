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
