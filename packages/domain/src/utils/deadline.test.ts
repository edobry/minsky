/**
 * withDeadline tests (mt#2677).
 *
 * Mirrors the assertion style of `octokit-timeout.test.ts` (a real, small
 * timer bounding a promise that never settles) — this is the same class of
 * bug (unbounded async work with no wall-clock guarantee) at the generic
 * per-operation layer rather than the Octokit-fetch layer.
 */
import { describe, test, expect } from "bun:test";
import { withDeadline, DeadlineExceededError } from "./deadline";

describe("withDeadline (mt#2677)", () => {
  test("rejects with DeadlineExceededError within timeout+1s when the promise never settles", async () => {
    const neverSettles = new Promise<string>(() => {});

    const start = performance.now();
    let caught: unknown;
    try {
      await withDeadline(neverSettles, 50);
    } catch (err) {
      caught = err;
    }
    const elapsedMs = performance.now() - start;

    expect(caught).toBeInstanceOf(DeadlineExceededError);
    expect(elapsedMs).toBeLessThan(50 + 1000);
  });

  test("passes a fast-resolving promise through unchanged", async () => {
    const result = await withDeadline(Promise.resolve("ok"), 10_000);
    expect(result).toBe("ok");
  });

  test("propagates a fast rejection from the underlying promise (not the deadline)", async () => {
    const boom = new Error("boom");
    await expect(withDeadline(Promise.reject(boom), 10_000)).rejects.toBe(boom);
  });

  test("timeoutMs <= 0 rejects immediately without scheduling a timer", async () => {
    const neverSettles = new Promise<string>(() => {});
    const start = performance.now();
    await expect(withDeadline(neverSettles, 0)).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test("a late resolution of an abandoned promise does not surface as an unhandled rejection", async () => {
    let resolveLate: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });

    await expect(withDeadline(stalled, 20)).rejects.toBeInstanceOf(DeadlineExceededError);

    // Resolve (and separately, in the next test, reject) the abandoned
    // promise after the deadline already fired. If withDeadline didn't attach
    // a swallowing .catch() up front, a late REJECTION here would surface as
    // an unhandledRejection in the test process.
    resolveLate?.();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("a late rejection of an abandoned promise does not surface as an unhandled rejection", async () => {
    let rejectLate: ((err: unknown) => void) | undefined;
    const stalled = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });

    await expect(withDeadline(stalled, 20)).rejects.toBeInstanceOf(DeadlineExceededError);

    rejectLate?.(new Error("late rejection from abandoned operation"));
    await new Promise((r) => setTimeout(r, 10));
  });
});
