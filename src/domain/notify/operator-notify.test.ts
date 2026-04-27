/**
 * Unit tests for `SystemOperatorNotify`.
 *
 * Uses narrow stubs for `CommandExecutor` and `StdoutSink` so no real
 * processes are spawned and no I/O reaches stdout during the test run.
 */

import { describe, expect, it } from "bun:test";

import type { CommandExecutor, StdoutSink } from "./operator-notify";
import { SystemOperatorNotify } from "./operator-notify";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeStubExecutor(returnStatus: number | null = 0): {
  executor: CommandExecutor;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const executor: CommandExecutor = {
    exec(cmd: string, args: string[]): { status: number | null } {
      calls.push({ cmd, args });
      return { status: returnStatus };
    },
  };
  return { executor, calls };
}

function makeStubStdout(): { sink: StdoutSink; written: string[] } {
  const written: string[] = [];
  const sink: StdoutSink = {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  };
  return { sink, written };
}

// ---------------------------------------------------------------------------
// bell()
// ---------------------------------------------------------------------------

describe("SystemOperatorNotify.bell", () => {
  it("writes the BEL character (\\x07) to stdout", () => {
    const { sink, written } = makeStubStdout();
    const { executor } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "linux");

    notify.bell();

    expect(written).toHaveLength(1);
    expect(written[0]).toBe("\x07");
  });

  it("writes exactly one chunk per call", () => {
    const { sink, written } = makeStubStdout();
    const { executor } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "linux");

    notify.bell();
    notify.bell();

    expect(written).toHaveLength(2);
    expect(written[0]).toBe("\x07");
    expect(written[1]).toBe("\x07");
  });

  it("does not invoke the command executor", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "linux");

    notify.bell();

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notify() on darwin
// ---------------------------------------------------------------------------

describe("SystemOperatorNotify.notify — darwin platform", () => {
  it("calls osascript with the correct -e argument", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "darwin");

    notify.notify("Build finished", "All tests passed");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("osascript");
    expect(calls[0]?.args[0]).toBe("-e");
    expect(calls[0]?.args[1]).toBe(
      'display notification "All tests passed" with title "Build finished"'
    );
  });

  it("does not write to stdout", () => {
    const { sink, written } = makeStubStdout();
    const { executor } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "darwin");

    notify.notify("title", "body");

    expect(written).toHaveLength(0);
  });

  it("escapes double-quotes in title to prevent osascript injection", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "darwin");

    notify.notify('Say "hello"', "body");

    const script = calls[0]?.args[1] ?? "";
    // The title in the script must not contain a raw unescaped double-quote
    // that would break the AppleScript string boundary.
    expect(script).toContain('with title "Say \\"hello\\""');
  });

  it("escapes double-quotes in body to prevent osascript injection", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "darwin");

    notify.notify("title", 'Value is "42"');

    const script = calls[0]?.args[1] ?? "";
    expect(script).toContain('display notification "Value is \\"42\\""');
  });
});

// ---------------------------------------------------------------------------
// notify() on non-darwin platforms
// ---------------------------------------------------------------------------

describe("SystemOperatorNotify.notify — non-darwin platform", () => {
  it("does not invoke the command executor on linux", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "linux");

    notify.notify("title", "body");

    expect(calls).toHaveLength(0);
  });

  it("does not invoke the command executor on win32", () => {
    const { sink } = makeStubStdout();
    const { executor, calls } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "win32");

    notify.notify("title", "body");

    expect(calls).toHaveLength(0);
  });

  it("does not write to the stdout sink on linux", () => {
    const { sink, written } = makeStubStdout();
    const { executor } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "linux");

    notify.notify("title", "body");

    expect(written).toHaveLength(0);
  });

  it("does not write to the stdout sink on win32", () => {
    const { sink, written } = makeStubStdout();
    const { executor } = makeStubExecutor();
    const notify = new SystemOperatorNotify(executor, sink, "win32");

    notify.notify("title", "body");

    expect(written).toHaveLength(0);
  });
});
