/**
 * Broken-pipe guard (mt#3885).
 *
 * The integration proof — a real `mcp start --http` growing at ~780 MB/s before
 * the fix and exiting after it — is in the PR body, because it needs a real
 * process whose stdout pipe is closed and cannot be made a cheap unit test.
 * What lives here is the part that unit tests are actually good for: the
 * DISCRIMINATION. A guard that exits on any error would pass the integration
 * check exactly as well as the correct one and would silently kill the process
 * on unrelated write failures, so the negative cases below are the point.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetBrokenPipeGuardForTests,
  installBrokenPipeGuard,
  isBrokenPipeError,
  type BrokenPipeGuardProcess,
} from "./logger";

/** Listener keys, as `<surface>:<event>` — the three routes the guard registers on. */
const STDOUT_ERROR = "stdout:error";
const STDERR_ERROR = "stderr:error";
const UNCAUGHT = "process:uncaughtException";

/** Records what the guard registered and whether it tried to exit. */
function fakeProcess(options: { withStreams?: boolean } = {}) {
  const withStreams = options.withStreams ?? true;
  const listeners: Record<string, Array<(error: unknown) => void>> = {};
  const exitCodes: Array<number | undefined> = [];

  const register = (event: string) => (evt: string, listener: (error: unknown) => void) => {
    const key = `${event}:${evt}`;
    (listeners[key] ??= []).push(listener);
    return undefined;
  };

  const proc: BrokenPipeGuardProcess = {
    on: register("process") as BrokenPipeGuardProcess["on"],
    exit: (code?: number) => {
      exitCodes.push(code);
      return undefined;
    },
    ...(withStreams
      ? {
          stdout: { on: register("stdout") as never },
          stderr: { on: register("stderr") as never },
        }
      : {}),
  };

  return {
    proc,
    exitCodes,
    listenersFor: (key: string) => listeners[key] ?? [],
    fire: (key: string, error: unknown) => {
      for (const listener of listeners[key] ?? []) listener(error);
    },
  };
}

beforeEach(() => {
  _resetBrokenPipeGuardForTests();
});

describe("isBrokenPipeError", () => {
  test("accepts the error a closed pipe produces", () => {
    expect(isBrokenPipeError({ code: "EPIPE" })).toBe(true);
    const realShape = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isBrokenPipeError(realShape)).toBe(true);
  });

  test("rejects everything else, so an unrelated failure cannot kill the process", () => {
    // These are the cases that make the guard safe rather than merely effective.
    expect(isBrokenPipeError({ code: "ENOENT" })).toBe(false);
    expect(isBrokenPipeError({ code: "ECONNRESET" })).toBe(false);
    expect(isBrokenPipeError(new Error("write EPIPE"))).toBe(false); // message, not code
    expect(isBrokenPipeError({})).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
    expect(isBrokenPipeError("EPIPE")).toBe(false);
  });
});

describe("installBrokenPipeGuard", () => {
  test("registers on both streams and on uncaughtException", () => {
    const { proc, listenersFor } = fakeProcess();
    installBrokenPipeGuard(proc);

    // All three, because the runtime delivers the failure by different routes:
    // an `error` event when the stream has a listener, an uncaught exception
    // when the write throws synchronously.
    expect(listenersFor(STDOUT_ERROR)).toHaveLength(1);
    expect(listenersFor(STDERR_ERROR)).toHaveLength(1);
    expect(listenersFor(UNCAUGHT)).toHaveLength(1);
  });

  test("exits 0 on a broken pipe, by every route", () => {
    for (const route of [STDOUT_ERROR, STDERR_ERROR, UNCAUGHT]) {
      _resetBrokenPipeGuardForTests();
      const { proc, exitCodes, fire } = fakeProcess();
      installBrokenPipeGuard(proc);

      fire(route, Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

      // Exit 0: a closed reader is a normal end to a pipeline.
      expect(exitCodes).toEqual([0]);
    }
  });

  test("does NOT exit on an unrelated error", () => {
    const { proc, exitCodes, fire } = fakeProcess();
    installBrokenPipeGuard(proc);

    fire(UNCAUGHT, Object.assign(new Error("boom"), { code: "ENOENT" }));
    fire(STDOUT_ERROR, new Error("some other write failure"));

    expect(exitCodes).toEqual([]);
  });

  test("installs once, so repeated logger construction does not stack listeners", () => {
    const { proc, listenersFor } = fakeProcess();
    installBrokenPipeGuard(proc);
    installBrokenPipeGuard(proc);
    installBrokenPipeGuard(proc);

    expect(listenersFor(UNCAUGHT)).toHaveLength(1);
  });

  test("tolerates a process object with no stdout/stderr", () => {
    const { proc, exitCodes, fire, listenersFor } = fakeProcess({ withStreams: false });

    expect(() => installBrokenPipeGuard(proc)).not.toThrow();
    expect(listenersFor(UNCAUGHT)).toHaveLength(1);

    fire(UNCAUGHT, { code: "EPIPE" });
    expect(exitCodes).toEqual([0]);
  });
});
