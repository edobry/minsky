import { describe, expect, it } from "bun:test";

import { classifyExecFailure, executeCommand } from "./exec";

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

  it("reads killed-with-no-code as a timeout kill", () => {
    expect(classifyExecFailure({ killed: true, code: null, signal: "SIGTERM" })).toEqual({
      kind: "timeout",
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

  it("leaves a successful command untouched", async () => {
    const { stdout } = await executeCommand("echo ok");
    expect(stdout.trim()).toBe("ok");
  });
});
