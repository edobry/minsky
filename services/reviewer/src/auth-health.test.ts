/**
 * Tests for the GitHub App auth-health signal (mt#2717).
 *
 * Hermetic: no network, no DB. The `AuthHealthTracker` is exercised directly
 * with typed mock emitters; `isAuthError` is a pure classifier; the process-wide
 * singleton is driven through one trip→recover cycle with captured logs.
 */

import { describe, test, expect, mock } from "bun:test";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";
import {
  isAuthError,
  AuthHealthTracker,
  githubAuthHealth,
  configureGithubAuthHealthAskEmitter,
} from "./auth-health";
import { GITHUB_APP_SETTINGS_URL, type OperatorIncidentContext } from "./ask-emitter";

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

  test("does NOT classify a bare 403 (permission denial) as an auth error", () => {
    // 403 "Resource not accessible by integration" is a per-repo permission
    // problem, not a token mint/refresh failure — it must not page auth-health.
    expect(isAuthError(httpError("Resource not accessible by integration", 403))).toBe(false);
  });

  test("does NOT classify a 403 rate-limit / abuse response as an auth error", () => {
    expect(isAuthError(httpError("API rate limit exceeded", 403))).toBe(false);
    expect(isAuthError(httpError("You have triggered an abuse detection mechanism", 403))).toBe(
      false
    );
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

// ---------------------------------------------------------------------------
// The operator paging tier (mt#2719)
// ---------------------------------------------------------------------------

describe("githubAuthHealth operator paging (mt#2719)", () => {
  test("a trip emits exactly one operator incident, with the GitHub remediation link", async () => {
    const captured: OperatorIncidentContext[] = [];
    configureGithubAuthHealthAskEmitter({
      emitCircuitBreakerAlert: () => Promise.resolve("created" as const),
      emitReviewFailureAlert: () => Promise.resolve("created" as const),
      emitOperatorIncidentAlert: (ctx: OperatorIncidentContext) => {
        captured.push(ctx);
        return Promise.resolve("created" as const);
      },
    });

    const capturedLogs = captureConsoleLogs();
    try {
      // Four failures, one threshold. The emit is deduped by the tracker's own
      // `tripped` flag, so the 4th must NOT produce a second page — a paging
      // tier that re-fires per failure is worse than no paging tier.
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());

      // The emit is fire-and-forget by design (onTrip is synchronous, on the
      // sweepers' error path), so let the microtask queue drain.
      await Promise.resolve();
      await Promise.resolve();

      expect(captured).toHaveLength(1);
      expect(captured[0]?.source).toBe("github_auth");
      expect(captured[0]?.remediationUrl).toBe(GITHUB_APP_SETTINGS_URL);
      if (captured[0]?.source === "github_auth") {
        expect(captured[0].consecutiveFailures).toBe(3);
        expect(captured[0].observedBy).toBe(SRC);
      }
    } finally {
      capturedLogs.restore();
      // Reset the process-wide singleton and unwire the emitter, so a later
      // test in the run sees neither a tripped tracker nor this fake.
      githubAuthHealth.recordSuccess();
      configureGithubAuthHealthAskEmitter(null);
    }
  });

  test("with no emitter wired, a trip still logs and does not throw", () => {
    configureGithubAuthHealthAskEmitter(null);
    const capturedLogs = captureConsoleLogs();
    try {
      // The degradation contract: the ask is ADDITIVE. No container, no DB, no
      // emitter — the distinct error log is still produced.
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());
      githubAuthHealth.recordFailure(SRC, badCreds());

      expect(findLogEvent(capturedLogs.logs, "reviewer.auth_health_failing")).not.toBeNull();
    } finally {
      capturedLogs.restore();
      githubAuthHealth.recordSuccess();
    }
  });
});
