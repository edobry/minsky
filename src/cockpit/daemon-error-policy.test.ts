import { describe, expect, test } from "bun:test";
import {
  classifyUncaughtException,
  createSurvivedErrorLogger,
  formatErrorForLog,
  isTransientConnectError,
  originatingFrame,
} from "./daemon-error-policy";

/**
 * Builds an Error with a caller-supplied stack, so a test can express "the
 * throw originated HERE" without depending on a real socket failure.
 */
function errorWithStack(name: string, message: string, frames: string[]): Error {
  const err = new Error(message);
  err.name = name;
  err.stack = [`${name}: ${message}`, ...frames.map((f) => `    at ${f}`)].join("\n");
  return err;
}

/** The mt#3534 signature: a bare TypeError thrown inside the runtime's net module. */
function bunConnectCrash(): Error {
  return errorWithStack("TypeError", "null is not an object (evaluating 'context.socket')", [
    "internalConnectMultipleTimeout (node:net:1128:5)",
    "listOnTimeout (node:internal/timers:594:17)",
  ]);
}

/**
 * A REAL Bun 1.2.21 socket-error stack, captured verbatim from
 * `net.connect({host:"127.0.0.1", port:1})`. Kept literal because the
 * `internal:shared` frame above the `node:net` frame is the whole reason
 * `originatingFrame` skips runtime error-construction frames.
 */
const REAL_BUN_ECONNREFUSED_STACK = [
  "Error: connect ECONNREFUSED 127.0.0.1:1",
  "    at new ExceptionWithHostPort (internal:shared:42:10)",
  "    at afterConnect (node:net:1172:39)",
  "    at connectError (node:net:366:48)",
].join("\n");

describe("originatingFrame", () => {
  test("returns the first frame", () => {
    expect(originatingFrame("Error: x\n    at a (node:net:1:1)\n    at b (src/y.ts:2:2)")).toBe(
      "at a (node:net:1:1)"
    );
  });

  test("skips the runtime's error-construction frame — real Bun stack", () => {
    expect(originatingFrame(REAL_BUN_ECONNREFUSED_STACK)).toBe(
      "at afterConnect (node:net:1172:39)"
    );
  });

  test("returns undefined when the stack carries no frames", () => {
    expect(originatingFrame("TypeError: message only")).toBeUndefined();
    expect(originatingFrame(undefined)).toBeUndefined();
  });
});

describe("isTransientConnectError", () => {
  test("matches a transient network error code", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isTransientConnectError(err)).toBe(true);
  });

  test("matches the mt#3534 runtime-internal throw by its top frame, not its message", () => {
    expect(isTransientConnectError(bunConnectCrash())).toBe(true);
  });

  test("matches regardless of the mislabelled expression in the message", () => {
    // Upstream (oven-sh/bun PR #32660) documents that JSC names the wrong
    // expression here, and that the text differs between runtime versions.
    const older = errorWithStack("TypeError", "null is not an object (evaluating 'context')", [
      "internalConnectMultipleTimeout (node:net:1128:5)",
    ]);
    expect(isTransientConnectError(older)).toBe(true);
  });

  test("matches a real Bun socket stack even with the code stripped", () => {
    // Proves the frame path — not just the code path — works against the stack
    // shape Bun actually produces, including its `internal:shared` top frame.
    const err = new Error("connect ECONNREFUSED 127.0.0.1:1");
    err.stack = REAL_BUN_ECONNREFUSED_STACK;
    expect(isTransientConnectError(err)).toBe(true);
  });

  test("does NOT match a Minsky bug that merely passes through a socket callback", () => {
    const appBug = errorWithStack("TypeError", "undefined is not a function", [
      "handleRow (src/cockpit/widgets/agents.ts:44:9)",
      "emit (node:net:296:52)",
    ]);
    expect(isTransientConnectError(appBug)).toBe(false);
  });

  test("does NOT match an unrelated error with no code and no frames", () => {
    expect(isTransientConnectError(new Error("boom"))).toBe(false);
  });

  test("does NOT match non-error values", () => {
    expect(isTransientConnectError(null)).toBe(false);
    expect(isTransientConnectError("ECONNREFUSED")).toBe(false);
    expect(isTransientConnectError({ code: "ECONNREFUSED" })).toBe(true);
  });

  test("does NOT match an unrelated error code", () => {
    const err = Object.assign(new Error("nope"), { code: "ERR_INVALID_ARG_TYPE" });
    expect(isTransientConnectError(err)).toBe(false);
  });
});

describe("classifyUncaughtException", () => {
  test("survives the mt#3534 class", () => {
    expect(classifyUncaughtException(bunConnectCrash())).toBe("survive");
  });

  test("exits on anything else — the predicate is not a blanket swallow", () => {
    expect(classifyUncaughtException(new TypeError("genuine bug"))).toBe("exit");
    expect(classifyUncaughtException(new RangeError("out of range"))).toBe("exit");
    expect(classifyUncaughtException("string thrown")).toBe("exit");
  });
});

describe("formatErrorForLog", () => {
  test("records a stack frame — the information the handler used to discard", () => {
    const formatted = formatErrorForLog(bunConnectCrash());
    expect(formatted).toContain("at internalConnectMultipleTimeout (node:net:1128:5)");
  });

  test("records the error code", () => {
    const err = Object.assign(new Error("connect failed"), { code: "EHOSTUNREACH" });
    expect(formatErrorForLog(err)).toContain("[code=EHOSTUNREACH]");
  });

  test("records the cause chain", () => {
    const root = new Error("root cause");
    const wrapper = new Error("wrapper", { cause: root });
    const formatted = formatErrorForLog(wrapper);
    expect(formatted).toContain("caused by:");
    expect(formatted).toContain("root cause");
  });

  test("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => formatErrorForLog(a)).not.toThrow();
  });

  test("stringifies a non-error value", () => {
    expect(formatErrorForLog("plain string")).toBe("plain string");
  });
});

describe("createSurvivedErrorLogger", () => {
  test("logs the first occurrence and then every Nth", () => {
    const lines: string[] = [];
    const log = createSurvivedErrorLogger((line) => lines.push(line), 5);

    for (let i = 0; i < 11; i++) log(bunConnectCrash());

    // occurrences 1, 5 and 10 — not all 11.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("occurrence 1");
    expect(lines[1]).toContain("occurrence 5");
    expect(lines[2]).toContain("occurrence 10");
  });

  test("counts each distinct signature separately", () => {
    const lines: string[] = [];
    const log = createSurvivedErrorLogger((line) => lines.push(line), 100);

    log(new Error("first"));
    log(new Error("second"));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("occurrence 1");
    expect(lines[1]).toContain("occurrence 1");
  });

  test("includes the stack in the survived line", () => {
    const lines: string[] = [];
    createSurvivedErrorLogger((line) => lines.push(line))(bunConnectCrash());
    expect(lines[0]).toContain("at internalConnectMultipleTimeout (node:net:1128:5)");
  });
});
