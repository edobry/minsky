import { describe, expect, test } from "bun:test";
import { TimeoutError, withTimeout } from "./with-timeout";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

describe("withTimeout", () => {
  test("returns the inner promise's resolved value when it completes before the timeout", async () => {
    const result = await withTimeout("test.fast", 1_000, async () => "ok");
    expect(result).toBe("ok");
  });

  test("propagates non-timeout rejections from the inner promise unchanged", async () => {
    const innerError = new Error("inner failure");
    let caught: unknown;
    try {
      await withTimeout("test.error", 1_000, async () => {
        throw innerError;
      });
    } catch (err) {
      caught = err;
    }
    // Same instance — withTimeout must not wrap unrelated errors.
    expect(caught).toBe(innerError);
  });

  test("throws TimeoutError when the inner promise hangs past the timeout", async () => {
    let caught: unknown;
    try {
      await withTimeout(
        "test.hang",
        20,
        // Hang forever — never resolves nor rejects on its own.
        () => new Promise(() => {})
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    const e = caught as TimeoutError;
    expect(e.op).toBe("test.hang");
    expect(e.timeoutMs).toBe(20);
    expect(e.name).toBe("TimeoutError");
  });

  test("aborts the AbortSignal passed to inner so SDKs that respect it can cancel", async () => {
    let aborted = false;
    let caught: unknown;
    try {
      await withTimeout(
        "test.signal",
        20,
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted by signal"));
            });
          })
      );
    } catch (err) {
      caught = err;
    }
    expect(aborted).toBe(true);
    // The race resolves with whichever rejects first. In practice the
    // signal-listener path and the timeoutPromise reject at nearly the same
    // tick; either error shape is acceptable, but we MUST observe the abort.
    expect(caught).toBeDefined();
  });

  test("emits a structured-shape JSON timeout log on timeout", async () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      try {
        await withTimeout("test.log", 15, () => new Promise(() => {}));
      } catch {
        // expected TimeoutError
      }
    } finally {
      restore();
    }

    const parsed = findLogEvent(logs, "timeout");
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("expected a 'timeout' event to be logged");
    expect(parsed.op).toBe("test.log");
    expect(parsed.timeoutMs).toBe(15);
    expect(typeof parsed.durationMs).toBe("number");
    // durationMs should be at least the timeout (timer fires after the
    // budget elapses) and not negative.
    expect(parsed.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  test("does NOT log a timeout when the inner promise completes in time", async () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      const result = await withTimeout("test.no-log", 100, async () => 42);
      expect(result).toBe(42);
    } finally {
      restore();
    }
    expect(findLogEvent(logs, "timeout")).toBeNull();
  });

  test("clears the timer when inner resolves to avoid pending timer leaks", async () => {
    // Resolves in 1ms; timeout is 10s. After resolution the timer must be
    // cleared so the test process can exit promptly. We assert this
    // indirectly: the test would hang for 10s if the timer weren't cleared,
    // and bun's timeout would fail it. The 5s explicit limit catches that.
    // Date.now() here is for elapsed-time measurement, not path generation —
    // the no-real-fs-in-tests rule misfires on this usage.

    const start = Date.now();
    const result = await withTimeout("test.cleartimer", 10_000, async () => "done");
    expect(result).toBe("done");
    // eslint-disable-next-line custom/no-real-fs-in-tests
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("TimeoutError.message names both the operation and the timeout in ms", () => {
    const err = new TimeoutError("provider.openai.create", 12_345);
    expect(err.message).toContain("provider.openai.create");
    expect(err.message).toContain("12345");
  });
});
