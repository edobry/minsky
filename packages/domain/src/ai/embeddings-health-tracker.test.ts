import { describe, test, expect, beforeEach } from "bun:test";
import { EmbeddingsHealthTracker, type EmbeddingsHealthSummary } from "./embeddings-health-tracker";
import { NoopEventEmitter } from "../events/emitter";

const PROVIDER = "openai";
const QUOTA_CODE = "insufficient_quota";
const QUOTA_MSG = "You exceeded your current quota";
const RATE_CODE = "rate_limit";
const RATE_MSG = "429 rate limited";

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
    await tracker.recordError(PROVIDER, "circuit_breaker_open", "Circuit breaker is open");

    const summary = tracker.getSummary();
    expect(summary.status).toBe("degraded");
    expect(summary.degradedReason).toBe("circuit_breaker_open");
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
    expect(emitter.emitted[0].eventType).toBe("embeddings.provider_degraded");
    expect(emitter.emitted[0].payload).toMatchObject({
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
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted again");

    expect(emitter.emitted).toHaveLength(1);
  });

  test("emits new event after recovery and re-degradation", async () => {
    const emitter = new NoopEventEmitter();
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setEventEmitter(emitter);

    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted");
    expect(emitter.emitted).toHaveLength(1);

    tracker.recordRecovery();
    await tracker.recordError(PROVIDER, QUOTA_CODE, "quota exhausted again");
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
    expect(emitter.emitted[0].eventType).toBe("embeddings.provider_degraded");
    expect(emitter.emitted[0].payload).toMatchObject({
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
