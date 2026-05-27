import { describe, test, expect, beforeEach } from "bun:test";
import { EmbeddingsHealthTracker } from "../../../packages/domain/src/ai/embeddings-health-tracker";

describe("EmbeddingsHealthTracker fallback fields", () => {
  beforeEach(() => {
    EmbeddingsHealthTracker.resetForTest();
  });

  test("summary reports fallbackActive=false by default", () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    const summary = tracker.getSummary();
    expect(summary.fallbackActive).toBe(false);
    expect(summary.fallbackProvider).toBeNull();
  });

  test("setFallbackActive sets fallback fields", () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setFallbackActive("gemini");
    const summary = tracker.getSummary();
    expect(summary.fallbackActive).toBe(true);
    expect(summary.fallbackProvider).toBe("gemini");
  });

  test("recordRecovery clears fallback state", () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setFallbackActive("gemini");
    tracker.recordRecovery();
    const summary = tracker.getSummary();
    expect(summary.fallbackActive).toBe(false);
    expect(summary.fallbackProvider).toBeNull();
  });

  test("quota exhaustion + fallback active shows exhausted status with fallback", async () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    await tracker.recordError("openai", "insufficient_quota", "billing exhausted");
    tracker.setFallbackActive("gemini");

    const summary = tracker.getSummary();
    expect(summary.status).toBe("exhausted");
    expect(summary.fallbackActive).toBe(true);
    expect(summary.fallbackProvider).toBe("gemini");
    expect(summary.degradedReason).toBe("insufficient_quota");
  });

  test("fallback state persists — setFallbackActive is not cleared by non-recovery calls", () => {
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setFallbackActive("gemini");

    const summary1 = tracker.getSummary();
    expect(summary1.fallbackActive).toBe(true);
    expect(summary1.fallbackProvider).toBe("gemini");

    const summary2 = tracker.getSummary();
    expect(summary2.fallbackActive).toBe(true);
    expect(summary2.fallbackProvider).toBe("gemini");
  });
});
