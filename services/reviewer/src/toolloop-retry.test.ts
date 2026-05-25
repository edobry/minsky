/**
 * Tests for mt#1969's toolloop retry-on-timeout helper.
 *
 * `callToolloopWithRetry` wraps an SDK call in a `withTimeout` with a single
 * retry on `TimeoutError`. The retry uses a smaller ceiling (default 90s)
 * than the primary attempt (production 120s) so the failure surface fires
 * faster on genuinely-stuck calls while giving transient hiccups a second
 * shot.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { callToolloopWithRetry } from "./providers";
import { TimeoutError } from "./with-timeout";

const ENV_RETRY_ENABLED = "REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT";
const ENV_RETRY_TIMEOUT_MS = "REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS";
const ENV_KEYS = [ENV_RETRY_ENABLED, ENV_RETRY_TIMEOUT_MS];
const TEST_OP = "test.op";

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("mt#1969 callToolloopWithRetry", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  /**
   * Helper: simulate a hung SDK call that respects the abort signal. The
   * factory returns an async function that on its first call waits `waitMs`
   * (longer than the timeout, so `withTimeout` aborts and throws TimeoutError)
   * and on subsequent calls returns `successValue` (retry succeeds).
   */
  function makeFlakyFn(waitMs: number, successValue: string) {
    let count = 0;
    const fn = async (signal: AbortSignal): Promise<string> => {
      count++;
      if (count === 1) {
        await new Promise((resolve) => {
          const handle = setTimeout(resolve, waitMs);
          signal.addEventListener("abort", () => clearTimeout(handle));
        });
        return "should-not-reach";
      }
      return successValue;
    };
    return { fn, getCount: () => count };
  }

  /**
   * Helper: simulate a sustained-stuck SDK call that ALWAYS hangs past the
   * configured timeout on every call (retry also times out).
   */
  function makeAlwaysStuckFn(waitMs: number) {
    let count = 0;
    const fn = async (signal: AbortSignal): Promise<string> => {
      count++;
      await new Promise((resolve) => {
        const handle = setTimeout(resolve, waitMs);
        signal.addEventListener("abort", () => clearTimeout(handle));
      });
      return "should-not-reach";
    };
    return { fn, getCount: () => count };
  }

  test("returns first-attempt result without retry on success", async () => {
    let calls = 0;
    const result = await callToolloopWithRetry(TEST_OP, 0, 1000, async () => {
      calls++;
      return "ok";
    });
    expect(result).toEqual({ result: "ok", retriedOnTimeout: false });
    expect(calls).toBe(1);
  });

  test("retries once on TimeoutError with reduced ceiling", async () => {
    process.env[ENV_RETRY_TIMEOUT_MS] = "500";
    const { fn, getCount } = makeFlakyFn(200, "retry-ok");
    const result = await callToolloopWithRetry(TEST_OP, 0, 50, fn);
    expect(result).toEqual({ result: "retry-ok", retriedOnTimeout: true });
    expect(getCount()).toBe(2);
  });

  test("throws TimeoutError when retry also times out", async () => {
    process.env[ENV_RETRY_TIMEOUT_MS] = "50";
    const { fn, getCount } = makeAlwaysStuckFn(500);
    await expect(callToolloopWithRetry(TEST_OP, 0, 50, fn)).rejects.toBeInstanceOf(TimeoutError);
    expect(getCount()).toBe(2);
  });

  test("does NOT retry when retry-enabled env is 'false'", async () => {
    process.env[ENV_RETRY_ENABLED] = "false";
    const { fn, getCount } = makeAlwaysStuckFn(500);
    await expect(callToolloopWithRetry(TEST_OP, 0, 50, fn)).rejects.toBeInstanceOf(TimeoutError);
    // Critical: only ONE call, no retry.
    expect(getCount()).toBe(1);
  });

  test("propagates non-timeout errors without retry", async () => {
    let calls = 0;
    await expect(
      callToolloopWithRetry(TEST_OP, 0, 1000, async () => {
        calls++;
        throw new Error("not-a-timeout");
      })
    ).rejects.toThrow(/not-a-timeout/);
    expect(calls).toBe(1);
  });

  test("treats '1' as truthy for retry-enabled", async () => {
    process.env[ENV_RETRY_ENABLED] = "1";
    process.env[ENV_RETRY_TIMEOUT_MS] = "500";
    const { fn, getCount } = makeFlakyFn(200, "ok");
    const result = await callToolloopWithRetry(TEST_OP, 0, 50, fn);
    expect(result).toEqual({ result: "ok", retriedOnTimeout: true });
    expect(getCount()).toBe(2);
  });

  test("falls back to default retry ceiling when env var is malformed", async () => {
    // Asserts that an invalid env var still ENABLES retry; cannot assert
    // the actual 90_000 default ceiling without a 90+ second test.
    process.env[ENV_RETRY_TIMEOUT_MS] = "not-a-number";
    const { fn, getCount } = makeFlakyFn(200, "ok");
    const result = await callToolloopWithRetry(TEST_OP, 0, 50, fn);
    expect(result).toEqual({ result: "ok", retriedOnTimeout: true });
    expect(getCount()).toBe(2);
  });
});
