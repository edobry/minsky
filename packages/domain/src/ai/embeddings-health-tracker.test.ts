import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { EmbeddingsHealthTracker, type EmbeddingsHealthSummary } from "./embeddings-health-tracker";
import {
  NoopEventEmitter,
  type EventEmitterWithTryEmit,
  type SystemEventInput,
} from "../events/emitter";

/**
 * Fake emitter whose `tryEmit` reports a REAL persistence failure (like
 * `DrizzleEventEmitter.tryEmit` returning `false` on a caught DB error) —
 * distinct from a builder that throws before an emitter is even resolved.
 * Used by the PR #2284 R2 regression test below.
 */
class FailThenSucceedEmitter implements EventEmitterWithTryEmit {
  readonly emitted: SystemEventInput[] = [];
  callCount = 0;

  async emit(event: SystemEventInput): Promise<void> {
    await this.tryEmit(event);
  }

  async tryEmit(event: SystemEventInput): Promise<boolean> {
    this.callCount++;
    if (this.callCount === 1) {
      return false; // simulates a caught-and-swallowed DB insert failure
    }
    this.emitted.push(event);
    return true;
  }
}

const PROVIDER = "openai";
const QUOTA_CODE = "insufficient_quota";
const QUOTA_MSG = "You exceeded your current quota";
const QUOTA_MSG_AGAIN = "quota exhausted again";
const RATE_CODE = "rate_limit";
const RATE_MSG = "429 rate limited";
const BREAKER_CODE = "circuit_breaker_open";
const BREAKER_MSG = "Circuit breaker is open";
const DEGRADED_EVENT_TYPE = "embeddings.provider_degraded";

describe("EmbeddingsHealthTracker", () => {
  beforeEach(() => {
    EmbeddingsHealthTracker.resetForTest();
  });

  test("singleton returns same instance", () => {
    const a = EmbeddingsHealthTracker.getInstance();
    const b = EmbeddingsHealthTracker.getInstance();
    expect(a).toBe(b);
  });

  test("resetForTest creates fresh instance", () => {
    const a = EmbeddingsHealthTracker.getInstance();
    EmbeddingsHealthTracker.resetForTest();
    const b = EmbeddingsHealthTracker.getInstance();
    expect(a).not.toBe(b);
  });

  test("initial summary is healthy", () => {
    const summary = EmbeddingsHealthTracker.getInstance().getSummary();
    expect(summary.status).toBe("healthy");
    expect(summary.lastErrorAt).toBeNull();
    expect(summary.errorCountLastHour).toBe(0);
    expect(summary.degradedReason).toBeNull();
  });

  test("recordError with insufficient_quota sets status to exhausted", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG);

    const summary = tracker.getSummary();
    expect(summary.status).toBe("exhausted");
    expect(summary.provider).toBe(PROVIDER);
    expect(summary.degradedReason).toBe(QUOTA_CODE);
    expect(summary.errorCountLastHour).toBe(1);
    expect(summary.lastErrorAt).not.toBeNull();
  });

  test("recordError with insufficient_quota in message sets exhausted", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, "unknown", `Embedding request failed: 429 - ${QUOTA_CODE}`);

    const summary = tracker.getSummary();
    expect(summary.status).toBe("exhausted");
    expect(summary.degradedReason).toBe(QUOTA_CODE);
  });

  test("repeated rate_limit errors set status to degraded after threshold", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();

    await tracker.recordError(PROVIDER, RATE_CODE, RATE_MSG);
    expect(tracker.getSummary().status).toBe("healthy");

    await tracker.recordError(PROVIDER, RATE_CODE, RATE_MSG);
    expect(tracker.getSummary().status).toBe("healthy");

    await tracker.recordError(PROVIDER, RATE_CODE, RATE_MSG);
    expect(tracker.getSummary().status).toBe("degraded");
    expect(tracker.getSummary().degradedReason).toMatch(/repeated_rate_limit/);
  });

  test("circuit_breaker_open immediately sets status to degraded", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, BREAKER_CODE, BREAKER_MSG);

    const summary = tracker.getSummary();
    expect(summary.status).toBe("degraded");
    expect(summary.degradedReason).toBe(BREAKER_CODE);
  });

  test("recordRecovery resets to healthy", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    expect(tracker.getSummary().status).toBe("exhausted");

    tracker.recordRecovery();
    expect(tracker.getSummary().status).toBe("healthy");
    expect(tracker.getSummary().degradedReason).toBeNull();
  });

  test("emits embeddings.provider_degraded event on first quota exhaustion", async () => {
    const emitter = new NoopEventEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");

    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.eventType).toBe(DEGRADED_EVENT_TYPE);
    expect(emitter.emitted[0]?.payload).toMatchObject({
      provider: PROVIDER,
      errorCode: QUOTA_CODE,
      status: "exhausted",
      degradedReason: QUOTA_CODE,
    });
  });

  test("does not emit duplicate events for same degradation", async () => {
    const emitter = new NoopEventEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG_AGAIN);

    expect(emitter.emitted).toHaveLength(1);
  });

  test("emits new event after recovery and re-degradation", async () => {
    const emitter = new NoopEventEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    expect(emitter.emitted).toHaveLength(1);

    tracker.recordRecovery();
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG_AGAIN);
    expect(emitter.emitted).toHaveLength(2);
  });

  test("summary shape matches debug_systemInfo contract", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");

    const summary: EmbeddingsHealthSummary = tracker.getSummary();
    expect(summary).toHaveProperty("provider");
    expect(summary).toHaveProperty("status");
    expect(summary).toHaveProperty("lastErrorAt");
    expect(summary).toHaveProperty("errorCountLastHour");
    expect(summary).toHaveProperty("degradedReason");
    expect(typeof summary.provider).toBe("string");
    expect(["healthy", "degraded", "exhausted"]).toContain(summary.status);
  });

  test("ring buffer caps at MAX_EVENTS", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    for (let i = 0; i < 150; i++) {
      await tracker.recordError(PROVIDER, RATE_CODE, `error ${i}`);
    }
    expect(tracker.getSummary().errorCountLastHour).toBeLessThanOrEqual(100);
  });
});

/**
 * Regression tests for mt#2568: emitDegradationEvent per-call event-emitter
 * fallback.
 *
 * Pre-fix bug: emitDegradationEvent had `if (!this.eventEmitter) return;`,
 * and emittedForCurrentDegradation latches to true BEFORE that check runs —
 * so whenever the one-shot setEventEmitter() startup wiring in
 * start-command.ts hadn't fired yet (e.g. on proxy/staleness-respawned
 * servers, mirroring the mt#2562/mt#2567 presence write-path race), the
 * embeddings.provider_degraded event for that degradation cycle was lost
 * PERMANENTLY — no retry, even after the wiring eventually completed.
 *
 * Fix: build the emitter per-call via a registered fallback builder when
 * this.eventEmitter is not pre-set — mirrors the buildAskRepository /
 * getPresenceClaimRepo per-call fallback pattern from mt#2567.
 * setEventEmitter() becomes a warm-up fast-path only.
 */
describe("emitDegradationEvent per-call event-emitter fallback (mt#2568 regression)", () => {
  beforeEach(() => {
    EmbeddingsHealthTracker.resetForTest();
  });

  test("REGRESSION: emits via per-call builder when setEventEmitter was never called", async () => {
    // This test reproduces the mt#2568 bug:
    // - Pre-fix code: `if (!this.eventEmitter) return;` — emitted stays empty.
    // - Post-fix code: per-call fallback builds an emitter from the
    //   registered builder → the event is emitted even though the one-shot
    //   setter never fired.
    const emitter = new NoopEventEmitter();
    let builderCallCount = 0;

    EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => {
      builderCallCount++;
      return emitter;
    });

    // CRITICAL: do NOT call tracker.setEventEmitter(...) — this simulates
    // the one-shot startup wiring in start-command.ts never completing
    // before the first embeddings-provider error, the exact mt#2568
    // failure scenario.
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");

    expect(builderCallCount).toBeGreaterThanOrEqual(1);
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.eventType).toBe(DEGRADED_EVENT_TYPE);
    expect(emitter.emitted[0]?.payload).toMatchObject({
      provider: PROVIDER,
      errorCode: QUOTA_CODE,
      status: "exhausted",
    });
  });

  test("fast-path: uses pre-set emitter without going through the builder", async () => {
    const emitter = new NoopEventEmitter();
    let builderCallCount = 0;

    EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => {
      builderCallCount++;
      return emitter;
    });

    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");

    expect(emitter.emitted).toHaveLength(1);
    // The fast-path emitter was used directly — the fallback builder was
    // never invoked.
    expect(builderCallCount).toBe(0);
  });

  test("no-ops gracefully when neither a fast-path emitter nor a builder is registered", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();

    await expect(
      tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted")
    ).resolves.toBeUndefined();
    expect(tracker.getSummary().status).toBe("exhausted");
  });

  test("no-ops gracefully when the builder throws", async () => {
    EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => {
      throw new Error("container has no persistence provider");
    });

    const tracker = EmbeddingsHealthTracker.getInstance();

    await expect(
      tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted")
    ).resolves.toBeUndefined();
    expect(tracker.getSummary().status).toBe("exhausted");
  });

  test("REGRESSION (PR #2284 R1): a transient builder failure does not permanently latch the degradation cycle -- the next call retries and succeeds", async () => {
    // R1 finding: emittedForCurrentDegradation previously latched to true
    // BEFORE the emit was confirmed, so a builder that fails on its FIRST
    // invocation (transient — container momentarily unavailable) would
    // permanently drop this degradation cycle's event even once the builder
    // started succeeding on a later call. Fixed: the latch only sets on a
    // confirmed successful emit.
    const emitter = new NoopEventEmitter();
    let callCount = 0;

    EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("transient: container has no persistence provider yet");
      }
      return emitter;
    });

    const tracker = EmbeddingsHealthTracker.getInstance();

    // First call: builder throws — no-ops, but must NOT latch.
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    expect(emitter.emitted).toHaveLength(0);

    // Second call, same degradation cycle (status already "exhausted"):
    // the builder now succeeds — this call must retry and emit.
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG_AGAIN);
    expect(callCount).toBe(2);
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.eventType).toBe(DEGRADED_EVENT_TYPE);
  });

  test("REGRESSION (PR #2284 R2): a real tryEmit persistence failure (DB insert failed) does not latch either -- retries on the next call", async () => {
    // R2 finding: emitDegradationEvent's R1 fix wrapped emitter.emit() in
    // try/catch, but EventEmitter.emit()'s documented contract is "always
    // resolves, never rejects" EVEN when the underlying DB write fails --
    // so that try/catch could never observe a real insert failure, and the
    // latch still flipped to true. This test exercises tryEmit's boolean
    // failure signal directly (no builder involved at all -- the emitter
    // resolves fine, its OWN persistence attempt is what fails first).
    const emitter = new FailThenSucceedEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    // First call: tryEmit signals failure (false) -- must NOT latch.
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    expect(emitter.emitted).toHaveLength(0);
    expect(emitter.callCount).toBe(1);

    // Second call, same degradation cycle: tryEmit now succeeds -- must
    // retry and actually persist the event.
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG_AGAIN);
    expect(emitter.callCount).toBe(2);
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.eventType).toBe(DEGRADED_EVENT_TYPE);
  });

  test("resetForTest clears a registered builder", async () => {
    const emitter = new NoopEventEmitter();
    EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => emitter);

    EmbeddingsHealthTracker.resetForTest();

    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");

    // Builder was cleared by resetForTest — nothing to fall back to.
    expect(emitter.emitted).toHaveLength(0);
  });
});

describe("stale-degradation decay (mt#4212)", () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const START = new Date("2026-08-17T09:08:40.000Z");

  beforeEach(() => {
    EmbeddingsHealthTracker.resetForTest();
    setSystemTime(START);
  });

  afterEach(() => {
    setSystemTime();
  });

  test("circuit_breaker_open stops being reported once its window is empty", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, BREAKER_CODE, BREAKER_MSG);
    expect(tracker.getSummary().status).toBe("degraded");

    // The originating incident: the breaker self-healed in 60s but nothing
    // called embeddings again, so the banner still read "degraded" six hours
    // later. The breaker cannot outlive its own 60s timeout, so an hour with no
    // errors is proof the reported reason is no longer true.
    setSystemTime(new Date(START.getTime() + ONE_HOUR_MS + 1));

    const summary = tracker.getSummary();
    expect(summary.status).toBe("healthy");
    expect(summary.degradedReason).toBeNull();
    expect(summary.errorCountLastHour).toBe(0);
  });

  test("a degradation with errors still in the window is left alone", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, BREAKER_CODE, BREAKER_MSG);

    setSystemTime(new Date(START.getTime() + ONE_HOUR_MS / 2));

    expect(tracker.getSummary().status).toBe("degraded");
    expect(tracker.getSummary().degradedReason).toBe(BREAKER_CODE);
  });

  test("repeated_rate_limit decays — its reason is defined by the same window", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    for (let i = 0; i < 3; i++) await tracker.recordError(PROVIDER, RATE_CODE, RATE_MSG);
    expect(tracker.getSummary().status).toBe("degraded");

    setSystemTime(new Date(START.getTime() + ONE_HOUR_MS + 1));
    expect(tracker.getSummary().status).toBe("healthy");
  });

  test("exhausted is NOT decayed — quota persists until the account is topped up", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError(PROVIDER, QUOTA_CODE, QUOTA_MSG);
    expect(tracker.getSummary().status).toBe("exhausted");

    setSystemTime(new Date(START.getTime() + 24 * ONE_HOUR_MS));

    const summary = tracker.getSummary();
    expect(summary.status).toBe("exhausted");
    expect(summary.degradedReason).toBe(QUOTA_CODE);
  });

  test("a decayed degradation can emit an event again on the next cycle", async () => {
    const emitter = new NoopEventEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, BREAKER_CODE, BREAKER_MSG);
    expect(emitter.emitted).toHaveLength(1);

    setSystemTime(new Date(START.getTime() + ONE_HOUR_MS + 1));
    expect(tracker.getSummary().status).toBe("healthy");

    // Decay must clear the per-cycle emit latch too, or a later, genuinely new
    // degradation would go unrecorded.
    await tracker.recordError(PROVIDER, BREAKER_CODE, BREAKER_MSG);
    expect(tracker.getSummary().status).toBe("degraded");
    expect(emitter.emitted).toHaveLength(2);
  });
});
