/**
 * Tests for `handleOctokitError`'s 5xx (server-side degradation) branch
 * (mt#2890).
 *
 * Before this fix, a 5xx Octokit error fell through to the generic
 * fallback (`Failed to ${operation}: ${getErrorMessage(error)}`), which
 * typically does NOT include the numeric HTTP status -- so downstream
 * classifiers (e.g. workflow-commands.ts's `classifyMergeError`) had no
 * reliable way to distinguish "GitHub is degraded" from any other failure.
 * The new branch surfaces "GitHub API degraded/unavailable (HTTP <status>)"
 * so the status text survives into the message.
 */

import { describe, test, expect } from "bun:test";
import {
  handleOctokitError,
  classifyOctokitError,
  type ErrorContext,
} from "./github-error-handler";
import { MinskyError } from "../errors/index";

function makeStatusError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const CTX: ErrorContext = {
  operation: "merge pull request",
  owner: "owner",
  repo: "repo",
  prNumber: 1988,
};

const PERMISSION_DENIED_MSG = "GitHub Permission Denied";

describe("handleOctokitError — 5xx branch (mt#2890)", () => {
  test("500 surfaces 'GitHub API degraded/unavailable (HTTP 500)'", () => {
    expect(() => handleOctokitError(makeStatusError(500), CTX)).toThrow(
      "GitHub API degraded/unavailable (HTTP 500)"
    );
  });

  test("502/503/504 all surface the degraded message with their own status", () => {
    for (const status of [502, 503, 504]) {
      expect(() => handleOctokitError(makeStatusError(status), CTX)).toThrow(
        `GitHub API degraded/unavailable (HTTP ${status})`
      );
    }
  });

  test("thrown error is a MinskyError", () => {
    try {
      handleOctokitError(makeStatusError(503), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MinskyError);
    }
  });

  test("does not misclassify a 5xx as rate-limit or conflict", () => {
    try {
      handleOctokitError(makeStatusError(500), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("Rate Limit");
      expect(msg).not.toContain("conflict");
    }
  });

  test("regression: 401/403/404/429 continue to classify as before, not as degraded", () => {
    expect(() => handleOctokitError(makeStatusError(401), CTX)).toThrow(
      "GitHub Authentication Failed"
    );
    expect(() => handleOctokitError(makeStatusError(403), CTX)).toThrow(PERMISSION_DENIED_MSG);
    expect(() => handleOctokitError(makeStatusError(404), CTX)).toThrow("GitHub Not Found");
    expect(() => handleOctokitError(makeStatusError(429), CTX)).toThrow(
      "GitHub Rate Limit Exceeded"
    );
  });

  test("regression: a 200-class or missing status never hits the 5xx branch", () => {
    // No numeric status at all -- falls through to the generic fallback.
    expect(() => handleOctokitError(new Error("some other failure"), CTX)).toThrow(
      "Failed to merge pull request: some other failure"
    );
  });
});

describe("handleOctokitError — 403 rate-limit precedence (mt#2890 R-final)", () => {
  test("a 403 with a rate-limit message classifies as rate limit, NOT permission denied", () => {
    // GitHub's PRIMARY rate limits are HTTP 403 with "API rate limit exceeded" —
    // the rate-limit branch must run before the any-403 permission branch.
    const err = makeStatusError(403, "API rate limit exceeded for installation ID 123");
    expect(() => handleOctokitError(err, CTX)).toThrow("GitHub Rate Limit Exceeded");
    expect(() => handleOctokitError(err, CTX)).not.toThrow(PERMISSION_DENIED_MSG);
  });

  test("a plain 403 without rate-limit text still classifies as permission denied", () => {
    expect(() => handleOctokitError(makeStatusError(403, "Resource not accessible"), CTX)).toThrow(
      PERMISSION_DENIED_MSG
    );
  });
});

describe("classifyOctokitError", () => {
  test("extracts status from a top-level .status field", () => {
    const info = classifyOctokitError(makeStatusError(503, "Service Unavailable"));
    expect(info.status).toBe(503);
    expect(info.message).toBe("Service Unavailable");
  });
});
