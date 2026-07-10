/**
 * Tests for the GitHub App auth-health signal (mt#2717).
 *
 * Hermetic: no network, no DB. The `AuthHealthTracker` is exercised directly
 * with typed mock emitters; `isAuthError` is a pure classifier; the process-wide
 * singleton is driven through one trip→recover cycle with captured logs.
 */

import { describe, test, expect, mock } from "bun:test";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";
import { isAuthError, AuthHealthTracker, githubAuthHealth } from "./auth-health";

/** Build an Error carrying an Octokit-style numeric `status`. */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// Extracted to satisfy custom/no-magic-string-duplication (both literals recur
// across cases): a sweeper source label and the exact "Bad credentials" string
// the live deployment logged 1,730 times (mt#2717).
const SRC = "merge_state_sweeper";
const BAD_CREDS_FULL = "Bad credentials - https://docs.github.com/rest";

/** A fresh auth-class error (HTTP 401 "Bad credentials"). */
const badCreds = () => httpError("Bad credentials", 401);

type TripInfo = {
  consecutiveFailures: number;
  threshold: number;
  source: string;
  lastError: string;
};
type RecoverInfo = { source: string; failuresBeforeRecovery: number };

describe("isAuthError", () => {
  test("classifies HTTP 401 as an auth error", () => {
    expect(isAuthError(httpError("Something", 401))).toBe(true);
  });

  test("classifies HTTP 403 as an auth error", () => {
    expect(isAuthError(httpError("Resource not accessible", 403))).toBe(true);
  });

  test("classifies the GitHub 'Bad credentials' message as an auth error", () => {
    expect(isAuthError(new Error(BAD_CREDS_FULL))).toBe(true);
  });

  test("classifies 'Unauthorized' message as an auth error", () => {
    expect(isAuthError(new Error("Request failed: Unauthorized"))).toBe(true);
  });

  test("matches a bare 'Bad credentials' string (non-Error input)", () => {
    expect(isAuthError("Bad credentials")).toBe(true);
  });

  test("does NOT classify a 5xx as an auth error", () => {
    expect(isAuthError(httpError("Server Error", 500))).toBe(false);
  });

  test("does NOT classify a timeout/network error as an auth error", () => {
    expect(isAuthError(new Error("github.pulls.get timed out after 30000ms"))).toBe(false);
    expect(isAuthError(new Error("fetch failed: ECONNRESET"))).toBe(false);
  });
});

describe("AuthHealthTracker", () => {
  function makeTracker(threshold: number) {
    const onTrip = mock((_info: TripInfo) => {});
    const onRecover = mock((_info: RecoverInfo) => {});
    const tracker = new AuthHealthTracker(threshold, { onTrip, onRecover });
    return { tracker, onTrip, onRecover };
  }

  test("does not trip below the threshold", () => {
    const { tracker, onTrip } = makeTracker(3);
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(tracker.failureCount).toBe(2);
    expect(tracker.isTripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  test("trips exactly at the threshold, and only once (deduped)", () => {
    const { tracker, onTrip } = makeTracker(3);
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(onTrip).not.toHaveBeenCalled();
    tracker.recordFailure(SRC, badCreds());
    expect(tracker.isTripped).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1);
    // Further failures past the trip do not re-fire the alert.
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(tracker.failureCount).toBe(5);
  });

  test("passes accurate context to onTrip", () => {
    const { tracker, onTrip } = makeTracker(2);
    tracker.recordFailure("sweeper", badCreds());
    tracker.recordFailure("sweeper", new Error(BAD_CREDS_FULL));
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0]?.[0]).toEqual({
      consecutiveFailures: 2,
      threshold: 2,
      source: "sweeper",
      lastError: BAD_CREDS_FULL,
    });
  });

  test("non-auth failures do not move the counter or trip", () => {
    const { tracker, onTrip } = makeTracker(3);
    tracker.recordFailure(SRC, httpError("Server Error", 500));
    tracker.recordFailure(SRC, new Error("timed out"));
    tracker.recordFailure(SRC, new Error("ECONNRESET"));
    tracker.recordFailure(SRC, new Error("timed out"));
    expect(tracker.failureCount).toBe(0);
    expect(tracker.isTripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  test("a success before any trip does not fire onRecover", () => {
    const { tracker, onRecover } = makeTracker(3);
    tracker.recordFailure(SRC, badCreds());
    tracker.recordSuccess();
    expect(tracker.failureCount).toBe(0);
    expect(onRecover).not.toHaveBeenCalled();
  });

  test("a success interrupts the streak (no trip)", () => {
    const { tracker, onTrip } = makeTracker(3);
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    tracker.recordSuccess(); // resets to 0
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(tracker.isTripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  test("recovers after a trip and re-arms for a subsequent trip", () => {
    const { tracker, onTrip, onRecover } = makeTracker(2);
    // First trip.
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(onTrip).toHaveBeenCalledTimes(1);
    // Recover.
    tracker.recordSuccess();
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover.mock.calls[0]?.[0]).toEqual({ source: SRC, failuresBeforeRecovery: 2 });
    expect(tracker.isTripped).toBe(false);
    expect(tracker.failureCount).toBe(0);
    // Re-arm: a fresh streak trips again.
    tracker.recordFailure(SRC, badCreds());
    tracker.recordFailure(SRC, badCreds());
    expect(onTrip).toHaveBeenCalledTimes(2);
  });
});

describe("githubAuthHealth singleton", () => {
  test("emits reviewer.auth_health_failing on trip and reviewer.auth_health_recovered on recovery", () => {
    const captured = captureConsoleLogs();
    try {
      // Default threshold is 3 (REVIEWER_AUTH_HEALTH_FAILURE_THRESHOLD unset).
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());

      const failing = findLogEvent(captured.logs, "reviewer.auth_health_failing");
      expect(failing).not.toBeNull();
      expect(failing?.["consecutiveFailures"]).toBe(3);
      expect(failing?.["source"]).toBe(SRC);

      // Recover so this test leaves the process-wide singleton reset for any
      // later test in the run.
      githubAuthHealth.recordSuccess();
      expect(findLogEvent(captured.logs, "reviewer.auth_health_recovered")).not.toBeNull();
      expect(githubAuthHealth.isTripped).toBe(false);
    } finally {
      captured.restore();
    }
  });
});
