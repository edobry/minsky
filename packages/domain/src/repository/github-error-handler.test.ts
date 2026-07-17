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
    expect(() => handleOctokitError(makeStatusError(403), CTX)).toThrow("GitHub Permission Denied");
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

describe("classifyOctokitError", () => {
  test("extracts status from a top-level .status field", () => {
    const info = classifyOctokitError(makeStatusError(503, "Service Unavailable"));
    expect(info.status).toBe(503);
    expect(info.message).toBe("Service Unavailable");
  });
});
