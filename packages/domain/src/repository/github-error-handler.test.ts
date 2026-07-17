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

import { describe, test, expect, afterEach } from "bun:test";
import {
  handleOctokitError,
  classifyOctokitError,
  looksLikeHtmlBody,
  sanitizeOctokitMessage,
  type ErrorContext,
} from "./github-error-handler";
import { MinskyError } from "../errors/index";
import {
  recordRateLimitHeaders,
  resetGithubRateLimitStateForTests,
} from "./github-rate-limit-state";

function makeStatusError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * A recorded fixture approximating GitHub's real "Unicorn" 503 error page —
 * an HTML document (truncated here; the real page is ~5KB with inlined
 * base64 images) that `@octokit/request`'s fetch wrapper folds verbatim
 * into `RequestError.message` when the response isn't JSON (mt#2888
 * originating incident, 2026-07-16).
 */
const RECORDED_503_HTML_BODY =
  "<!DOCTYPE html>\n<html>\n<head>\n<title>Service Unavailable</title>\n" +
  "<style>body { background-color: #f4f2f0; }</style>\n</head>\n<body>\n" +
  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" ' +
  'alt="Unicorn"/>\n<p>Whoa there! GitHub is temporarily unable to handle ' +
  "this request.</p>\n</body>\n</html>\n";

const RATE_LIMIT_EXCEEDED_MSG = "GitHub Rate Limit Exceeded";
const SERVICE_UNAVAILABLE_MSG = "Service Unavailable";

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
    expect(() => handleOctokitError(makeStatusError(429), CTX)).toThrow(RATE_LIMIT_EXCEEDED_MSG);
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
    expect(() => handleOctokitError(err, CTX)).toThrow(RATE_LIMIT_EXCEEDED_MSG);
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
    const info = classifyOctokitError(makeStatusError(503, SERVICE_UNAVAILABLE_MSG));
    expect(info.status).toBe(503);
    expect(info.message).toBe(SERVICE_UNAVAILABLE_MSG);
  });
});

describe("looksLikeHtmlBody / sanitizeOctokitMessage (mt#2888)", () => {
  test("recognizes a doctype-led HTML document", () => {
    expect(looksLikeHtmlBody(RECORDED_503_HTML_BODY)).toBe(true);
  });

  test("recognizes an <html> tag without a doctype", () => {
    expect(looksLikeHtmlBody("<html><body>Bad Gateway</body></html>")).toBe(true);
  });

  test("does not misclassify plain JSON/text error messages", () => {
    expect(looksLikeHtmlBody(SERVICE_UNAVAILABLE_MSG)).toBe(false);
    expect(looksLikeHtmlBody('{"message":"Not Found"}')).toBe(false);
    expect(looksLikeHtmlBody("")).toBe(false);
  });

  test("sanitizes an HTML body to a short placeholder naming the length, never the markup", () => {
    const sanitized = sanitizeOctokitMessage(RECORDED_503_HTML_BODY);
    expect(sanitized).not.toContain("<html>");
    expect(sanitized).not.toContain("<!DOCTYPE");
    expect(sanitized).not.toContain("base64");
    expect(sanitized).toContain(String(RECORDED_503_HTML_BODY.length));
  });

  test("leaves a non-HTML message unchanged", () => {
    expect(sanitizeOctokitMessage(SERVICE_UNAVAILABLE_MSG)).toBe(SERVICE_UNAVAILABLE_MSG);
  });
});

describe("handleOctokitError — recorded 503-HTML fixture (mt#2888)", () => {
  function makeHtmlBodyError(status: number): Error & {
    status: number;
    response: { status: number; data: string };
  } {
    const err = new Error(RECORDED_503_HTML_BODY) as Error & {
      status: number;
      response: { status: number; data: string };
    };
    err.status = status;
    err.response = { status, data: RECORDED_503_HTML_BODY };
    return err;
  }

  test("a 503 whose .message is a raw HTML body classifies as degraded, one line, no markup", () => {
    try {
      handleOctokitError(makeHtmlBodyError(503), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      const msg = (err as Error).message;
      // Classified: names the status + retry guidance (acceptance criterion:
      // "Simulated 503 HTML response -> tool error is one line naming
      // server_error + retry guidance").
      expect(msg).toContain("GitHub API degraded/unavailable (HTTP 503)");
      expect(msg).toContain("Retry the operation in a few minutes");
      // Never the raw markup.
      expect(msg).not.toContain("<!DOCTYPE");
      expect(msg).not.toContain("<html>");
      expect(msg).not.toContain("base64");
      expect(msg).not.toContain("<img");
    }
  });
});

describe("handleOctokitError — rate-limit reset time (mt#2888)", () => {
  afterEach(() => {
    resetGithubRateLimitStateForTests();
  });

  test("rate-limit error includes the last-observed reset time when a snapshot was captured", () => {
    // Simulate a prior request having captured GitHub's rate-limit headers
    // (mirrors what createOctokit's request hooks do in production).
    const resetEpochSeconds = Math.floor(Date.parse("2026-07-16T23:00:00Z") / 1000);
    recordRateLimitHeaders({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String(resetEpochSeconds),
    });

    try {
      handleOctokitError(makeStatusError(429, "API rate limit exceeded"), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(RATE_LIMIT_EXCEEDED_MSG);
      expect(msg).toContain("2026-07-16T23:00:00.000Z");
    }
  });

  test("rate-limit error omits the reset suffix when no snapshot has been captured", () => {
    try {
      handleOctokitError(makeStatusError(429, "API rate limit exceeded"), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(RATE_LIMIT_EXCEEDED_MSG);
      expect(msg).not.toContain("(resets");
    }
  });
});
