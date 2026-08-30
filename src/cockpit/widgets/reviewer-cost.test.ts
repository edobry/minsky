/**
 * Unit tests for the reviewer-cost widget (mt#4557).
 *
 * Covers the mt#4546 coordination blocker directly: `fetch()` must resolve
 * an explicit `degraded` state (never a fabricated `ok` payload, and never a
 * throw that some other layer could swallow into a zero) as long as mt#4546's
 * accessor is unwired. This is a regression test for the SC3 boundary itself
 * -- it fails loudly if a future edit starts querying review_timing directly
 * from this widget (the "second query layer" SC3 forbids) instead of routing
 * through mt#4546's accessor.
 */
import { describe, test, expect } from "bun:test";
import { reviewerCostWidget, NOT_YET_WIRED_REASON_PREFIX } from "./reviewer-cost";

describe("reviewerCostWidget", () => {
  test("id and updateMode match the widget-registry contract", () => {
    expect(reviewerCostWidget.id).toBe("reviewer-cost");
    expect(reviewerCostWidget.updateMode).toEqual({ type: "polling", intervalMs: 60_000 });
  });

  test("fetch() resolves an explicit degraded state, never ok, while mt#4546 is unwired", async () => {
    const result = await reviewerCostWidget.fetch({ id: "reviewer-cost" });
    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    // Names both the blocking task and the tracking ask -- an operator
    // reading the cockpit (or this test's failure output) can find both.
    expect(result.reason).toContain("mt#4546");
    expect(result.reason).toContain("ask#10301");
    // The reason must start with the exported, matchable prefix -- the
    // frontend hook (useReviewerCost.ts) keys off this exact string to
    // distinguish "not wired yet" from a genuine live failure (mt#3348 R1).
    // A change here without updating the hook silently collapses that
    // distinction back into one generic error state.
    expect(result.reason.startsWith(NOT_YET_WIRED_REASON_PREFIX)).toBe(true);
  });

  test("fetch() never throws -- degraded is a value, not an exception (mt#2757 discipline)", async () => {
    await expect(reviewerCostWidget.fetch({ id: "reviewer-cost" })).resolves.toBeDefined();
  });
});
