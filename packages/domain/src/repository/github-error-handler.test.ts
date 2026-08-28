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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
 * A 404 carrying the request-path evidence a real Octokit `RequestError`
 * always attaches (mt#4692) — `error.request.url`, the fully-resolved URL
 * Octokit actually dispatched. `requestPath` is the path portion only
 * (e.g. `/repos/owner/repo/pulls`); the origin is fixed to
 * `https://api.github.com` since only the path matters to the
 * discriminator.
 */
function makeStatusErrorWithRequestPath(
  status: number,
  requestPath: string,
  message = `HTTP ${status}`
): Error & { status: number; request: { url: string } } {
  const err = new Error(message) as Error & { status: number; request: { url: string } };
  err.status = status;
  err.request = { url: `https://api.github.com${requestPath}` };
  return err;
}

/**
 * A GitHub-RESPONDED error: status plus a `response`, the shape
 * `@octokit/request` throws when GitHub actually sent the status
 * (`fetch-wrapper.js` passes `response: octokitResponse` on every such path).
 *
 * mt#3221 made this distinction load-bearing for the 5xx branch, so the 5xx
 * tests below use this rather than {@link makeStatusError}: a bare `.status`
 * with no `response` is Octokit's TRANSPORT-failure shape, which now
 * deliberately classifies as a network error instead. `makeStatusError` stays
 * in use for the 4xx cases, where `response` presence carries no meaning.
 */
function makeServerError(
  status: number,
  message = `HTTP ${status}`
): Error & { status: number; response: { status: number } } {
  const err = new Error(message) as Error & { status: number; response: { status: number } };
  err.status = status;
  err.response = { status };
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

/** Headlines that are PARSED downstream (merge-error-classification.ts) — shared so a
 * change to either is a one-line change here rather than a scattered find-and-replace. */
const DEGRADED_HEADLINE_PREFIX = "GitHub API degraded/unavailable";
const DEGRADED_HTTP_500 = `${DEGRADED_HEADLINE_PREFIX} (HTTP 500)`;
const NETWORK_HEADLINE = "Network Connection Error";

const CTX: ErrorContext = {
  operation: "merge pull request",
  owner: "owner",
  repo: "repo",
  prNumber: 1988,
};

const PERMISSION_DENIED_MSG = "GitHub Permission Denied";

/**
 * The App-coverage hint's remedy line (mt#4680/mt#4692) — factored out
 * because it's asserted present/absent across many cases in both the
 * repo-level and sub-resource describe blocks below, and the
 * no-magic-string-duplication lint rule (minLength 15) flags 3+ inline
 * repeats of a string this long.
 */
const REPOSITORY_ACCESS_HINT = "Repository access";

describe("handleOctokitError — 5xx branch (mt#2890)", () => {
  test("500 surfaces 'GitHub API degraded/unavailable (HTTP 500)'", () => {
    expect(() => handleOctokitError(makeServerError(500), CTX)).toThrow(DEGRADED_HTTP_500);
  });

  test("502/503/504 all surface the degraded message with their own status", () => {
    for (const status of [502, 503, 504]) {
      expect(() => handleOctokitError(makeServerError(status), CTX)).toThrow(
        `GitHub API degraded/unavailable (HTTP ${status})`
      );
    }
  });

  test("thrown error is a MinskyError", () => {
    try {
      handleOctokitError(makeServerError(503), CTX);
      throw new Error("expected handleOctokitError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MinskyError);
    }
  });

  test("does not misclassify a 5xx as rate-limit or conflict", () => {
    try {
      handleOctokitError(makeServerError(500), CTX);
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
  // Reset on BOTH sides. The rate-limit snapshot is module-global, and
  // `bun test` shares one process across files, so `github-rate-limit-state.test.ts`
  // writes the same state this describe reads. Cleaning up only afterwards makes
  // the "no snapshot has been captured" case depend on every predecessor having
  // tidied up — and `bunfig.toml` sets `randomize = true`, so which predecessors
  // ran is not fixed. Establishing the precondition here makes it independent.
  beforeEach(() => {
    resetGithubRateLimitStateForTests();
  });

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
    expect(msg).toContain(DEGRADED_HTTP_500);
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

  // PR #2313 R1 (BLOCKING): the original implementation put `.message` SECOND, ahead of
  // `ghErrors`. That contradicted both SC1 and the stated server-before-client principle —
  // `ghErrors` comes from GitHub's response body, `.message` is whatever Octokit put on the
  // Error. This pins the corrected order so it cannot silently regress.
  test("server-supplied ghErrors outranks the client-supplied .message", () => {
    const info = classifyOctokitError(
      makeDetailError(500, {
        message: "client-side restatement",
        ghMessage: "",
        ghErrors: [{ message: "server-side detail", code: "custom" }],
      })
    );
    expect(selectErrorDetail(info)).toBe("server-side detail custom");
    expect(selectErrorDetail(info)).not.toContain("client-side restatement");
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
    expect(msg).toContain(NETWORK_HEADLINE);
    expect(msg).toContain("getaddrinfo ENOTFOUND api.github.com");
  });

  test("network branch renders the placeholder rather than a bare `Error:`", () => {
    // A trigger word in `.message` with no server-side detail at all.
    const msg = messageFromThrow(() => handleOctokitError(new Error("timeout"), CTX));
    expect(msg).toContain(NETWORK_HEADLINE);
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

// ---------------------------------------------------------------------------
// mt#3221 — "GitHub returned a 5xx" vs "the request never reached GitHub".
//
// `@octokit/request`'s fetch wrapper synthesizes `status: 500` for EVERY
// transport-level failure (DNS failure, connection refused, TLS error, abort),
// rethrowing as `new RequestError(message, 500, { request })` with no
// `response` — while every path that throws for a response GitHub actually
// SENT passes `response: octokitResponse`. Before this fix the 5xx branch
// keyed on status alone, so the operator's OWN connectivity failure rendered
// as "GitHub API degraded/unavailable" and `classifyMergeError` recorded a
// GitHub outage.
//
// Verified against the installed @octokit/request during planning by issuing a
// real request to an unresolvable host: status 500, `response` absent, message
// "Unable to connect. Is the computer able to access the url?".
// ---------------------------------------------------------------------------

/** The exact shape Octokit synthesizes for a transport failure: status, no response. */
function makeTransportError(message: string): Error & { status: number } {
  return makeStatusError(500, message);
}

describe("mt#3221 — a synthesized transport 5xx is not a GitHub outage", () => {
  test("AT1: status 500 with NO response classifies as network, not degraded", () => {
    const msg = messageFromThrow(() =>
      handleOctokitError(
        makeTransportError("Unable to connect. Is the computer able to access the url?"),
        CTX
      )
    );

    expect(msg).toContain(NETWORK_HEADLINE);
    expect(msg).not.toContain(DEGRADED_HEADLINE_PREFIX);
    // The contract `merge-error-classification.ts:93` parses — its absence is
    // what stops the merge classifier recording `degraded` for this case.
    expect(msg).not.toMatch(/\(HTTP 5\d\d\)/);
    // The upstream detail still survives (mt#3171 behavior, class-not-instance).
    expect(msg).toContain("Unable to connect");
  });

  test("AT2: status 500 WITH a response still classifies as degraded, headline intact", () => {
    const msg = messageFromThrow(() => handleOctokitError(makeServerError(500, "boom"), CTX));

    expect(msg).toContain(DEGRADED_HTTP_500);
    expect(msg).toMatch(/\(HTTP 5\d\d\)/);
  });

  test("a 502/503/504 that GitHub responded with is unaffected", () => {
    for (const status of [502, 503, 504]) {
      const msg = messageFromThrow(() => handleOctokitError(makeServerError(status), CTX));
      expect(msg).toContain(`GitHub API degraded/unavailable (HTTP ${status})`);
    }
  });

  test("AT3: a status-less error naming a gateway timeout stays on the network branch", () => {
    // Deliberate disposition (SC3): with neither a status nor a response there
    // is no evidence GitHub responded, so promoting it to "degraded" would
    // assert exactly what cannot be established.
    const msg = messageFromThrow(() => handleOctokitError(new Error("504 Gateway Timeout"), CTX));

    expect(msg).toContain(NETWORK_HEADLINE);
    expect(msg).not.toContain(DEGRADED_HEADLINE_PREFIX);
  });

  test("AT4: a non-status '500' in ordinary prose does not classify as degraded", () => {
    // Why message-text matching was rejected for this branch: `500` is a common
    // round number in prose in a way `403`/`404` are not.
    const msg = messageFromThrow(() => handleOctokitError(new Error("processed 500 records"), CTX));

    expect(msg).not.toContain(DEGRADED_HEADLINE_PREFIX);
    expect(msg).not.toMatch(/\(HTTP 5\d\d\)/);
    expect(msg).toContain("Failed to merge pull request: processed 500 records");
  });

  test("classifyOctokitError reports hasResponse for both shapes", () => {
    expect(classifyOctokitError(makeServerError(500)).hasResponse).toBe(true);
    expect(classifyOctokitError(makeTransportError("fetch failed")).hasResponse).toBe(false);
    expect(classifyOctokitError(new Error("no shape at all")).hasResponse).toBe(false);
  });

  test("status is still read from response.status when only nested (regression)", () => {
    const err = new Error("boom") as Error & { response: { status: number } };
    err.response = { status: 502 };
    const info = classifyOctokitError(err);
    expect(info.status).toBe(502);
    expect(info.hasResponse).toBe(true);
    expect(() => handleOctokitError(err, CTX)).toThrow(
      "GitHub API degraded/unavailable (HTTP 502)"
    );
  });

  test("the 5xx check still precedes the network branch for a responded 5xx", () => {
    // Ordering constraint (SC4): a GitHub-responded 5xx whose message ALSO
    // contains a network trigger word must still classify as degraded.
    const msg = messageFromThrow(() =>
      handleOctokitError(makeServerError(503, "upstream timeout"), CTX)
    );
    expect(msg).toContain("GitHub API degraded/unavailable (HTTP 503)");
    expect(msg).not.toContain(NETWORK_HEADLINE);
  });
});

describe("handleOctokitError — repo-level 404 names the App-installation cause (mt#4680)", () => {
  /** No prNumber — the shape `pulls.create` produces when the repo is unreachable. */
  const REPO_CTX: ErrorContext = {
    operation: "create pull request",
    owner: "edobry",
    repo: "peezombie.me",
  };

  function messageFor(ctx: ErrorContext): string {
    try {
      handleOctokitError(makeStatusError(404), ctx);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected handleOctokitError to throw");
  }

  test("names BOTH causes — GitHub returns the same 404 for absent and ungranted", () => {
    // The originating failure: an ungranted repo 404s identically to a
    // nonexistent one, and the old message asserted only the first, sending
    // the operator looking for a typo.
    const msg = messageFor(REPO_CTX);
    expect(msg).toContain("edobry/peezombie.me");
    expect(msg).toContain("was not found");
    expect(msg).toContain("GitHub App");
    expect(msg).toMatch(/installation does not cover|installation covers/);
  });

  test("names the concrete remedy, not just the cause", () => {
    const msg = messageFor(REPO_CTX);
    expect(msg).toContain(REPOSITORY_ACCESS_HINT);
    expect(msg).toContain("minsky setup");
  });

  test("a PR-level 404 does NOT mention the App — that cause does not apply", () => {
    // Reaching a PR at all means the repo was reachable, so the installation
    // covers it; suggesting otherwise would be a false lead.
    const msg = messageFor({ ...REPO_CTX, prNumber: 1988 });
    expect(msg).toContain("Pull request #1988");
    expect(msg).not.toContain("GitHub App");
    expect(msg).not.toContain(REPOSITORY_ACCESS_HINT);
  });

  test("with NO request-path evidence at all, the hint still fires (mt#4680 default preserved)", () => {
    // `makeStatusError` carries no `.request` — the shape a hand-constructed
    // test error, or any non-Octokit error, produces. Absence of evidence
    // must not be read as "sub-resource"; only a POSITIVELY identified
    // sub-resource path narrows the hint (mt#4692).
    const msg = messageFor(REPO_CTX);
    expect(msg).toContain("GitHub App");
    expect(msg).toContain(REPOSITORY_ACCESS_HINT);
  });
});

describe("handleOctokitError — sub-resource 404s do not carry the App-coverage hint (mt#4692)", () => {
  const REPO_CTX: ErrorContext = {
    operation: "list workflow runs",
    owner: "edobry",
    repo: "minsky",
  };

  function messageForPath(requestPath: string, ctx: ErrorContext = REPO_CTX): string {
    try {
      handleOctokitError(makeStatusErrorWithRequestPath(404, requestPath), ctx);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected handleOctokitError to throw");
  }

  test("workflow-runs shape — a 404 from a nonexistent workflow file names neither cause", () => {
    // The originating incident: `forge_ci_run_list --workflow deploy-mcp.yml`
    // against `edobry/minsky` (the one repo the App installation is
    // confirmed to cover) 404s because the WORKFLOW FILE doesn't exist —
    // reaching this endpoint already proves the repo/installation resolved.
    const msg = messageForPath("/repos/edobry/minsky/actions/workflows/deploy-mcp.yml/runs");
    expect(msg).not.toContain("GitHub App");
    expect(msg).not.toContain(REPOSITORY_ACCESS_HINT);
    // The subject itself must not claim the repo wasn't found either —
    // that claim is exactly as false as the App-coverage hint here.
    expect(msg).not.toContain("was not found, or the Minsky GitHub App");
    expect(msg).toContain("edobry/minsky");
  });

  test("branch-protection shape — an unprotected branch is a normal 404, not an App-coverage gap", () => {
    const msg = messageForPath("/repos/edobry/minsky/branches/main/protection", {
      operation: "get branch protection",
      owner: "edobry",
      repo: "minsky",
    });
    expect(msg).not.toContain("GitHub App");
    expect(msg).not.toContain(REPOSITORY_ACCESS_HINT);
  });

  test("label shape — a renamed/missing label is a normal 404, not an App-coverage gap", () => {
    const msg = messageForPath("/repos/edobry/minsky/labels/nonexistent-label", {
      operation: "update label",
      owner: "edobry",
      repo: "minsky",
    });
    expect(msg).not.toContain("GitHub App");
    expect(msg).not.toContain(REPOSITORY_ACCESS_HINT);
  });

  test("repo-level shape (pulls.create) — the hint still fires when the path has explicit evidence", () => {
    // `/repos/{owner}/{repo}/pulls` has nothing beyond owner/repo but a
    // fixed literal ("pulls") — no caller-supplied identifier, so the 404
    // can only be explained by the repo/App. mt#4680's originating case,
    // this time with explicit path evidence rather than the no-evidence
    // fallback (covered separately above).
    const msg = messageForPath("/repos/edobry/minsky/pulls", {
      operation: "create pull request",
      owner: "edobry",
      repo: "minsky",
    });
    expect(msg).toContain("GitHub App");
    expect(msg).toContain(REPOSITORY_ACCESS_HINT);
  });

  test("repo-root shape (repos.get) — the hint still fires", () => {
    const msg = messageForPath("/repos/edobry/minsky", {
      operation: "get repository",
      owner: "edobry",
      repo: "minsky",
    });
    expect(msg).toContain("GitHub App");
    expect(msg).toContain(REPOSITORY_ACCESS_HINT);
  });

  test("a PR-level 404 (prNumber set) skips the sub-resource check entirely — no App mention either way", () => {
    // The PR-level branch is a separate, already-narrow carve-out (mt#4680);
    // it takes precedence over the sub-resource discriminator regardless of
    // what the request path looks like.
    const msg = messageForPath("/repos/edobry/minsky/pulls/1988", {
      operation: "merge pull request",
      owner: "edobry",
      repo: "minsky",
      prNumber: 1988,
    });
    expect(msg).toContain("Pull request #1988");
    expect(msg).not.toContain("GitHub App");
    expect(msg).not.toContain(REPOSITORY_ACCESS_HINT);
  });
});

describe("classifyOctokitError — requestPath extraction (mt#4692)", () => {
  test("extracts the pathname from a well-formed request.url", () => {
    const info = classifyOctokitError(
      makeStatusErrorWithRequestPath(404, "/repos/edobry/minsky/actions/runs")
    );
    expect(info.requestPath).toBe("/repos/edobry/minsky/actions/runs");
  });

  test("is undefined when the error carries no .request at all", () => {
    const info = classifyOctokitError(makeStatusError(404));
    expect(info.requestPath).toBeUndefined();
  });

  test("is undefined when .request.url is not a well-formed URL", () => {
    const err = makeStatusError(404) as Error & { status: number; request: { url: string } };
    err.request = { url: "not-a-url" };
    const info = classifyOctokitError(err);
    expect(info.requestPath).toBeUndefined();
  });
});
