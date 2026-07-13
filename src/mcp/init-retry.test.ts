/**
 * mt#1962 — tests for the retry-aware init controller.
 *
 * Acceptance tests (one-to-one with the spec's §Acceptance Tests):
 *
 * 1. Success on first init (no retry path).
 * 2. Failure then success on retry — uses injected clock advancing past backoff.
 * 3. Failure then failure with backoff respected (second attempt only fires
 *    after the configured interval has elapsed).
 * 4. Concurrent-call collapsing — 5 concurrent `awaitReady()` calls during an
 *    in-flight initializer produce exactly 1 initializer invocation.
 * 5. Error message propagation — the actual rejection surfaces on both the
 *    in-flight-failure path and the backoff-blocked path.
 * 6. Structured-log emission — `onAttemptSettled` fires exactly once per
 *    settled attempt, regardless of how many awaiters were queued.
 */

import { describe, test, expect } from "bun:test";

import { RetryingInitController, type AttemptResult } from "./init-retry";

class FakeClock {
  private t: number;
  constructor(initial = 0) {
    this.t = initial;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

class CallCounter {
  count = 0;
  /** Resolves the next call's promise from outside; lets a test step
   * through an in-flight initializer at controlled points. */
  private resolvers: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  /** Returns an initializer that always rejects with the given error. */
  failing(error: unknown): () => Promise<void> {
    return async () => {
      this.count++;
      throw error;
    };
  }

  /** Returns an initializer that always resolves. */
  succeeding(): () => Promise<void> {
    return async () => {
      this.count++;
    };
  }

  /** Returns an initializer that the test can settle by calling
   * `settleNext({ ok: true })` or `settleNext({ error })`. */
  controllable(): () => Promise<void> {
    return () => {
      this.count++;
      return new Promise<void>((resolve, reject) => {
        this.resolvers.push({ resolve, reject });
      });
    };
  }

  settleNext(outcome: { ok: true } | { error: unknown }): void {
    const r = this.resolvers.shift();
    if (!r) throw new Error("No in-flight controllable initializer to settle");
    if ("ok" in outcome) r.resolve();
    else r.reject(outcome.error);
  }

  /** Returns a sequenced initializer: nth call uses the nth outcome. */
  sequenced(outcomes: Array<{ ok: true } | { error: unknown }>): () => Promise<void> {
    let i = 0;
    return async () => {
      this.count++;
      const o = outcomes[i++];
      if (!o) throw new Error("Sequenced initializer ran out of outcomes");
      if ("ok" in o) return;
      throw o.error;
    };
  }
}

describe("RetryingInitController — mt#1962", () => {
  test("acceptance 1: success on first init — initializer called exactly once across N awaits", async () => {
    const counter = new CallCounter();
    const ctrl = new RetryingInitController({
      initializer: counter.succeeding(),
      now: new FakeClock().now,
    });

    await ctrl.awaitReady();
    await ctrl.awaitReady();
    await ctrl.awaitReady();

    expect(counter.count).toBe(1);
  });

  test("acceptance 2: failure then success on retry — second attempt fires after backoff window elapses", async () => {
    const counter = new CallCounter();
    const clock = new FakeClock();
    const FIRST_ATTEMPT_FAILS = "first attempt fails";
    const ERROR = new Error(FIRST_ATTEMPT_FAILS);
    const ctrl = new RetryingInitController({
      initializer: counter.sequenced([{ error: ERROR }, { ok: true }]),
      now: clock.now,
      minRetryIntervalMs: 30_000,
    });

    // First attempt rejects.
    await expect(ctrl.awaitReady()).rejects.toThrow(FIRST_ATTEMPT_FAILS);
    expect(counter.count).toBe(1);

    // Within the backoff window: the rejection is re-thrown without a new attempt.
    clock.advance(29_999);
    await expect(ctrl.awaitReady()).rejects.toThrow(FIRST_ATTEMPT_FAILS);
    expect(counter.count).toBe(1);

    // After the backoff window: a new attempt fires and succeeds.
    clock.advance(2);
    await ctrl.awaitReady();
    expect(counter.count).toBe(2);

    // Further awaits use the cached success.
    await ctrl.awaitReady();
    await ctrl.awaitReady();
    expect(counter.count).toBe(2);
  });

  test("acceptance 3: failure then failure with backoff respected — third attempt only fires after second backoff window", async () => {
    const counter = new CallCounter();
    const clock = new FakeClock();
    const ERROR = new Error("init failure");
    const ctrl = new RetryingInitController({
      initializer: counter.failing(ERROR),
      now: clock.now,
      minRetryIntervalMs: 30_000,
    });

    // Attempt 1.
    await expect(ctrl.awaitReady()).rejects.toThrow("init failure");
    expect(counter.count).toBe(1);

    // Inside backoff window — no new attempt.
    clock.advance(15_000);
    await expect(ctrl.awaitReady()).rejects.toThrow("init failure");
    expect(counter.count).toBe(1);

    // Past backoff — attempt 2.
    clock.advance(15_001);
    await expect(ctrl.awaitReady()).rejects.toThrow("init failure");
    expect(counter.count).toBe(2);

    // Inside second backoff — no new attempt.
    clock.advance(15_000);
    await expect(ctrl.awaitReady()).rejects.toThrow("init failure");
    expect(counter.count).toBe(2);
  });

  test("acceptance 4: concurrent calls during in-flight initializer collapse to one invocation", async () => {
    const counter = new CallCounter();
    const ctrl = new RetryingInitController({
      initializer: counter.controllable(),
      now: new FakeClock().now,
    });

    const awaiters = [
      ctrl.awaitReady(),
      ctrl.awaitReady(),
      ctrl.awaitReady(),
      ctrl.awaitReady(),
      ctrl.awaitReady(),
    ];

    // Only one initializer invocation despite 5 awaiters.
    expect(counter.count).toBe(1);

    counter.settleNext({ ok: true });
    await Promise.all(awaiters);

    // Still just one — subsequent awaits hit the cached success.
    expect(counter.count).toBe(1);
  });

  test("acceptance 5: error message propagation — the actual rejection reaches the awaiter on both in-flight-failure and backoff-blocked paths", async () => {
    const counter = new CallCounter();
    const clock = new FakeClock();
    const MIGRATION_DIR_NOT_FOUND = "Auto-migration directory not found";
    const SPECIFIC_ERROR = new Error(MIGRATION_DIR_NOT_FOUND);
    const ctrl = new RetryingInitController({
      initializer: counter.failing(SPECIFIC_ERROR),
      now: clock.now,
      minRetryIntervalMs: 30_000,
    });

    // In-flight failure: awaiter sees the actual rejection.
    await expect(ctrl.awaitReady()).rejects.toThrow(MIGRATION_DIR_NOT_FOUND);

    // Backoff-blocked: awaiter ALSO sees the actual rejection (not a generic "init pending" message).
    clock.advance(1_000);
    await expect(ctrl.awaitReady()).rejects.toThrow(MIGRATION_DIR_NOT_FOUND);

    // The error object identity is preserved across both paths.
    let caught: unknown;
    try {
      await ctrl.awaitReady();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(SPECIFIC_ERROR);
  });

  test("acceptance 6: onAttemptSettled fires once per settled attempt regardless of awaiter count", async () => {
    const counter = new CallCounter();
    const clock = new FakeClock();
    const events: AttemptResult[] = [];
    const ctrl = new RetryingInitController({
      initializer: counter.sequenced([
        { error: new Error("first failure") },
        { error: new Error("second failure") },
        { ok: true },
      ]),
      now: clock.now,
      minRetryIntervalMs: 30_000,
      onAttemptSettled: (r) => events.push(r),
    });

    // Attempt 1 — multiple awaiters, but only one event.
    const a = ctrl.awaitReady();
    const b = ctrl.awaitReady();
    const c = ctrl.awaitReady();
    await Promise.allSettled([a, b, c]);
    expect(events.length).toBe(1);
    const first = events[0];
    if (!first) throw new Error("expected attempt-1 event");
    expect(first.attempt).toBe(1);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.error).toBeInstanceOf(Error);

    // Backoff-blocked re-throws don't trigger new events.
    clock.advance(1_000);
    await expect(ctrl.awaitReady()).rejects.toThrow("first failure");
    expect(events.length).toBe(1);

    // Past backoff — attempt 2 (still failing).
    clock.advance(30_000);
    await expect(ctrl.awaitReady()).rejects.toThrow("second failure");
    expect(events.length).toBe(2);
    const second = events[1];
    if (!second) throw new Error("expected attempt-2 event");
    expect(second.attempt).toBe(2);
    expect(second.consecutiveFailures).toBe(2);

    // Past second backoff — attempt 3 succeeds; consecutiveFailures resets.
    clock.advance(30_000);
    await ctrl.awaitReady();
    expect(events.length).toBe(3);
    const third = events[2];
    if (!third) throw new Error("expected attempt-3 event");
    expect(third.attempt).toBe(3);
    expect(third.consecutiveFailures).toBe(0);
    expect(third.error).toBeUndefined();
  });

  test("onAttemptSettled errors do not affect controller behavior", async () => {
    const counter = new CallCounter();
    const ctrl = new RetryingInitController({
      initializer: counter.succeeding(),
      now: new FakeClock().now,
      onAttemptSettled: () => {
        throw new Error("observer crashed");
      },
    });

    // Even though the observer throws, awaitReady() still resolves successfully.
    await ctrl.awaitReady();
    expect(counter.count).toBe(1);
  });

  test("backoff is keyed off attempt START time, not settle time", async () => {
    // A slow failure that takes longer than the backoff window to settle
    // must allow the next call to retry immediately on the next await,
    // because attempt-to-attempt rate (the spec's "1 retry per 30s") is
    // already satisfied. Keying off start time gives this naturally.
    const counter = new CallCounter();
    const clock = new FakeClock();
    const ctrl = new RetryingInitController({
      initializer: counter.controllable(),
      now: clock.now,
      minRetryIntervalMs: 30_000,
    });

    // Start attempt 1 at t=0.
    const first = ctrl.awaitReady();
    expect(counter.count).toBe(1);

    // Simulate a slow failure: 60s elapse before the first attempt settles.
    clock.advance(60_000);
    counter.settleNext({ error: new Error("slow failure") });
    await expect(first).rejects.toThrow("slow failure");

    // Now t=60_000; attempt 1 started at t=0; elapsed = 60_000 ≥ 30_000.
    // The next awaitReady() must START a new attempt, not re-throw.
    const second = ctrl.awaitReady();
    expect(counter.count).toBe(2);

    counter.settleNext({ ok: true });
    await second;
  });

  test("default backoff is 30 seconds when minRetryIntervalMs is omitted", async () => {
    const counter = new CallCounter();
    const clock = new FakeClock();
    const ctrl = new RetryingInitController({
      initializer: counter.failing(new Error("fail")),
      now: clock.now,
    });

    await expect(ctrl.awaitReady()).rejects.toThrow("fail");
    expect(counter.count).toBe(1);

    clock.advance(29_999);
    await expect(ctrl.awaitReady()).rejects.toThrow("fail");
    expect(counter.count).toBe(1);

    clock.advance(2);
    await expect(ctrl.awaitReady()).rejects.toThrow("fail");
    expect(counter.count).toBe(2);
  });
});
