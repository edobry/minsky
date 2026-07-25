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
  selectErrorDetail,
  formatErrorDetailLine,
  NO_DETAIL_PLACEHOLDER,
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

// ---------------------------------------------------------------------------
// mt#3171 — the trailing `Error:` line must carry the SERVER's detail, and must
// never be bare.
//
// Originating incident (2026-07-24): a GitHub 500 during PR creation surfaced an
// error ending in a bare `Error:` with nothing after it. The handler was not
// discarding the body — it interpolated `info.message` (the Error object's own
// message), which was empty, while `info.ghMessage` (GitHub's
// `response.data.message`) held the server's actual text and went unread.
// ---------------------------------------------------------------------------

/** Build an Octokit-shaped error with independent control of every message source. */
function makeDetailError(
  status: number,
  opts: { message?: string; ghMessage?: string; ghErrors?: Record<string, unknown>[] } = {}
): Error {
  const err = new Error(opts.message ?? "") as Error & {
    status: number;
    response: { status: number; data: Record<string, unknown> };
  };
  err.status = status;
  err.response = {
    status,
    data: {
      ...(opts.ghMessage !== undefined ? { message: opts.ghMessage } : {}),
      ...(opts.ghErrors !== undefined ? { errors: opts.ghErrors } : {}),
    },
  };
  return err;
}

function messageFromThrow(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("mt#3171 — selectErrorDetail preference order", () => {
  test("AT1: a 5xx with an EMPTY .message but a populated response.data.message surfaces the latter", () => {
    const msg = messageFromThrow(() =>
      handleOctokitError(
        makeDetailError(500, { message: "", ghMessage: "Server Error: request id abc123" }),
        CTX
      )
    );

    expect(msg).toContain("Server Error: request id abc123");
    // The headline is a parsed contract (merge-error-classification.ts) — it must survive.
    expect(msg).toContain("GitHub API degraded/unavailable (HTTP 500)");
  });

  test("ghMessage is preferred over .message when BOTH are populated", () => {
    const info = classifyOctokitError(
      makeDetailError(500, { message: "generic client restatement", ghMessage: "the real cause" })
    );
    expect(selectErrorDetail(info)).toBe("the real cause");
  });

  test("falls back to .message when ghMessage is absent", () => {
    const info = classifyOctokitError(makeDetailError(500, { message: "only the client message" }));
    expect(selectErrorDetail(info)).toBe("only the client message");
  });

  test("falls back to structured response.data.errors when both messages are empty", () => {
    const info = classifyOctokitError(
      makeDetailError(500, {
        message: "",
        ghMessage: "",
        ghErrors: [{ message: "upstream timeout", code: "custom", field: "base" }],
      })
    );
    // Rendered for DISPLAY — not the lowercased `ghErrorsText` used for substring matching.
    expect(selectErrorDetail(info)).toBe("upstream timeout custom base");
  });

  test("whitespace-only candidates do not count as detail", () => {
    const info = classifyOctokitError(makeDetailError(500, { message: "   ", ghMessage: "\n\t" }));
    expect(selectErrorDetail(info)).toBeNull();
  });
});

describe("mt#3171 — no bare `Error:` line ever renders", () => {
  test("AT2: a 5xx with message, ghMessage and errors[] all empty carries the explicit placeholder", () => {
    const msg = messageFromThrow(() =>
      handleOctokitError(makeDetailError(503, { message: "", ghMessage: "", ghErrors: [] }), CTX)
    );

    expect(msg).toContain(NO_DETAIL_PLACEHOLDER);
    // The specific regression: a trailing "Error:" with nothing after it.
    expect(msg).not.toMatch(/Error:\s*$/);
  });

  test("formatErrorDetailLine never returns a bare `Error:`", () => {
    const empty = classifyOctokitError(makeDetailError(500, { message: "", ghMessage: "" }));
    expect(formatErrorDetailLine(empty)).toBe(`Error: ${NO_DETAIL_PLACEHOLDER}`);
    expect(formatErrorDetailLine(empty)).not.toMatch(/Error:\s*$/);
  });
});

describe("mt#3171 — AT3: the network/timeout branch gets the same treatment (class-not-instance)", () => {
  test("network branch surfaces ghMessage when .message lacks detail beyond the trigger word", () => {
    // `.message` must contain a trigger word for this branch to be selected at all, and the
    // error must NOT be a 5xx (no status) or the degraded branch would take it first.
    const err = new Error("network") as Error & {
      response: { data: Record<string, unknown> };
    };
    err.response = { data: { message: "getaddrinfo ENOTFOUND api.github.com" } };

    const msg = messageFromThrow(() => handleOctokitError(err, CTX));
    expect(msg).toContain("Network Connection Error");
    expect(msg).toContain("getaddrinfo ENOTFOUND api.github.com");
  });

  test("network branch renders the placeholder rather than a bare `Error:`", () => {
    // A trigger word in `.message` with no server-side detail at all.
    const msg = messageFromThrow(() => handleOctokitError(new Error("timeout"), CTX));
    expect(msg).toContain("Network Connection Error");
    expect(msg).not.toMatch(/Error:\s*$/);
    // `.message` is "timeout" — non-empty, so it IS the detail; the placeholder is not needed.
    expect(msg).toContain("Error: timeout");
  });
});

describe("mt#3171 — AT4: the 5xx text no longer asserts credentials/PR are fine", () => {
  test("the unconditional 'not a problem with your PR or credentials' claim is gone", () => {
    const msg = messageFromThrow(() =>
      handleOctokitError(makeDetailError(500, { message: "boom" }), CTX)
    );

    expect(msg).not.toContain("not a problem with your PR or credentials");
    // What replaced it states only what a 5xx actually establishes.
    expect(msg).toContain("does not, by itself, establish");
  });
});
