/**
 * Tests for the pr-watch scheduler's total-failure response (mt#4435).
 *
 * `runWatcher` has always counted per-watch errors; every caller dropped the
 * number. The consequence was that a scheduler in which EVERY watch failed
 * logged `poll_complete` each cycle and re-polled at full cadence — 18 identical
 * rate-limit errors across 41 minutes with nothing escalating.
 *
 * `evaluateCycleOutcome` is the decision that fixes it, extracted as a pure
 * function so the policy is asserted directly rather than by driving a timer.
 */

import { describe, expect, test } from "bun:test";
import { evaluateCycleOutcome } from "./pr-watch-scheduler";

/** A cycle where every inspected watch failed. */
const TOTAL_FAILURE = { success: true, inspected: 2, errors: 2 };
/** A cycle where the watches ran cleanly. */
const HEALTHY = { success: true, inspected: 2, errors: 0 };

describe("evaluateCycleOutcome", () => {
  test("a healthy cycle keeps the streak at zero and does not back off", () => {
    expect(evaluateCycleOutcome(0, HEALTHY)).toEqual({
      consecutiveTotalFailures: 0,
      escalate: false,
      skipTicks: 0,
    });
  });

  test("a healthy cycle RESETS an existing streak", () => {
    // Without this, one recovery would leave the scheduler still backing off
    // and still counting toward an escalation it no longer warrants.
    expect(evaluateCycleOutcome(5, HEALTHY).consecutiveTotalFailures).toBe(0);
    expect(evaluateCycleOutcome(5, HEALTHY).skipTicks).toBe(0);
  });

  test("a cycle with SOME failures is not a total failure", () => {
    // One watch pointing at a deleted PR is routine and per-watch; it must not
    // trigger a systemic-fault response.
    const outcome = evaluateCycleOutcome(0, { success: true, inspected: 3, errors: 1 });
    expect(outcome.consecutiveTotalFailures).toBe(0);
    expect(outcome.skipTicks).toBe(0);
  });

  test("a cycle inspecting ZERO watches is not a failure", () => {
    // With no active watches `runWatcher` makes no GitHub calls at all, so the
    // cycle carries no evidence either way. Counting it would let an idle
    // scheduler escalate and back off having never touched the network.
    const outcome = evaluateCycleOutcome(0, { success: true, inspected: 0, errors: 0 });
    expect(outcome.consecutiveTotalFailures).toBe(0);
    expect(outcome.escalate).toBe(false);
    expect(outcome.skipTicks).toBe(0);
  });

  test("a total failure starts a streak and begins backing off", () => {
    const outcome = evaluateCycleOutcome(0, TOTAL_FAILURE);
    expect(outcome.consecutiveTotalFailures).toBe(1);
    expect(outcome.skipTicks).toBe(1);
  });

  test("a failed domain call counts as a total failure", () => {
    // The whole call failing (no DB connection, a thrown credential error) is
    // systemic by definition, and reports no inspected/errors counts at all.
    const outcome = evaluateCycleOutcome(0, { success: false });
    expect(outcome.consecutiveTotalFailures).toBe(1);
  });

  test("backoff grows exponentially with the streak", () => {
    expect(evaluateCycleOutcome(1, TOTAL_FAILURE).skipTicks).toBe(2);
    expect(evaluateCycleOutcome(2, TOTAL_FAILURE).skipTicks).toBe(4);
    expect(evaluateCycleOutcome(3, TOTAL_FAILURE).skipTicks).toBe(8);
  });

  test("backoff is capped so the scheduler still re-probes within the hour", () => {
    // GitHub's rate-limit budget resets hourly. An uncapped 2^n would idle for
    // days after a long outage, so a recovered service would never be noticed.
    const outcome = evaluateCycleOutcome(50, TOTAL_FAILURE);
    expect(outcome.skipTicks).toBe(30);
  });

  test("escalates exactly once, when the streak crosses the threshold", () => {
    expect(evaluateCycleOutcome(1, TOTAL_FAILURE).escalate).toBe(false);
    expect(evaluateCycleOutcome(2, TOTAL_FAILURE).escalate).toBe(true);
    // The fourth and later failing cycles must NOT re-escalate — a fault that
    // persists for hours should page once, not every minute.
    expect(evaluateCycleOutcome(3, TOTAL_FAILURE).escalate).toBe(false);
    expect(evaluateCycleOutcome(20, TOTAL_FAILURE).escalate).toBe(false);
  });

  test("re-escalates after a recovery and a fresh streak", () => {
    // The streak resets on recovery, so a second independent outage is a second
    // page rather than being permanently suppressed by the first.
    const recovered = evaluateCycleOutcome(9, HEALTHY);
    expect(recovered.consecutiveTotalFailures).toBe(0);

    let streak = recovered.consecutiveTotalFailures;
    const escalations: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = evaluateCycleOutcome(streak, TOTAL_FAILURE);
      streak = outcome.consecutiveTotalFailures;
      escalations.push(outcome.escalate);
    }
    expect(escalations).toEqual([false, false, true]);
  });
});
